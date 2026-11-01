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
