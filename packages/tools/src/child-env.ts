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

/** Environment for git: no system config, never an interactive prompt. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...childEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
