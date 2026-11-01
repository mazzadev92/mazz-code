import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { promisify, TextDecoder } from 'node:util';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { languageOf, outlineSource, type OutlineSymbol } from './code.js';
import { isSecretFile } from './default-deny.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const INDEX_SCHEMA = 1;
const PARSER_VERSION = 'ast-grep-outline-v1';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 50_000;
const MAX_CONTENT_QUERY_CHARS = 512;
const MAX_CONTENT_LINE_RESULTS_PER_FILE = 5;
const IGNORED_DIRS = ['.git', 'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'out', 'bin', 'obj', 'coverage', '.turbo'];
const EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.py', '.rs'];

type AstNode = {
  kind(): string;
  text(): string;
  field(name: string): AstNode | null;
  findAll(rule: unknown): AstNode[];
  range(): { start: { line: number } };
};
type AstApi = {
  parse(lang: string, src: string): { root(): AstNode };
  registerDynamicLanguage(m: Record<string, unknown>): void;
  Lang: Record<string, string>;
};
type StoredImport = { specifier: string; line: number; relative: boolean; kind?: 'module' | 'import'; target?: string };
export type IndexedSourceFile = {
  path: string;
  language: string;
  sha256: string;
  bytes: number;
  mtimeMs: number;
  parserVersion: string;
  status: 'indexed' | 'error';
  error?: string;
  symbols: OutlineSymbol[];
  imports: StoredImport[];
  indexedAt: string;
  checkedAt: string;
};
type PersistedIndex = { schemaVersion: number; workspace: string; parserVersion: string; updatedAt: string; files: Record<string, IndexedSourceFile> };
type ImportCandidate = { specifier: string; line: number; relative: boolean; kind?: 'module' | 'import' };
type UpdateSummary = { scanned: number; parsed: number; unchanged: number; removed: number; errors: number; updatedAt: string };
type RawContentMatch = { path: string; line: number; byteColumn: number; indexed: IndexedSourceFile };
export type ProjectCodeContentMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
  sha256: string;
  bytes: number;
  indexedAt: string;
};

let astApi: AstApi | null | undefined;
const storeLocks = new Map<string, Promise<unknown>>();

function loadAst(): AstApi {
  if (astApi) return astApi;
  if (astApi === null) throw new Error('ast-grep indisponible : indexation des symboles non démarrée.');
  try {
    // C/C++/Python/Rust grammars match the parser used by code.outline.
    const api = require('@ast-grep/napi') as AstApi;
    const dynamic: Record<string, unknown> = {};
    for (const [name, pkg] of [['c', '@ast-grep/lang-c'], ['cpp', '@ast-grep/lang-cpp'], ['python', '@ast-grep/lang-python'], ['rust', '@ast-grep/lang-rust']]) {
      const loaded = require(pkg);
      dynamic[name] = (loaded as { default?: unknown }).default ?? loaded;
    }
    api.registerDynamicLanguage(dynamic);
    astApi = api;
    return api;
  } catch (error) {
    astApi = null;
    throw new Error(`ast-grep indisponible : ${(error as Error).message}`);
  }
}

function canonical(p: string): string {
  const absolute = path.resolve(p);
  const parsedRoot = path.parse(absolute).root;
  const resolved = absolute === parsedRoot ? absolute : absolute.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function relativePath(p: string): string {
  return p.split(path.sep).join('/');
}

function appDataDirectory(): string {
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'MAZZ Agent Studio', 'code-index');
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function unwrapStringLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 2 || !['"', "'", '`'].includes(trimmed[0]) || trimmed.at(-1) !== trimmed[0]) return undefined;
  const quote = trimmed[0];
  const body = trimmed.slice(1, -1);
  if (quote === '`' && body.includes('${')) return undefined;
  if (quote === '"') {
    try { return JSON.parse(trimmed) as string; } catch { return undefined; }
  }
  return body.replace(/\\([\\'`])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function fieldLiteral(node: AstNode | null): string | undefined {
  return node ? unwrapStringLiteral(node.text()) : undefined;
}

function parseImports(source: string, language: string): ImportCandidate[] {
  const api = loadAst();
  const root = api.parse(api.Lang[language] ?? language, source).root();
  const found: ImportCandidate[] = [];
  const add = (node: AstNode, value: string | undefined, relative = false, kind: 'module' | 'import' = 'import') => {
    if (value && value.trim()) found.push({ specifier: value.trim(), line: node.range().start.line + 1, relative, kind });
  };
  if (language === 'TypeScript' || language === 'Tsx' || language === 'JavaScript') {
    for (const node of root.findAll({ rule: { any: [{ kind: 'import_statement' }, { kind: 'export_statement' }] } })) {
      const specifier = fieldLiteral(node.field('source'));
      add(node, specifier, specifier?.startsWith('.') ?? false);
    }
    for (const node of root.findAll({ rule: { kind: 'call_expression' } })) {
      const fn = node.field('function')?.text().trim();
      if (fn !== 'require' && fn !== 'import') continue;
      const match = node.field('arguments')?.text().match(/^\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1\s*\)$/);
      if (match) {
        const specifier = unwrapStringLiteral(`${match[1]}${match[2]}${match[1]}`);
        add(node, specifier, specifier?.startsWith('.') ?? false);
      }
    }
  } else if (language === 'python') {
    for (const node of root.findAll({ rule: { kind: 'import_statement' } })) {
      const value = node.field('name')?.text().split(',')[0]?.trim();
      add(node, value?.split(/\s+as\s+/)[0], false);
    }
    for (const node of root.findAll({ rule: { kind: 'import_from_statement' } })) {
      const module = node.text().match(/^\s*from\s+(\.*[\p{L}\p{N}_.]*?)\s+import\b/u)?.[1];
      add(node, module, module?.startsWith('.') ?? false);
    }
  } else if (language === 'rust') {
    for (const node of root.findAll({ rule: { kind: 'mod_item' } })) {
      const name = node.field('name')?.text().trim();
      if (name && /;\s*$/.test(node.text())) add(node, name, true, 'module');
    }
    for (const node of root.findAll({ rule: { kind: 'use_declaration' } })) {
      const value = node.field('argument')?.text().replace(/;\s*$/, '').trim();
      add(node, value, /^(crate|self|super)::/.test(value ?? ''));
    }
  } else if (language === 'c' || language === 'cpp') {
    for (const node of root.findAll({ rule: { kind: 'preproc_include' } })) {
      const value = node.field('path')?.text().trim();
      const quoted = value?.startsWith('"') ?? false;
      add(node, value ? (unwrapStringLiteral(value) ?? value.replace(/^<|>$/g, '')) : undefined, quoted);
    }
  }
  const unique = new Map<string, ImportCandidate>();
  for (const item of found) unique.set(`${item.line}\0${item.specifier}`, item);
  return [...unique.values()].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function candidatesForImport(from: string, specifier: string, language: string, kind?: 'module' | 'import'): string[] {
  const baseDir = path.posix.dirname(from);
  if (language === 'python') {
    const dots = specifier.match(/^\.+/)?.[0].length ?? 0;
    const rest = specifier.slice(dots).replace(/\./g, '/');
    const up = Math.max(0, dots - 1);
    const start = path.posix.normalize(path.posix.join(baseDir, ...Array(up).fill('..'), rest));
    if (dots === 0) {
      const fromWorkspace = rest;
      const fromImporter = path.posix.normalize(path.posix.join(baseDir, rest));
      return [fromWorkspace + '.py', `${fromWorkspace}/__init__.py`, fromImporter + '.py', `${fromImporter}/__init__.py`];
    }
    return [start + '.py', `${start}/__init__.py`];
  }
  if (language === 'rust') {
    let modulePath = specifier.replace(/\{[\s\S]*$/, '').replace(/::\*$/, '');
    if (modulePath.startsWith('crate::')) modulePath = path.posix.join(from.startsWith('src/') ? 'src' : '', modulePath.slice(7));
    else if (modulePath.startsWith('self::')) modulePath = path.posix.join(baseDir, modulePath.slice(6));
    else if (modulePath.startsWith('super::')) modulePath = path.posix.join(baseDir, '..', modulePath.slice(7));
    else if (kind === 'module' && /^[A-Za-z_][\w]*$/.test(specifier)) {
      const filename = path.posix.basename(from);
      const moduleDir = filename === 'main.rs' || filename === 'lib.rs' || filename === 'mod.rs'
        ? baseDir
        : path.posix.join(baseDir, filename.replace(/\.rs$/i, ''));
      modulePath = path.posix.join(moduleDir, specifier);
    }
    else return [];
    const target = path.posix.normalize(modulePath.replace(/::/g, '/'));
    return [`${target}.rs`, `${target}/mod.rs`];
  }
  if (language === 'c' || language === 'cpp') {
    const fromBase = path.posix.normalize(path.posix.join(baseDir, specifier));
    const fromRoot = path.posix.normalize(specifier);
    const candidates = [fromBase];
    if (fromRoot !== fromBase) candidates.push(fromRoot);
    const fromInclude = path.posix.normalize(path.posix.join('include', specifier));
    if (!candidates.includes(fromInclude)) candidates.push(fromInclude);
    return candidates;
  }
  if (!specifier.startsWith('.')) return [];
  const target = path.posix.normalize(path.posix.join(baseDir, specifier));
  const ext = path.posix.extname(target);
  if (ext === '.js') return [target, target.slice(0, -3) + '.ts', target.slice(0, -3) + '.tsx', target.slice(0, -3) + '.mts', target.slice(0, -3) + '.cts'];
  if (ext === '.mjs') return [target, target.slice(0, -4) + '.mts', target.slice(0, -4) + '.ts'];
  if (ext === '.cjs') return [target, target.slice(0, -4) + '.cts', target.slice(0, -4) + '.ts'];
  if (ext) return [target];
  return [target, ...EXTENSIONS.map((suffix) => target + suffix), ...EXTENSIONS.map((suffix) => `${target}/index${suffix}`)];
}

async function rgPath(): Promise<string> {
  try {
    const loaded = await import('@vscode/ripgrep');
    const p = (loaded as { rgPath?: string }).rgPath;
    if (p) return p;
  } catch { /* PATH fallback below */ }
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

/** Search only the paths in the freshly updated index; source text is never persisted in the index. */
async function ripgrepIndexedContent(
  root: string,
  files: IndexedSourceFile[],
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<{ matches: RawContentMatch[]; truncated: boolean }> {
  if (query.length > MAX_CONTENT_QUERY_CHARS) throw new Error(`La recherche de contenu est limitée à ${MAX_CONTENT_QUERY_CHARS} caractères.`);
  if (/[\0\r\n]/.test(query)) throw new Error('La recherche de contenu doit tenir sur une seule ligne et ne peut pas contenir NUL.');
  if (signal?.aborted) throw new Error('Recherche annulée.');

  const indexed = new Map<string, IndexedSourceFile>();
  for (const entry of files) {
    const rel = entry.path.replace(/\\/g, '/');
    // The persistent index is data, not authority: reject path traversal and
    // unsafe paths before giving any path to ripgrep's --files-from input.
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((part) => !part || part === '.' || part === '..') || /[\0\r\n]/.test(rel)) {
      throw new Error(`Chemin invalide dans l’index persistant : ${JSON.stringify(entry.path)}.`);
    }
    if (!(await isSafeWorkspaceEntry(root, rel))) {
      throw new Error(`Le workspace a changé pendant la recherche; le fichier indexé n’est plus sûr ou disponible : ${rel}. Relance l’actualisation.`);
    }
    const absolute = path.resolve(root, rel);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Le fichier indexé n’est plus un fichier régulier : ${rel}.`);
    indexed.set(rel, entry);
  }
  if (indexed.size === 0) return { matches: [], truncated: false };

  // This bundled ripgrep predates --files-from. Pass explicit, already-vetted
  // file arguments in bounded batches so Windows command lines stay below the
  // CreateProcess limit and the search can never broaden to other workspace paths.
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchChars = 0;
  for (const rel of [...indexed.keys()].sort((a, b) => a.localeCompare(b))) {
    const nextChars = rel.length + 4;
    if (batch.length > 0 && batchChars + nextChars > 12_000) {
      batches.push(batch);
      batch = [];
      batchChars = 0;
    }
    batch.push(rel);
    batchChars += nextChars;
  }
  if (batch.length) batches.push(batch);

  const executable = await rgPath();
  const matches: RawContentMatch[] = [];
  let truncated = false;
  for (const fileBatch of batches) {
    if (signal?.aborted) throw new Error('Recherche annulée.');
    const child = spawn(executable, [
      '--json', '--fixed-strings', '--no-follow', '--no-messages', '--no-ignore',
      '--max-count', String(MAX_CONTENT_LINE_RESULTS_PER_FILE), '-e', query, '--', ...fileBatch,
    ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 32_768) stderr += chunk.slice(0, 32_768 - stderr.length); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, killedBy) => resolve({ code, signal: killedBy }));
    });
    let aborted = false;
    let timedOut = false;
    const abortSearch = () => { aborted = true; child.kill(); };
    signal?.addEventListener('abort', abortSearch, { once: true });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    timeout.unref?.();
    try {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; submatches?: Array<{ start?: number }> } };
        try { event = JSON.parse(line) as typeof event; }
        catch { throw new Error('ripgrep a produit un événement JSON invalide pendant la recherche de contenu.'); }
        if (event.type !== 'match' || !event.data) continue;
        if (matches.length >= limit) {
          truncated = true;
          child.kill();
          break;
        }
        const rawPath = event.data.path?.text;
        const lineNumber = event.data.line_number;
        const byteColumn = event.data.submatches?.[0]?.start;
        if (typeof rawPath !== 'string' || !Number.isSafeInteger(lineNumber) || (lineNumber ?? 0) < 1 || !Number.isSafeInteger(byteColumn) || (byteColumn ?? -1) < 0) {
          throw new Error('ripgrep a produit une référence de source incomplète.');
        }
        const rel = rawPath.replace(/\\/g, '/');
        const entry = indexed.get(rel);
        if (!entry) throw new Error(`ripgrep a retourné un chemin absent de l’index courant : ${rel}.`);
        matches.push({ path: rel, line: lineNumber!, byteColumn: byteColumn!, indexed: entry });
      }
      const result = await closed;
      if (aborted || signal?.aborted) throw new Error('Recherche annulée.');
      if (timedOut) throw new Error('La recherche de contenu a dépassé la limite de 120 secondes.');
      if (!truncated && result.code !== 0 && result.code !== 1) {
        throw new Error(`ripgrep a échoué (${result.code ?? result.signal ?? 'inconnu'}) : ${stderr.trim() || 'aucun détail fourni'}.`);
      }
    } catch (error) {
      child.kill();
      await closed.catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortSearch);
    }
    if (truncated) break;
  }
  return { matches, truncated };
}

function excerptAround(line: string, matchStart: number, matchLength: number): string {
  const maxLength = 600;
  if (line.length <= maxLength) return line;
  let start = Math.max(0, matchStart - 240);
  let end = Math.min(line.length, matchStart + matchLength + 240);
  if (end - start > maxLength) end = start + maxLength;
  if (start > 0 && line.charCodeAt(start) >= 0xDC00 && line.charCodeAt(start) <= 0xDFFF) start++;
  if (end < line.length && line.charCodeAt(end - 1) >= 0xD800 && line.charCodeAt(end - 1) <= 0xDBFF) end--;
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

async function isSafeWorkspaceEntry(root: string, relative: string, safeDirCache?: Set<string>): Promise<boolean> {
  const absolute = path.resolve(root, relative);
  const physicalRoot = canonical(root);
  if (!isInside(physicalRoot, canonical(absolute))) return false;
  const relativeFromRoot = path.relative(root, absolute);
  const parts = relativeFromRoot.split(/[\\/]+/).filter((part) => part && part !== '.');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const isLeaf = i === parts.length - 1;
    if (!isLeaf && safeDirCache?.has(current)) {
      continue;
    }
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || (!isLeaf && !stat.isDirectory())) return false;
      // On Windows this also catches junction/reparse-point targets whose
      // lstat metadata is not reported as a symbolic link by the filesystem.
      if (!isLeaf || stat.isDirectory() || !safeDirCache?.has(path.dirname(current))) {
        const physical = await fs.realpath(current);
        if (!isInside(physicalRoot, canonical(physical))) return false;
      }
      if (!isLeaf && safeDirCache) safeDirCache.add(current);
    } catch {
      // A disappearing or inaccessible entry is not safe to index.
      return false;
    }
  }
  return parts.length > 0;
}

async function windowsReparseDirectories(root: string): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const script = [
    "$root = [System.IO.Path]::GetFullPath($env:MAZZ_CODE_INDEX_ROOT)",
    "$ErrorActionPreference = 'Stop'",
    "$ignored = @('.git','node_modules','dist','build','target','.venv','__pycache__','.next','out','bin','obj','coverage','.turbo')",
    "$pending = New-Object 'System.Collections.Generic.Stack[string]'",
    "$pending.Push($root)",
    "try {",
    "  while ($pending.Count -gt 0) {",
    "    $currentDirectory = $pending.Pop()",
    "    Get-ChildItem -LiteralPath $currentDirectory -Directory -Force -ErrorAction Stop | ForEach-Object {",
    "      if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {",
    "        $relative = $_.FullName.Substring($root.Length).TrimStart([char]92, [char]47).Replace('\\', '/')",
    "        [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($relative)))",
    "      } elseif ($ignored -notcontains $_.Name) {",
    "        $pending.Push($_.FullName)",
    "      }",
    "    }",
    "  }",
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: root,
      env: { ...process.env, MAZZ_CODE_INDEX_ROOT: root },
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return String(stdout).split(/\r?\n/).filter(Boolean).map((line) => Buffer.from(line, 'base64').toString('utf8').replace(/\\/g, '/'));
  } catch (error) {
    throw new Error(`Impossible d’identifier les jonctions Windows avant le parcours ripgrep : ${(error as Error).message}`);
  }
}

function escapeGitignoreComponent(component: string): string {
  return component.replace(/[\\!#*?\[\]{}]/g, '\\$&');
}

function escapeGitignorePath(relative: string): string {
  return relative.replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(escapeGitignoreComponent)
    .join('/');
}

function isProductIgnoredPath(file: string, reparseDirs: string[]): boolean {
  const relative = file.replace(/\\/g, '/');
  const parts = relative.split('/');
  if (parts.some((part) => IGNORED_DIRS.includes(part))) return true;
  if (relative.endsWith('.min.js') || relative.endsWith('.map')) return true;
  return reparseDirs.some((directory) => {
    const normalized = directory.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return relative === normalized || relative.startsWith(`${normalized}/`);
  });
}

async function listSourceFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  const args = ['--files', '--hidden', '--null', '--no-messages', '--no-follow', '--no-require-git'];
  // ripgrep's Windows walker can enumerate files beneath junctions even with
  // --no-follow. Exclude every reparse-point directory before starting rg so
  // those external trees are never traversed or included in scanned counts.
  const reparseDirs = await windowsReparseDirectories(root);
  // --glob overrides all ignore-file logic in ripgrep. A temporary ignore file
  // adds MAZZ's exclusions while preserving workspace .gitignore and .ignore rules.
  const extraIgnoreRules = [
    ...IGNORED_DIRS.map((dir) => `**/${escapeGitignoreComponent(dir)}/`),
    '**/*.min.js',
    '**/*.map',
    ...reparseDirs.map((dir) => `/${escapeGitignorePath(dir)}/`),
  ];
  const temporaryIgnoreDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-index-ignore-'));
  try {
    const temporaryIgnoreFile = path.join(temporaryIgnoreDirectory, 'index-exclusions.ignore');
    await fs.writeFile(temporaryIgnoreFile, `${extraIgnoreRules.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
    try {
      const { stdout } = await execFileAsync(await rgPath(), [...args, '--ignore-file', temporaryIgnoreFile], {
        cwd: root, windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', signal,
      });
      const candidates = (stdout as Buffer).toString('utf8').split('\0').filter(Boolean)
        .filter((file) => !!languageOf(file) && !isSecretFile(file) && !isProductIgnoredPath(file, reparseDirs));
      const safeDirCache = new Set<string>();
      const files: string[] = [];
      for (const file of candidates) {
        if (await isSafeWorkspaceEntry(root, file, safeDirCache)) files.push(file);
        if (files.length > MAX_SOURCE_FILES) throw new Error(`Indexation interrompue : plus de ${MAX_SOURCE_FILES} fichiers source dépassent la limite sûre.`);
      }
      return files.sort((a, b) => a.localeCompare(b));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 1 || code === '1') return [];
      throw new Error(`Parcours ripgrep impossible : ${(error as Error).message}`);
    }
  } finally {
    await fs.rm(temporaryIgnoreDirectory, { recursive: true, force: true });
  }
}

function emptyIndex(workspace: string): PersistedIndex {
  return { schemaVersion: INDEX_SCHEMA, workspace, parserVersion: PARSER_VERSION, updatedAt: new Date(0).toISOString(), files: {} };
}

async function readIndex(file: string, workspace: string): Promise<PersistedIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as PersistedIndex;
    if (parsed.schemaVersion !== INDEX_SCHEMA || parsed.workspace !== workspace || !parsed.files || typeof parsed.files !== 'object') {
      throw new Error('Le fichier d’index persistant a un schéma ou un workspace invalide.');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex(workspace);
    throw error;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Persistent, per-workspace source index; its only writes are under dataDirectory. */
export class ProjectCodeIndexStore {
  readonly workspaceRoot: string;
  readonly indexPath: string;

  private constructor(workspaceRoot: string, indexPath: string) {
    this.workspaceRoot = workspaceRoot;
    this.indexPath = indexPath;
  }

  static async open(workspaceRoot: string, dataDirectory = appDataDirectory()): Promise<ProjectCodeIndexStore> {
    const root = await fs.realpath(workspaceRoot);
    const id = sha256(canonical(root)).slice(0, 32);
    return new ProjectCodeIndexStore(root, path.join(dataDirectory, `${id}.json`));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = storeLocks.get(this.indexPath) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => lock);
    storeLocks.set(this.indexPath, queued);
    await previous;
    try { return await operation(); }
    finally { release(); if (storeLocks.get(this.indexPath) === queued) storeLocks.delete(this.indexPath); }
  }

  async snapshot(): Promise<PersistedIndex> {
    return readIndex(this.indexPath, canonical(this.workspaceRoot));
  }

  async resolveImpactTarget(targetPath: string): Promise<string> {
    const absolute = path.resolve(this.workspaceRoot, targetPath);
    const root = canonical(this.workspaceRoot);
    if (!isInside(root, canonical(absolute))) throw new Error('Le chemin d’impact doit rester dans le workspace.');
    const physical = await fs.realpath(absolute);
    if (!isInside(root, canonical(physical))) throw new Error('Le chemin d’impact résout hors du workspace.');
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Le chemin d’impact doit désigner un fichier régulier du workspace.');
    const relative = relativePath(path.relative(this.workspaceRoot, absolute));
    if (!languageOf(relative)) throw new Error('Extension non indexable pour "' + relative + '".');
    return relative;
  }

  async update(signal?: AbortSignal): Promise<UpdateSummary> {
    return this.exclusive(async () => {
      const workspace = canonical(this.workspaceRoot);
      const index = await readIndex(this.indexPath, workspace);
      const paths = await listSourceFiles(this.workspaceRoot, signal);
      const seen = new Set<string>();
      let parsed = 0;
      let unchanged = 0;
      let errors = 0;
      const now = new Date().toISOString();
      for (const relFs of paths) {
        if (signal?.aborted) throw new Error('Indexation annulée.');
        const abs = path.resolve(this.workspaceRoot, relFs);
        const rel = relativePath(path.relative(this.workspaceRoot, abs));
        if (!isInside(workspace, canonical(abs))) continue;
        try { if (!isInside(workspace, canonical(await fs.realpath(abs)))) continue; }
        catch { continue; }
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try { stat = await fs.lstat(abs); } catch { continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        seen.add(rel);
        if (stat.size > MAX_SOURCE_BYTES) {
          index.files[rel] = { path: rel, language: languageOf(rel)!, sha256: '', bytes: stat.size, mtimeMs: stat.mtimeMs, parserVersion: PARSER_VERSION, status: 'error', error: `Fichier supérieur à la limite de ${MAX_SOURCE_BYTES} octets.`, symbols: [], imports: [], indexedAt: index.files[rel]?.indexedAt ?? now, checkedAt: now };
          errors++;
          continue;
        }
        let bytes: Buffer;
        try { bytes = await fs.readFile(abs); } catch (error) {
          index.files[rel] = { path: rel, language: languageOf(rel)!, sha256: '', bytes: stat.size, mtimeMs: stat.mtimeMs, parserVersion: PARSER_VERSION, status: 'error', error: (error as Error).message, symbols: [], imports: [], indexedAt: index.files[rel]?.indexedAt ?? now, checkedAt: now };
          errors++;
          continue;
        }
        const digest = sha256(bytes);
        const previous = index.files[rel];
        if (previous?.sha256 === digest && previous.parserVersion === PARSER_VERSION && previous.status === 'indexed') {
          previous.bytes = bytes.byteLength;
          previous.mtimeMs = stat.mtimeMs;
          previous.checkedAt = now;
          unchanged++;
          continue;
        }
        parsed++;
        const language = languageOf(rel)!;
        try {
          const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          const symbols = outlineSource(source, language);
          const candidates = parseImports(source, language);
          index.files[rel] = {
            path: rel, language, sha256: digest, bytes: bytes.byteLength, mtimeMs: stat.mtimeMs,
            parserVersion: PARSER_VERSION, status: 'indexed', symbols,
            imports: candidates.map(({ specifier, line, relative, kind }) => ({ specifier, line, relative, kind })),
            indexedAt: now, checkedAt: now,
          };
        } catch (error) {
          index.files[rel] = { path: rel, language, sha256: digest, bytes: bytes.byteLength, mtimeMs: stat.mtimeMs, parserVersion: PARSER_VERSION, status: 'error', error: (error as Error).message, symbols: [], imports: [], indexedAt: now, checkedAt: now };
          errors++;
        }
      }
      const before = Object.keys(index.files).length;
      for (const rel of Object.keys(index.files)) if (!seen.has(rel)) delete index.files[rel];
      const removed = before - Object.keys(index.files).length;

      // Resolve internal edges after scanning so import ordering cannot hide a target.
      const available = new Map(Object.keys(index.files).map((item) => [pathKey(item), item]));
      for (const entry of Object.values(index.files)) {
        for (const item of entry.imports) {
          if (!item.relative && entry.language !== 'python' && entry.language !== 'c' && entry.language !== 'cpp') { delete item.target; continue; }
          if (item.target && available.has(pathKey(item.target))) { item.target = available.get(pathKey(item.target)); continue; }
          const target = candidatesForImport(entry.path, item.specifier, entry.language, item.kind).map((candidate) => available.get(pathKey(candidate))).find((candidate) => !!candidate);
          if (target) item.target = target;
          else delete item.target;
        }
      }
      index.parserVersion = PARSER_VERSION;
      index.updatedAt = now;
      await atomicWrite(this.indexPath, JSON.stringify(index));
      return { scanned: paths.length, parsed, unchanged, removed, errors, updatedAt: now };
    });
  }

  async search(query: string, limit = 30, signal?: AbortSignal): Promise<{
    query: string;
    matches: Array<{ path: string; language: string; sha256: string; symbols: OutlineSymbol[]; imports: StoredImport[]; indexedAt: string }>;
    contentMatches: ProjectCodeContentMatch[];
    contentSearchTruncated: boolean;
    indexedAt: string;
    update: UpdateSummary;
  }> {
    const needle = query.trim().toLowerCase();
    if (!needle) throw new Error('La recherche exige une chaîne non vide.');
    if (query.length > MAX_CONTENT_QUERY_CHARS) throw new Error(`La recherche de contenu est limitée à ${MAX_CONTENT_QUERY_CHARS} caractères.`);
    if (/[\0\r\n]/.test(query)) throw new Error('La recherche de contenu doit tenir sur une seule ligne et ne peut pas contenir NUL.');

    // Search always refreshes the metadata index first, including when called
    // directly through the store instead of through the HTTP tool endpoint.
    const update = await this.update(signal);
    const index = await this.snapshot();
    const indexedFiles = Object.entries(index.files)
      .filter(([, entry]) => entry.status === 'indexed')
      .map(([key, entry]) => {
        if (key.replace(/\\/g, '/') !== entry.path.replace(/\\/g, '/')) {
          throw new Error(`L’index persistant associe une clé incohérente au fichier ${JSON.stringify(entry.path)}.`);
        }
        return entry;
      });
    const boundedLimit = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 30));
    const contentResult = await ripgrepIndexedContent(this.workspaceRoot, indexedFiles, query, boundedLimit, signal);
    const verifiedBytes = new Map<string, { bytes: Buffer; source: string }>();
    const contentMatches: ProjectCodeContentMatch[] = [];
    const queryBytes = Buffer.from(query, 'utf8');
    for (const raw of contentResult.matches) {
      let sourceSnapshot = verifiedBytes.get(raw.path);
      if (!sourceSnapshot) {
        if (!(await isSafeWorkspaceEntry(this.workspaceRoot, raw.path))) {
          throw new Error(`Le fichier ${raw.path} est devenu indisponible ou non sûr pendant la recherche; relance l’actualisation.`);
        }
        const absolute = path.resolve(this.workspaceRoot, raw.path);
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SOURCE_BYTES) {
          throw new Error(`Le fichier ${raw.path} ne respecte plus les limites de l’index pendant la recherche.`);
        }
        const bytes = await fs.readFile(absolute);
        const digest = sha256(bytes);
        if (digest !== raw.indexed.sha256) {
          throw new Error(`Le fichier ${raw.path} a changé pendant la recherche; aucun extrait potentiellement périmé ne sera retourné. Relance l’actualisation.`);
        }
        let source: string;
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error(`Le fichier ${raw.path} n’est plus du texte UTF-8 indexable.`); }
        sourceSnapshot = { bytes, source };
        verifiedBytes.set(raw.path, sourceSnapshot);
      }

      const actualLine = sourceSnapshot.source.split('\n')[raw.line - 1];
      if (actualLine === undefined) throw new Error(`La ligne ${raw.line} de ${raw.path} n’existe plus; relance l’actualisation.`);
      const line = actualLine.endsWith('\r') ? actualLine.slice(0, -1) : actualLine;
      const lineBytes = Buffer.from(line, 'utf8');
      const byteEnd = raw.byteColumn + queryBytes.byteLength;
      if (byteEnd > lineBytes.byteLength || !lineBytes.subarray(raw.byteColumn, byteEnd).equals(queryBytes)) {
        throw new Error(`La correspondance ${raw.path}:${raw.line} ne correspond plus aux octets lus; relance l’actualisation.`);
      }
      const matchStart = lineBytes.subarray(0, raw.byteColumn).toString('utf8').length;
      contentMatches.push({
        path: raw.path,
        line: raw.line,
        column: matchStart + 1,
        excerpt: excerptAround(line, matchStart, query.length),
        sha256: raw.indexed.sha256,
        bytes: sourceSnapshot.bytes.byteLength,
        indexedAt: raw.indexed.indexedAt,
      });
    }

    const matches = Object.values(index.files).filter((entry) => entry.status === 'indexed' && (
      entry.path.toLowerCase().includes(needle) || entry.symbols.some((s) => `${s.name} ${signatureForSearch(s, entry.language)}`.toLowerCase().includes(needle))
    )).sort((a, b) => {
      const aPath = a.path.toLowerCase().includes(needle);
      const bPath = b.path.toLowerCase().includes(needle);
      if (aPath !== bPath) return aPath ? -1 : 1;
      return a.path.localeCompare(b.path);
    }).slice(0, boundedLimit)
      .map((entry) => {
        const matching = entry.symbols.filter((s) => `${s.name} ${signatureForSearch(s, entry.language)}`.toLowerCase().includes(needle));
        const nonMatching = entry.symbols.filter((s) => !matching.includes(s));
        return {
          path: entry.path,
          language: entry.language,
          sha256: entry.sha256,
          symbols: [...matching, ...nonMatching],
          imports: entry.imports,
          indexedAt: entry.indexedAt,
        };
      });
    return { query, matches, contentMatches, contentSearchTruncated: contentResult.truncated, indexedAt: index.updatedAt, update };
  }

  async impact(targetPath: string, limit = 100): Promise<{ target: string; direct: string[]; transitive: string[]; indexedAt: string }> {
    const index = await this.snapshot();
    const target = await this.resolveImpactTarget(targetPath);
    if (!index.files[target]) throw new Error(`Fichier absent de l’index : ${target}. Lance action=update et vérifie que le fichier est un source pris en charge.`);
    const reverse = new Map<string, Set<string>>();
    for (const entry of Object.values(index.files)) {
      if (entry.status !== 'indexed') continue;
      for (const item of entry.imports) if (item.target) {
        const parents = reverse.get(item.target) ?? new Set<string>();
        parents.add(entry.path);
        reverse.set(item.target, parents);
      }
    }
    const maxResults = Math.max(1, Math.min(500, limit));
    const allDirect = [...(reverse.get(target) ?? [])].sort();
    const direct = allDirect.slice(0, maxResults);
    const seen = new Set<string>([target, ...allDirect]);
    const queue = [...allDirect];
    const transitiveList: string[] = [];
    for (let i = 0; i < queue.length && transitiveList.length < maxResults; i++) {
      const current = queue[i];
      for (const parent of reverse.get(current) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
          transitiveList.push(parent);
          if (transitiveList.length >= maxResults) break;
        }
      }
    }
    const transitive = transitiveList.sort();
    return { target, direct, transitive, indexedAt: index.updatedAt };
  }
}

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const SYMBOL_BODY_KINDS = new Set([
  'function_declaration', 'method_definition', 'variable_declarator', 'function_definition', 'function_item',
  'class_declaration', 'class_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'type_definition',
  'namespace_definition', 'impl_item',
]);

function signatureForSearch(symbol: OutlineSymbol, language: string): string {
  if (language === 'python' && ['function_definition', 'class_definition'].includes(symbol.kind)) {
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote: string | undefined;
    let escaped = false;
    for (let index = 0; index < symbol.signature.length; index++) {
      const char = symbol.signature[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = undefined;
        continue;
      }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') parenDepth++;
      else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (char === '[') bracketDepth++;
      else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (char === ':' && parenDepth === 0 && bracketDepth === 0) return symbol.signature.slice(0, index).trimEnd();
    }
  }
  if (!SYMBOL_BODY_KINDS.has(symbol.kind)) return symbol.signature;
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lastTopLevelBody = -1;
  let lastTopLevelArrow = -1;
  for (let index = 0; index < symbol.signature.length; index++) {
    const char = symbol.signature[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '=' && symbol.signature[index + 1] === '>' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      lastTopLevelArrow = index;
      index++;
      continue;
    }
    if (char === '(') parenDepth++;
    else if (char === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (char === '[') bracketDepth++;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '<' && braceDepth === 0) angleDepth++;
    else if (char === '>' && braceDepth === 0) angleDepth = Math.max(0, angleDepth - 1);
    else if (char === '{' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      lastTopLevelBody = index;
      braceDepth++;
    } else if (char === '{') braceDepth++;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
  }
  if (lastTopLevelBody >= 0) return symbol.signature.slice(0, lastTopLevelBody).trimEnd();
  if (symbol.kind === 'variable_declarator' && lastTopLevelArrow >= 0) return symbol.signature.slice(0, lastTopLevelArrow + 2).trimEnd();
  return symbol.signature;
}

export class ProjectCodeIndexTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code.index',
    description: 'Construit et interroge un index persistant des symboles et dépendances du workspace. action=search recherche les chemins, symboles et le contenu littéral réel des sources, puis retourne des extraits avec lignes et SHA-256; les actions search/impact actualisent d’abord l’index depuis les fichiers réels.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['update', 'search', 'impact', 'status'], description: 'Actualiser, chercher un symbole, calculer les dépendances inverses ou consulter l’index' },
        query: { type: 'string', description: 'Texte littéral ou nom de fichier/symbole/signature pour action=search (une seule ligne, 512 caractères maximum)' },
        path: { type: 'string', description: 'Fichier source du workspace pour action=impact' },
        limit: { type: 'integer', description: 'Nombre maximal de résultats (défaut 30)' },
      },
      required: ['action'],
    },
    requiresPermission: false,
  };

  constructor(private readonly storeFactory = ProjectCodeIndexStore.open) {}

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const action = params.action;
      const limit = typeof params.limit === 'number' ? params.limit : 30;
      if (action === 'search' && (typeof params.query !== 'string' || !params.query.trim())) throw new Error('query non vide est requis pour action=search.');
      if (action === 'impact' && (typeof params.path !== 'string' || !params.path.trim())) throw new Error('path est requis pour action=impact.');
      if (!['update', 'status', 'search', 'impact'].includes(String(action))) throw new Error('Action code.index inconnue : ' + String(action) + '.');
      const store = await this.storeFactory(context.workspaceRoot);
      if (action === 'update') {
        const update = await store.update(context.signal);
        return { success: update.errors === 0, output: update, ...(update.errors ? { error: 'Indexation partielle : ' + update.errors + ' fichier(s) en erreur. Utilise action=status pour consulter les chemins et causes.' } : {}), durationMs: Date.now() - start };
      }
      if (action === 'status') {
        const index = await store.snapshot();
        const files = Object.values(index.files);
        const errorFiles = files.filter((f) => f.status === 'error').map(({ path: filePath, error }) => ({ path: filePath, error }));
        return { success: errorFiles.length === 0, output: { workspace: index.workspace, indexPath: store.indexPath, updatedAt: index.updatedAt, indexedFiles: files.filter((f) => f.status === 'indexed').length, errorFiles, symbols: files.reduce((sum, f) => sum + f.symbols.length, 0), schemaVersion: index.schemaVersion, parserVersion: index.parserVersion }, ...(errorFiles.length ? { error: 'L’index contient ' + errorFiles.length + ' fichier(s) en erreur; leurs chemins et causes sont dans output.errorFiles.' } : {}), durationMs: Date.now() - start };
      }
      if (action === 'search') {
        const result = await store.search(params.query as string, limit, context.signal);
        return { success: result.update.errors === 0, output: result, ...(result.update.errors ? { error: 'Résultats partiels : ' + result.update.errors + ' fichier(s) n’ont pas été indexés; consulte action=status.' } : {}), durationMs: Date.now() - start };
      }
      if (action === 'impact') {
        const target = await store.resolveImpactTarget(params.path as string);
        const update = await store.update(context.signal);
        const result = await store.impact(target, limit);
        return { success: update.errors === 0, output: { ...result, update }, ...(update.errors ? { error: 'Impact partiel : ' + update.errors + ' fichier(s) n’ont pas été indexés; consulte action=status.' } : {}), durationMs: Date.now() - start };
      }
      throw new Error('Action code.index inconnue : ' + String(action) + '.');
    } catch (error) {
      return { success: false, output: null, error: (error as Error).message, durationMs: Date.now() - start };
    }
  }
}
