import { execFileSync } from 'node:child_process';
import { assertSafeRepo, GIT_SAFE_CONFIG, gitEnv } from './child-env.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type {
  ITool,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  CheckpointRecord,
  RollbackOutcome,
} from '@mazz/shared';
import { resolveSafePath, physicalPath } from './fs.js';

export interface CheckpointSummary {
  id: string;
  timestamp: number;
  description: string;
  workspaceRoot?: string;
  fileCount: number;
  files: string[];
}

interface SnapshotFileIntegrity {
  exists: boolean;
  sizeBytes: number;
  sha256: string | null;
}

type ManagedCheckpoint = CheckpointRecord & {
  workspaceRoot?: string;
  /** Additive metadata; absent on records written by older MAZZ versions. */
  integrityVersion?: 1;
  fileIntegrity?: Record<string, SnapshotFileIntegrity>;
};

interface PreparedRestore {
  relPath: string;
  safePath: string;
  bytes: Buffer | null;
  integrity: SnapshotFileIntegrity;
  originalExists: boolean;
  originalIntegrity?: SnapshotFileIntegrity;
  backupPath?: string;
  stagedPath?: string;
  applied?: boolean;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function snapshotPayload(record: ManagedCheckpoint, relPath: string, previousContent: string | null): Buffer | null {
  const hasBinary = Object.prototype.hasOwnProperty.call(record.binaryFiles ?? {}, relPath);
  if (previousContent === null) {
    if (hasBinary) throw new Error(`Snapshot incohérent : ${relPath} est absent mais possède aussi un contenu binaire.`);
    return null;
  }
  if (typeof previousContent !== 'string') throw new Error(`Snapshot invalide : contenu non textuel pour ${relPath}.`);
  if (!hasBinary) return Buffer.from(previousContent, 'utf-8');

  const encoded = record.binaryFiles![relPath];
  if (previousContent !== '' || typeof encoded !== 'string') throw new Error(`Snapshot binaire incohérent pour ${relPath}.`);
  const bytes = Buffer.from(encoded, 'base64');
  // Buffer.from(base64) is deliberately forgiving; require its canonical form so
  // malformed or truncated saved data cannot be accepted as a valid snapshot.
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error(`Contenu binaire du snapshot invalide pour ${relPath}.`);
  return bytes;
}

function integrityFor(bytes: Buffer | null): SnapshotFileIntegrity {
  return bytes === null
    ? { exists: false, sizeBytes: 0, sha256: null }
    : { exists: true, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function matchesIntegrity(expected: SnapshotFileIntegrity, actual: SnapshotFileIntegrity): boolean {
  return expected.exists === actual.exists && expected.sizeBytes === actual.sizeBytes && expected.sha256 === actual.sha256;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sameWorkspace(left: string, right: string): boolean {
  const a = physicalPath(left);
  const b = physicalPath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function transactionTempPath(target: string, kind: 'stage' | 'backup'): string {
  return path.join(path.dirname(target), `.mazz-rollback-${kind}-${randomBytes(12).toString('hex')}.tmp`);
}

async function ensureParentDirectories(dir: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(dir);
  for (;;) {
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory()) throw new Error(`Le parent du fichier à restaurer n’est pas un dossier : ${cursor}`);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await fs.mkdir(directory);
      created.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory()) throw error;
    }
  }
}

async function cleanupPaths(paths: Array<string | undefined>): Promise<void> {
  for (const filePath of paths) {
    if (filePath) await fs.rm(filePath, { force: true }).catch(() => undefined);
  }
}

async function cleanupEmptyDirectories(directories: string[]): Promise<void> {
  for (const directory of [...directories].reverse()) await fs.rmdir(directory).catch(() => undefined);
}

export class CheckpointManager {
  private checkpoints = new Map<string, ManagedCheckpoint>();
  /** Called after every mutation, e.g. to persist checkpoints on disk. */
  onChange?: (records: Array<CheckpointRecord & { workspaceRoot?: string }>) => void;

  /** Restores records loaded from disk. */
  load(records: Array<CheckpointRecord & { workspaceRoot?: string }>): void {
    for (const r of records) this.checkpoints.set(r.id, r);
  }

  /**
   * Captures the pre-modification state of one file into checkpoint `id`.
   * Paths come from tool calls already validated against the access policy
   * (project or user-allowed directory), so they are resolved as given.
   * creating the checkpoint if needed. A file already captured keeps its
   * first (oldest) state, so rollback returns to the state before the task.
   */
  async captureFile(workspaceRoot: string, id: string, description: string, relPath: string): Promise<boolean> {
    const safe = resolveSafePath(workspaceRoot, relPath);
    const canonicalRoot = physicalPath(workspaceRoot);
    let record = this.checkpoints.get(id);
    const created = !record;
    let workspaceBound = false;
    if (record?.workspaceRoot && !sameWorkspace(record.workspaceRoot, canonicalRoot)) {
      throw new Error('Le checkpoint appartient à un autre workspace.');
    }

    // A leaf symlink cannot be restored safely by this transaction: replacing
    // its path would replace the link, while reading it would snapshot its target.
    let capturedBytes: Buffer | null;
    try {
      const stat = await fs.lstat(safe);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`La capture exige un fichier ordinaire, sans lien symbolique : ${relPath}.`);
      capturedBytes = await fs.readFile(safe);
    } catch (error) {
      if (!isMissing(error)) throw error;
      capturedBytes = null;
    }

    if (!record) {
      record = { id, timestamp: Date.now(), description, files: {}, workspaceRoot: canonicalRoot, integrityVersion: 1, fileIntegrity: {} };
      this.checkpoints.set(id, record);
    } else if (!record.workspaceRoot) {
      // Bind an unscoped legacy record to the workspace that first extends it.
      record.workspaceRoot = canonicalRoot;
      workspaceBound = true;
    }
    if (!(relPath in record.files)) {
      const managed = record as ManagedCheckpoint;
      if (managed.integrityVersion === undefined && managed.fileIntegrity === undefined) {
        managed.fileIntegrity = {};
        for (const [savedPath, savedText] of Object.entries(record.files)) {
          managed.fileIntegrity[savedPath] = integrityFor(snapshotPayload(managed, savedPath, savedText));
        }
      }
      if (capturedBytes !== null) {
        const bytes = capturedBytes;
        const text=bytes.toString('utf-8');
        if(bytes.includes(0)||!Buffer.from(text,'utf-8').equals(bytes)){
          (record.binaryFiles ??= {})[relPath]=bytes.toString('base64');record.files[relPath]='';
        }else record.files[relPath]=text;
        (managed.fileIntegrity ??= {})[relPath] = integrityFor(bytes);
      } else {
        record.files[relPath]=null;
        (managed.fileIntegrity ??= {})[relPath] = integrityFor(null);
      }
      managed.integrityVersion = 1;
      this.onChange?.(Array.from(this.checkpoints.values()));
    } else if (workspaceBound) this.onChange?.(Array.from(this.checkpoints.values()));
    return created;
  }

  list(): CheckpointSummary[] {
    return Array.from(this.checkpoints.values())
      .map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        description: r.description,
        workspaceRoot: r.workspaceRoot,
        fileCount: Object.keys(r.files).length,
        files: Object.keys(r.files),
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  delete(id: string): boolean {
    const ok = this.checkpoints.delete(id);
    if (ok) this.onChange?.(Array.from(this.checkpoints.values()));
    return ok;
  }

  async createCheckpoint(
    workspaceRoot: string,
    id: string,
    description: string,
    filePaths: string[]
  ): Promise<CheckpointRecord> {
    for(const rel of filePaths)await this.captureFile(workspaceRoot,id,description,rel);
    const record=this.checkpoints.get(id) ?? {id,timestamp:Date.now(),description,files:{},workspaceRoot};
    this.checkpoints.set(id,record);return record;
  }

  async rollback(workspaceRoot: string, id: string): Promise<RollbackOutcome> {
    const record = this.checkpoints.get(id);
    if (!record) {
      return {
        success: false,
        checkpointId: id,
        restoredFiles: [],
        errors: [`Checkpoint "${id}" introuvable.`],
      };
    }
    if (record.workspaceRoot && !sameWorkspace(record.workspaceRoot, workspaceRoot)) return { success: false, checkpointId: id, restoredFiles: [], errors: ['Le checkpoint appartient à un autre workspace.'] };

    const restoredFiles: string[] = [];
    const errors: string[] = [];
    const prepared: PreparedRestore[] = [];
    const hasIntegrity = record.integrityVersion !== undefined || record.fileIntegrity !== undefined;

    // Validate the entire saved record before changing a single workspace file.
    // Old records without digests remain readable; their available payload is
    // still decoded strictly and every restored byte is verified below.
    try {
      if (record.integrityVersion !== undefined && record.integrityVersion !== 1) throw new Error('Version d’intégrité du snapshot non prise en charge.');
      for (const relPath of Object.keys(record.binaryFiles ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(record.files, relPath)) throw new Error(`Snapshot incohérent : contenu binaire orphelin pour ${relPath}.`);
      }
      for (const relPath of Object.keys(record.fileIntegrity ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(record.files, relPath)) throw new Error(`Snapshot incohérent : empreinte orpheline pour ${relPath}.`);
      }
      for (const [relPath, previousContent] of Object.entries(record.files)) {
        const safePath = resolveSafePath(workspaceRoot, relPath);
        const bytes = snapshotPayload(record, relPath, previousContent);
        const actualIntegrity = integrityFor(bytes);
        if (hasIntegrity) {
          const expected = record.fileIntegrity?.[relPath];
          if (!expected || !matchesIntegrity(expected, actualIntegrity)) throw new Error(`Contenu du snapshot corrompu pour ${relPath}.`);
        }
        let originalExists = false;
        try {
          const current = await fs.lstat(safePath);
          if (!current.isFile()) throw new Error(`La destination n’est pas un fichier ordinaire : ${relPath}.`);
          originalExists = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        const normalized = path.resolve(safePath);
        const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
        if (prepared.some((entry) => (process.platform === 'win32' ? path.resolve(entry.safePath).toLowerCase() : path.resolve(entry.safePath)) === key)) {
          throw new Error(`Plusieurs entrées du snapshot désignent le même chemin : ${relPath}.`);
        }
        prepared.push({ relPath, safePath, bytes, integrity: actualIntegrity, originalExists });
      }
      if (hasIntegrity && Object.keys(record.fileIntegrity ?? {}).length !== Object.keys(record.files).length) {
        throw new Error('Le manifeste d’intégrité ne couvre pas exactement les fichiers du snapshot.');
      }
    } catch (err) {
      return { success: false, checkpointId: id, restoredFiles: [], errors: [`Snapshot refusé avant restauration : ${(err as Error).message}`] };
    }

    const createdDirectories: string[] = [];
    try {
      // Stage all target bytes and copies of all existing files first. If disk
      // space, permissions, or a path error blocks preparation, workspace files
      // have not yet been changed.
      for (const file of prepared) {
        if (file.bytes !== null || file.originalExists) {
          await ensureParentDirectories(path.dirname(file.safePath), createdDirectories);
        }
        let nowExists = false;
        try {
          const current = await fs.lstat(file.safePath);
          if (!current.isFile()) throw new Error(`La destination n’est pas un fichier ordinaire : ${file.relPath}.`);
          nowExists = true;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (nowExists !== file.originalExists) throw new Error(`La destination a changé pendant la préparation : ${file.relPath}.`);
        if (nowExists) {
          const current = await fs.readFile(file.safePath);
          file.originalIntegrity = integrityFor(current);
          file.backupPath = transactionTempPath(file.safePath, 'backup');
          await fs.writeFile(file.backupPath, current, { flag: 'wx' });
          const backup = await fs.readFile(file.backupPath);
          if (!matchesIntegrity(file.originalIntegrity, integrityFor(backup))) throw new Error(`La copie de sauvegarde temporaire est incomplète : ${file.relPath}.`);
        } else {
          file.originalIntegrity = integrityFor(null);
        }
        if (file.bytes !== null) {
          file.stagedPath = transactionTempPath(file.safePath, 'stage');
          await fs.writeFile(file.stagedPath, file.bytes, { flag: 'wx' });
          const staged = await fs.readFile(file.stagedPath);
          if (!matchesIntegrity(file.integrity, integrityFor(staged))) throw new Error(`Le fichier temporaire ne correspond pas au snapshot : ${file.relPath}.`);
        }
      }
    } catch (err) {
      await cleanupPaths(prepared.flatMap((file) => [file.stagedPath, file.backupPath]));
      await cleanupEmptyDirectories(createdDirectories);
      return { success: false, checkpointId: id, restoredFiles: [], errors: [`Préparation du rollback refusée : ${(err as Error).message}`] };
    }

    for (const file of prepared) {
      try {
        // Detect a concurrent change between staging and commit. Never overwrite
        // bytes that were not present when this restore transaction was prepared.
        if (file.originalExists) {
          const current = await fs.readFile(file.safePath);
          const backup = await fs.readFile(file.backupPath!);
          if (!matchesIntegrity(file.originalIntegrity!, integrityFor(current)) || !matchesIntegrity(file.originalIntegrity!, integrityFor(backup))) {
            throw new Error(`Le fichier a changé depuis la préparation : ${file.relPath}.`);
          }
        } else {
          try {
            await fs.lstat(file.safePath);
            throw new Error(`Le chemin est apparu depuis la préparation : ${file.relPath}.`);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }

        if (file.bytes === null) {
          if (file.originalExists) {
            await fs.unlink(file.safePath);
            file.applied = true;
          }
          try {
            await fs.lstat(file.safePath);
            throw new Error('Le chemin devait rester absent après le rollback.');
          } catch (e) {
            if (!isMissing(e)) throw e;
          }
          restoredFiles.push(`${file.relPath} (supprimé)`);
        } else {
          if (file.originalExists) {
            await fs.rename(file.stagedPath!, file.safePath);
            file.stagedPath = undefined;
          } else {
            // link() creates the missing destination atomically and refuses to
            // replace a path that appeared after the last absence check.
            await fs.link(file.stagedPath!, file.safePath);
            file.applied = true;
            await fs.unlink(file.stagedPath!);
            file.stagedPath = undefined;
          }
          file.applied = true;
          const restored = await fs.readFile(file.safePath);
          if (!matchesIntegrity(file.integrity, integrityFor(restored))) throw new Error(`La relecture après restauration ne correspond pas au snapshot : ${file.relPath}.`);
          restoredFiles.push(file.relPath);
        }
      } catch (err) {
        errors.push(`Erreur lors de la restauration de ${file.relPath}: ${(err as Error).message}`);
        break;
      }
    }

    if (errors.length > 0) {
      for (const file of [...prepared].reverse()) {
        if (!file.applied) continue;
        try {
          if (file.originalExists) {
            await fs.rename(file.backupPath!, file.safePath);
            file.backupPath = undefined;
            const restoredOriginal = await fs.readFile(file.safePath);
            if (!matchesIntegrity(file.originalIntegrity!, integrityFor(restoredOriginal))) throw new Error('La compensation ne correspond pas à l’état antérieur.');
          } else {
            try {
              const current = await fs.lstat(file.safePath);
              if (!current.isFile()) throw new Error('La compensation refuse de supprimer un chemin non fichier.');
              await fs.unlink(file.safePath);
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
            try {
              await fs.lstat(file.safePath);
              throw new Error('Le chemin créé par le rollback subsiste après compensation.');
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
          }
          file.applied = false;
          const restoredIndex = restoredFiles.findIndex((name) => name === file.relPath || name === `${file.relPath} (supprimé)`);
          if (restoredIndex >= 0) restoredFiles.splice(restoredIndex, 1);
        } catch (error) {
          errors.push(`Échec de compensation pour ${file.relPath}: ${(error as Error).message}`);
        }
      }
    }

    await cleanupPaths(prepared.flatMap((file) => [file.stagedPath, file.backupPath]));
    if (errors.length > 0) await cleanupEmptyDirectories(createdDirectories);

    return {
      success: errors.length === 0,
      checkpointId: id,
      restoredFiles,
      errors,
    };
  }

  getCheckpoint(id: string): CheckpointRecord | undefined {
    return this.checkpoints.get(id);
  }
}

export const globalCheckpointManager = new CheckpointManager();

export class GitStatusTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'git.status',
    description: 'Renvoie le statut Git actuel du workspace (branche, fichiers modifiés, non suivis).',
    category: 'git',
    parameters: {
      type: 'object',
      properties: {},
    },
    requiresPermission: false,
  };

  async execute(_params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      let isGit = false;
      let branch = '';
      let statusOutput = '';

      // Outside the try: a refused repository is an error, not "no git repository here".
      assertSafeRepo(context.workspaceRoot);
      try {
        const opts = { cwd: context.workspaceRoot, encoding: 'utf-8' as const, windowsHide: true, timeout: 20_000, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
        branch = execFileSync('git', [...GIT_SAFE_CONFIG, 'rev-parse', '--abbrev-ref', 'HEAD'], opts).trim();
        statusOutput = execFileSync('git', [...GIT_SAFE_CONFIG, 'status', '--short'], opts).trim();
        isGit = true;
      } catch {
        isGit = false;
      }

      const files = statusOutput
        ? statusOutput.split('\n').map((line) => {
            const status = line.slice(0, 2).trim();
            const filePath = line.slice(3).trim();
            return { status, filePath };
          })
        : [];

      return {
        success: true,
        output: {
          isGitRepo: isGit,
          branch: branch || undefined,
          dirtyCount: files.length,
          files,
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
