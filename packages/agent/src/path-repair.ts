import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

const SKIPPED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
  '__pycache__', '.venv', 'venv', 'env', '.idea', '.vscode', '.next', '.nuxt', '.cache',
]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 12_000;

export interface PathMatchOptions {
  includeDirectories?: boolean;
  maxResults?: number;
}

/**
 * Finds workspace-relative paths whose basename matches a path the model got
 * wrong (typically a file name without its directory). The search is bounded
 * and skips dependency/build directories so a bad path cannot stall a task.
 */
export async function findWorkspacePathMatches(
  workspaceRoot: string,
  requestedPath: string,
  options: PathMatchOptions = {},
): Promise<string[]> {
  const normalized = requestedPath.replace(/\\/gu, '/').replace(/^\.\//u, '').trim();
  if (!normalized || path.isAbsolute(normalized)) return [];
  const baseName = path.posix.basename(normalized).toLowerCase();
  if (!baseName || baseName === '.' || baseName === '..') return [];
  const suffix = normalized.toLowerCase();
  const maxResults = options.maxResults ?? 5;
  const matches: string[] = [];
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: workspaceRoot, relative: '', depth: 0 },
  ];
  let inspected = 0;

  while (queue.length && matches.length < maxResults && inspected < MAX_ENTRIES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (inspected >= MAX_ENTRIES || matches.length >= maxResults) break;
      if (entry.name.startsWith('.')) continue;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (options.includeDirectories && entry.name.toLowerCase() === baseName && !matches.includes(relative)) {
          matches.push(relative);
        }
        if (SKIPPED_DIRECTORIES.has(entry.name) || current.depth >= MAX_DEPTH) continue;
        queue.push({ absolute: path.join(current.absolute, entry.name), relative, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      inspected++;
      const lower = entry.name.toLowerCase();
      if (lower === baseName || relative.toLowerCase().endsWith(`/${suffix}`)) {
        if (!matches.includes(relative)) matches.push(relative);
      }
    }
  }

  return matches
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, maxResults);
}
