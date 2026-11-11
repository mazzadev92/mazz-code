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

/**
 * Model folders announced by the launcher and used by the gateway for downloads: MAZZ_MODEL_DIRS,
 * an OS path-delimiter list (same variable as the Python side). Without it, a model downloaded from
 * the public catalogue lands outside the folders the Studio scans and never appears in the picker.
 */
export function modelDirs(): string[] {
  return (process.env.MAZZ_MODEL_DIRS ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

export function mazzPath(...parts: string[]): string {
  return path.join(mazzHome(), ...parts);
}
