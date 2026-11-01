import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentEvent, ChatMessage, InferenceTelemetry } from '@mazz/shared';
import { DebouncedWriter, readJson } from './storage.js';

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'interrupted';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted';

export interface SessionTurn {
  id: string;
  taskId: string;
  prompt: string;
  mode: string;
  providerId: string;
  modelId: string;
  startedAt: number;
  endedAt?: number;
  status: TurnStatus;
  /** Events with consecutive token/thought deltas merged. */
  events: AgentEvent[];
  finalText: string;
  telemetry: InferenceTelemetry[];
  checkpointId?: string;
  error?: string;
  attachments?: Array<{
    id: string; name: string; sizeBytes: number; kind: string; chars: number; pages?: number; note?: string;
    sourceSha256?: string; textSha256?: string; extractionStatus?: string; offsetUnit?: string;
  }>;
}

export interface SessionRecord {
  id: string;
  title: string;
  projectRoot: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  archived: boolean;
  pinned: boolean;
  providerId: string;
  modelId: string;
  mode: string;
  /** Folders added to this session (like /add-dir): reachable without asking. */
  extraRoots?: string[];
  /** default: settings permissions; acceptEdits: file edits without asking; bypass: no confirmation. */
  permissionMode?: SessionPermissionMode;
  turns: SessionTurn[];
  /** Summary of the first `summarizedTurns` turns (automatic or /compact). */
  summary?: string;
  summarizedTurns?: number;
}

export type SessionPermissionMode = 'default' | 'acceptEdits' | 'bypass';

export type SessionSummary = Omit<SessionRecord, 'turns'> & {
  turnCount: number;
  lastPrompt?: string;
  lastTelemetry?: InferenceTelemetry;
};

const MAX_EVENTS_PER_TURN = 4000;

/** Appends an event, merging it into the previous one when both are text deltas of the same kind. */
export function appendCompacted(events: AgentEvent[], ev: AgentEvent): void {
  const last = events[events.length - 1];
  if (last && (ev.type === 'token' || ev.type === 'thought') && last.type === ev.type) {
    (last as { delta: string }).delta += ev.delta;
    last.timestamp = ev.timestamp;
    return;
  }
  if (events.length >= MAX_EVENTS_PER_TURN) return;
  events.push(ev.type === 'token' || ev.type === 'thought' ? { ...ev } : ev);
}

function summarize(s: SessionRecord): SessionSummary {
  const { turns, ...rest } = s;
  const last = turns[turns.length - 1];
  return {
    ...rest,
    turnCount: turns.length,
    lastPrompt: last?.prompt.slice(0, 160),
    lastTelemetry: last?.telemetry[last.telemetry.length - 1],
  };
}

export class SessionStore {
  private readonly dir: string;
  private sessions = new Map<string, SessionRecord>();
  private writers = new Map<string, DebouncedWriter>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'sessions');
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    let recoveredInterruptedSession = false;
    for (const name of await fs.readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      const s = await readJson<SessionRecord | null>(path.join(this.dir, name), null);
      // The session id is also used to derive the filename on future writes.
      // Ignore malformed or renamed records rather than allowing persisted data
      // to redirect writes outside this store.
      if (!s || typeof s.id !== 'string' || path.basename(name, '.json') !== s.id || !Array.isArray(s.turns)) continue;
      // A session still marked running belonged to a previous server process.
      if (s.status === 'running') {
        s.status = 'interrupted';
        for (const t of s.turns) if (t.status === 'running') t.status = 'interrupted';
        this.persist(s);
        recoveredInterruptedSession = true;
      }
      this.sessions.set(s.id, s);
    }
    // Make recovery itself durable before the server begins accepting requests.
    if (recoveredInterruptedSession) await this.flush();
  }

  private writer(id: string): DebouncedWriter {
    let w = this.writers.get(id);
    if (!w) {
      w = new DebouncedWriter(path.join(this.dir, `${id}.json`), 800);
      this.writers.set(id, w);
    }
    return w;
  }

  persist(s: SessionRecord): void {
    s.updatedAt = Date.now();
    this.writer(s.id).schedule(s);
  }

  async flush(id?: string): Promise<void> {
    if (id) {
      await this.writers.get(id)?.flush();
      return;
    }
    // A concurrent session mutation may add a writer while a flush is in
    // progress. Repeat until the complete current writer set has drained.
    for (;;) {
      const targets = Array.from(this.writers.values());
      await Promise.all(targets.map((w) => w.flush()));
      const current = Array.from(this.writers.values());
      if (current.length === targets.length && current.every((writer, index) => writer === targets[index])) return;
    }
  }

  list(filter: { includeArchived?: boolean; projectRoot?: string } = {}): SessionSummary[] {
    return Array.from(this.sessions.values())
      .filter((s) => (filter.includeArchived ? true : !s.archived))
      .filter((s) => (filter.projectRoot ? s.projectRoot === filter.projectRoot : true))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .map(summarize);
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  create(input: { title?: string; projectRoot: string; providerId: string; modelId: string; mode: string }): SessionRecord {
    const now = Date.now();
    const s: SessionRecord = {
      id: `s_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      title: (input.title || 'Nouvelle session').slice(0, 120),
      projectRoot: input.projectRoot,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      archived: false,
      pinned: false,
      providerId: input.providerId,
      modelId: input.modelId,
      mode: input.mode,
      turns: [],
    };
    this.sessions.set(s.id, s);
    this.persist(s);
    return s;
  }

  update(id: string, patch: Partial<Pick<SessionRecord, 'title' | 'archived' | 'pinned' | 'providerId' | 'modelId' | 'mode' | 'extraRoots' | 'permissionMode'>>): SessionRecord {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session introuvable.');
    if (typeof patch.title === 'string') s.title = patch.title.trim().slice(0, 120) || s.title;
    if (typeof patch.archived === 'boolean') s.archived = patch.archived;
    if (typeof patch.pinned === 'boolean') s.pinned = patch.pinned;
    if (typeof patch.providerId === 'string') s.providerId = patch.providerId;
    if (typeof patch.modelId === 'string') s.modelId = patch.modelId;
    if (typeof patch.mode === 'string') s.mode = patch.mode;
    if (Array.isArray(patch.extraRoots)) {
      s.extraRoots = [...new Set(patch.extraRoots.filter((r): r is string => typeof r === 'string' && path.isAbsolute(r)).map((r) => path.resolve(r)))];
    }
    if (patch.permissionMode === 'default' || patch.permissionMode === 'acceptEdits' || patch.permissionMode === 'bypass') s.permissionMode = patch.permissionMode;
    this.persist(s);
    return s;
  }

  duplicate(id: string): SessionRecord {
    const src = this.sessions.get(id);
    if (!src) throw new Error('Session introuvable.');
    const copy = this.create({ ...src, title: `${src.title} (copie)` });
    copy.turns = structuredClone(src.turns.filter((t) => t.status !== 'running'));
    copy.status = src.status === 'running' ? 'idle' : src.status;
    this.persist(copy);
    return copy;
  }

  async remove(id: string): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.status === 'running') throw new Error('Session en cours d’exécution : annulez la tâche avant de la supprimer.');
    this.sessions.delete(id);
    const w = this.writers.get(id);
    await w?.flush();
    this.writers.delete(id);
    await fs.rm(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }

  /** Conversation history for the model: prompts and final answers of finished turns. */
  history(id: string, maxTurns = 8, formatUser?: (prompt: string, mode: string, projectRoot: string) => string): ChatMessage[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    const out: ChatMessage[] = [];
    for (const t of s.turns.slice(s.summarizedTurns ?? 0).filter((t) => t.status !== 'running').slice(-maxTurns)) {
      out.push({ role: 'user', content: formatUser ? formatUser(t.prompt, t.mode, s.projectRoot) : t.prompt });
      if (t.finalText) out.push({ role: 'assistant', content: t.finalText });
    }
    return out;
  }

  /** Turns not covered by the summary (finished ones only). */
  unsummarized(id: string): SessionTurn[] {
    const s = this.sessions.get(id);
    if (!s) return [];
    return s.turns.slice(s.summarizedTurns ?? 0).filter((t) => t.status !== 'running');
  }

  setSummary(id: string, summary: string, summarizedTurns: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.summary = summary;
    s.summarizedTurns = summarizedTurns;
    this.persist(s);
  }

  beginTurn(id: string, turn: Omit<SessionTurn, 'events' | 'finalText' | 'telemetry' | 'status'>): SessionTurn {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Session introuvable.');
    const t: SessionTurn = { ...turn, status: 'running', events: [], finalText: '', telemetry: [] };
    s.turns.push(t);
    s.status = 'running';
    s.providerId = turn.providerId;
    s.modelId = turn.modelId;
    s.mode = turn.mode;
    if (s.turns.length === 1 && s.title === 'Nouvelle session') {
      s.title = turn.prompt.replace(/\s+/g, ' ').trim().slice(0, 64) || s.title;
    }
    this.persist(s);
    return t;
  }

  recordEvent(id: string, turnId: string, ev: AgentEvent): void {
    const s = this.sessions.get(id);
    const t = s?.turns.find((x) => x.id === turnId);
    if (!s || !t) return;
    // Liveness pings are only useful while streaming; they are not history.
    if (ev.type === 'progress') return;
    appendCompacted(t.events, ev);
    // The loop's summary is the last assistant message: it becomes the remembered answer.
    if (ev.type === 'complete') t.finalText = ev.summary;
    if (ev.type === 'usage' && ev.telemetry) t.telemetry.push(ev.telemetry);
    if (ev.type === 'checkpoint') t.checkpointId = ev.checkpointId;
    if (ev.type === 'error' && ev.fatal) t.error = ev.message;
    this.persist(s);
  }

  endTurn(id: string, turnId: string, status: TurnStatus, summary?: string): void {
    const s = this.sessions.get(id);
    const t = s?.turns.find((x) => x.id === turnId);
    if (!s || !t) return;
    t.status = status;
    t.endedAt = Date.now();
    if (!t.finalText && summary) t.finalText = summary;
    s.status = status === 'completed' ? 'completed' : status === 'aborted' ? 'interrupted' : status === 'failed' ? 'failed' : 'idle';
    this.persist(s);
  }
}
