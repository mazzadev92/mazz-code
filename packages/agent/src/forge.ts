/**
 * MAZZ Forge — verified project synthesis for small local models.
 *
 * A blueprint (architecture + algorithm card, usually stored in Bib1) fixes the
 * files, signatures and pseudo-code steps. The model writes every function
 * body, one step at a time, under three constraints:
 *   1. a grammar that forbids starting a statement with a comment or directive;
 *   2. per-step checks (required identifiers, real parser/compiler syntax check);
 *   3. per-unit oracles (compile + run real tests, mutation checks for tests).
 * Several candidates are sampled in parallel (llama.cpp slots) and the first one
 * that passes its oracle is kept. Nothing is accepted without a real execution.
 */
import { execFile } from 'node:child_process';
import { promises as fs, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, PlanItem, ToolExecutionContext } from '@mazz/shared';
import type { IModelProvider } from '@mazz/providers';
import { detectToolchains, type ToolRegistry } from '@mazz/tools';
import { defaultArm, experienceKey, type ExperienceStore, type ForgeArm, type ForgeStrategy } from './forge-experience.js';

export type ForgeLang = 'c' | 'python' | 'markdown';

export interface ForgeStep {
  text: string;
  /** Indentation level inside the unit (1 = function body). */
  depth?: number;
  /** The step only opens a block (`with ...:`, `for (...) {`); its body comes from the next, deeper steps. */
  opens?: boolean;
  /** Regular expressions the generated code of this step must match. */
  must?: string[];
  /** Keyword the statement must start with (`for (`, `with `...); derived from the step text when omitted. */
  lead?: string;
}

export interface ForgeCheck {
  /** argv lists run in the sandbox; `{python}` and `{gcc}` are resolved. All must exit 0. */
  commands: string[][];
  /** Extra files written only for this check (test drivers). */
  files?: Record<string, string>;
  /** Each mutant (a replaced file in a copy) must make at least one command fail: proves a test really tests. */
  mutants?: Array<{ path: string; content: string }>;
}

export interface ForgeUnit {
  id: string;
  file: string;
  lang: ForgeLang;
  /** Function/method header written by the blueprint (C: up to `)`, Python: `def ...:`). Empty for markdown. */
  signature: string;
  doc: string;
  /** Lines the harness places before the steps (typed views of parameters, never logic). */
  prelude?: string[];
  steps: ForgeStep[];
  /** Fixed text appended after the unit (e.g. `_LIB = _load()`). */
  after?: string;
  oracle?: ForgeCheck;
  maxCandidates?: number;
}

export interface ForgeFile {
  path: string;
  lang: ForgeLang;
  prologue: string;
  epilogue?: string;
}

export interface ForgeCommand {
  label: string;
  tool: 'compiler.gcc' | 'terminal.run';
  params: Record<string, unknown>;
}

export interface ForgeBlueprint {
  id: string;
  title: string;
  description: string;
  keywords: string[];
  knowledgeQuery?: string;
  /** Case-insensitive pattern a Bib1 hit must contain to be cited. */
  knowledgeMust?: string;
  files: ForgeFile[];
  units: ForgeUnit[];
  build: ForgeCommand[];
  verify: ForgeCommand[];
  source?: string;
}

export interface ForgeOptions {
  taskId: string;
  goal: string;
  workspaceRoot: string;
  provider: IModelProvider;
  modelId: string;
  tools: ToolRegistry;
  blueprint?: ForgeBlueprint;
  blueprintDirs?: string[];
  signal?: AbortSignal;
  permissionLevel?: ToolExecutionContext['permissionLevel'];
  requestApproval?: ToolExecutionContext['requestApproval'];
  allowedRoots?: string[];
  requestPathAccess?: ToolExecutionContext['requestPathAccess'];
  deniedRoots?: string[];
  hooks?: ToolExecutionContext['hooks'];
  /** Bib1 search (path, line, title, body, status per hit); absent = no citation. */
  knowledgeSearch?: (query: string) => Promise<Array<{ path: string; line?: number; title?: string; body?: string; status?: string }>>;
  /** Concurrent generations; default = llama.cpp slot count reported by /props (max 4). */
  concurrency?: number;
  maxCandidates?: number;
  stepRetries?: number;
  /** Move the last indentation space into the grammar (default true). */
  tokenHealing?: boolean;
  /** Repair failed candidates with their real error message (default true). */
  repair?: boolean;
  /** Learned decoding arms (strategy x temperature) per model, language and unit kind; absent = fixed portfolio. */
  experience?: ExperienceStore;
}

/** Experience key part: tests and implementations reward different arms. */
export function unitKind(unit: ForgeUnit): string {
  return /(^|[\\/])tests?[\\/]/.test(unit.file) ? 'test' : 'impl';
}

// ---------------------------------------------------------------------------
// Blueprints

const PACKAGED_BLUEPRINTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'blueprints');

/** Relative path that stays inside its root: no absolute, drive (`C:x`), stream (`a:b`) or `..` segment. */
export function safeRelative(p: unknown): boolean {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.includes(':') && !p.split(/[\\/]/).includes('..');
}

/**
 * Oracle argv: a card comes from a user-editable folder, so only the toolchain and the binaries the
 * oracle itself built may run (`{gcc}`, `{python}`, `{dir}/build/...`), never a shell.
 */
export function safeOracleArgv(argv: unknown): boolean {
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === 'string')) return false;
  const [cmd, ...args] = argv as string[];
  const exe = cmd === '{gcc}' || cmd === '{python}' || /^\{dir\}\/build\/[\w.-]+$/.test(cmd);
  return exe && args.every((a) => !path.isAbsolute(a) && !a.split(/[\\/]/).includes('..'));
}

const FINAL_TOOLS = new Set(['compiler.gcc', 'terminal.run']);

export function validateBlueprint(value: unknown): string | undefined {
  const b = value as Partial<ForgeBlueprint>;
  if (!b || typeof b !== 'object') return 'blueprint absent';
  if (typeof b.id !== 'string' || !/^[a-z0-9-]{2,64}$/.test(b.id)) return 'id invalide';
  if (typeof b.title !== 'string' || !Array.isArray(b.keywords) || !b.keywords.every((k) => typeof k === 'string' && k.trim())) return 'titre ou mots-clés invalides';
  if (b.knowledgeMust !== undefined) { try { new RegExp(b.knowledgeMust); } catch { return 'knowledgeMust invalide'; } }
  if (!Array.isArray(b.files) || !b.files.length || !Array.isArray(b.units) || !b.units.length) return 'files/units vides';
  const files = new Set<string>();
  for (const f of b.files) {
    if (!safeRelative(f.path) || f.path === 'FORGE_REPORT.json' || files.has(f.path.toLowerCase())) return `chemin de fichier invalide : ${f.path}`;
    if (!['c', 'python', 'markdown'].includes(f.lang)) return `langage invalide : ${f.lang}`;
    if (typeof f.prologue !== 'string' || (f.epilogue !== undefined && typeof f.epilogue !== 'string')) return `prologue invalide : ${f.path}`;
    files.add(f.path.toLowerCase());
  }
  const ids = new Set<string>();
  for (const u of b.units) {
    if (typeof u.id !== 'string' || ids.has(u.id)) return `unité dupliquée ou sans id : ${u.id}`;
    ids.add(u.id);
    if (typeof u.file !== 'string' || !files.has(u.file.toLowerCase())) return `unité ${u.id} : fichier inconnu ${u.file}`;
    if (!['c', 'python', 'markdown'].includes(u.lang) || typeof u.signature !== 'string' || typeof u.doc !== 'string') return `unité ${u.id} : langage, signature ou doc invalide`;
    if (!Array.isArray(u.steps) || !u.steps.length) return `unité ${u.id} : aucune étape`;
    for (const s of u.steps) {
      if (typeof s?.text !== 'string') return `unité ${u.id} : étape sans texte`;
      for (const m of s.must ?? []) {
        try { new RegExp(m); } catch { return `unité ${u.id} : regex invalide ${m}`; }
      }
    }
    if (u.oracle) {
      if (!Array.isArray(u.oracle.commands) || !u.oracle.commands.every(safeOracleArgv)) return `unité ${u.id} : commande d’oracle refusée (seuls {gcc}, {python} et {dir}/build/* sont permis)`;
      if (!Object.keys(u.oracle.files ?? {}).every(safeRelative) || !(u.oracle.mutants ?? []).every((m) => safeRelative(m.path) && typeof m.content === 'string')) return `unité ${u.id} : chemin d’oracle invalide`;
    }
  }
  if (!Array.isArray(b.build) || !Array.isArray(b.verify)) return 'build/verify absents';
  for (const c of [...b.build, ...b.verify]) {
    if (!FINAL_TOOLS.has(c?.tool) || typeof c.label !== 'string' || !c.params || typeof c.params !== 'object') return `commande finale refusée : ${c?.tool}`;
  }
  return undefined;
}

export function loadBlueprints(dirs: readonly string[] = []): ForgeBlueprint[] {
  const out = new Map<string, ForgeBlueprint>();
  for (const dir of [PACKAGED_BLUEPRINTS, ...dirs]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as ForgeBlueprint;
        if (!validateBlueprint(parsed)) out.set(parsed.id, { ...parsed, source: file });
      } catch { /* an unreadable card is skipped, never half-loaded */ }
    }
  }
  return [...out.values()];
}

/** Keyword score; ties and zero scores return undefined (no guessing). */
export function matchBlueprint(goal: string, blueprints: readonly ForgeBlueprint[]): ForgeBlueprint | undefined {
  const text = goal.toLowerCase();
  const scored = blueprints
    .map((b) => ({ b, score: b.keywords.filter((k) => text.includes(k.toLowerCase())).length }))
    .filter((s) => s.score > 0)
    .sort((a, z) => z.score - a.score);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score)) return undefined;
  return scored[0].b;
}

// ---------------------------------------------------------------------------
// Decoding helpers (pure, unit-tested)

// Measured: allowing leading blank lines or spaces here lowered Qwen3 0.6B pass rates (endless
// blank lines, other tokenisation); a forced lowercase first letter is the better trade-off.
const FIRST_CHAR_GRAMMAR: Record<ForgeLang, string> = {
  c: 'root ::= [a-z_] [^\\x00]*',
  python: 'root ::= [a-z_] [^\\x00]*',
  markdown: 'root ::= [A-Za-z`*(] [^\\x00]*',
};

/** Body depth of a unit: a Python method (`    def`) starts one level deeper than a function. */
export function baseDepth(unit: ForgeUnit): number {
  return Math.floor((unit.signature.length - unit.signature.trimStart().length) / 4) + 1;
}

const LEADS: Record<'c' | 'python', Record<string, string>> = {
  c: { for: 'for (', while: 'while (', if: 'if (', return: 'return' },
  python: { for: 'for ', while: 'while ', if: 'if ', with: 'with ', return: 'return' },
};

/** Control keyword forced by the grammar: a small model then only writes the condition and body. */
export function leadOf(unit: ForgeUnit, step: ForgeStep): string | undefined {
  if (step.lead !== undefined) return step.lead || undefined;
  if (unit.lang === 'markdown') return undefined;
  // "call f(...)": the statement starts with the call itself, so a void result is never tested or assigned.
  const call = /^call\s+([A-Za-z_][\w.]*)\s*\(/i.exec(step.text.trim());
  if (call) return `${call[1]}(`;
  return LEADS[unit.lang][step.text.trim().split(/\s+/)[0].toLowerCase()];
}

export function stepGrammar(unit: ForgeUnit, step: ForgeStep): string {
  const lead = leadOf(unit, step);
  return lead ? `root ::= ${JSON.stringify(lead)} [^\\x00]*` : FIRST_CHAR_GRAMMAR[unit.lang];
}

/**
 * Token healing for indented prompts: BPE tokenizers encode "    double" as "   " + " double", so a prompt
 * ending on the full indentation forces an unnatural token boundary (Qwen3 0.6B then produced `ndef`,
 * `ivec`). The last space is moved into the grammar instead: [characters cut from the prompt, grammar].
 */
export function heal(o: { tokenHealing?: boolean }, ind: string, grammar: string): [number, string] {
  if (o.tokenHealing === false || !ind.endsWith(" ")) return [0, grammar];
  return [1, grammar.replace("root ::= ", 'root ::= " " ')];
}

export function indentOf(unit: ForgeUnit, step: ForgeStep): string {
  return unit.lang === 'markdown' ? '' : '    '.repeat(step.depth ?? baseDepth(unit));
}

export function stepComment(unit: ForgeUnit, index: number, step: ForgeStep): string {
  const ind = indentOf(unit, step);
  if (unit.lang === 'c') return `${ind}/* step ${index + 1}: ${step.text.replace(/\*\//g, '* /')} */\n`;
  if (unit.lang === 'python') return `${ind}# step ${index + 1}: ${step.text}\n`;
  return '';
}

export function unitHead(unit: ForgeUnit): string {
  if (unit.lang === 'c') {
    const prelude = (unit.prelude ?? []).map((l) => `    ${l}\n`).join('');
    return `/* ${unit.doc.replace(/\*\//g, '* /')} */\n${unit.signature} {\n${prelude}`;
  }
  if (unit.lang === 'python') {
    const ind = '    '.repeat(baseDepth(unit));
    const prelude = (unit.prelude ?? []).map((l) => `${ind}${l}\n`).join('');
    return `${unit.signature}\n${ind}"""${unit.doc.replace(/"""/g, "'''")}"""\n${prelude}`;
  }
  return '';
}

function balance(raw: string, open: string, close: string): number {
  // Harness comments (step texts, docs) may hold quotes or braces: they are not code.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*#.*$/gm, '');
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (open.includes(ch)) depth++;
    else if (close.includes(ch)) depth--;
  }
  return depth;
}

/** One C statement or block: stops at `;` at depth 0, at the `}` closing a block, or at `{` for an opening step. */
export function extractC(out: string, opens = false): string {
  const text = out.replace(/^\s+/, '');
  let braces = 0;
  let parens = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '{') {
      braces++;
      if (opens && braces === 1 && parens === 0) return text.slice(0, i + 1);
    } else if (ch === '}') {
      braces--;
      if (braces < 0) return text.slice(0, i).trimEnd();
      // A brace initializer (`double a[3] = {1, 2, 3};`) ends at its `;`, not at the closing brace.
      if (braces === 0 && parens === 0 && !/^\s*(else\b|;)/.test(text.slice(i + 1))) return text.slice(0, i + 1);
    } else if (ch === ';' && braces === 0 && parens === 0 && !/^\s*else\b/.test(text.slice(i + 1))) return text.slice(0, i + 1);
  }
  return braces === 0 && parens === 0 && /[;}]\s*$/.test(text) ? text.trimEnd() : '';
}

/** One Python statement (with bracket continuation) or, for block steps, the header and its deeper lines. */
export function extractPython(out: string, indent: string, opens = false): string {
  const lines = out.split('\n');
  if (!lines[0]?.trim()) return '';
  const keep = [lines[0].trimEnd()];
  let depth = balance(lines[0], '([{', ')]}');
  const header = /:\s*(#.*)?$/.test(lines[0]);
  const block = header && !opens;
  for (const line of lines.slice(1)) {
    const lead = line.length - line.trimStart().length;
    if (depth > 0) keep.push(line.trimEnd());
    else if (block && line.trim() && lead > indent.length) keep.push(line.trimEnd());
    else if (block && !line.trim()) continue;
    else break;
    depth += balance(line, '([{', ')]}');
  }
  if (depth !== 0) return '';
  if (opens && !header) return '';
  return keep.join('\n');
}

export function extractMarkdown(out: string): string {
  return out.split(/\n\s*\n/)[0].trim();
}

/**
 * Code of one step. Small models often prepare a value before the statement the step asks for
 * (`expected = f(x)` then `assertEqual(expected, 0)`): up to three statements at the step's own
 * indentation are taken when the first alone misses the step's anchors.
 */
/** Length of the prefix of 	ext that piece (a whitespace-trimmed copy of it) was taken from. */
function consumed(text: string, piece: string): number {
  let i = 0;
  for (const ch of piece.trimStart()) {
    while (i < text.length && text[i] !== ch && /\s/.test(text[i])) i++;
    if (text[i] === ch) i++;
  }
  return i;
}

export function extractStep(lang: ForgeLang, out: string, ind: string, step: ForgeStep): string {
  if (lang === 'markdown') return extractMarkdown(out);
  const one = (text: string) => lang === 'c' ? extractC(text, step.opens) : extractPython(text, ind, step.opens);
  let piece = one(out);
  if (!piece || step.opens || pieceAcceptable(step, piece)) return piece;
  const first = piece;
  // extractC/extractPython trim, so consumption is measured on the original text, never searched.
  let rest = out.slice(consumed(out, piece));
  for (let extra = 0; extra < 2; extra++) {
    if (lang === 'python') {
      const m = /^(?:[ \t]*\n)+([ \t]*)/.exec(rest);
      if (!m || m[1] !== ind) break;
      rest = rest.slice(m[0].length);
    }
    const next = one(rest);
    if (!next) break;
    rest = rest.slice(consumed(rest, next));
    piece += `\n${ind}${next}`;
    if (pieceAcceptable(step, piece)) return piece;
  }
  return first;
}

export function stepAnchors(step: ForgeStep): RegExp[] {
  const anchors = (step.must ?? []).map((m) => new RegExp(m));
  for (const m of step.text.matchAll(/`([^`]+)`/g)) {
    anchors.push(new RegExp(`(?<![\\w.])${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`));
  }
  if (/^return\b/i.test(step.text)) anchors.push(/\breturn\b/);
  return anchors;
}

export function pieceAcceptable(step: ForgeStep, piece: string): boolean {
  const body = piece.trim();
  if (!body || body === 'pass' || body === ';' || /^#|^\/[/*]/.test(body)) return false;
  // A premature `return` (seen: `return _LIB.call(...)` for a "call" step) makes every later step dead code.
  if (/^return\b/.test(body) && !/\breturn\b/i.test(step.text)) return false;
  return stepAnchors(step).every((a) => a.test(body));
}

/** Chat wrapper for the raw /completion endpoint. ChatML covers Qwen/SmolLM/Hermes; others get a plain code document. */
export function wrapPrompt(modelId: string, instruction: string, fence: string, code: string): string {
  if (/qwen|smol|hermes|chatml|yi-/i.test(modelId)) {
    const noThink = /qwen3/i.test(modelId) ? ' /no_think' : '';
    return `<|im_start|>user\n${instruction}${noThink}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n\`\`\`${fence}\n${code}`;
  }
  return `${instruction}\n\n\`\`\`${fence}\n${code}`;
}

// ---------------------------------------------------------------------------
// Sandbox execution

interface RunResult { code: number; out: string }

// Generated code runs here: it gets no API keys or tokens from the Studio environment.
const SANDBOX_ENV_KEYS = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LANG'];
const SANDBOX_ENV = Object.fromEntries(SANDBOX_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));

function runArgv(argv: string[], cwd: string, timeoutMs = 20_000, input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20, env: { ...SANDBOX_ENV, PYTHONIOENCODING: 'utf-8' } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
      // A missing toolchain (ENOENT), a timeout or an output overflow must stay visible as a failure.
      const reason = error && code === 1 && !`${stdout}${stderr}`.trim() ? `${error.message}` : '';
      resolve({ code, out: `${stdout}${stderr}${reason}`.slice(-4000) });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

interface Toolchain { python: string; gcc: string }

function toolchain(): Toolchain {
  const found = detectToolchains();
  const pick = (name: string) => found.find((t) => t.name === name && t.isAvailable)?.path || name;
  return { python: pick('python'), gcc: pick('gcc') };
}

class Sandbox {
  private seq = 0;
  constructor(readonly root: string, readonly tc: Toolchain) {}

  async materialize(files: Map<string, string>, extra: Record<string, string> = {}): Promise<string> {
    const dir = path.join(this.root, `c${++this.seq}`);
    for (const [rel, content] of [...files, ...Object.entries(extra)]) {
      const target = path.resolve(dir, rel);
      if (!target.startsWith(dir + path.sep)) throw new Error(`Chemin hors du bac à sable refusé : ${rel}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    await fs.mkdir(path.join(dir, 'build'), { recursive: true });
    return dir;
  }

  resolve(argv: string[], dir: string): string[] {
    return argv.map((a) => a === '{python}' ? this.tc.python : a === '{gcc}' ? this.tc.gcc : a.replace('{dir}', dir));
  }

  /** Real parser/compiler check of one file inside a full copy of the project (relative includes resolve). */
  async syntax(lang: ForgeLang, files: Map<string, string>, rel: string): Promise<string | undefined> {
    if (lang === 'markdown') return undefined;
    const dir = await this.materialize(files);
    const file = path.join(dir, rel);
    const argv = lang === 'c'
      ? [this.tc.gcc, '-fsyntax-only', '-std=c11', '-w', file]
      : [this.tc.python, '-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())', file];
    const r = await runArgv(argv, dir, 15_000);
    return r.code === 0 ? undefined : r.out.split('\n').find((l) => /error/i.test(l))?.trim() || r.out.trim().slice(0, 300) || `contrôle syntaxique en échec (code ${r.code})`;
  }

  async check(files: Map<string, string>, check: ForgeCheck): Promise<{ ok: boolean; detail: string }> {
    const dir = await this.materialize(files, check.files);
    for (const argv of check.commands) {
      const r = await runArgv(this.resolve(argv, dir), dir);
      if (r.code !== 0) return { ok: false, detail: diagnostic(r.out) || `code ${r.code}` };
    }
    for (const mutant of check.mutants ?? []) {
      const mdir = await this.materialize(files, { ...check.files, [mutant.path]: mutant.content });
      let failed = false;
      for (const argv of check.commands) {
        if ((await runArgv(this.resolve(argv, mdir), mdir)).code !== 0) { failed = true; break; }
      }
      if (!failed) return { ok: false, detail: `le test ne détecte pas l’implémentation volontairement fausse de ${mutant.path}` };
    }
    return { ok: true, detail: 'oracle réussi' };
  }
}

/**
 * The lines of a failed command that say what is wrong. gcc ends with "warnings being treated as errors" and
 * Python with a traceback, so the tail alone often misses the cause: keep the first compiler diagnostic
 * (with its source line), else the last Python exception, else the tail.
 */
export function diagnostic(out: string): string {
  const lines = out.trim().split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  const gcc = lines.findIndex((l) => /:\s*(fatal )?error:|undefined reference to/.test(l));
  let picked: string[];
  if (gcc >= 0) picked = lines.slice(gcc, gcc + 2);
  else {
    const exc = lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*([\w.]+(Error|Exception)|AssertionError)\b/.test(l)).pop();
    picked = exc ? [...lines.slice(Math.max(0, exc[1] - 1), exc[1] + 1)] : lines.slice(-3);
  }
  return picked.join(' | ').slice(0, 400);
}

// ---------------------------------------------------------------------------
// Runner

interface Candidate { code: string; modelText: string; strategy: ForgeStrategy | 'repair'; rejected?: string }

/** A rejected candidate worth repairing: it produced a whole body, and its failure is a real compiler/test message. */
interface RepairSource { modelText: string; detail: string }

/** Error text for a repair prompt: sandbox paths reduced to file names, first lines only. */
export function repairDetail(detail: string): string {
  return detail.replace(/[A-Za-z]:[\\/][^\s:'"]*[\\/]([^\\/\s:'"]+)/g, '$1').replace(/\/(?:tmp|var)\/[^\s:'"]*\/([^/\s:'"]+)/g, '$1').split(/\s*\|\s*|\n/).filter(Boolean).slice(0, 3).join('\n').slice(0, 400);
}

interface Stats { generations: number; completionTokens: number; candidates: number; syntaxRejects: number; anchorRejects: number }

class Channel {
  private items: AgentEvent[] = [];
  private wake?: () => void;
  closed = false;
  push(e: AgentEvent): void { this.items.push(e); this.wake?.(); }
  close(): void { this.closed = true; this.wake?.(); }
  async *drain(): AsyncIterable<AgentEvent> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = undefined;
    }
  }
}

export class ForgeRunner {
  async *run(options: ForgeOptions): AsyncIterable<AgentEvent> {
    const channel = new Channel();
    const done = this.pipeline(options, (e) => channel.push(e)).catch((err: Error) => {
      channel.push({ type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'FORGE_FAILED', message: err.message, fatal: true });
      channel.push({ type: 'complete', taskId: options.taskId, timestamp: Date.now(), success: false, summary: err.message, durationMs: 0 });
    }).finally(() => channel.close());
    yield* channel.drain();
    await done;
  }

  private async pipeline(o: ForgeOptions, emit: (e: AgentEvent) => void): Promise<void> {
    const start = Date.now();
    const taskId = o.taskId;
    const now = () => Date.now();
    const blueprint = o.blueprint ?? matchBlueprint(o.goal, loadBlueprints(o.blueprintDirs));
    if (!blueprint) {
      const msg = 'Forge : aucun blueprint ne correspond à cette demande. Blueprints disponibles : '
        + loadBlueprints(o.blueprintDirs).map((b) => `${b.id} (${b.title})`).join(', ');
      emit({ type: 'error', taskId, timestamp: now(), code: 'FORGE_NO_BLUEPRINT', message: msg, fatal: true });
      emit({ type: 'complete', taskId, timestamp: now(), success: false, summary: msg, durationMs: now() - start });
      return;
    }
    if (!o.provider.completePrefix) throw new Error('Forge exige un fournisseur llama.cpp (complétion de préfixe brute).');

    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-forge-'));
    try {
      await this.forgeProject(o, blueprint, new Sandbox(sandboxRoot, toolchain()), emit, start);
    } finally {
      await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async forgeProject(o: ForgeOptions, blueprint: ForgeBlueprint, sandbox: Sandbox, emit: (e: AgentEvent) => void, start: number): Promise<void> {
    const taskId = o.taskId;
    const now = () => Date.now();
    const concurrency = o.concurrency ?? await slotCount(o.provider);
    const stats: Stats = { generations: 0, completionTokens: 0, candidates: 0, syntaxRejects: 0, anchorRejects: 0 };
    const ctx: ToolExecutionContext = {
      taskId, workspaceRoot: o.workspaceRoot, signal: o.signal ?? new AbortController().signal,
      permissionLevel: o.permissionLevel ?? 'ask_on_write', emitEvent: emit, requestApproval: o.requestApproval,
      allowedRoots: o.allowedRoots, requestPathAccess: o.requestPathAccess, deniedRoots: o.deniedRoots, hooks: o.hooks,
    };
    const forge = (data: Record<string, unknown>) => emit({ type: 'forge', taskId, timestamp: now(), blueprintId: blueprint.id, ...data } as AgentEvent);

    forge({
      phase: 'blueprint', detail: blueprint.title, source: blueprint.source, concurrency,
      units: blueprint.units.map((u) => ({ id: u.id, file: u.file, lang: u.lang, steps: u.steps.length })),
    });
    if (concurrency === 1) emit({ type: 'status', taskId, timestamp: now(), stage: 'forge', message: 'llama.cpp expose 1 slot : les candidats sont générés un par un. Avec 4 slots (paramètre parallel=4 et contexte x4), le débit cumulé mesuré sur Qwen3 0,6B / i5-6500 passe de 35 à 95 tokens/s.' });
    const plan: PlanItem[] = blueprint.units.map((u) => ({ content: `${u.file} : ${u.id}`, status: 'pending' }));
    const publishPlan = () => emit({ type: 'plan', taskId, timestamp: now(), items: plan.map((p) => ({ ...p })) });
    publishPlan();

    // Bib1: the real search result (or its absence) is quoted, never invented. A hit counts only
    // when its text matches the blueprint's relevance pattern.
    let citation = 'aucune référence vérifiable trouvée dans Bib1';
    if (blueprint.knowledgeQuery && o.knowledgeSearch) {
      const relevant = new RegExp(blueprint.knowledgeMust ?? '.', 'i');
      const hits = await o.knowledgeSearch(blueprint.knowledgeQuery).catch(() => []);
      const hit = hits.find((h) => relevant.test(`${h.title ?? ''}\n${h.body ?? ''}`));
      emit({ type: 'status', taskId, timestamp: now(), stage: 'knowledge-sources', message: `Bib1 : ${hits.length} passage(s), ${hit ? 'une référence pertinente retenue' : 'aucun passage pertinent'}.`,
        sourceEvidence: hits.slice(0, 5).map((h) => ({ path: h.path, line: h.line ?? 0, body: (h.body ?? '').slice(0, 400), status: h.status })) });
      // One line, no comment terminator: the citation is pasted into generated files.
      if (hit) citation = `Bib1 : ${hit.path}${hit.line ? `:${hit.line}` : ''}${hit.title ? ` (${hit.title.replace(/\*|"/g, '')})` : ''}${hit.status ? `, statut ${hit.status}` : ''}`.replace(/\s+/g, ' ').replace(/\*\//g, '* /').slice(0, 300);
    }
    const files0 = blueprint.files.map((f) => ({ ...f, prologue: f.prologue.split('{bib1}').join(citation), epilogue: f.epilogue?.split('{bib1}').join(citation) }));

    const accepted = new Map<string, string>(); // unit id -> code
    const modelLines = new Map<string, number>();
    // compact: earlier units reduced to their interface, to keep long files inside a small per-slot context.
    const header = (u: ForgeUnit) => u.lang === 'c' ? `${u.signature};\n` : u.lang === 'python' ? `${unitHead(u)}${'    '.repeat(baseDepth(u))}...\n` : '';
    const assemble = (extra?: { unit: ForgeUnit; code: string }, compact = false) => {
      const files = new Map<string, string>();
      for (const f of files0) {
        const parts = blueprint.units
          .filter((u) => u.file === f.path)
          .map((u) => {
            const code = extra?.unit.id === u.id ? extra.code : accepted.has(u.id) && compact ? header(u) : accepted.get(u.id);
            return code === undefined ? undefined : `${code}${u.after ?? ''}`;
          })
          .filter((p): p is string => p !== undefined);
        // PEP 8 spacing: two blank lines between top-level Python definitions, one between methods.
        const nested = blueprint.units.some((u) => u.file === f.path && baseDepth(u) > 1);
        const sep = f.lang === 'python' && !nested ? '\n\n' : '\n';
        const lead = f.prologue.endsWith('\n') ? sep : '\n';
        files.set(f.path, `${f.prologue}${parts.length ? `${lead}${parts.join(sep)}` : ''}${f.epilogue ?? ''}`);
      }
      return files;
    };
    for (const [index, unit] of blueprint.units.entries()) {
      if (ctx.signal.aborted) throw new Error('Tâche interrompue.');
      plan[index].status = 'in_progress';
      publishPlan();
      forge({ phase: 'unit_start', unitId: unit.id, file: unit.file, steps: unit.steps.map((s) => s.text) });
      const unitWithCitation: ForgeUnit = { ...unit, steps: unit.steps.map((s) => ({ ...s, text: s.text.split('{bib1}').join(citation).replace(/\s+/g, ' ') })) };
      const max = unit.maxCandidates ?? o.maxCandidates ?? 12;
      const expKey = experienceKey(o.modelId, unit.lang, unitKind(unit));
      let winner: Candidate | undefined;
      let tried = 0;
      // Failed candidates with a real error, most informative first: repaired by one slot of each later batch.
      const repairable: RepairSource[] = [];
      while (!winner && tried < max) {
        const batch = Math.min(concurrency, max - tried);
        const ids = Array.from({ length: batch }, (_, i) => tried + i);
        tried += batch;
        const base = assemble();
        // The unit is inserted before the file epilogue (`if __name__ == ...`), never after it.
        const epilogue = files0.find((f) => f.path === unit.file)?.epilogue ?? '';
        const whole = base.get(unit.file) ?? '';
        const fileSoFar = whole.slice(0, whole.length - epilogue.length);
        const withFile = (text: string) => new Map(base).set(unit.file, `${text}${epilogue}`);
        // Prompt context: the full file while it is short, its interface-only form beyond ~1 500 tokens.
        const compactFile = assemble(undefined, true).get(unit.file) ?? '';
        const promptFile = fileSoFar.length > 6000 ? compactFile.slice(0, compactFile.length - epilogue.length) : fileSoFar;
        // The first slot of every batch after the first repairs the most informative failure so far.
        const repairFor = (i: number) => (i === 0 && unit.lang !== 'markdown' && o.repair !== false ? repairable.shift() : undefined);
        const evaluate = async (n: number, arm: ForgeArm, repair?: RepairSource) => {
          const cand = repair
            ? await this.whole(o, unitWithCitation, promptFile, arm.tempBucket, stats, repair)
            : arm.strategy === 'whole'
            ? await this.whole(o, unitWithCitation, promptFile, arm.tempBucket, stats)
            : await this.stepwise(o, unitWithCitation, fileSoFar, promptFile, withFile, arm.tempBucket, sandbox, stats);
          stats.candidates++;
          if (cand.rejected) return { n, cand, ok: false, detail: cand.rejected };
          const files = assemble({ unit, code: cand.code });
          const syntaxError = await sandbox.syntax(unit.lang, files, unit.file);
          if (syntaxError) return { n, cand, ok: false, detail: syntaxError };
          if (!unit.oracle) return { n, cand, ok: true, detail: 'syntaxe valide' };
          return { n, cand, ...await sandbox.check(files, unit.oracle) };
        };
        const results = await Promise.all(ids.map(async (n, i) => {
          // Markdown has no whole-body mode; code units take their arm from the experience store when present.
          const arm: ForgeArm = unit.lang === 'markdown' ? { strategy: 'stepwise', tempBucket: n % 4 } : o.experience?.choose(expKey, n) ?? defaultArm(n);
          const repair = repairFor(i);
          // One candidate's provider error (context budget, timeout) rejects that candidate, not the run.
          let providerError = false;
          const r = await evaluate(n, arm, repair).catch((err: Error) => {
            if (o.signal?.aborted) throw err;
            providerError = true;
            return { n, cand: { code: '', modelText: '', strategy: repair ? 'repair' as const : arm.strategy }, ok: false, detail: err.message };
          });
          // Reward = oracle verdict; provider failures say nothing about the arm and are not recorded.
          if (o.experience && unit.lang !== 'markdown' && !providerError && !repair) o.experience.record(expKey, arm, r.ok);
          // Only complete bodies that ran into a real message are worth repairing (not "step N without code").
          // The whole function is shown (step-by-step text alone lacks indentation and closing braces).
          if (!r.ok && !providerError && r.cand.modelText.trim() && !(r.cand as Candidate).rejected) repairable.unshift({ modelText: r.cand.code, detail: r.detail });
          forge({ phase: 'candidate', unitId: unit.id, candidate: r.n + 1, strategy: r.cand.strategy, verdict: r.ok ? 'pass' : 'reject', detail: r.detail, code: r.cand.code.slice(0, 4000) });
          return r;
        }));
        // Several passing candidates: the shortest model text wins (fewer stray statements).
        winner = results.filter((r) => r.ok).sort((a, z) => a.cand.modelText.length - z.cand.modelText.length)[0]?.cand;
      }
      if (o.experience) {
        try { o.experience.save(); } catch (err) { emit({ type: 'error', taskId, timestamp: now(), code: 'FORGE_EXPERIENCE_SAVE', message: `Mémoire d’expérience non enregistrée : ${(err as Error).message}`, fatal: false }); }
      }
      if (!winner) {
        plan[index].status = 'pending';
        publishPlan();
        const msg = `Forge : l’unité « ${unit.id} » n’a passé son oracle avec aucun des ${tried} candidats. Aucun fichier n’a été écrit.`;
        forge({ phase: 'summary', success: false, detail: msg, stats });
        emit({ type: 'error', taskId, timestamp: now(), code: 'FORGE_UNIT_FAILED', message: msg, fatal: true });
        emit({ type: 'complete', taskId, timestamp: now(), success: false, summary: msg, durationMs: now() - start });
        return;
      }
      accepted.set(unit.id, winner.code);
      modelLines.set(unit.id, winner.modelText.split('\n').filter((l) => l.trim()).length);
      plan[index].status = 'completed';
      publishPlan();
      forge({ phase: 'unit_done', unitId: unit.id, strategy: winner.strategy, candidates: tried, code: winner.code, oracle: Boolean(unit.oracle) });
    }

    // Accepted sources go through the normal tools: approvals, diffs and checkpoints stay visible.
    const files = assemble();
    for (const [rel, content] of files) {
      const r = await o.tools.executeTool('fs.write', { path: rel, content }, ctx);
      if (!r.success) throw new Error(`Écriture refusée ou impossible pour ${rel} : ${r.error ?? 'erreur inconnue'}`);
    }
    const report = {
      blueprint: blueprint.id, source: blueprint.source, model: o.modelId, citation,
      units: blueprint.units.map((u) => ({ id: u.id, file: u.file, modelLines: modelLines.get(u.id) ?? 0, steps: u.steps.length })),
      harnessWrote: 'prologues de fichiers (includes/imports), signatures, docstrings, commentaires d’étape, préludes de typage, commandes de build',
      modelWrote: 'tous les corps de fonctions, de tests et le texte du README',
      stats, concurrency, durationMs: now() - start,
    };
    const reportWrite = await o.tools.executeTool('fs.write', { path: 'FORGE_REPORT.json', content: `${JSON.stringify(report, null, 2)}\n` }, ctx);
    if (!reportWrite.success) throw new Error(`Écriture refusée ou impossible pour FORGE_REPORT.json : ${reportWrite.error ?? 'erreur inconnue'}`);
    forge({ phase: 'files', files: [...files.keys(), 'FORGE_REPORT.json'] });

    let verified = true;
    for (const cmd of [...blueprint.build, ...blueprint.verify]) {
      const r = await o.tools.executeTool(cmd.tool, cmd.params, ctx);
      const ok = r.success && (r.exitCode === undefined || r.exitCode === 0);
      forge({ phase: 'verify', detail: cmd.label, verdict: ok ? 'pass' : 'reject' });
      if (!ok) { verified = false; break; }
    }

    const totalModel = [...modelLines.values()].reduce((a, b) => a + b, 0);
    const summary = verified
      ? `Forge « ${blueprint.title} » : ${blueprint.units.length} unités écrites par ${o.modelId} (${totalModel} lignes de code modèle), ${stats.candidates} candidats, ${stats.generations} générations, ${stats.completionTokens} tokens. Build et vérifications réussis.`
      : `Forge « ${blueprint.title} » : sources écrites mais une vérification finale a échoué ; voir les résultats d’outils.`;
    forge({ phase: 'summary', success: verified, detail: summary, stats });
    emit({ type: 'complete', taskId, timestamp: now(), success: verified, summary, durationMs: now() - start });
  }

  private async generate(o: ForgeOptions, prompt: string, stop: string[], grammar: string, temperature: number, maxTokens: number, stats: Stats): Promise<string> {
    stats.generations++;
    // Local llama.cpp occasionally resets a keep-alive socket under parallel load: retry transport errors only.
    for (let attempt = 0; ; attempt++) {
      let text = '';
      let failure: string | undefined;
      for await (const ev of o.provider.completePrefix!(prompt, { modelId: o.modelId, taskId: o.taskId, temperature, topP: 0.9, maxTokens, stop, grammar, signal: o.signal })) {
        if (ev.type === 'token') text += ev.delta;
        else if (ev.type === 'usage') stats.completionTokens += ev.completionTokens || 0;
        else if (ev.type === 'error' && ev.fatal) failure = ev.message;
      }
      if (!failure) return text;
      if (attempt >= 2 || !/fetch failed|ECONNRESET|socket|UND_ERR/i.test(failure) || o.signal?.aborted) throw new Error(failure);
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  private instruction(unit: ForgeUnit): string {
    if (unit.lang === 'markdown') return `Write the README of this project, one part at a time. ${unit.doc}`;
    return `Complete the ${unit.lang === 'c' ? 'C' : 'Python'} function exactly as described. Under each step comment, write the code for that step only.`;
  }

  private stops(unit: ForgeUnit): string[] {
    if (unit.lang === 'c') return ['/* step', '\n}\n', '```'];
    if (unit.lang === 'python') return ['# step', '\ndef ', '\nclass ', '\nif __name__', '```'];
    return ['```', '\n#'];
  }

  /** Step-anchored decoding: the harness writes each step comment, the model writes that step's code. */
  private async stepwise(o: ForgeOptions, unit: ForgeUnit, fileSoFar: string, promptFile: string, withFile: (text: string) => Map<string, string>, tempBucket: number, sandbox: Sandbox, stats: Stats): Promise<Candidate> {
    const fence = unit.lang;
    let code = unitHead(unit);
    let modelText = '';
    const retries = o.stepRetries ?? 5;
    const base = baseDepth(unit);
    let depth = base;
    for (const [i, step] of unit.steps.entries()) {
      const ind = indentOf(unit, step);
      // C blocks opened by earlier steps are closed by the harness when the steps go back up.
      const target = step.depth ?? base;
      while (unit.lang === 'c' && depth > target) code += `${'    '.repeat(--depth)}}\n`;
      code += stepComment(unit, i, step);
      let piece = '';
      for (let k = 0; k < retries && !piece; k++) {
        const temperature = Math.min(1, 0.2 + 0.12 * tempBucket + 0.15 * k);
        const instruction = unit.lang === 'markdown' ? `${this.instruction(unit)}\nNext part: ${step.text}` : this.instruction(unit);
        const [cut, grammar] = heal(o, ind, stepGrammar(unit, step));
        const prompt = wrapPrompt(o.modelId, instruction, fence, `${promptFile}\n\n${code}${ind.slice(0, ind.length - cut)}`);
        const out = (await this.generate(o, prompt, this.stops(unit), grammar, temperature, 220, stats)).slice(cut);
        // Leading blank lines: the first real line then carries the step's own indentation.
        const lead = /^(?:[ \t]*\n)+([ \t]*)/.exec(out);
        const text = lead && lead[1].length >= ind.length ? out.slice(lead[0].length - lead[1].length + ind.length) : out;
        const raw = extractStep(unit.lang, text, ind, step);
        if (process.env.MAZZ_FORGE_DEBUG) process.stderr.write(`[forge] ${unit.id} step ${i + 1} try ${k + 1}: ${JSON.stringify(out.slice(0, 160))} -> ${JSON.stringify(raw)}\n`);
        if (!pieceAcceptable(step, raw)) { stats.anchorRejects++; continue; }
        if (unit.lang !== 'markdown') {
          const closing = unit.lang === 'c'
            ? '}'.repeat(Math.max(0, balance(code + raw, '{', '}')))
            : step.opens ? `\n${ind}    pass\n` : '\n';
          const err = await sandbox.syntax(unit.lang, withFile(`${fileSoFar}\n\n${code}${ind}${raw}${closing}\n`), unit.file);
          if (err) { stats.syntaxRejects++; continue; }
        }
        piece = raw;
      }
      if (!piece) return { code, modelText, strategy: 'stepwise', rejected: `étape ${i + 1} sans code valide après ${retries} essais` };
      code += unit.lang === 'markdown' ? `${piece}\n\n` : `${ind}${piece}\n`;
      modelText += `${piece}\n`;
      depth = (step.depth ?? base) + (step.opens ? 1 : 0);
    }
    if (unit.lang === 'c') {
      while (depth > base) code += `${'    '.repeat(--depth)}}\n`;
      code += '}\n'.repeat(Math.max(1, balance(code, '{', '}')));
    }
    return { code: code.trimEnd() + '\n', modelText, strategy: 'stepwise' };
  }

  /**
   * Whole-body decoding under the full step list; kept in the portfolio because it sometimes succeeds where steps fail.
   * With `repair`, the model also sees a failed body and its real error, and writes a corrected body (S*-style debugging).
   */
  private async whole(o: ForgeOptions, unit: ForgeUnit, fileSoFar: string, tempBucket: number, stats: Stats, repair?: RepairSource): Promise<Candidate> {
    const strategy = repair ? 'repair' : 'whole';
    const head = unitHead(unit) + unit.steps.map((s, i) => stepComment(unit, i, s)).join('');
    const ind = '    '.repeat(baseDepth(unit));
    const [cut, grammar] = heal(o, ind, FIRST_CHAR_GRAMMAR[unit.lang]);
    const instruction = repair
      ? `${this.instruction(unit)}\nA previous version of this function failed with this error:\n${repairDetail(repair.detail)}\nPrevious version:\n${repair.modelText.trimEnd()}\nWrite a corrected body that fixes this error and follows every step.`
      : this.instruction(unit);
    const prompt = wrapPrompt(o.modelId, instruction, unit.lang, `${fileSoFar}\n\n${head}${ind.slice(0, ind.length - cut)}`);
    const stops = unit.lang === 'c' ? ['\n}\n', '```'] : ['\ndef ', '\nclass ', '\nif __name__', '```', '\n_LIB', '\n@'];
    let out = (await this.generate(o, prompt, stops, grammar, 0.3 + 0.1 * tempBucket, 500, stats)).slice(cut);
    let body: string;
    if (unit.lang === 'c') {
      body = `${ind}${out.trimEnd()}\n`;
      const open = balance(head + body, '{', '}');
      if (open < 1) return { code: head, modelText: '', strategy, rejected: 'corps C mal équilibré' };
      body += '}\n'.repeat(open);
    } else {
      // The model sometimes restarts the whole function: keep only the body of that restart.
      const name = /def\s+(\w+)/.exec(unit.signature)?.[1];
      const restart = name ? new RegExp(`^.*\\bdef\\s+${name}\\s*\\(.*\\n`, 'm').exec(out) : null;
      if (restart) out = out.slice(restart.index + restart[0].length).replace(/^ {4}/gm, '').trimStart();
      const lines = `${ind}${out}`.split('\n');
      const cut = lines.findIndex((l) => l.trim() && l.length - l.trimStart().length < ind.length);
      body = (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trimEnd() + '\n';
    }
    if (!body.trim() || body.trim() === 'pass') return { code: head, modelText: '', strategy, rejected: 'corps vide' };
    return { code: head + body, modelText: body, strategy };
  }
}

async function slotCount(provider: IModelProvider): Promise<number> {
  try {
    const origin = provider.baseUrl.replace(/\/v1\/?$/u, '');
    const props = await (await fetch(`${origin}/props`, { signal: AbortSignal.timeout(3000) })).json() as { total_slots?: number };
    return Math.max(1, Math.min(4, Number(props.total_slots) || 1));
  } catch {
    return 1;
  }
}

export const defaultForgeRunner = new ForgeRunner();
