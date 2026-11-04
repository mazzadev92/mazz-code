import * as fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mazzPath } from '@mazz/shared';

const persistenceFailures=new Map<string,{at:string;message:string}>();
export function getPersistenceFailures():Array<{file:string;at:string;message:string}>{
  return [...persistenceFailures].map(([file,error])=>({file,...error}));
}

/**
 * Data directory of the Studio (settings, sessions, telemetry, audit).
 * Overridable with MAZZ_STUDIO_DATA, e.g. for tests. When MAZZ_HOME is set (portable mode) it is
 * <MAZZ_HOME>/studio; otherwise the historical %APPDATA% default is kept so existing installs keep their data.
 */
export function resolveDataDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.MAZZ_STUDIO_DATA) return path.resolve(process.env.MAZZ_STUDIO_DATA);
  if (process.env.MAZZ_HOME) return mazzPath('studio');
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'MAZZ_AGENT_STUDIO');
}

const BACKUP_SUFFIX = '.bak';

function uniqueSibling(file: string, suffix: string): string {
  return `${file}.${process.pid}.${Date.now()}.${randomUUID()}.${suffix}`;
}

async function writeSyncedFile(file: string, contents: string): Promise<void> {
  const handle = await fs.open(file, 'wx');
  try {
    await handle.writeFile(contents, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function preserveCurrentFile(file: string): Promise<void> {
  let current: string;
  try {
    current = await fs.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  // A backup is useful only when it contains a complete JSON document. If the
  // current file is already damaged, keep its bytes in a forensic sidecar and
  // retain the previous known-good backup instead of replacing it with damage.
  try {
    JSON.parse(current);
  } catch {
    const damaged = uniqueSibling(file, 'corrupt');
    await fs.copyFile(file, damaged, fsConstants.COPYFILE_EXCL);
    const handle = await fs.open(damaged, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return;
  }

  const backup = `${file}${BACKUP_SUFFIX}`;
  const tmpBackup = uniqueSibling(backup, 'tmp');
  try {
    await writeSyncedFile(tmpBackup, current);
    await fs.rename(tmpBackup, backup);
  } catch (error) {
    await fs.rm(tmpBackup, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes via fsynced temporary data and atomic rename; keeps a valid previous JSON revision. */
async function writeTextAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = uniqueSibling(file, 'tmp');
  try {
    await writeSyncedFile(tmp, contents);
    await preserveCurrentFile(file);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Writes through a temporary file then renames, so a crash never leaves half a JSON file. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const contents = JSON.stringify(data, null, 2);
  if (contents === undefined) throw new TypeError(`Donnée JSON invalide pour ${file}`);
  await writeTextAtomic(file, contents);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;

    const backup = `${file}${BACKUP_SUFFIX}`;
    let backupText: string;
    try {
      backupText = await fs.readFile(backup, 'utf-8');
    } catch (backupError) {
      if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw backupError;
    }
    let recovered: T;
    try {
      recovered = JSON.parse(backupText) as T;
    } catch (backupError) {
      throw new AggregateError([error, backupError], `JSON illisible et sauvegarde invalide : ${file}`);
    }

    // Preserve the damaged bytes before atomically restoring the known-good
    // revision. The original evidence is never discarded during recovery.
    const damaged = uniqueSibling(file, 'corrupt');
    await fs.copyFile(file, damaged, fsConstants.COPYFILE_EXCL);
    const handle = await fs.open(damaged, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    const tmp = uniqueSibling(file, 'restore');
    try {
      await writeSyncedFile(tmp, backupText);
      await fs.rename(tmp, file);
    } catch (restoreError) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw restoreError;
    }
    return recovered;
  }
}

/** Serializes writes to one file and coalesces bursts (last value wins). */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | null = null;
  private pending: unknown;
  private hasPending = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly delayMs = 400) {}

  schedule(data: unknown): void {
    this.pending = data;
    this.hasPending = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(error=>console.error(`Persistance impossible (${this.file}):`,(error as Error).message));
    }, this.delayMs);
  }

  private enqueuePending(): void {
    // Serialize at the flush boundary. Session objects can keep changing while
    // the filesystem is busy; the bytes queued here must represent one coherent
    // revision, while a later schedule is written after it in the same chain.
    let contents: string;
    try {
      contents = JSON.stringify(this.pending, null, 2);
      if (contents === undefined) throw new TypeError(`Donnée JSON invalide pour ${this.file}`);
    } catch (error) {
      persistenceFailures.set(this.file, { at: new Date().toISOString(), message: (error as Error).message });
      throw error;
    }
    this.hasPending = false;
    // Keep a failure observable to flush() callers. A subsequent scheduled value
    // can still retry instead of permanently poisoning the serialized chain.
    this.chain = this.chain.catch(() => undefined).then(async () => {
      try {
        await writeTextAtomic(this.file, contents);
        persistenceFailures.delete(this.file);
      } catch (error) {
        persistenceFailures.set(this.file, { at: new Date().toISOString(), message: (error as Error).message });
        throw error;
      }
    });
  }

  /** Drain every revision queued before and during this call. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.hasPending) this.enqueuePending();
      const queued = this.chain;
      await queued;
      // A mutation may have scheduled another timer while the current write was
      // in flight. Do not report a clean flush until that revision is durable.
      if (!this.hasPending && !this.timer && queued === this.chain) return;
    }
  }
}

export async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const sub = await dirSize(full);
        bytes += sub.bytes;
        files += sub.files;
      } else if (e.isFile()) {
        bytes += (await fs.stat(full)).size;
        files++;
      }
    }
  } catch {
    // missing directory counts as empty
  }
  return { bytes, files };
}
