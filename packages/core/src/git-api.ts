import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveSafePath } from '@mazz/tools';

/** Git commands run with execFile (no shell) inside the workspace only. */
function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, windowsHide: true, timeout: 20000, maxBuffer }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout, stderr, code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

export interface GitFileStatus {
  path: string;
  /** Index (staged) status letter, or ' '. */
  index: string;
  /** Working tree status letter, or ' '. */
  worktree: string;
  origPath?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
  error?: string;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  if (!r.ok) {
    if (/not a git repository/i.test(r.stderr)) return { isRepo: false, files: [] };
    return { isRepo: false, files: [], error: r.stderr.trim() || 'git indisponible' };
  }
  const parts = r.stdout.split('\0');
  const out: GitStatus = { isRepo: true, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const m = p.slice(3).match(/^(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?,? ?(?:behind (\d+))?\])?/);
      if (m) {
        out.branch = m[1];
        out.upstream = m[2];
        out.ahead = m[3] ? Number(m[3]) : 0;
        out.behind = m[4] ? Number(m[4]) : 0;
      }
      continue;
    }
    const entry: GitFileStatus = { index: p[0], worktree: p[1], path: p.slice(3) };
    if (p[0] === 'R' || p[0] === 'C') {
      entry.origPath = parts[++i];
    }
    out.files.push(entry);
  }
  return out;
}

export async function gitDiff(cwd: string, file: string, staged: boolean): Promise<{ patch: string; untrackedContent?: string; binary: boolean }> {
  resolveSafePath(cwd, file);
  const status = await git(cwd, ['status', '--porcelain=v1', '--', file]);
  if (status.stdout.startsWith('??')) {
    const abs = path.join(cwd, file);
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return { patch: '', binary: true };
    return { patch: '', untrackedContent: buf.toString('utf-8').slice(0, 1024 * 1024), binary: false };
  }
  const r = await git(cwd, ['diff', '--no-ext-diff', '--unified=3', ...(staged ? ['--cached'] : []), '--', file]);
  return { patch: r.stdout, binary: /^Binary files/m.test(r.stdout) };
}

export async function gitLog(cwd: string, limit = 50): Promise<Array<{ hash: string; author: string; date: number; subject: string }>> {
  const r = await git(cwd, ['log', `-n${Math.min(limit, 500)}`, '--pretty=format:%H%x1f%an%x1f%at%x1f%s%x1e']);
  if (!r.ok) return [];
  return r.stdout
    .split('\x1e')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [hash, author, at, subject] = l.split('\x1f');
      return { hash, author, date: Number(at) * 1000, subject };
    });
}

function checkPaths(cwd: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('Liste de chemins requise.');
  return paths.map((p) => {
    if (typeof p !== 'string') throw new Error('Chemin invalide.');
    resolveSafePath(cwd, p);
    return p;
  });
}

export async function gitStage(cwd: string, paths: unknown): Promise<void> {
  const r = await git(cwd, ['add', '--', ...checkPaths(cwd, paths)]);
  if (!r.ok) throw new Error(r.stderr.trim());
}

export async function gitUnstage(cwd: string, paths: unknown): Promise<void> {
  const r = await git(cwd, ['restore', '--staged', '--', ...checkPaths(cwd, paths)]);
  if (!r.ok) throw new Error(r.stderr.trim());
}

/** Discards working-tree changes of tracked files. Untracked files are not deleted. */
export async function gitDiscard(cwd: string, paths: unknown): Promise<void> {
  const r = await git(cwd, ['restore', '--worktree', '--', ...checkPaths(cwd, paths)]);
  if (!r.ok) throw new Error(r.stderr.trim());
}

export async function gitCommit(cwd: string, message: unknown): Promise<string> {
  if (typeof message !== 'string' || !message.trim()) throw new Error('Message de commit requis.');
  const r = await git(cwd, ['commit', '-m', message.trim()]);
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

export async function gitBranches(cwd: string): Promise<{ current?: string; branches: string[] }> {
  const r = await git(cwd, ['branch', '--format=%(refname:short)']);
  const cur = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { current: cur.ok ? cur.stdout.trim() : undefined, branches: r.ok ? r.stdout.split(/\r?\n/).filter(Boolean) : [] };
}

/** Staged changes as a unified diff (input of the commit message suggestion). */
export async function gitStagedDiff(cwd: string): Promise<string> {
  const r = await git(cwd, ['diff', '--cached', '--no-ext-diff', '--unified=2', '--stat', '--patch']);
  return r.ok ? r.stdout : '';
}

const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,120}$/;

/** Switches branch, or creates it from the current HEAD. */
export async function gitCheckout(cwd: string, branch: unknown, create: boolean): Promise<string> {
  if (typeof branch !== 'string' || !BRANCH_RE.test(branch) || branch.includes('..')) throw new Error('Nom de branche invalide.');
  const r = await git(cwd, create ? ['switch', '-c', branch] : ['switch', branch]);
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim());
  return (r.stderr || r.stdout).trim();
}

function gitLong(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    );
  });
}

/** Push; the first push of a branch sets its upstream on origin. Never forced. */
export async function gitPush(cwd: string): Promise<string> {
  const up = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const r = await gitLong(cwd, up.ok ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
  if (!r.ok) throw new Error(r.out || 'Échec du push.');
  return r.out;
}

/** Pull in fast-forward only: never creates a merge commit behind the user's back. */
export async function gitPull(cwd: string): Promise<string> {
  const r = await gitLong(cwd, ['pull', '--ff-only']);
  if (!r.ok) throw new Error(r.out || 'Échec du pull.');
  return r.out;
}

function gh(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, windowsHide: true, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'GitHub CLI (gh) introuvable : installez-le et connectez-vous avec « gh auth login ».' : `${stdout}${stderr}`.trim() })
    );
  });
}

/** Pull request of the current branch on GitHub (gh CLI, user's own login). */
export async function ghPrCreate(cwd: string, title: unknown, body: unknown, base?: unknown): Promise<string> {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Titre de la pull request requis.');
  const args = ['pr', 'create', '--title', title.trim().slice(0, 200), '--body', typeof body === 'string' ? body.slice(0, 20000) : ''];
  if (typeof base === 'string' && BRANCH_RE.test(base)) args.push('--base', base);
  const r = await gh(cwd, args);
  if (!r.ok) throw new Error(r.out);
  return r.out.split(/\r?\n/).find((l) => l.startsWith('https://')) ?? r.out;
}

export async function ghPrView(cwd: string): Promise<{ number: number; title: string; url: string; state: string } | null> {
  const r = await gh(cwd, ['pr', 'view', '--json', 'number,title,url,state']);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}
