import type { AgentEvent } from '@mazz/shared';

/**
 * Keeps every running agent task independent of the HTTP connection that
 * started it: events are buffered so a client can re-attach after a reload or
 * a dropped SSE connection, and resume from the last index it received.
 */

export interface TaskInfo {
  taskId: string;
  sessionId?: string;
  turnId?: string;
  mode: string;
  providerId: string;
  modelId: string;
  workspaceRoot: string;
  startedAt: number;
  endedAt?: number;
  stage: string;
  done: boolean;
  success?: boolean;
  eventCount: number;
  pendingApprovals: number;
}

type Listener = (ev: AgentEvent, index: number) => void;

interface TaskEntry {
  info: TaskInfo;
  events: AgentEvent[];
  listeners: Set<Listener>;
  doneListeners: Set<() => void>;
  abort: AbortController;
}

const MAX_BUFFERED_EVENTS = 20000;
const KEEP_FINISHED_MS = 10 * 60 * 1000;

export class TaskHub {
  private tasks = new Map<string, TaskEntry>();

  create(info: Omit<TaskInfo, 'done' | 'eventCount' | 'stage' | 'pendingApprovals'>): AbortController {
    const abort = new AbortController();
    this.tasks.set(info.taskId, {
      info: { ...info, done: false, eventCount: 0, stage: 'init', pendingApprovals: 0 },
      events: [],
      listeners: new Set(),
      doneListeners: new Set(),
      abort,
    });
    return abort;
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  emit(taskId: string, ev: AgentEvent): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    if (t.events.length < MAX_BUFFERED_EVENTS) t.events.push(ev);
    t.info.eventCount = t.events.length;
    if (ev.type === 'status') t.info.stage = ev.stage;
    if (ev.type === 'tool_start') t.info.stage = `outil ${ev.toolName}`;
    if (ev.type === 'approval_request') t.info.pendingApprovals++;
    if (ev.type === 'approval_result') t.info.pendingApprovals = Math.max(0, t.info.pendingApprovals - 1);
    const index = t.events.length - 1;
    for (const l of t.listeners) l(ev, index);
  }

  finish(taskId: string, success: boolean): void {
    const t = this.tasks.get(taskId);
    if (!t) return;
    t.info.done = true;
    t.info.success = success;
    t.info.endedAt = Date.now();
    t.info.stage = success ? 'terminé' : 'échec';
    for (const l of t.doneListeners) l();
    t.listeners.clear();
    t.doneListeners.clear();
    setTimeout(() => this.tasks.delete(taskId), KEEP_FINISHED_MS).unref?.();
  }

  /** Replays events from `from` then follows live ones. Returns an unsubscribe function. */
  attach(taskId: string, from: number, onEvent: Listener, onDone: () => void): (() => void) | null {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    for (let i = Math.max(0, from); i < t.events.length; i++) onEvent(t.events[i], i);
    if (t.info.done) {
      onDone();
      return () => undefined;
    }
    t.listeners.add(onEvent);
    t.doneListeners.add(onDone);
    return () => {
      t.listeners.delete(onEvent);
      t.doneListeners.delete(onDone);
    };
  }

  cancel(taskId: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.info.done) return false;
    t.abort.abort();
    return true;
  }

  runningForSession(sessionId: string): TaskInfo | undefined {
    for (const t of this.tasks.values()) if (!t.info.done && t.info.sessionId === sessionId) return t.info;
    return undefined;
  }

  list(includeDone = true): TaskInfo[] {
    return Array.from(this.tasks.values())
      .map((t) => ({ ...t.info }))
      .filter((t) => includeDone || !t.done)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  runningCount(): number {
    return this.list(false).length;
  }

  abortAll(): void {
    for (const t of this.tasks.values()) if (!t.info.done) t.abort.abort();
  }
}
