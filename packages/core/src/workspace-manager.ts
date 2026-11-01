import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { WorkspaceStatus, DetectedToolchain } from '@mazz/shared';
import { detectToolchains } from '@mazz/tools';

let toolchainCache: { at: number; value: DetectedToolchain[] } | null = null;

/** Toolchain detection spawns several processes: cached for one minute. */
export function cachedToolchains(force = false): DetectedToolchain[] {
  if (!force && toolchainCache && Date.now() - toolchainCache.at < 60000) return toolchainCache.value;
  toolchainCache = { at: Date.now(), value: detectToolchains() };
  return toolchainCache.value;
}

export class WorkspaceManager {
  private currentWorkspace: string;

  constructor(initialWorkspace?: string) {
    this.currentWorkspace = initialWorkspace ? path.resolve(initialWorkspace) : process.cwd();
  }

  getWorkspaceRoot(): string {
    return this.currentWorkspace;
  }

  async setWorkspaceRoot(newPath: string): Promise<WorkspaceStatus> {
    const resolved = path.resolve(newPath);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Le chemin "${newPath}" n'est pas un dossier valide.`);
    }
    this.currentWorkspace = resolved;
    return this.getStatus();
  }

  async getStatus(): Promise<WorkspaceStatus> {
    const workspaceRoot = this.currentWorkspace;
    const name = path.basename(workspaceRoot);

    let isGit = false;
    let gitBranch: string | undefined;
    let gitDirtyCount = 0;

    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD 2>nul', {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      const statusOut = execSync('git status --short 2>nul', {
        cwd: workspaceRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }).trim();
      gitDirtyCount = statusOut ? statusOut.split('\n').length : 0;
      isGit = true;
    } catch {
      isGit = false;
    }

    // Scan for file count & languages (light traversal)
    let fileCount = 0;
    const languages = new Set<string>();

    async function walk(dir: string, depth: number) {
      if (depth > 2) return;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
          if (e.isDirectory()) {
            await walk(path.join(dir, e.name), depth + 1);
          } else if (e.isFile()) {
            fileCount++;
            const ext = path.extname(e.name).toLowerCase();
            if (ext === '.c' || ext === '.h') languages.add('C');
            else if (ext === '.cpp' || ext === '.hpp') languages.add('C++');
            else if (ext === '.py') languages.add('Python');
            else if (ext === '.ts' || ext === '.tsx') languages.add('TypeScript');
            else if (ext === '.js' || ext === '.jsx') languages.add('JavaScript');
            else if (ext === '.rs') languages.add('Rust');
            else if (ext === '.java') languages.add('Java');
          }
        }
      } catch {}
    }

    await walk(workspaceRoot, 0);

    const toolchains: DetectedToolchain[] = cachedToolchains();

    return {
      workspaceRoot,
      name,
      isGitRepo: isGit,
      gitBranch,
      gitDirtyCount,
      fileCount,
      detectedLanguages: Array.from(languages),
      toolchains,
      lastIndexedAt: Date.now(),
    };
  }
}

export const defaultWorkspaceManager = new WorkspaceManager();
