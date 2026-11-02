import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { syntaxGate } from './syntax-gate.js';
import { assertEditable, recordSeen, writeAtomic } from './edit-guard.js';
import { isSecretFile } from './default-deny.js';

export const FS_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const FS_SEARCH_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const FS_SEARCH_MAX_FILES = 5000;
export const FS_SEARCH_MAX_RESULTS = 300;
export const FS_SEARCH_MAX_DURATION_MS = 10000;

/** Read at most maxBytes plus one byte, so a file that grows after stat stays bounded. */
async function readAtMost(target: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await fs.open(target, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes) return null;
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

/** True when `target` is `root` itself or inside it (case-insensitive on Windows). */
export function isInside(root: string, target: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  return norm(t) === norm(r) || norm(t).startsWith(norm(r.endsWith(path.sep) ? r : r + path.sep));
}

/** Resolve junctions/symlinks even when the final output file does not exist yet. */
export function physicalPath(target: string): string {
  let cursor=path.resolve(target);
  const tail:string[]=[];
  for(;;){
    try{return path.join(realpathSync.native(cursor),...tail);}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code!=='ENOENT' && code!=='ENOTDIR')throw error;
      const parent=path.dirname(cursor);
      if(parent===cursor)throw error;
      tail.unshift(path.basename(cursor));cursor=parent;
    }
  }
}

/** Windows paths of 260 characters or more get the \\?\ prefix (spec 03): no ENAMETOOLONG in deep trees. */
export const WINDOWS_MAX_PATH = 260;
export function withLongPathPrefix(target: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || target.length < WINDOWS_MAX_PATH || target.startsWith('\\\\')) return target;
  return path.win32.toNamespacedPath(target);
}

/**
 * Resolves a tool path. Relative paths are relative to the project; absolute
 * paths are accepted inside the project or inside a directory the user allowed.
 */
export function resolveSafePath(workspaceRoot: string, targetPath: string, allowedRoots: string[] = []): string {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const physical=physicalPath(resolved);
  const roots=[workspaceRoot,...allowedRoots];
  if (roots.some(root=>isInside(physicalPath(root),physical))) return withLongPathPrefix(resolved);
  throw new Error(`Accès refusé : "${targetPath}" est hors du projet et des dossiers autorisés. L’utilisateur peut autoriser ce dossier ; sinon utilise un chemin relatif au projet.`);
}

export class FsListTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.list',
    description: 'Liste les fichiers et sous-dossiers dans un chemin relatif du workspace.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif dans le workspace (défaut ".")' },
      },
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const relPath = typeof params.path === 'string' && params.path.trim() ? params.path.trim() : '.';
      const safePath = resolveSafePath(context.workspaceRoot, relPath, context.allowedRoots);
      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const items = entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        relativePath: path.relative(context.workspaceRoot, path.join(safePath, e.name)).replace(/\\/g, '/'),
      }));
      return {
        success: true,
        output: { directory: relPath, count: items.length, items },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

/** Lines returned by fs.read when no range is given. */
const DEFAULT_READ_LINES = 2000;

export class FsReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.read',
    description: 'Lit un fichier texte du workspace. Pour un gros fichier, lire une plage avec offset (première ligne, à partir de 1) et limit (nombre de lignes).',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif du fichier à lire' },
        offset: { type: 'integer', description: 'Première ligne à lire (1 = début du fichier)' },
        limit: { type: 'integer', description: 'Nombre de lignes à lire à partir de offset' },
        maxLines: { type: 'number', description: 'Ancien nom de limit (lignes depuis le début)' },
      },
      required: ['path'],
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.path !== 'string') throw new Error('Paramètre "path" manquant ou invalide.');
      const requestedPath = params.path;
      const candidates = [requestedPath];
      if (!path.isAbsolute(requestedPath)) {
        const segments = requestedPath.split(/[\\/]+/).filter(Boolean);
        const rootName = path.basename(path.resolve(context.workspaceRoot));
        const sameRootName = process.platform === 'win32'
          ? segments[0]?.toLocaleLowerCase() === rootName.toLocaleLowerCase()
          : segments[0] === rootName;
        if (sameRootName && segments.length > 1) candidates.push(segments.slice(1).join(path.sep));
      }

      let safePath: string | undefined;
      let content: string | undefined;
      let lastReadError: unknown;
      for (const candidate of candidates) {
        const candidatePath = resolveSafePath(context.workspaceRoot, candidate, context.allowedRoots);
        try {
          content = await fs.readFile(candidatePath, 'utf-8');
          safePath = candidatePath;
          break;
        } catch (error) {
          lastReadError = error;
          // Retry without a redundant workspace-name prefix only when the
          // literal path is absent. Permission, boundary, and type errors stay visible.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === candidates.at(-1)) throw error;
        }
      }
      if (!safePath || content === undefined) throw lastReadError ?? new Error('Fichier introuvable.');
      await recordSeen(context.taskId, safePath);
      // Range read (offset/limit, 1-based). Small models often ask for 1 line and then never see the code:
      // a limit below 40 lines is widened to 40. Without a range the file is returned up to
      // DEFAULT_READ_LINES lines; the result says which lines were read so the model can ask for the rest.
      const lines = content.split('\n');
      const totalLines = lines.length;
      const offset = typeof params.offset === 'number' && params.offset >= 1 ? Math.floor(params.offset) : 1;
      const askedLimit = typeof params.limit === 'number' ? params.limit : typeof params.maxLines === 'number' ? params.maxLines : undefined;
      const limit = askedLimit !== undefined && askedLimit > 0 ? Math.max(40, Math.floor(askedLimit)) : DEFAULT_READ_LINES;
      const startLine = Math.min(offset, totalLines);
      const endLine = Math.min(totalLines, startLine + limit - 1);
      const partial = startLine > 1 || endLine < totalLines;
      return {
        success: true,
        output: {
          path: path.relative(context.workspaceRoot, safePath).replace(/\\/g, '/'),
          content: partial ? lines.slice(startLine - 1, endLine).join('\n') : content,
          startLine,
          endLine,
          totalLines,
          totalBytes: Buffer.byteLength(content, 'utf-8'),
          ...(partial ? { note: `Lignes ${startLine}-${endLine} sur ${totalLines}. Lire la suite avec offset=${endLine + 1}.` } : {}),
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

export class FsWriteTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.write',
    description: 'Crée ou remplace un fichier avec le contenu spécifié dans le workspace.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif du fichier à écrire' },
        content: { type: 'string', description: 'Contenu texte à écrire' },
      },
      required: ['path', 'content'],
    },
    requiresPermission: true,
    isDestructive: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.path !== 'string') throw new Error('Paramètre "path" manquant.');
      if (typeof params.content !== 'string') throw new Error('Paramètre "content" manquant.');
      const safePath = resolveSafePath(context.workspaceRoot, params.path, context.allowedRoots);
      await assertEditable(context.taskId, safePath, params.path);

      let oldContent: string | null = null;
      try {
        oldContent = await fs.readFile(safePath, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        oldContent = null;
      }

      const syntaxError = await syntaxGate(safePath, params.content, oldContent);
      if (syntaxError) throw new Error(syntaxError);
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await writeAtomic(safePath, params.content, oldContent);
      await recordSeen(context.taskId, safePath);

      context.emitEvent({
        type: 'diff',
        taskId: context.taskId,
        timestamp: Date.now(),
        filePath: params.path,
        oldContent,
        newContent: params.content,
        patch: `--- a/${params.path}\n+++ b/${params.path}\n@@ -1,${oldContent ? oldContent.split('\n').length : 0} +1,${params.content.split('\n').length} @@`,
      });

      return {
        success: true,
        output: { path: params.path, bytesWritten: Buffer.byteLength(params.content, 'utf-8'), isNew: oldContent === null },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

export class FsDeleteTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.delete',
    description: 'Supprime un fichier ou dossier dans le workspace.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin relatif à supprimer' },
      },
      required: ['path'],
    },
    requiresPermission: true,
    isDestructive: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.path !== 'string') throw new Error('Paramètre "path" manquant.');
      const safePath = resolveSafePath(context.workspaceRoot, params.path, context.allowedRoots);
      const stat = await fs.stat(safePath);
      if (stat.isDirectory()) {
        await fs.rm(safePath, { recursive: true, force: true });
      } else {
        await fs.unlink(safePath);
      }
      return {
        success: true,
        output: { path: params.path, deleted: true },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}

export class FsSearchTextTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'fs.search_text',
    description: 'Recherche une chaîne ou expression régulière dans les fichiers du workspace.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texte ou motif à rechercher' },
        extension: { type: 'string', description: 'Filtre d’extension facultatif (ex. ".c", ".ts")' },
        maxResults: { type: 'number', description: 'Nombre maximum de correspondances' },
      },
      required: ['query'],
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.query !== 'string') throw new Error('Paramètre "query" manquant.');
      const query = params.query;
      if (!query.trim()) throw new Error('Paramètre "query" vide : indique un texte exact à rechercher.');
      if (query.length > 10000) throw new Error('La requête dépasse la limite de 10 000 caractères.');
      const ext = typeof params.extension === 'string' ? params.extension.toLowerCase() : undefined;
      const requestedResults = typeof params.maxResults === 'number' && Number.isFinite(params.maxResults)
        ? Math.max(1, Math.floor(params.maxResults))
        : 50;
      const maxResults = Math.min(requestedResults, FS_SEARCH_MAX_RESULTS);

      const results: Array<{ file: string; line: number; text: string }> = [];
      const limitReasons = new Set<string>();
      let scannedFiles = 0;
      let scannedBytes = 0;
      let skippedLargeFiles = 0;
      let skippedUnreadableFiles = 0;
      let skippedBinaryFiles = 0;
      const deadline = start + FS_SEARCH_MAX_DURATION_MS;
      const physicalRoot = physicalPath(context.workspaceRoot);
      const visitedDirectories = new Set<string>();

      const stopFor = (reason: string) => limitReasons.add(reason);

      async function walk(dir: string, depth = 0): Promise<void> {
        if (depth > 64) { stopFor('directory_depth_limit'); return; }
        if (results.length >= maxResults) { stopFor('result_limit'); return; }
        if (scannedFiles >= FS_SEARCH_MAX_FILES) { stopFor('file_count_limit'); return; }
        if (scannedBytes >= FS_SEARCH_MAX_TOTAL_BYTES) { stopFor('workspace_byte_limit'); return; }
        if (Date.now() >= deadline) { stopFor('time_limit'); return; }
        let physicalDir: string;
        try {
          physicalDir = physicalPath(dir);
        } catch {
          skippedUnreadableFiles++;
          return;
        }
        if (!isInside(physicalRoot, physicalDir)) { stopFor('outside_workspace_path'); return; }
        const directoryKey = process.platform === 'win32' ? physicalDir.toLowerCase() : physicalDir;
        if (visitedDirectories.has(directoryKey)) { stopFor('directory_cycle_or_alias'); return; }
        visitedDirectories.add(directoryKey);
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          skippedUnreadableFiles++;
          return;
        }
        for (const entry of entries) {
          if (results.length >= maxResults) { stopFor('result_limit'); break; }
          if (scannedFiles >= FS_SEARCH_MAX_FILES) { stopFor('file_count_limit'); break; }
          if (scannedBytes >= FS_SEARCH_MAX_TOTAL_BYTES) { stopFor('workspace_byte_limit'); break; }
          if (Date.now() >= deadline) { stopFor('time_limit'); break; }
          // Ignore heavy or hidden folders
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            stopFor('symbolic_link_skipped');
            continue;
          }
          if (entry.isDirectory()) {
            await walk(fullPath, depth + 1);
          } else if (entry.isFile()) {
            if (ext && !entry.name.toLowerCase().endsWith(ext)) continue;
            if (isSecretFile(entry.name)) continue;
            try {
              const physicalFile = physicalPath(fullPath);
              if (!isInside(physicalRoot, physicalFile)) {
                stopFor('outside_workspace_path');
                continue;
              }
              const stat = await fs.stat(fullPath);
              if (stat.size > FS_SEARCH_MAX_FILE_BYTES) {
                skippedLargeFiles++;
                stopFor('file_size_limit');
                continue;
              }
              const remaining = FS_SEARCH_MAX_TOTAL_BYTES - scannedBytes;
              if (stat.size > remaining) {
                stopFor('workspace_byte_limit');
                break;
              }
              const bytes = await readAtMost(fullPath, Math.min(FS_SEARCH_MAX_FILE_BYTES, remaining));
              if (!bytes) {
                skippedLargeFiles++;
                stopFor(stat.size > remaining ? 'workspace_byte_limit' : 'file_size_limit');
                continue;
              }
              scannedFiles++;
              scannedBytes += bytes.byteLength;
              if (bytes.includes(0)) {
                skippedBinaryFiles++;
                continue;
              }
              const content = bytes.toString('utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(query)) {
                  results.push({
                    file: path.relative(context.workspaceRoot, fullPath).replace(/\\/g, '/'),
                    line: i + 1,
                    text: lines[i].trim(),
                  });
                  if (results.length >= maxResults) { stopFor('result_limit'); break; }
                }
              }
            } catch {
              skippedUnreadableFiles++;
            }
          }
        }
      }

      await walk(context.workspaceRoot);
      return {
        success: true,
        output: {
          query,
          count: results.length,
          matches: results,
          truncated: limitReasons.size > 0,
          limitReasons: [...limitReasons],
          scannedFiles,
          scannedBytes,
          skippedLargeFiles,
          skippedUnreadableFiles,
          skippedBinaryFiles,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}
