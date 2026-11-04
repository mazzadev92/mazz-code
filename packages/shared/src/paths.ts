import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Single root of the per-user MAZZ data (control.key, llama.key, studio data, models in portable mode).
 * MAZZ_HOME relocates it (portable mode); same variable and default (~/.mazz) as the Python gateway.
 */
export function mazzHome(): string {
  const env = process.env.MAZZ_HOME;
  return env && env.trim() ? path.resolve(env) : path.join(os.homedir(), '.mazz');
}

export function mazzPath(...parts: string[]): string {
  return path.join(mazzHome(), ...parts);
}
