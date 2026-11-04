import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Shared llama-server API key, read by both the gateway (Python) and Studio (Node).
 *
 * The key file is passed to llama-server with --api-key-file: the value never appears in the
 * command line, the logs or a URL. It lives under the user profile with a user-only ACL.
 */
let cached: string | undefined;

export function llamaKeyPath(): string {
  return process.env.MAZZ_LLAMA_KEY_FILE || path.join(os.homedir(), '.mazz', 'llama.key');
}

/** Returns the key, creating a 32-byte random one on first use. */
export function ensureLlamaKey(): string {
  if (cached) return cached;
  const file = llamaKeyPath();
  try {
    const existing = readFileSync(file, 'utf-8').trim();
    if (existing) {
      cached = existing;
      return existing;
    }
  } catch {
    // missing or unreadable: create a fresh key below
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, key, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Another process won the race: use its key instead of overwriting it.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const other = readFileSync(file, 'utf-8').trim();
    if (!other) throw err;
    cached = other;
    return other;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ignores POSIX modes; the ACL below is the real restriction.
  }
  restrictAcl(file);
  cached = key;
  return key;
}

/** Authorization header for local llama-server calls (harmless when the server has no key). */
export function llamaAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ensureLlamaKey()}` };
}

function restrictAcl(file: string): void {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) return;
  execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { timeout: 5000, windowsHide: true }, () => undefined);
}

/** Test hook: forgets the in-memory key so a new MAZZ_LLAMA_KEY_FILE is honoured. */
export function resetLlamaKeyCacheForTests(): void {
  cached = undefined;
}

export function llamaKeyExists(): boolean {
  return existsSync(llamaKeyPath());
}
