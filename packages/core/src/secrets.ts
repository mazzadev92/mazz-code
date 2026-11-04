import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readJson, writeJsonAtomic } from './storage.js';

/**
 * API key vault.
 *
 * Windows: keys are encrypted with DPAPI (CurrentUser scope) through PowerShell;
 * the plaintext goes through stdin, never through command-line arguments.
 * Other systems: stored in a file restricted to the user (mode 0600) and the
 * status reports that it is NOT encrypted.
 *
 * Plaintext keys only live in this process memory and in provider objects.
 * Nothing in this module returns them to HTTP callers: only a masked hint.
 */

export type SecretProtection = 'dpapi' | 'file-0600';

interface VaultFile {
  protection: SecretProtection;
  entries: Record<string, { blob: string; hint: string; updatedAt: number }>;
}

export interface SecretInfo {
  id: string;
  hint: string;
  updatedAt: number;
}

const PS_PROTECT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Console]::In.ReadToEnd()
$items = $in | ConvertFrom-Json
$out = @{}
foreach ($p in $items.PSObject.Properties) {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$p.Value)
  $out[$p.Name] = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))
}
$out | ConvertTo-Json -Compress
`;

const PS_UNPROTECT = PS_PROTECT.replace(
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'))",
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$p.Value), $null, 'CurrentUser'))"
).replace('$bytes = [Text.Encoding]::UTF8.GetBytes([string]$p.Value)', '');

function runPowerShell(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`DPAPI : ${(stderr || err.message).trim().slice(0, 300)}`));
        else resolve(stdout.trim());
      }
    );
    child.stdin?.end(input, 'utf-8');
  });
}

/** Reads a ~/.mazz secret file: plain text, or a "dpapi:<base64>" blob written by the gateway (decrypted for the current user). */
export async function readSecretFile(file: string): Promise<string> {
  const raw = (await fs.readFile(file, 'utf8')).trim();
  if (!raw.startsWith('dpapi:')) return raw;
  const out = JSON.parse(await runPowerShell(PS_UNPROTECT, JSON.stringify({ k: raw.slice(6) })) || '{}') as { k?: string };
  return (out.k ?? '').trim();
}

/** Masked form shown in the UI: prefix family and last 4 characters only. */
export function maskSecret(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return '••••';
  const prefix = k.match(/^(sk-ant-|sk-|gsk_|AIza)/)?.[0] ?? '';
  return `${prefix}••••${k.slice(-4)}`;
}

export class SecretVault {
  private readonly file: string;
  private readonly protection: SecretProtection = process.platform === 'win32' ? 'dpapi' : 'file-0600';
  private data: VaultFile = { protection: this.protection, entries: {} };
  private plain = new Map<string, string>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'secrets.vault.json');
  }

  getProtection(): SecretProtection {
    return this.protection;
  }

  /** Loads and decrypts all entries; returns ids that failed to decrypt. */
  async load(): Promise<{ loaded: string[]; failed: string[] }> {
    this.data = await readJson<VaultFile>(this.file, { protection: this.protection, entries: {} });
    const ids = Object.keys(this.data.entries);
    if (ids.length === 0) return { loaded: [], failed: [] };
    const blobs: Record<string, string> = {};
    for (const id of ids) blobs[id] = this.data.entries[id].blob;
    try {
      let decoded: Record<string, string>;
      if (this.data.protection === 'dpapi') {
        decoded = JSON.parse(await runPowerShell(PS_UNPROTECT, JSON.stringify(blobs)) || '{}');
      } else {
        decoded = Object.fromEntries(ids.map((id) => [id, Buffer.from(blobs[id], 'base64').toString('utf-8')]));
      }
      for (const [id, v] of Object.entries(decoded)) this.plain.set(id, v);
      return { loaded: Object.keys(decoded), failed: ids.filter((id) => !(id in decoded)) };
    } catch {
      return { loaded: [], failed: ids };
    }
  }

  get(id: string): string | undefined {
    return this.plain.get(id);
  }

  list(): SecretInfo[] {
    return Object.entries(this.data.entries).map(([id, e]) => ({ id, hint: e.hint, updatedAt: e.updatedAt }));
  }

  async set(id: string, value: string): Promise<SecretInfo> {
    const key = value.trim();
    if (!key) throw new Error('Clé vide.');
    if (key.length > 4096) throw new Error('Clé trop longue.');
    let blob: string;
    if (this.protection === 'dpapi') {
      const out = JSON.parse(await runPowerShell(PS_PROTECT, JSON.stringify({ [id]: key })));
      blob = out[id];
      if (!blob) throw new Error('Chiffrement DPAPI impossible.');
    } else {
      blob = Buffer.from(key, 'utf-8').toString('base64');
    }
    const entry = { blob, hint: maskSecret(key), updatedAt: Date.now() };
    this.data.entries[id] = entry;
    this.plain.set(id, key);
    await this.persist();
    return { id, hint: entry.hint, updatedAt: entry.updatedAt };
  }

  async remove(id: string): Promise<boolean> {
    const existed = id in this.data.entries;
    delete this.data.entries[id];
    this.plain.delete(id);
    await this.persist();
    return existed;
  }

  private async persist(): Promise<void> {
    this.data.protection = this.protection;
    await writeJsonAtomic(this.file, this.data);
    if (this.protection === 'file-0600') {
      await fs.chmod(this.file, 0o600).catch(() => undefined);
    }
  }
}
