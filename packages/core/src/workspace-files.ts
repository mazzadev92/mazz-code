import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { resolveSafePath, writeAtomic } from '@mazz/tools';

export interface TreeEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  modifiedAt?: number;
  /** Heavy or generated folder: listed but not expanded automatically. */
  heavy?: boolean;
}

const HEAVY = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'out']);
const MAX_ENTRIES = 2000;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function rel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, '/');
}

/** One directory level, directories first; never recursive (projects can be huge). */
export async function listDirectory(root: string, relPath = '.'): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  const abs = resolveSafePath(root, relPath || '.');
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: TreeEntry[] = [];
  for (const d of dirents.slice(0, MAX_ENTRIES)) {
    const full = path.join(abs, d.name);
    const entry: TreeEntry = { name: d.name, path: rel(root, full), isDirectory: d.isDirectory() };
    if (d.isDirectory()) {
      if (HEAVY.has(d.name)) entry.heavy = true;
    } else {
      try {
        const st = await fs.stat(full);
        entry.sizeBytes = st.size;
        entry.modifiedAt = st.mtimeMs;
      } catch {
        // unreadable entry stays listed without size
      }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'fr'));
  return { path: rel(root, abs) || '.', entries, truncated: dirents.length > MAX_ENTRIES };
}

export async function readWorkspaceFile(root: string, relPath: string): Promise<{
  path: string;
  content?: string;
  binary: boolean;
  tooLarge: boolean;
  sizeBytes: number;
  modifiedAt: number;
}> {
  const abs = resolveSafePath(root, relPath);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error('Ce chemin est un dossier.');
  const base = { path: rel(root, abs), sizeBytes: st.size, modifiedAt: st.mtimeMs };
  if (st.size > MAX_READ_BYTES) return { ...base, binary: false, tooLarge: true };
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true, tooLarge: false };
  return { ...base, content: buf.toString('utf-8'), binary: false, tooLarge: false };
}

/**
 * Writes a file. `expectedModifiedAt` guards against overwriting a change made
 * on disk since the editor loaded the file.
 */
export async function writeWorkspaceFile(root: string, relPath: string, content: string, expectedModifiedAt?: number): Promise<{ path: string; modifiedAt: number; created: boolean }> {
  const abs = resolveSafePath(root, relPath);
  const exists = existsSync(abs);
  if (exists && expectedModifiedAt !== undefined) {
    const st = await fs.stat(abs);
    if (Math.abs(st.mtimeMs - expectedModifiedAt) > 1) {
      throw Object.assign(new Error('Le fichier a été modifié sur le disque depuis son ouverture.'), { code: 'CONFLICT' });
    }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Same atomic path as the agent's writes: temp file, fsync, rename, BOM kept. A crash never leaves half a file.
  let previous: string | null = null;
  if (exists) {
    try { previous = await fs.readFile(abs, 'utf-8'); } catch { previous = null; }
  }
  await writeAtomic(abs, content, previous);
  const st = await fs.stat(abs);
  return { path: rel(root, abs), modifiedAt: st.mtimeMs, created: !exists };
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

/** Plain-text search, bounded in files, matches and time. */
export async function searchWorkspace(root: string, query: string, opts: { maxResults?: number; fileNamesOnly?: boolean } = {}): Promise<{ matches: SearchMatch[]; files: string[]; truncated: boolean }> {
  const maxResults = opts.maxResults ?? 200;
  const needle = query.toLowerCase();
  const matches: SearchMatch[] = [];
  const files: string[] = [];
  const deadline = Date.now() + 4000;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (Date.now() > deadline || matches.length >= maxResults || files.length >= maxResults) {
        truncated = true;
        return;
      }
      if (d.name.startsWith('.') || HEAVY.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full);
      } else if (d.isFile()) {
        if (d.name.toLowerCase().includes(needle)) files.push(rel(root, full));
        if (opts.fileNamesOnly) continue;
        try {
          const st = await fs.stat(full);
          if (st.size > 1024 * 1024) continue;
          const buf = await fs.readFile(full);
          if (buf.subarray(0, 4000).includes(0)) continue;
          const lines = buf.toString('utf-8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(needle)) {
              matches.push({ file: rel(root, full), line: i + 1, text: lines[i].trim().slice(0, 300) });
              if (matches.length >= maxResults) break;
            }
          }
        } catch {
          // unreadable file
        }
      }
    }
  }

  await walk(path.resolve(root));
  return { matches, files, truncated };
}

/** Absolute directory browser for pickers (folders, and files matching an extension). */
export async function browseFileSystem(absPath: string | undefined, ext?: string): Promise<{
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string; isDirectory: boolean; sizeBytes?: number }>;
}> {
  if (!absPath) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const p = `${letter}:\\`;
        if (existsSync(p)) drives.push({ name: `${letter}:`, path: p, isDirectory: true });
      }
      return { path: null, parent: null, entries: drives };
    }
    absPath = '/';
  }
  const abs = path.resolve(absPath);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents) {
    if (d.name.startsWith('$') || d.name === 'System Volume Information') continue;
    if (d.isDirectory()) entries.push({ name: d.name, path: path.join(abs, d.name), isDirectory: true });
    else if (ext && d.isFile() && d.name.toLowerCase().endsWith(ext)) {
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await fs.stat(path.join(abs, d.name))).size;
      } catch {}
      entries.push({ name: d.name, path: path.join(abs, d.name), isDirectory: false, sizeBytes });
    }
    if (entries.length > 3000) break;
  }
  entries.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'fr'));
  const parent = path.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, entries };
}
