import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GgufMetadata } from '@mazz/shared';
import { parseGgufHeader } from './gguf-parser.js';

export class ModelScanner {
  private defaultFolders: string[] = [
    'D:\\Models Locaux',
    'D:\\MAZZ IA\\models\\local',
    'D:\\models',
    path.join(process.env.USERPROFILE || '', '.cache', 'lm-studio', 'models'),
    path.join(process.env.USERPROFILE || '', '.ollama', 'models'),
  ];

  async scanDirectory(dirPath: string): Promise<GgufMetadata[]> {
    const results: GgufMetadata[] = [];
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) return results;
    } catch {
      return results;
    }

    async function walk(currentDir: string, depth: number) {
      if (depth > 3) return;
      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(currentDir, e.name);
          if (e.isDirectory() && !e.name.startsWith('.')) {
            await walk(full, depth + 1);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.gguf')) {
            const meta = await parseGgufHeader(full);
            results.push(meta);
          }
        }
      } catch (err) {
        console.warn(`[models] dossier ou fichier ignoré ${currentDir} : ${(err as Error).message}`);
      }
    }

    await walk(dirPath, 0);
    return results;
  }

  async scanDefaultLocations(): Promise<GgufMetadata[]> {
    const all: GgufMetadata[] = [];
    for (const folder of this.defaultFolders) {
      const found = await this.scanDirectory(folder);
      all.push(...found);
    }
    return all;
  }
}

export const defaultModelScanner = new ModelScanner();
