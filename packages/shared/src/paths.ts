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

/** Extra model folders of this machine: MAZZ_LEGACY_DIRS, an OS path-delimiter list (same variable as the gateway). */
export function legacyDirs(): string[] {
  return (process.env.MAZZ_LEGACY_DIRS ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

export function mazzPath(...parts: string[]): string {
  return path.join(mazzHome(), ...parts);
}
