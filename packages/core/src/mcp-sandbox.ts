import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Least privilege for stdio MCP servers: scrubbed environment, confined working directory,
 * journal of tool calls (names of arguments only, never values), per-server permission.
 */

export type McpPermission = 'ask' | 'allow' | 'deny';

export function normalizeMcpPermission(v: unknown): McpPermission {
  return v === 'allow' || v === 'deny' ? v : 'ask';
}

/** Variables a child needs to run at all (case-insensitive on Windows). Nothing else of the Studio environment passes. */
const ESSENTIAL = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'NUMBER_OF_PROCESSORS']);

/** Essentials from `base`, then the variables explicitly listed in the server config, then the vault secret. */
export function scrubbedEnv(explicit: Record<string, string> | undefined, secret?: { name: string; value: string }, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && ESSENTIAL.has(k.toUpperCase())) out[k] = v;
  Object.assign(out, explicit ?? {});
  if (secret) out[secret.name] = secret.value;
  return out;
}

/** The configured cwd, else the active workspace. Throws when the directory does not exist (no silent fallback to the Studio cwd). */
export function confinedCwd(configured: string | undefined, workspaceRoot: string | undefined): string {
  const dir = configured || workspaceRoot;
  if (!dir) throw new Error('Aucun dossier de travail : configurez « cwd » ou ouvrez un espace de travail.');
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Dossier de travail MCP introuvable : ${abs}`);
  return abs;
}

export interface McpJournalEntry {
  at: string;
  server: string;
  tool: string;
  argKeys: string[];
  durationMs: number;
  success: boolean;
}

/** Argument NAMES only: values (sensitive or not) are never read into the journal. */
export function journalEntry(server: string, tool: string, args: Record<string, unknown> | undefined, durationMs: number, success: boolean, now = new Date()): McpJournalEntry {
  const argKeys = Object.keys(args ?? {}).slice(0, 30).map((k) => k.slice(0, 64));
  return { at: now.toISOString(), server, tool, argKeys, durationMs: Math.round(durationMs), success };
}

/** Append-only JSONL, rotated to <file>.1 past maxBytes (one generation kept). */
export class McpJournal {
  constructor(private readonly file: string, private readonly maxBytes = 1024 * 1024) {}

  append(e: McpJournalEntry): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size >= this.maxBytes) renameSync(this.file, `${this.file}.1`);
      appendFileSync(this.file, `${JSON.stringify(e)}\n`, 'utf8');
    } catch (err) {
      console.error(`[mcp] journal non inscriptible : ${(err as Error).message}`);
    }
  }

  /** Most recent entries first. */
  last(n = 50): McpJournalEntry[] {
    const lines: string[] = [];
    for (const f of [`${this.file}.1`, this.file]) {
      try {
        if (existsSync(f)) lines.push(...readFileSync(f, 'utf8').split('\n').filter(Boolean));
      } catch { /* fichier en cours de rotation : ignoré */ }
    }
    const out: McpJournalEntry[] = [];
    for (const l of lines.slice(-n).reverse()) {
      try { out.push(JSON.parse(l) as McpJournalEntry); } catch { /* ligne tronquée : ignorée */ }
    }
    return out;
  }
}
