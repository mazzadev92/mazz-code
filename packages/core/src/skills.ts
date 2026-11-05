import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { SkillImportError, validateImportedSkillBundle, type SkillImportBundle } from './skill-import.js';

/**
 * Skills in the SKILL.md format shared by Claude Code, Codex and Antigravity:
 * one folder per skill, a SKILL.md with a YAML front matter (name, description)
 * and optional reference files. Only names and descriptions are kept in memory;
 * the body is read when the agent (or the user with /name) loads the skill.
 */

export type SkillSource = 'studio' | 'project' | 'claude-user' | 'claude-project' | 'folder';

export interface SkillInfo {
  name: string;
  description: string;
  source: SkillSource;
  dir: string;
  provenance?: SkillProvenance;
}

export interface SkillProvenance {
  version: 1;
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: string;
  importedAt: string;
  archiveSha256: string;
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  studio: 'Studio',
  project: 'Projet (.mazz/skills)',
  'claude-user': 'Claude Code (profil)',
  'claude-project': 'Claude Code (projet)',
  folder: 'Dossier ajouté',
};

export function skillSourceLabel(s: SkillSource): string {
  return SOURCE_LABEL[s];
}

/** Minimal front matter reader: `key: value` lines, quoted or not. */
export function parseFrontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

const WORD = /[^\p{L}\p{N}]+/u;

export class SkillStore {
  private skills = new Map<string, SkillInfo>();
  private scannedAt = 0;

  constructor(
    private readonly studioDir: string,
    private readonly options: () => { folders: string[]; includeClaude: boolean; projectRoot?: string }
  ) {}

  async scan(): Promise<SkillInfo[]> {
    const o = this.options();
    const roots: Array<{ dir: string; source: SkillSource }> = [{ dir: this.studioDir, source: 'studio' }];
    if (o.projectRoot) {
      roots.push({ dir: path.join(o.projectRoot, '.mazz', 'skills'), source: 'project' });
      if (o.includeClaude) roots.push({ dir: path.join(o.projectRoot, '.claude', 'skills'), source: 'claude-project' });
    }
    if (o.includeClaude) roots.push({ dir: path.join(os.homedir(), '.claude', 'skills'), source: 'claude-user' });
    for (const f of o.folders) roots.push({ dir: f, source: 'folder' });

    const found = new Map<string, SkillInfo>();
    for (const r of roots) {
      const entries = await fs.readdir(r.dir, { withFileTypes: true }).catch(() => []); // best effort: probe: absent or unreadable path is treated as missing
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const dir = path.join(r.dir, e.name);
        const head = await readHead(path.join(dir, 'SKILL.md'));
        if (head === undefined) continue;
        const { meta } = parseFrontMatter(head);
        const name = (meta.name || e.name).trim().slice(0, 80);
        // First source wins: project skills override same-named profile ones only if listed first.
        if (found.has(name)) continue;
        found.set(name, {
          name,
          description: (meta.description || '').slice(0, 600),
          source: r.source,
          dir,
          ...(r.source === 'studio' ? { provenance: await readProvenance(dir) } : {}),
        });
      }
    }
    this.skills = found;
    this.scannedAt = Date.now();
    return this.list();
  }

  list(): SkillInfo[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async ensure(): Promise<void> {
    if (Date.now() - this.scannedAt > 30_000) await this.scan();
  }

  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /** Full SKILL.md body (front matter removed) and the skill's other files. */
  async load(name: string): Promise<{ skill: SkillInfo; body: string; files: string[] }> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill inconnu : "${name}".`);
    const text = await this.readFile(name, 'SKILL.md');
    return { skill, body: parseFrontMatter(text).body.trim(), files: await listFiles(skill.dir) };
  }

  /** Reads a reference file inside a skill folder (never outside it). */
  async readFile(name: string, rel: string): Promise<string> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill inconnu : "${name}".`);
    const root = await fs.realpath(skill.dir);
    const abs = path.resolve(root, rel);
    if (!isChildPath(root, abs)) throw new Error('Chemin hors du dossier du skill.');
    const physical = await fs.realpath(abs);
    if (!isChildPath(root, physical)) throw new Error('Le fichier de référence résout hors du dossier du skill.');
    const stat = await fs.stat(physical);
    if (!stat.isFile()) throw new Error('Le fichier de référence doit être un fichier régulier.');
    return fs.readFile(physical, 'utf-8');
  }

  /** Word overlap ranking of names and descriptions against a request. */
  search(query: string, limit = 5): Array<SkillInfo & { score: number }> {
    const words = new Set(query.toLowerCase().split(WORD).filter((w) => w.length > 3));
    if (!words.size) return [];
    const out: Array<SkillInfo & { score: number }> = [];
    for (const s of this.skills.values()) {
      const nameWords = s.name.toLowerCase().split(WORD);
      const desc = s.description.toLowerCase().split(WORD);
      const score = nameWords.filter((w) => words.has(w)).length * 3 + desc.filter((w) => words.has(w)).length;
      if (score > 0) out.push({ ...s, score });
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  async create(name: string, description: string, body: string): Promise<SkillInfo> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Nom invalide : minuscules, chiffres et tirets (64 caractères maximum).');
    const desc = description.replace(/\r?\n/g, ' ').replace(/"/g, "'").trim();
    if (!desc || !body.trim()) throw new Error('Description et instructions requises.');
    return this.commitSkillDirectory(name, async (stage) => {
      await fs.writeFile(path.join(stage, 'SKILL.md'), `---\nname: ${name}\ndescription: "${desc}"\n---\n\n${body.trim()}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    });
  }

  /** Installs a prevalidated remote bundle as one atomic directory rename; never replaces an existing skill. */
  async installImported(bundle: SkillImportBundle): Promise<SkillInfo> {
    try { validateImportedSkillBundle(bundle); }
    catch (error) { throw error; }
    return this.commitSkillDirectory(bundle.name, async (stage) => {
      const provenance: SkillProvenance = {
        version: 1,
        sourceUrl: bundle.sourceUrl,
        finalUrl: bundle.finalUrl,
        fetchedAt: bundle.fetchedAt,
        importedAt: new Date().toISOString(),
        archiveSha256: bundle.archiveSha256,
        files: bundle.files.map((file) => ({
          path: file.path,
          sizeBytes: file.bytes.length,
          sha256: createSha256(file.bytes),
        })),
      };
      for (const file of bundle.files) {
        const destination = path.resolve(stage, ...file.path.split('/'));
        if (!isChildPath(stage, destination)) throw new SkillImportError(422, `Chemin hors du skill : ${file.path}`);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const handle = await fs.open(destination, 'wx', 0o600);
        try { await handle.writeFile(file.bytes); await handle.sync(); }
        finally { await handle.close(); }
        if (createSha256(await fs.readFile(destination)) !== createSha256(file.bytes)) throw new Error(`La relecture après écriture ne correspond pas aux octets source : ${file.path}`);
      }
      await fs.writeFile(path.join(stage, 'MAZZ_PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    });
  }

  private async commitSkillDirectory(name: string, populate: (stage: string) => Promise<void>): Promise<SkillInfo> {
    await fs.mkdir(this.studioDir, { recursive: true });
    const root = await fs.realpath(this.studioDir);
    await this.scan();
    if (this.skills.has(name)) throw new Error(`Un skill nommé « ${name} » existe déjà dans les sources configurées.`);
    const target = path.resolve(root, name);
    if (!isChildPath(root, target)) throw new Error('Chemin du skill hors du dossier Studio.');
    const lock = path.join(root, `.mazz-skill-install-${name}.lock`);
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Une installation du skill « ${name} » est déjà en cours.`);
      throw error;
    }
    const stage = path.join(root, `.mazz-skill-stage-${randomUUID()}`);
    try {
      try { await fs.lstat(target); throw new Error(`Le dossier « ${name} » existe déjà ; aucun remplacement n’a été effectué.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.mkdir(stage, { mode: 0o700 });
      await populate(stage);
      // Check again immediately before commit. The lock serializes Studio installs and
      // SkillStore.create; rename exposes the completed skill as a single directory.
      try { await fs.lstat(target); throw new Error(`Le dossier « ${name} » est apparu pendant l’installation ; aucun remplacement n’a été effectué.`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await fs.rename(stage, target);
      await this.scan();
      const installed = this.skills.get(name);
      if (!installed || installed.source !== 'studio') throw new Error('Le skill installé n’a pas été découvert après le commit.');
      return installed;
    } finally {
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined); // best effort: cleanup of a temp/stale file
      await fs.rm(lock, { recursive: true, force: true }).catch(() => undefined); // best effort: cleanup of a temp/stale file
    }
  }

  /** Only skills created in the Studio folder can be removed from the interface. */
  async remove(name: string): Promise<void> {
    const s = this.skills.get(name);
    if (!s) throw new Error(`Skill inconnu : "${name}".`);
    if (s.source !== 'studio') throw new Error('Seuls les skills du Studio peuvent être supprimés ici ; les autres restent dans leur dossier d’origine.');
    await fs.rm(s.dir, { recursive: true, force: true });
    await this.scan();
  }
}

/** A skill reference must remain beneath the physical skill directory after symlinks resolve. */
function isChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function readHead(file: string): Promise<string | undefined> {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, 4096, 0);
      return buf.subarray(0, bytesRead).toString('utf-8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

async function listFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) { // best effort: probe: absent or unreadable path is treated as missing
    if (out.length >= 100) break;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await listFiles(abs, base, out);
    else if (e.name !== 'SKILL.md' && e.name.toLocaleLowerCase('en-US') !== 'mazz_provenance.json') out.push(path.relative(base, abs).replace(/\\/g, '/'));
  }
  return out;
}

async function readProvenance(dir: string): Promise<SkillProvenance | undefined> {
  const file = path.join(dir, 'MAZZ_PROVENANCE.json');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return undefined;
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as SkillProvenance;
    if (parsed?.version !== 1 || !/^https:\/\//.test(parsed.sourceUrl) || !/^https:\/\//.test(parsed.finalUrl)
      || !/^[a-f0-9]{64}$/.test(parsed.archiveSha256) || !Array.isArray(parsed.files)) return undefined;
    return parsed;
  } catch { return undefined; }
}

function createSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** skills.search: find skills relevant to the task. */
export class SkillsSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'skills.search',
    description: 'Cherche des skills (procédures et savoir-faire réutilisables) adaptés à la tâche.',
    category: 'analysis',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Mots-clés de la tâche' } }, required: ['query'] },
    requiresPermission: false,
  };

  constructor(private readonly store: SkillStore) {}

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    await this.store.ensure();
    const hits = this.store.search(String(params.query ?? ''), 8).map((s) => ({ name: s.name, description: s.description.slice(0, 240) }));
    return { success: true, output: { skills: hits, total: this.store.list().length }, durationMs: Date.now() - start };
  }
}

/** skills.load: instructions of a skill, or one of its reference files. */
export class SkillsLoadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'skills.load',
    description: 'Charge les instructions d’un skill (nom exact), ou un de ses fichiers de référence.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom du skill' },
        file: { type: 'string', description: 'Fichier de référence du skill (optionnel)' },
      },
      required: ['name'],
    },
    requiresPermission: false,
  };

  constructor(private readonly store: SkillStore) {}

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      await this.store.ensure();
      const name = String(params.name ?? '');
      if (typeof params.file === 'string' && params.file) {
        const text = await this.store.readFile(name, params.file);
        return { success: true, output: { name, file: params.file, text: text.slice(0, 30000), truncated: text.length > 30000 }, durationMs: Date.now() - start };
      }
      const { body, files } = await this.store.load(name);
      return { success: true, output: { name, instructions: body.slice(0, 30000), truncated: body.length > 30000, files }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}
