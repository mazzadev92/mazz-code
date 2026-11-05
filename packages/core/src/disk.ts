import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import * as path from 'node:path';

export interface DiskSpace { path: string; freeBytes: number; totalBytes: number }

/** Free/total space of the volume holding `p` (nearest existing ancestor). null when statfs is unavailable. */
export async function diskSpace(p: string): Promise<DiskSpace | null> {
  try {
    let dir = path.resolve(p);
    while (!existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    const s = await statfs(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    return Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0 ? { path: p, freeBytes, totalBytes } : null;
  } catch {
    return null;
  }
}
