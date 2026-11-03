import { spawnSync } from 'node:child_process';

/**
 * Environment for commands the agent runs (terminal.run, terminal.start). The Studio process holds
 * provider keys and tokens (HF_TOKEN, GROQ_API_KEY, ...); a model-written command must not be able to
 * print or exfiltrate them. Toolchain variables (PATH, compilers, Python, Node) are kept as they are.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD_|CREDENTIAL|COOKIE|SESSION|AUTH)/i;
const ALWAYS_KEEP = new Set(['PATH', 'PATHEXT', 'PWD', 'OLDPWD']);

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!ALWAYS_KEEP.has(name.toUpperCase()) && SECRET_NAME.test(name)) continue;
    env[name] = value;
  }
  return env;
}

/**
 * Prefix for every git call made on a workspace the agent did not create: a downloaded repository can
 * carry a .git/config whose core.fsmonitor, pager or external diff runs a program on `git status`/`git diff`.
 */
export const GIT_SAFE_CONFIG = [
  // diff.external cannot be cleared with -c: diff and log calls pass --no-ext-diff instead.
  '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never',
  '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '--no-pager',
];

/**
 * Programs a repository's own .git/config can make git run that -c cannot clear without knowing their name:
 * clean/smudge/process filters (run by status and diff), diff drivers and textconv, merge drivers.
 * Returns the offending keys; git calls on such a repository are refused instead.
 */
export function repoConfigRunsPrograms(cwd: string): string[] {
  const r = spawnSync('git', ['config', '--local', '--name-only', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(textconv|command)|merge\\..*\\.driver)$'],
    { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1' } });
  return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export function assertSafeRepo(cwd: string): void {
  const keys = repoConfigRunsPrograms(cwd);
  if (keys.length) throw new Error(`Dépôt refusé : sa configuration locale exécute des programmes (${keys.slice(0, 3).join(', ')}). Vérifiez .git/config avant d'utiliser les outils git.`);
}

/** Environment for git: no system config, never an interactive prompt. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
