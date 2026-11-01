import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { parseFrontMatter } from './skills.js';

/** Durable memory is stored as inspectable Markdown with a versioned manifest. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'procedural' | 'quality';
export type MemoryScope = 'global' | 'project';
export type MemoryOrigin = 'user' | 'agent';

export interface MemoryEntry {
  name: string;
  description: string;
  type: MemoryType;
  scope: MemoryScope;
  workspaceId?: string;
  version: number;
  contentSha256: string;
  integrity: 'verified' | 'legacy' | 'modified';
  origin: MemoryOrigin;
  sourceTaskId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySaveMetadata {
  origin?: MemoryOrigin;
  taskId?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEMORY_TYPES: MemoryType[] = ['user', 'feedback', 'project', 'reference', 'episodic', 'procedural', 'quality'];
const PROJECT_TYPES = new Set<MemoryType>(['project', 'episodic', 'procedural', 'quality']);
const GLOBAL_TYPES = new Set<MemoryType>(['user', 'feedback', 'reference']);
const MAX_CONTENT_BYTES = 1024 * 1024;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function numberMeta(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeDescription(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/["\\]/g, "'").trim().slice(0, 300);
}

function frontMatterValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"`;
}

function parseType(value: string | undefined): MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType) ? value as MemoryType : 'project';
}

function requireType(value: string): MemoryType {
  if (!MEMORY_TYPES.includes(value as MemoryType)) throw new Error(`Type de mémoire invalide : ${value}`);
  return value as MemoryType;
}

function parseScope(value: string | undefined, fallback: MemoryScope): MemoryScope {
  return value === 'project' || value === 'global' ? value : fallback;
}

export class MemoryStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly scope: MemoryScope;
  private readonly workspaceId?: string;

  constructor(private readonly dir: string, options: { scope?: MemoryScope; workspaceRoot?: string } = {}) {
    this.scope = options.scope ?? 'global';
    this.workspaceId = options.workspaceRoot ? MemoryStore.workspaceId(options.workspaceRoot) : undefined;
  }

  static workspaceId(workspaceRoot: string): string {
    const normalized = path.resolve(workspaceRoot).replace(/\\/g, '/').replace(/\/$/, '');
    return sha256(process.platform === 'win32' ? normalized.toLowerCase() : normalized).slice(0, 32);
  }

  /** Project memories are isolated by a stable hash of the resolved workspace path. */
  forProject(workspaceRoot: string): MemoryStore {
    const id = MemoryStore.workspaceId(workspaceRoot);
    return new MemoryStore(path.join(this.dir, 'projects', id), { scope: 'project', workspaceRoot });
  }

  get directory(): string { return this.dir; }
  get memoryScope(): MemoryScope { return this.scope; }

  private file(name: string): string {
    if (!NAME_RE.test(name)) throw new Error('Nom de mémoire invalide : minuscules, chiffres et tirets.');
    return path.join(this.dir, `${name}.md`);
  }

  private async entryFor(name: string, text: string, file: string): Promise<MemoryEntry> {
    const { meta, body } = parseFrontMatter(text);
    const stat = await fs.stat(file);
    const content = body.trim();
    const type = parseType(meta.type);
    const createdAt = numberMeta(meta.createdAt, stat.birthtimeMs || stat.mtimeMs);
    return {
      name,
      description: meta.description ?? '',
      type,
      scope: parseScope(meta.scope, this.scope),
      ...(meta.workspaceId || this.workspaceId ? { workspaceId: meta.workspaceId || this.workspaceId } : {}),
      version: Math.max(1, Math.floor(numberMeta(meta.version, 1))),
      contentSha256: meta.contentSha256 || sha256(content),
      integrity: meta.contentSha256 ? (meta.contentSha256 === sha256(content) ? 'verified' : 'modified') : 'legacy',
      origin: meta.origin === 'agent' ? 'agent' : 'user',
      ...(meta.sourceTaskId ? { sourceTaskId: meta.sourceTaskId } : {}),
      createdAt,
      updatedAt: numberMeta(meta.updatedAt, stat.mtimeMs),
    };
  }

  async list(): Promise<MemoryEntry[]> {
    const files = (await fs.readdir(this.dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    })).filter((f) => f.endsWith('.md'));
    const out: MemoryEntry[] = [];
    for (const f of files) {
      const file = path.join(this.dir, f);
      const text = await fs.readFile(file, 'utf-8');
      out.push(await this.entryFor(f.slice(0, -3), text, file));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  async read(name: string): Promise<{ entry: MemoryEntry; content: string }> {
    const file = this.file(name);
    const text = await fs.readFile(file, 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`Mémoire inconnue : ${name}`);
      throw err;
    });
    const { body } = parseFrontMatter(text);
    return { entry: await this.entryFor(name, text, file), content: body.trim() };
  }

  /** Write full content atomically, retain replaced revisions, and serialize concurrent updates. */
  async save(name: string, description: string, type: string, content: string, metadata: MemorySaveMetadata = {}): Promise<MemoryEntry> {
    const task = this.writeQueue.then(async () => {
      const t = requireType(type);
      const desc = safeDescription(description);
      const body = content.trim();
      if (!body) throw new Error('Contenu vide.');
      if (Buffer.byteLength(body, 'utf8') > MAX_CONTENT_BYTES) throw new Error(`Contenu mémoire supérieur à ${MAX_CONTENT_BYTES} octets.`);
      const file = this.file(name);
      await fs.mkdir(this.dir, { recursive: true });
      const previous = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return undefined;
        throw err;
      });
      const now = Date.now();
      const previousMeta = previous ? parseFrontMatter(previous).meta : {};
      const version = Math.max(0, Math.floor(numberMeta(previousMeta.version, previous ? 1 : 0))) + 1;
      const createdAt = numberMeta(previousMeta.createdAt, now);
      if (previous) {
        const historyDir = path.join(this.dir, '.history', name);
        await fs.mkdir(historyDir, { recursive: true });
        const historyFile = path.join(historyDir, `v${Math.max(1, version - 1)}.md`);
        await fs.writeFile(historyFile, previous, { encoding: 'utf8', flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'EEXIST') throw err;
        });
      }
      const origin = metadata.origin ?? 'user';
      const taskId = metadata.taskId && /^[a-zA-Z0-9_-]{1,120}$/.test(metadata.taskId) ? metadata.taskId : undefined;
      const data = [
        '---',
        `name: ${name}`,
        `description: ${frontMatterValue(desc)}`,
        `type: ${t}`,
        `scope: ${this.scope}`,
        ...(this.workspaceId ? [`workspaceId: ${this.workspaceId}`] : []),
        `version: ${version}`,
        `origin: ${origin}`,
        ...(taskId ? [`sourceTaskId: ${taskId}`] : []),
        `contentSha256: ${sha256(body)}`,
        `createdAt: ${createdAt}`,
        `updatedAt: ${now}`,
        '---',
        '',
        body,
        '',
      ].join('\n');
      const temp = path.join(this.dir, `.${name}.${process.pid}.${now}.tmp`);
      try {
        await fs.writeFile(temp, data, { encoding: 'utf8', flag: 'wx' });
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      return this.entryFor(name, data, file);
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async remove(name: string): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const file = this.file(name);
      await fs.rm(file, { force: true });
      // Deletion from the UI is an erasure request: remove revision copies too.
      await fs.rm(path.join(this.dir, '.history', name), { recursive: true, force: true });
    });
    this.writeQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  /** Word overlap over name, description and full memory content. */
  async search(query: string, limit = 8): Promise<Array<MemoryEntry & { excerpt: string }>> {
    const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2));
    const scored: Array<MemoryEntry & { excerpt: string; score: number }> = [];
    for (const e of await this.list()) {
      const { content } = await this.read(e.name);
      const hay = `${e.name.replace(/-/g, ' ')} ${e.description} ${content}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      const score = hay.filter((w) => words.has(w)).length;
      if (e.integrity !== 'modified' && (score > 0 || !words.size)) scored.push({ ...e, excerpt: content.slice(0, 300), score });
    }
    return scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit).map(({ score: _s, ...rest }) => rest);
  }

  async searchForProject(query: string, workspaceRoot: string, limit = 8): Promise<Array<MemoryEntry & { excerpt: string }>> {
    const [global, project] = await Promise.all([this.search(query, limit), this.forProject(workspaceRoot).search(query, limit)]);
    return [...project, ...global.filter((entry) => GLOBAL_TYPES.has(entry.type))].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  async readForProject(name: string, workspaceRoot: string, scope?: MemoryScope): Promise<{ entry: MemoryEntry; content: string }> {
    if (scope === 'global') return this.read(name);
    const projectStore = this.forProject(workspaceRoot);
    if (scope === 'project') return projectStore.read(name);
    try { return await projectStore.read(name); } catch (err) {
      if (!(err instanceof Error) || !err.message.startsWith('Mémoire inconnue :')) throw err;
      const global = await this.read(name);
      if (!GLOBAL_TYPES.has(global.entry.type)) throw new Error(`Cette mémoire historique de type ${global.entry.type} est globale et n'est plus injectée dans les projets. Associez-la explicitement au projet actif.`);
      return global;
    }
  }

  /** Project and user facts are both available to the active project, with explicit scope in each line. */
  async indexForProject(workspaceRoot: string, maxChars = 3000): Promise<string> {
    const [global, project] = await Promise.all([this.list(), this.forProject(workspaceRoot).list()]);
    const lines: string[] = [];
    let size = 0;
    for (const e of [...project, ...global.filter((entry) => GLOBAL_TYPES.has(entry.type))].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const line = `- [${e.scope}/${e.type}; v${e.version}; sha256:${e.contentSha256.slice(0, 12)}] ${e.name} : ${e.description}`;
      if (e.integrity === 'modified') continue;
      if (size + line.length > maxChars) break;
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join('\n');
  }

  /** Index given to the model for global-only callers. */
  async index(maxChars = 3000): Promise<string> {
    const lines: string[] = [];
    let size = 0;
    for (const e of await this.list()) {
      const line = `- [global/${e.type}; v${e.version}; sha256:${e.contentSha256.slice(0, 12)}] ${e.name} : ${e.description}`;
      if (e.integrity === 'modified') continue;
      if (size + line.length > maxChars) break;
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join('\n');
  }
}

function result(start: number, ok: boolean, output: unknown, error?: string): ToolExecutionResult {
  return { success: ok, output, error, durationMs: Date.now() - start };
}

type MemoryEnabled = () => boolean;

export class MemorySaveTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'memory.save',
    description: 'Enregistre un fait durable dans la mémoire utilisateur ou celle du projet actif. Les domaines projet, épisodique, procédural et qualité restent associés au projet.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'identifiant-en-tirets' },
        description: { type: 'string', description: 'Résumé d’une ligne' },
        type: { type: 'string', enum: MEMORY_TYPES },
        content: { type: 'string' },
      },
      required: ['name', 'description', 'content'],
    },
    requiresPermission: false,
  };
  constructor(private readonly store: MemoryStore, private readonly enabled: MemoryEnabled = () => true) {}
  async execute(p: Record<string, unknown>, c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const t0 = Date.now();
    if (!this.enabled()) return result(t0, false, null, 'La mémoire durable est désactivée dans les réglages; aucune écriture effectuée.');
    try {
      const type = requireType(String(p.type ?? 'project'));
      const scoped = PROJECT_TYPES.has(type) ? this.store.forProject(c.workspaceRoot) : this.store;
      return result(t0, true, await scoped.save(String(p.name), String(p.description ?? ''), type, String(p.content ?? ''), { origin: 'agent', taskId: c.taskId }));
    } catch (err) {
      return result(t0, false, null, (err as Error).message);
    }
  }
}

export class MemorySearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'memory.search',
    description: 'Cherche dans la mémoire durable globale et dans celle du projet actif.',
    category: 'analysis',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    requiresPermission: false,
  };
  constructor(private readonly store: MemoryStore, private readonly enabled: MemoryEnabled = () => true) {}
  async execute(p: Record<string, unknown>, c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const t0 = Date.now();
    if (!this.enabled()) return result(t0, false, null, 'La mémoire durable est désactivée dans les réglages.');
    return result(t0, true, { results: await this.store.searchForProject(String(p.query ?? ''), c.workspaceRoot) });
  }
}

export class MemoryReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'memory.read',
    description: 'Lit une entrée de la mémoire durable globale ou du projet actif.',
    category: 'analysis',
    parameters: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] } }, required: ['name'] },
    requiresPermission: false,
  };
  constructor(private readonly store: MemoryStore, private readonly enabled: MemoryEnabled = () => true) {}
  async execute(p: Record<string, unknown>, c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const t0 = Date.now();
    if (!this.enabled()) return result(t0, false, null, 'La mémoire durable est désactivée dans les réglages.');
    try {
      const scope = p.scope === 'global' || p.scope === 'project' ? p.scope : undefined;
      return result(t0, true, await this.store.readForProject(String(p.name), c.workspaceRoot, scope));
    } catch (err) {
      return result(t0, false, null, (err as Error).message);
    }
  }
}
