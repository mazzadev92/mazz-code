import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { resolveSafePath } from './fs.js';
import { assertEditable, recordSeen, writeAtomic } from './edit-guard.js';
import { syntaxGate } from './syntax-gate.js';
import { isSecretFile } from './default-deny.js';

/**
 * Code intelligence tools for small local models: instead of reading whole files
 * or the whole repository, the agent searches (ripgrep), looks at the structure
 * (ast-grep / Tree-sitter) and edits precise blocks (fs.patch).
 */

const require = createRequire(import.meta.url);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'out', 'bin', 'obj']);

// ---------------------------------------------------------------- ripgrep

function ripgrepPath(): string | undefined {
  try {
    const p = (require('@vscode/ripgrep') as { rgPath: string }).rgPath;
    if (existsSync(p)) return p;
  } catch {
    // package absent: PATH lookup below
  }
  return undefined;
}

/** Line search used when ripgrep is missing: `file:line:text`, case-insensitive for lowercase queries. */
export async function fallbackSearch(cwd: string, target: string, query: string, regex: boolean, max: number): Promise<string[]> {
  const flags = query === query.toLowerCase() ? 'i' : '';
  const re = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const out: string[] = [];
  const visit = async (rel: string, top = false) => {
    if (out.length >= max) return;
    const abs = path.join(cwd, rel);
    // Below the searched target, links are skipped as ripgrep does without --follow: notes.txt -> .env is never read.
    const st = await (top ? fs.stat(abs) : fs.lstat(abs)).catch(() => undefined); // best effort: probe: absent or unreadable path is treated as missing
    if (!st || st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const e of await fs.readdir(abs).catch(() => [] as string[])) {
        if (!e.startsWith('.') && !IGNORED_DIRS.has(e)) await visit(rel === '.' ? e : `${rel}/${e}`);
      }
      return;
    }
    if (st.size > 2 * 1024 * 1024 || isSecretFile(rel)) return;
    const real = await fs.realpath(abs).catch(() => undefined); // best effort: probe: absent or unreadable path is treated as missing
    if (!real || isSecretFile(real)) return;
    const text = await fs.readFile(abs, 'utf-8').catch(() => '');
    if (text.includes('\u0000')) return;
    text.split(/\r?\n/).forEach((line, i) => { if (out.length < max && re.test(line)) out.push(`${rel}:${i + 1}:${line.slice(0, 240)}`); });
  };
  await visit(target, true);
  return out;
}

export class CodeSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code.search',
    description: 'Recherche rapide (ripgrep) d’un texte ou d’une expression régulière dans les fichiers du projet. Renvoie fichier:ligne:texte.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texte recherché' },
        regex: { type: 'boolean', description: 'Interpréter la requête comme une expression régulière' },
        glob: { type: 'string', description: 'Filtre de fichiers, ex. "*.c" ou "src/**"' },
        path: { type: 'string', description: 'Dossier où chercher (défaut : le projet)' },
        maxResults: { type: 'number', description: 'Nombre maximum de lignes (défaut 60)' },
      },
      required: ['query'],
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    const query = String(params.query ?? '');
    const max = Math.min(typeof params.maxResults === 'number' ? params.maxResults : 60, 300);
    const rg = ripgrepPath() ?? 'rg';
    const args = ['--with-filename', '--line-number', '--no-heading', '--color', 'never', '--max-columns', '240', '--max-columns-preview', '--max-count', '20', '--smart-case', '--max-filesize', '2M'];
    if (!params.regex) args.push('--fixed-strings');
    if (typeof params.glob === 'string' && params.glob.trim()) args.push('--glob', params.glob.trim());
    for (const d of IGNORED_DIRS) args.push('--glob', `!${d}/`);
    // Secret files are excluded at the source as well as filtered line by line below.
    for (const g of ['!.env', '!.env.*', '!*.key', '!*.pem']) args.push('--glob', g);
    let cwd = context.workspaceRoot;
    // A file given as "path" is searched itself (small models often pass the file they want to look into).
    let target = '.';
    let prefix = '';
    try {
      if (typeof params.path === 'string' && params.path.trim()) {
        const resolved = resolveSafePath(context.workspaceRoot, params.path, context.allowedRoots);
        const st = await fs.stat(resolved).catch(() => undefined); // best effort: probe: absent or unreadable path is treated as missing
        if (!st) throw new Error(`Chemin "${params.path}" introuvable dans le projet.`);
        if (st.isFile()) {
          cwd = path.dirname(resolved);
          target = path.basename(resolved);
          prefix = `${path.relative(context.workspaceRoot, cwd).replace(/\\/g, '/')}/`.replace(/^\/$/, '');
        } else {
          cwd = resolved;
          // Paths stay relative to the project, so the model can read them back as-is.
          prefix = `${path.relative(context.workspaceRoot, cwd).replace(/\\/g, '/')}/`.replace(/^\/$/, '');
        }
      }
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
    args.push('--', query, target);
    return await new Promise((resolve) => {
      execFile(rg, args, { cwd, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, async (err, stdout) => {
        const code = (err as { code?: number | string } | null)?.code;
        if (err && code === 'ENOENT') {
          // No ripgrep on this machine: plain line search in Node, same output shape.
          const matches = await fallbackSearch(cwd, target, query, params.regex === true, max).catch(() => []); // best effort: optional result, caller handles the fallback
          resolve({ success: true, output: { query, count: matches.length, truncated: matches.length >= max, totalLines: matches.length, matches: matches.map((m) => prefix + m), engine: 'node' }, durationMs: Date.now() - start });
          return;
        }
        if (err && code !== 1) {
          resolve({ success: false, output: null, error: `ripgrep : ${err.message}`, durationMs: Date.now() - start });
          return;
        }
        // Secret files (.env, keys) never reach the model, even as a matching line.
        const lines = stdout.split(/\r?\n/).filter((l) => l && !isSecretFile(target === '.' ? l.match(/^(.+?):\d+:/)?.[1] ?? '' : target));
        // A single searched file is printed by ripgrep without its name: put the path back.
        const matches = lines.slice(0, max).map((l) => prefix + (target === '.' ? l.replace(/^\.[\\/]/, '') : `${target}:${l}`).replace(/\\/g, '/'));
        resolve({
          success: true,
          output: { query, count: matches.length, truncated: lines.length > max, totalLines: lines.length, matches, engine: 'ripgrep' },
          durationMs: Date.now() - start,
        });
      });
    });
  }
}

// ---------------------------------------------------------------- ast-grep outline

type AstNode = {
  kind(): string;
  text(): string;
  field(name: string): AstNode | null;
  find(rule: unknown): AstNode | null;
  findAll(rule: unknown): AstNode[];
  range(): { start: { line: number } };
  parent(): AstNode | null;
};
type AstApi = { parse(lang: string, src: string): { root(): AstNode }; registerDynamicLanguage(m: Record<string, unknown>): void; Lang: Record<string, string> };

let ast: AstApi | null | undefined;

function loadAst(): AstApi | null {
  if (ast !== undefined) return ast;
  try {
    const api = require('@ast-grep/napi') as AstApi;
    const dyn: Record<string, unknown> = {};
    for (const [name, pkg] of [
      ['c', '@ast-grep/lang-c'],
      ['cpp', '@ast-grep/lang-cpp'],
      ['python', '@ast-grep/lang-python'],
      ['rust', '@ast-grep/lang-rust'],
    ]) {
      try {
        const m = require(pkg);
        dyn[name] = m.default ?? m;
      } catch {
        // grammar package missing: that language is simply not supported
      }
    }
    api.registerDynamicLanguage(dyn);
    ast = api;
  } catch {
    ast = null;
  }
  return ast;
}

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.tsx': 'Tsx',
  '.js': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.jsx': 'Tsx',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.py': 'python',
  '.rs': 'rust',
};

const KINDS: Record<string, string[]> = {
  TypeScript: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'variable_declarator'],
  Tsx: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration', 'type_alias_declaration', 'variable_declarator'],
  JavaScript: ['function_declaration', 'class_declaration', 'method_definition', 'variable_declarator'],
  c: ['function_definition', 'struct_specifier', 'enum_specifier', 'type_definition'],
  cpp: ['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier', 'namespace_definition'],
  python: ['function_definition', 'class_definition'],
  rust: ['function_item', 'struct_item', 'enum_item', 'trait_item', 'impl_item', 'mod_item'],
};

export interface OutlineSymbol {
  kind: string;
  name: string;
  line: number;
  signature: string;
  parent?: string;
}

function symbolName(n: AstNode): string | undefined {
  // Rust `impl Type` is named by its type; elsewhere `type` is a return type.
  const direct = n.field('name') ?? (n.kind() === 'impl_item' ? n.field('type') : null);
  if (direct) return direct.text();
  // C/C++ functions: the name sits inside the declarator chain.
  // Walk the declarator chain (pointer -> function -> identifier), same in C and C++.
  let d = n.field('declarator');
  for (let i = 0; d && i < 8; i++) {
    const k = d.kind();
    if (k.endsWith('identifier') || k === 'destructor_name' || k === 'operator_name') return d.text();
    d = d.field('declarator') ?? d.field('name');
  }
  return undefined;
}

const CONTAINER_KINDS = new Set(['class_declaration', 'class_definition', 'class_specifier', 'impl_item', 'trait_item', 'namespace_definition']);

export function outlineSource(src: string, lang: string): OutlineSymbol[] {
  const api = loadAst();
  if (!api) throw new Error('ast-grep indisponible.');
  const root = api.parse(api.Lang[lang] ?? lang, src).root();
  const out: OutlineSymbol[] = [];
  for (const n of root.findAll({ rule: { any: KINDS[lang].map((k) => ({ kind: k })) } })) {
    const kind = n.kind();
    // Only arrow functions / function expressions count among variable declarators.
    if (kind === 'variable_declarator') {
      const v = n.field('value')?.kind();
      if (v !== 'arrow_function' && v !== 'function_expression' && v !== 'function') continue;
    }
    // Struct/enum references without a body are uses, not definitions.
    if ((kind === 'struct_specifier' || kind === 'enum_specifier' || kind === 'class_specifier') && !n.field('body')) continue;
    const name = symbolName(n);
    if (!name) continue;
    let parent: string | undefined;
    for (let p = n.parent(); p; p = p.parent()) {
      if (CONTAINER_KINDS.has(p.kind())) {
        parent = symbolName(p);
        break;
      }
    }
    const first = n.text().split('\n')[0].trim();
    out.push({ kind, name: name.slice(0, 120), line: n.range().start.line + 1, signature: first.length > 140 ? `${first.slice(0, 137)}...` : first, parent });
  }
  return out.sort((a, b) => a.line - b.line);
}

export function languageOf(file: string): string | undefined {
  return EXT_LANG[path.extname(file).toLowerCase()];
}

export class CodeOutlineTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code.outline',
    description: 'Plan d’un fichier source (fonctions, classes, structures avec numéros de ligne) sans lire tout le fichier. C, C++, Python, Rust, TypeScript, JavaScript.',
    category: 'analysis',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Chemin relatif du fichier' } }, required: ['path'] },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const rel = String(params.path);
      const lang = languageOf(rel);
      if (!lang) throw new Error(`Langage non pris en charge pour "${rel}". Extensions : ${Object.keys(EXT_LANG).join(' ')}.`);
      const abs = resolveSafePath(context.workspaceRoot, rel, context.allowedRoots);
      const src = await fs.readFile(abs, 'utf-8');
      const symbols = outlineSource(src, lang);
      return { success: true, output: { path: rel, language: lang, lines: src.split('\n').length, symbols }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}

// ---------------------------------------------------------------- repository map

// Names too common to say anything about which file a reference points to.
const GENERIC_NAMES = new Set(['main', 'init', 'run', 'get', 'set', 'test', 'setup', 'new', 'self', 'this', 'value', 'data', 'name', 'type']);

function identifierCounts(src: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of src.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return counts;
}

/**
 * File importance from the reference graph (as in Aider's repo map): file A points to file B when A uses a
 * symbol B defines. PageRank (damping 0.85) is personalized toward the files matching the focus terms, so
 * the map keeps what the task touches plus what that code depends on.
 */
export function rankByReferences(entries: ReadonlyArray<{ rel: string; score: number; names: string[]; idents: Map<string, number> }>): Map<string, number> {
  const n = entries.length;
  const rank = new Map<string, number>();
  if (!n) return rank;
  const definers = new Map<string, number[]>();
  entries.forEach((e, i) => {
    for (const name of new Set(e.names)) {
      if (name.length < 3 || GENERIC_NAMES.has(name.toLowerCase())) continue;
      const list = definers.get(name) ?? [];
      list.push(i);
      definers.set(name, list);
    }
  });
  // Weighted edges from user to definer; a name defined in many files spreads its weight thin.
  const out: Array<Map<number, number>> = entries.map(() => new Map());
  entries.forEach((e, i) => {
    for (const [ident, count] of e.idents) {
      const defs = definers.get(ident);
      if (!defs) continue;
      for (const j of defs) if (j !== i) out[i].set(j, (out[i].get(j) ?? 0) + Math.sqrt(count) / defs.length);
    }
  });
  const focusTotal = entries.reduce((a, e) => a + e.score, 0);
  const teleport = entries.map((e) => (focusTotal > 0 ? e.score / focusTotal : 1 / n));
  let pr = entries.map(() => 1 / n);
  for (let iter = 0; iter < 30; iter++) {
    const next = teleport.map((t) => 0.15 * t);
    let dangling = 0;
    out.forEach((edges, i) => {
      const total = [...edges.values()].reduce((a, w) => a + w, 0);
      if (!total) { dangling += pr[i]; return; }
      for (const [j, w] of edges) next[j] += 0.85 * pr[i] * (w / total);
    });
    // Files that reference nothing hand their weight back along the focus.
    for (let i = 0; i < n; i++) next[i] += 0.85 * dangling * teleport[i];
    pr = next;
  }
  entries.forEach((e, i) => rank.set(e.rel, pr[i]));
  return rank;
}

export async function buildRepoMap(root: string, opts: { maxChars?: number; focus?: string; maxFiles?: number } = {}): Promise<{ text: string; files: number; symbols: number; truncated: boolean }> {
  const maxChars = opts.maxChars ?? 6000;
  const maxFiles = opts.maxFiles ?? 400;
  const files: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8 || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (languageOf(e.name)) files.push(full);
    }
  };
  await walk(path.resolve(root), 0);

  const terms = (opts.focus ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 2);
  const entries: Array<{ rel: string; lines: string[]; score: number; names: string[]; idents: Map<string, number> }> = [];
  let symbolCount = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      if (st.size > 300 * 1024) continue;
      const src = await fs.readFile(f, 'utf-8');
      const syms = outlineSource(src, languageOf(f)!);
      symbolCount += syms.length;
      const rel = path.relative(root, f).replace(/\\/g, '/');
      const lines = syms.slice(0, 40).map((s) => `  ${s.line}: ${s.parent ? `${s.parent}.` : ''}${s.signature}`);
      const hay = `${rel} ${syms.map((s) => s.name).join(' ')}`.toLowerCase();
      const score = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
      entries.push({ rel, lines, score, names: syms.map((s) => s.name), idents: identifierCounts(src) });
    } catch {
      // unreadable or unparsable file: skipped
    }
  }
  const rank = rankByReferences(entries);
  entries.sort((a, b) => (rank.get(b.rel) ?? 0) - (rank.get(a.rel) ?? 0) || b.score - a.score || a.rel.localeCompare(b.rel));
  let text = '';
  let truncated = false;
  for (const e of entries) {
    const block = `${e.rel}\n${e.lines.join('\n')}\n`;
    if (text.length + block.length > maxChars) {
      truncated = true;
      if (text.length + e.rel.length + 1 < maxChars) text += `${e.rel}\n`;
      continue;
    }
    text += block;
  }
  return { text: text.trimEnd(), files: entries.length, symbols: symbolCount, truncated };
}

export class CodeMapTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'code.map',
    description: 'Carte compacte du dépôt : fichiers source et leurs symboles principaux, classés selon le sujet. À utiliser en premier pour comprendre un projet.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        focus: { type: 'string', description: 'Sujet de la tâche pour classer les fichiers pertinents en premier' },
        maxChars: { type: 'number', description: 'Taille maximale (défaut 6000 caractères)' },
      },
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const map = await buildRepoMap(context.workspaceRoot, {
        focus: typeof params.focus === 'string' ? params.focus : undefined,
        maxChars: typeof params.maxChars === 'number' ? Math.min(params.maxChars, 20000) : 6000,
      });
      return { success: true, output: map, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}

// ---------------------------------------------------------------- block edits

export interface PatchEdit {
  search: string;
  replace: string;
}

/** Normalize only for comparison while retaining source offsets for safe edits. */
function normalizePatchSource(source: string): { text: string; boundaries: number[] } {
  let text = '';
  const boundaries = [0];
  let lineStart = 0;

  while (lineStart < source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const kept = source.slice(lineStart, lineEnd).trimEnd();
    text += kept;
    for (let offset = 1; offset <= kept.length; offset++) boundaries.push(lineStart + offset);

    if (newline === -1) break;
    text += '\n';
    boundaries.push(newline + 1);
    lineStart = newline + 1;
  }

  return { text, boundaries };
}

function normalizePatchSearch(search: string): string {
  return search.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
}

/**
 * Applies search/replace blocks. Each search must match exactly once (unless
 * replaceAll); a failed match falls back to a match ignoring line endings and
 * trailing spaces. Errors explain what was not found so the model can retry.
 * Replaying a block already applied is a no-op (spec G13): an insertion (replacement containing its
 * search) is recognised from the file alone; a replacement only when `history` saw it applied, since a
 * missing search next to a replacement found elsewhere is otherwise a hallucinated block, not a replay.
 * `history` receives the key of every block this call applies.
 */
export function applyEdits(content: string, edits: PatchEdit[], replaceAll = false, history: Set<string> = new Set()): { content: string; applied: number; alreadyApplied: number } {
  let out = content;
  let alreadyApplied = 0;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  for (const [i, e] of edits.entries()) {
    if (typeof e?.search !== 'string' || typeof e?.replace !== 'string') throw new Error(`Bloc ${i + 1} : "search" et "replace" doivent être des chaînes.`);
    if (!e.search) throw new Error(`Bloc ${i + 1} : "search" est vide. Pour créer un fichier, utilise fs.write.`);
    let search = e.search;
    let replace = e.replace;
    const key = `${search.length}:${search}\u0000${replace}`;
    if (replace && replace !== search && out.includes(replace) && (replace.includes(search) || (!out.includes(search) && history.has(key)))) {
      alreadyApplied++;
      continue;
    }
    history.add(key);
    let count = out.split(search).length - 1;
    if (count === 0) {
      // Tolerate \n vs \r\n and trailing spaces without normalizing the whole file.
      const normalizedOut = normalizePatchSource(out);
      const normalizedSearch = normalizePatchSearch(search);
      const matches: number[] = [];
      if (normalizedSearch) {
        let at = normalizedOut.text.indexOf(normalizedSearch);
        while (at !== -1) {
          matches.push(at);
          at = normalizedOut.text.indexOf(normalizedSearch, at + normalizedSearch.length);
        }
      }
      if (matches.length > 0) {
        if (matches.length > 1 && !replaceAll) {
          throw new Error(`Bloc ${i + 1} trouvé ${matches.length} fois après normalisation : ajoute des lignes de contexte pour le rendre unique, ou replaceAll=true.`);
        }
        replace = replace.replace(/\r\n/g, '\n').replace(/\n/g, eol);
        let patched = '';
        let cursor = 0;
        for (const match of matches) {
          const start = normalizedOut.boundaries[match];
          const end = normalizedOut.boundaries[match + normalizedSearch.length];
          if (start === undefined || end === undefined || start < cursor || end < start) {
            throw new Error(`Bloc ${i + 1} : correspondance normalisée ambiguë, aucune modification appliquée.`);
          }
          patched += out.slice(cursor, start) + replace;
          cursor = end;
        }
        out = patched + out.slice(cursor);
        continue;
      }
    }
    if (count === 0) {
      const firstLine = e.search.split('\n').find((l) => l.trim())?.trim() ?? '';
      const hint = firstLine && out.includes(firstLine) ? ` La première ligne "${firstLine.slice(0, 60)}" existe : recopie le bloc exact avec fs.read.` : ' Relis le fichier avec fs.read ou code.outline.';
      throw new Error(`Bloc ${i + 1} introuvable dans le fichier.${hint}`);
    }
    if (count > 1 && !replaceAll) throw new Error(`Bloc ${i + 1} trouvé ${count} fois : ajoute des lignes de contexte pour le rendre unique, ou replaceAll=true.`);
    out = replaceAll ? out.split(search).join(replace) : out.replace(search, () => replace);
  }
  return { content: out, applied: edits.length - alreadyApplied, alreadyApplied };
}

/** Blocks applied per file in this process, so a replayed replacement is recognised (spec G13). */
// ponytail: in memory and process-wide; persist it with the session journal if replays must survive a restart.
const appliedEdits = new Map<string, Set<string>>();

export class FsPatchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.patch',
    description: 'Modifie un fichier existant en remplaçant des blocs exacts (search/replace), sans le réécrire entièrement.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif du fichier' },
        edits: {
          type: 'array',
          description: 'Blocs à remplacer, appliqués dans l’ordre',
          items: { type: 'object', properties: { search: { type: 'string' }, replace: { type: 'string' } }, required: ['search', 'replace'] },
        },
        replaceAll: { type: 'boolean', description: 'Remplacer toutes les occurrences' },
      },
      required: ['path', 'edits'],
    },
    requiresPermission: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const rel = String(params.path);
      const abs = resolveSafePath(context.workspaceRoot, rel, context.allowedRoots);
      const edits = params.edits as PatchEdit[];
      if (!Array.isArray(edits) || edits.length === 0) throw new Error('"edits" doit contenir au moins un bloc.');
      await assertEditable(context.taskId, abs, rel);
      let raw: Buffer;
      try {
        raw = await fs.readFile(abs);
      } catch {
        throw new Error(`Fichier "${rel}" introuvable : fs.patch modifie un fichier existant, utilise fs.write pour le créer.`);
      }
      const before = raw.toString('utf-8');
      // Windows-1252/Latin-1 bytes would come back as U+FFFD and be written over the original characters.
      if (!Buffer.from(before, 'utf-8').equals(raw)) throw new Error(`Fichier "${rel}" non UTF-8 (Windows-1252, Latin-1...) : fs.patch le corromprait. Convertis-le en UTF-8 ou demande à l’utilisateur.`);
      const fileKey = path.resolve(abs).toLowerCase();
      const history = new Set(appliedEdits.get(fileKey));
      const { content, applied, alreadyApplied } = applyEdits(before, edits, params.replaceAll === true, history);
      if (content === before) {
        return { success: true, output: { path: rel, blocksApplied: 0, alreadyApplied, note: 'Modification déjà présente : fichier inchangé.' }, durationMs: Date.now() - start };
      }
      const syntaxError = await syntaxGate(abs, content, before);
      if (syntaxError) throw new Error(syntaxError);
      await writeAtomic(abs, content, before);
      appliedEdits.set(fileKey, history);
      await recordSeen(context.taskId, abs);
      context.emitEvent({
        type: 'diff',
        taskId: context.taskId,
        timestamp: Date.now(),
        filePath: rel,
        oldContent: before,
        newContent: content,
        patch: `--- a/${rel}\n+++ b/${rel}`,
      });
      return { success: true, output: { path: rel, blocksApplied: applied, alreadyApplied, bytes: Buffer.byteLength(content) }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}
