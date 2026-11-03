// Workspace tools the Claude Code toolset has and the Studio lacked: file globbing, git diff/log and a
// test runner that detects the project's framework and returns a failure summary instead of a raw log.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { resolveSafePath } from './fs.js';
import { assertSafeRepo, childEnv, GIT_SAFE_CONFIG, gitEnv } from './child-env.js';
import { runBoundedCompilerProcess } from './compiler.js';

const IGNORED_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.next', 'target'];
const MAX_GLOB_RESULTS = 500;
const GIT_OUTPUT_LIMIT = 60_000;

function fail(start: number, err: unknown): ToolExecutionResult {
  return { success: false, output: null, error: (err as Error).message ?? String(err), durationMs: Date.now() - start };
}

export class FsGlobTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.glob',
    description: 'Liste les fichiers du workspace qui correspondent à un motif glob (ex. "src/**/*.ts", "**/test_*.py"), triés par date de modification, plus récents d’abord. Ignore node_modules, .git, dist, build.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Motif glob relatif au workspace' },
        path: { type: 'string', description: 'Sous-dossier où chercher (défaut : racine du workspace)' },
      },
      required: ['pattern'],
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.pattern !== 'string' || !params.pattern.trim()) throw new Error('Paramètre "pattern" manquant.');
      const base = resolveSafePath(context.workspaceRoot, typeof params.path === 'string' ? params.path : '.', context.allowedRoots);
      const matches: Array<{ path: string; mtime: number }> = [];
      let truncated = false;
      for await (const entry of fs.glob(params.pattern, {
        cwd: base,
        exclude: (name: string) => IGNORED_DIRS.includes(path.basename(name)),
      })) {
        const abs = path.join(base, entry);
        const stat = await fs.stat(abs).catch(() => undefined);
        if (!stat?.isFile()) continue;
        matches.push({ path: path.relative(context.workspaceRoot, abs).replace(/\\/g, '/'), mtime: stat.mtimeMs });
        if (matches.length >= MAX_GLOB_RESULTS) { truncated = true; break; }
      }
      matches.sort((a, b) => b.mtime - a.mtime);
      return {
        success: true,
        output: { pattern: params.pattern, count: matches.length, truncated, files: matches.map((m) => m.path) },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return fail(start, err);
    }
  }
}

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  assertSafeRepo(cwd);
  const r = spawnSync('git', [...GIT_SAFE_CONFIG, ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, env: gitEnv() });
  const out = `${r.stdout ?? ''}${r.status === 0 ? '' : r.stderr ?? ''}`;
  return { ok: r.status === 0, out: out.length > GIT_OUTPUT_LIMIT ? `${out.slice(0, GIT_OUTPUT_LIMIT)}\n... [tronqué : ${out.length - GIT_OUTPUT_LIMIT} caractères]` : out };
}

export class GitDiffTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git.diff',
    description: 'Diff Git du workspace : modifications non indexées par défaut, indexées avec staged=true, ou par rapport à un commit (ref). Limitable à un chemin.',
    category: 'git',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Fichier ou dossier à limiter' },
        staged: { type: 'boolean', description: 'Diff de l’index (git diff --cached)' },
        ref: { type: 'string', description: 'Commit ou branche de comparaison (ex. HEAD~1, main)' },
        stat: { type: 'boolean', description: 'Résumé par fichier seulement (--stat)' },
      },
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      if (params.staged === true) args.push('--cached');
      if (params.stat === true) args.push('--stat');
      if (typeof params.ref === 'string' && params.ref.trim()) {
        if (!/^[\w./~^@{}-]+$/.test(params.ref) || params.ref.startsWith('-')) throw new Error('ref invalide.');
        args.push(params.ref);
      }
      if (typeof params.path === 'string' && params.path.trim()) {
        args.push('--', path.relative(context.workspaceRoot, resolveSafePath(context.workspaceRoot, params.path, context.allowedRoots)) || '.');
      }
      const r = git(args, context.workspaceRoot);
      if (!r.ok) throw new Error(r.out.trim() || 'git diff a échoué (dépôt Git absent ?)');
      return { success: true, output: { diff: r.out || '(aucune différence)' }, durationMs: Date.now() - start };
    } catch (err) {
      return fail(start, err);
    }
  }
}

export class GitLogTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git.log',
    description: 'Historique Git récent : hash court, date, auteur, message. Limitable à un chemin.',
    category: 'git',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Nombre de commits (défaut 20, max 200)' },
        path: { type: 'string', description: 'Fichier ou dossier dont on veut l’historique' },
      },
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const limit = typeof params.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(params.limit))) : 20;
      const args = ['log', '--no-ext-diff', '--no-textconv', `-${limit}`, '--date=short', '--pretty=format:%h%x09%ad%x09%an%x09%s'];
      if (typeof params.path === 'string' && params.path.trim()) {
        args.push('--', path.relative(context.workspaceRoot, resolveSafePath(context.workspaceRoot, params.path, context.allowedRoots)) || '.');
      }
      const r = git(args, context.workspaceRoot);
      if (!r.ok) throw new Error(r.out.trim() || 'git log a échoué (dépôt Git absent ?)');
      const commits = r.out.split('\n').filter(Boolean).map((line) => {
        const [hash, date, author, ...msg] = line.split('\t');
        return { hash, date, author, message: msg.join('\t') };
      });
      return { success: true, output: { count: commits.length, commits }, durationMs: Date.now() - start };
    } catch (err) {
      return fail(start, err);
    }
  }
}

type Runner = { id: string; command: string; args: string[] };

/** Picks the test command from what the project declares; undefined when nothing is recognisable. */
export function detectTestRunner(root: string): Runner | undefined {
  const pkg = path.join(root, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {};
      if (typeof scripts.test === 'string' && !/no test specified/.test(scripts.test)) return { id: 'npm', command: 'npm', args: ['test', '--silent'] };
    } catch { /* unreadable package.json: try other runners */ }
  }
  const hasPy = ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'conftest.py'].some((f) => existsSync(path.join(root, f)))
    || existsSync(path.join(root, 'tests'));
  if (hasPy) return { id: 'pytest', command: 'python', args: ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'] };
  if (existsSync(path.join(root, 'CMakeLists.txt')) && existsSync(path.join(root, 'build'))) return { id: 'ctest', command: 'ctest', args: ['--test-dir', 'build', '--output-on-failure'] };
  return undefined;
}

const FAILURE_LINE = /(FAIL|FAILED|ERROR|Error:|AssertionError|\u2716|not ok|Traceback|failed)/;

export class TestRunTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'test.run',
    description: 'Lance les tests du projet (npm test, pytest ou ctest détectés automatiquement) et renvoie le code de sortie, le résumé et les lignes d’échec. target limite à un fichier ou un test.',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Fichier ou identifiant de test à lancer seul (ex. tests/test_core.py)' },
        timeoutSec: { type: 'integer', description: 'Délai maximum (défaut 300 s)' },
      },
    },
    requiresPermission: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const runner = detectTestRunner(context.workspaceRoot);
      if (!runner) throw new Error('Aucun framework de test détecté (package.json "test", pytest, ctest). Utiliser terminal.run avec la commande exacte.');
      const args = [...runner.args];
      if (typeof params.target === 'string' && params.target.trim()) {
        if (/[;&|`$<>]/.test(params.target)) throw new Error('target invalide.');
        args.push(...(runner.id === 'npm' ? ['--', params.target] : runner.id === 'ctest' ? ['-R', params.target] : [params.target]));
      }
      const timeout = Math.min(1800, Math.max(10, typeof params.timeoutSec === 'number' ? params.timeoutSec : 300)) * 1000;
      // Asynchronous with tree kill: a 30-minute test run must not freeze the Studio server (SSE, other tasks, cancel).
      const r = await runBoundedCompilerProcess(runner.command, args, context.workspaceRoot, timeout, 32 * 1024 * 1024,
        { shell: process.platform === 'win32', env: childEnv() });
      const output = `${r.stdout}\n${r.stderr}${r.error ? `\n${r.error}` : ''}`;
      const lines = output.split(/\r?\n/);
      const failures = lines.filter((l) => FAILURE_LINE.test(l)).slice(0, 40);
      return {
        success: r.code === 0,
        output: {
          runner: runner.id,
          command: [runner.command, ...args].join(' '),
          exitCode: r.code,
          passed: r.code === 0,
          timedOut: r.timedOut,
          failures,
          tail: lines.slice(-40).join('\n'),
        },
        error: r.code === 0 ? undefined : r.timedOut ? `Tests interrompus après ${timeout / 1000} s.` : `Tests en échec (code ${r.code}).`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return fail(start, err);
    }
  }
}
