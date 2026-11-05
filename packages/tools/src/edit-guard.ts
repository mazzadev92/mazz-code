import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Edit engine guards (spec 03b): Read-Before-Edit, staleness detection and atomic writes.
 * A task may modify an existing file only after reading (or writing) it, and only if the file has not
 * changed on disk since: size and mtime seen at that moment must still match.
 */

type Seen = { mtimeMs: number; size: number };

/** Tasks remembered at most; the oldest is forgotten first. */
const MAX_TASKS = 64;
const seenByTask = new Map<string, Map<string, Seen>>();

function key(absPath: string): string {
  const resolved = path.resolve(absPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Records the file as known to the task, with its current size and mtime. */
export async function recordSeen(taskId: string, absPath: string): Promise<void> {
  const st = await fs.stat(absPath);
  let files = seenByTask.get(taskId);
  if (!files) {
    files = new Map();
    seenByTask.set(taskId, files);
    if (seenByTask.size > MAX_TASKS) seenByTask.delete(seenByTask.keys().next().value as string);
  }
  files.set(key(absPath), { mtimeMs: st.mtimeMs, size: st.size });
}

/** Throws unless the task may modify `absPath`: new file, or read by this task and unchanged since. */
export async function assertEditable(taskId: string, absPath: string, displayPath: string): Promise<void> {
  let st: { mtimeMs: number; size: number };
  try {
    st = await fs.stat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const seen = seenByTask.get(taskId)?.get(key(absPath));
  if (!seen) throw new Error(`File has not been read yet : lis "${displayPath}" avec fs.read avant de le modifier.`);
  if (seen.mtimeMs !== st.mtimeMs || seen.size !== st.size) {
    throw new Error(`"${displayPath}" a été modifié sur le disque depuis ta dernière lecture : relis-le avec fs.read avant de le modifier.`);
  }
}

export function forgetTask(taskId: string): void {
  seenByTask.delete(taskId);
}

/**
 * Writes through `<file>.<random>.mazztmp` in the same directory then renames over the target, so a crash never
 * leaves a half-written file. A UTF-8 BOM present in `previous` is kept when `content` lacks it.
 */
export async function writeAtomic(absPath: string, content: string, previous: string | null = null): Promise<string> {
  const text = previous?.startsWith('﻿') && !content.startsWith('﻿') ? '﻿' + content : content;
  // Unpredictable name created exclusively ('wx'): a file or symlink planted at the temp path is never followed.
  const tmp = `${absPath}.${randomBytes(6).toString('hex')}.mazztmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(text, 'utf-8');
    // fsync before rename: a power loss must not leave a renamed file with unflushed bytes.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, absPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
    await fs.rm(tmp, { force: true });
    throw error;
  }
  return text;
}
