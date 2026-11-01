// Live agent runs, keyed by session. Streams /api/agent/run, re-attaches with
// /api/agent/attach after a dropped connection (resuming from the last event
// index), and throttles UI notifications so streaming tokens never re-render
// more than ~20 times per second.
import { useSyncExternalStore } from 'react';
import type { AgentEvent, ApprovalRequestEvent, InferenceTelemetry } from '@mazz/shared';
import { streamSse } from './sse';
import { api, errorMessage } from './api';
import { refreshSessions, refreshTasks, toast } from './store';
import type { AttachmentMeta } from './types';

export type RunStatus = 'connecting' | 'running' | 'reconnecting' | 'done' | 'failed' | 'aborted';

export interface LiveRun {
  key: string;
  sessionId?: string;
  taskId?: string;
  turnId?: string;
  status: RunStatus;
  prompt: string;
  attachments?: AttachmentMeta[];
  mode: string;
  providerId: string;
  modelId: string;
  startedAt: number;
  endedAt?: number;
  events: AgentEvent[];
  lastIndex: number;
  /** Server timestamps of streamed output chunks, for the rolling rate. */
  tokenTimes: number[];
  /** Cumulative tool-call chunks of the current model call (progress events). */
  progressChunks?: number;
  stage: string;
  error?: string;
  approvals: ApprovalRequestEvent[];
  telemetry: InferenceTelemetry[];
  version: number;
  /** The person has looked at the session since the run ended (sidebar unread dot). */
  seen?: boolean;
}

/** Marks a finished run as looked at; the sidebar drops its unread dot. */
export function markRunSeen(sessionId: string | undefined): void {
  const run = sessionId ? runs.get(sessionId) : undefined;
  if (!run || run.seen || run.status === 'running' || run.status === 'connecting' || run.status === 'reconnecting') return;
  run.seen = true;
  notify(true);
}

const runs = new Map<string, LiveRun>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let flushTimer: number | null = null;
let globalVersion = 0;

function notify(immediate = false): void {
  globalVersion++;
  if (immediate) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    for (const l of listeners) l();
    return;
  }
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    for (const l of listeners) l();
  }, 50);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRunsVersion(): number {
  return useSyncExternalStore(subscribe, () => globalVersion, () => globalVersion);
}

export function getRun(sessionId: string | undefined): LiveRun | undefined {
  return sessionId ? runs.get(sessionId) : undefined;
}

export function allRuns(): LiveRun[] {
  return Array.from(runs.values());
}

function apply(run: LiveRun, ev: AgentEvent): void {
  const last = run.events[run.events.length - 1];
  if ((ev.type === 'token' || ev.type === 'thought') && last && last.type === ev.type) {
    (last as { delta: string }).delta += ev.delta;
  } else {
    run.events.push(ev.type === 'token' || ev.type === 'thought' ? { ...ev } : ev);
  }
  if (ev.type === 'token' || ev.type === 'thought') {
    run.tokenTimes.push(ev.timestamp);
    if (run.tokenTimes.length > 4096) run.tokenTimes.splice(0, 1024);
  }
  if (ev.type === 'progress') {
    // One timestamp per new chunk keeps the rolling rate meaningful during tool-call streaming.
    const seen = run.progressChunks ?? 0;
    for (let i = seen; i < ev.outputChunks; i++) run.tokenTimes.push(ev.timestamp);
    run.progressChunks = ev.outputChunks;
    run.stage = `Génération d’un appel d’outil (${ev.outputChunks} fragments)`;
    run.version++;
    return;
  }
  if (ev.type === 'usage') run.progressChunks = 0;
  if (ev.type === 'status') run.stage = ev.message;
  if (ev.type === 'tool_start') run.stage = `Outil : ${ev.toolName}`;
  if (ev.type === 'approval_request') run.approvals = [...run.approvals, ev];
  if (ev.type === 'approval_result') run.approvals = run.approvals.filter((a) => a.callId !== ev.callId);
  if (ev.type === 'usage' && ev.telemetry) run.telemetry = [...run.telemetry, ev.telemetry];
  if (ev.type === 'error' && ev.fatal) run.error = ev.message;
  if (ev.type === 'complete') {
    run.status = ev.success ? 'done' : run.events.some((e) => e.type === 'error' && e.code === 'TASK_ABORTED') ? 'aborted' : 'failed';
    run.endedAt = ev.timestamp;
    run.approvals = [];
  }
  run.version++;
}

async function follow(run: LiveRun, url: string, body: unknown, method: 'GET' | 'POST'): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(run.key, ctrl);
  await streamSse(url, {
    method,
    body,
    signal: ctrl.signal,
    onMessage: (msg) => {
      let data: any;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (msg.event === 'meta') {
        run.taskId = data.taskId;
        run.turnId = data.turnId;
        if (data.sessionId && run.sessionId !== data.sessionId) {
          runs.delete(run.key);
          run.sessionId = data.sessionId;
          run.key = data.sessionId;
          runs.set(run.key, run);
          controllers.set(run.key, ctrl);
        }
        run.status = 'running';
        notify(true);
        return;
      }
      if (msg.id !== undefined) run.lastIndex = Number(msg.id);
      const urgent = data.type !== 'token' && data.type !== 'thought';
      apply(run, data as AgentEvent);
      notify(urgent);
    },
  });
}

async function reattach(run: LiveRun): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (!run.taskId || run.status === 'done' || run.status === 'failed' || run.status === 'aborted') return;
    run.status = 'reconnecting';
    notify(true);
    await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** (attempt - 1))));
    try {
      await follow(run, `/api/agent/attach?taskId=${encodeURIComponent(run.taskId)}&from=${run.lastIndex + 1}`, undefined, 'GET');
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      if ((err as { status?: number }).status === 404) {
        // Task expired on the server: the persisted session holds the result.
        run.status = 'failed';
        run.error = 'La tâche n’est plus suivie par le serveur ; l’historique enregistré fait foi.';
        notify(true);
        return;
      }
    }
  }
  run.status = 'failed';
  run.error = 'Connexion perdue : impossible de reprendre le flux.';
  notify(true);
}

function finalize(run: LiveRun): void {
  controllers.delete(run.key);
  if (run.status === 'running' || run.status === 'connecting') run.status = run.error ? 'failed' : 'done';
  run.endedAt ??= Date.now();
  notify(true);
  void refreshSessions();
  void refreshTasks();
  window.dispatchEvent(new CustomEvent('mazz:run-finished', { detail: { sessionId: run.sessionId } }));
  announceIfHidden(run);
}

/**
 * A task that ends while the tab is hidden: the tab title says so until the tab is shown again,
 * and a system notification is shown when the person already allowed notifications.
 */
function announceIfHidden(run: LiveRun): void {
  if (typeof document === 'undefined' || !document.hidden) return;
  const label = run.status === 'done' ? 'Terminé' : run.status === 'aborted' ? 'Interrompu' : 'Échec';
  const original = document.title.replace(/^\((Terminé|Interrompu|Échec)\) /, '');
  document.title = `(${label}) ${original}`;
  const restore = () => {
    if (document.hidden) return;
    document.title = original;
    document.removeEventListener('visibilitychange', restore);
  };
  document.addEventListener('visibilitychange', restore);
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(`Agent : ${label.toLowerCase()}`, { body: run.prompt.slice(0, 140), tag: run.key });
    } catch {
      // Some embedded browsers refuse page-created notifications; the tab title remains.
    }
  }
}

export interface StartRunInput {
  sessionId?: string;
  goal: string;
  mode: string;
  providerId: string;
  modelId: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  maxOutputTokens?: number;
  attachments?: AttachmentMeta[];
  requiredPromptAttachmentId?: string;
}

/** Starts a task. Resolves with the session id once the server has created it. */
export function startRun(input: StartRunInput): Promise<string | undefined> {
  const key = input.sessionId || `pending_${Date.now()}`;
  const run: LiveRun = {
    key,
    sessionId: input.sessionId,
    status: 'connecting',
    prompt: input.goal,
    attachments: input.attachments,
    mode: input.mode,
    providerId: input.providerId,
    modelId: input.modelId,
    startedAt: Date.now(),
    events: [],
    lastIndex: -1,
    tokenTimes: [],
    stage: 'Connexion',
    approvals: [],
    telemetry: [],
    version: 0,
  };
  runs.set(key, run);
  notify(true);
  return new Promise((resolve) => {
    let resolved = false;
    const check = window.setInterval(() => {
      if (!resolved && run.sessionId) {
        resolved = true;
        clearInterval(check);
        resolve(run.sessionId);
      }
    }, 30);
    follow(run, '/api/agent/run', {
      sessionId: input.sessionId,
      goal: input.goal,
      attachments: input.attachments?.map((a) => a.id),
      ...(input.requiredPromptAttachmentId ? { requiredPromptAttachmentId: input.requiredPromptAttachmentId } : {}),
      mode: input.mode,
      selection: {
        providerId: input.providerId,
        modelId: input.modelId,
        temperature: input.temperature,
        topP: input.topP,
        topK: input.topK,
        presencePenalty: input.presencePenalty,
        maxOutputTokens: input.maxOutputTokens,
      },
    }, 'POST')
      .then(() => finalize(run))
      .catch(async (err) => {
        if ((err as Error).name === 'NetworkError' && run.taskId) {
          await reattach(run);
          finalize(run);
          return;
        }
        if ((err as Error).name === 'AbortError') {
          finalize(run);
          return;
        }
        run.status = 'failed';
        run.error = errorMessage(err);
        toast('bad', 'Exécution impossible', run.error);
        finalize(run);
      })
      .finally(() => {
        clearInterval(check);
        if (!resolved) resolve(run.sessionId);
      });
  });
}

/** Re-attaches the UI to a task that is still running on the server (after reload). */
export function attachRun(sessionId: string, task: { taskId: string; mode: string; providerId: string; modelId: string; startedAt: number }, prompt: string): void {
  const existing = runs.get(sessionId);
  if (existing && existing.taskId === task.taskId && existing.status !== 'failed') return;
  const run: LiveRun = {
    key: sessionId,
    sessionId,
    taskId: task.taskId,
    status: 'reconnecting',
    prompt,
    mode: task.mode,
    providerId: task.providerId,
    modelId: task.modelId,
    startedAt: task.startedAt,
    events: [],
    lastIndex: -1,
    tokenTimes: [],
    stage: 'Reprise du flux',
    approvals: [],
    telemetry: [],
    version: 0,
  };
  runs.set(sessionId, run);
  notify(true);
  follow(run, `/api/agent/attach?taskId=${encodeURIComponent(task.taskId)}&from=0`, undefined, 'GET')
    .then(() => finalize(run))
    .catch(async (err) => {
      if ((err as Error).name !== 'AbortError') await reattach(run);
      finalize(run);
    });
}

export async function cancelRun(sessionId: string): Promise<void> {
  const run = runs.get(sessionId);
  if (!run?.taskId) return;
  await api.post('/api/agent/cancel', { taskId: run.taskId });
}

export type ApprovalScope = 'once' | 'session' | 'always';

/** `content`: for a file write, the text kept after hunk review (only when it differs from the proposal). */
export async function answerApproval(sessionId: string, approvalId: string, approved: boolean, scope: ApprovalScope = 'once', content?: string): Promise<void> {
  await api.post('/api/agent/approve', { approvalId, approved, scope, ...(content !== undefined ? { content } : {}) });
  const run = runs.get(sessionId);
  if (run) {
    run.approvals = run.approvals.filter((a) => a.callId !== approvalId);
    notify(true);
  }
}

export function clearRun(sessionId: string): void {
  const run = runs.get(sessionId);
  if (run && (run.status === 'done' || run.status === 'failed' || run.status === 'aborted')) {
    runs.delete(sessionId);
    notify(true);
  }
}
