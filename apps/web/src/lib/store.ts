// Minimal global state: one external store, selector hooks, no extra library.
import { useSyncExternalStore } from 'react';
import { api, errorMessage } from './api';
import type { Health, LlamaStatus, ProviderInfo, SessionSummary, StudioSettings, SystemMetrics, TaskInfo } from './types';
import { prefs } from './prefs';

export type ViewId =
  | 'home'
  | 'agent'
  | 'sessions'
  | 'projects'
  | 'code'
  | 'git'
  | 'models'
  | 'providers'
  | 'compute'
  | 'tools'
  | 'memory'
  | 'performance'
  | 'quotas'
  | 'settings';

export type LayoutMode = 'focus' | 'coding' | 'review' | 'monitoring';

export interface Toast {
  id: number;
  tone: 'info' | 'good' | 'warn' | 'bad';
  title: string;
  detail?: string;
}

export interface AppState {
  view: ViewId;
  viewParam?: string;
  connected: boolean | null;
  connectionError?: string;
  health?: Health;
  settings?: StudioSettings;
  llama?: LlamaStatus;
  metrics?: SystemMetrics;
  providers: ProviderInfo[];
  sessions: SessionSummary[];
  activeSessionId?: string;
  tasks: TaskInfo[];
  toasts: Toast[];
  paletteOpen: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  bottomOpen: boolean;
  bottomTab: 'terminal' | 'interactive' | 'logs' | 'audit';
  layout: LayoutMode;
}

type Listener = () => void;

// Declared before the initial route is parsed (module evaluation order).
const VIEWS: ViewId[] = ['home', 'agent', 'sessions', 'projects', 'code', 'git', 'models', 'providers', 'compute', 'tools', 'memory', 'performance', 'quotas', 'settings'];

const initialRoute = parseHash(typeof location !== 'undefined' ? location.hash : '');

let state: AppState = {
  view: initialRoute.view,
  viewParam: initialRoute.param,
  connected: null,
  providers: [],
  sessions: [],
  activeSessionId: prefs.get<string | undefined>('activeSession', undefined),
  tasks: [],
  toasts: [],
  paletteOpen: false,
  sidebarOpen: prefs.get('sidebarOpen', true),
  inspectorOpen: prefs.get('inspectorOpen', true),
  bottomOpen: prefs.get('bottomOpen', false),
  bottomTab: 'terminal',
  layout: prefs.get<LayoutMode>('layout', 'coding'),
};

const listeners = new Set<Listener>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

// ---------------------------------------------------------------- routing

export function parseHash(hash: string): { view: ViewId; param?: string } {
  const [, view, ...rest] = hash.replace(/^#/, '').split('/');
  if (VIEWS.includes(view as ViewId)) return { view: view as ViewId, param: rest.length ? decodeURIComponent(rest.join('/')) : undefined };
  return { view: 'home' };
}

export function navigate(view: ViewId, param?: string): void {
  const hash = `#/${view}${param ? `/${encodeURIComponent(param)}` : ''}`;
  if (location.hash !== hash) history.pushState(null, '', hash);
  setState({ view, viewParam: param });
}

if (typeof window !== 'undefined') {
  const syncRoute = () => {
    const r = parseHash(location.hash);
    setState({ view: r.view, viewParam: r.param });
  };
  window.addEventListener('popstate', syncRoute);
  window.addEventListener('hashchange', syncRoute);
}

// ---------------------------------------------------------------- toasts

let toastSeq = 1;

export function toast(tone: Toast['tone'], title: string, detail?: string, ttlMs = tone === 'bad' ? 8000 : 4500): void {
  const id = toastSeq++;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, tone, title, detail }] }));
  setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------------------------------------------------------------- panels

export function togglePanel(key: 'sidebarOpen' | 'inspectorOpen' | 'bottomOpen', value?: boolean): void {
  const next = value ?? !state[key];
  prefs.set(key, next);
  setState({ [key]: next } as Partial<AppState>);
}

// Spec 02 : at <= 1366 px wide both side panels collapse to their 48 px rails.
// Only the transition collapses them, so a panel the user re-opens on a compact
// screen stays open across reloads; leaving compact mode restores what it closed.
export const COMPACT_QUERY = '(max-width: 1366px)';
type SidePanel = 'sidebarOpen' | 'inspectorOpen';

function compactNow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches;
}

function subscribeCompact(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(subscribeCompact, compactNow, compactNow);
}

export function applyCompactLayout(compact: boolean): void {
  if (prefs.get('compactLayout', false) === compact) return;
  prefs.set('compactLayout', compact);
  if (compact) {
    const closed = (['sidebarOpen', 'inspectorOpen'] as SidePanel[]).filter((k) => state[k]);
    prefs.set('compactCollapsed', closed);
    for (const k of closed) togglePanel(k, false);
  } else {
    for (const k of prefs.get<SidePanel[]>('compactCollapsed', [])) togglePanel(k, true);
    prefs.remove('compactCollapsed');
  }
}

export function setLayout(layout: LayoutMode): void {
  const presets: Record<LayoutMode, Pick<AppState, 'sidebarOpen' | 'inspectorOpen' | 'bottomOpen'>> = {
    focus: { sidebarOpen: false, inspectorOpen: false, bottomOpen: false },
    coding: { sidebarOpen: true, inspectorOpen: true, bottomOpen: false },
    review: { sidebarOpen: true, inspectorOpen: true, bottomOpen: true },
    monitoring: { sidebarOpen: false, inspectorOpen: true, bottomOpen: true },
  };
  const p = presets[layout];
  prefs.set('layout', layout);
  prefs.set('sidebarOpen', p.sidebarOpen);
  prefs.set('inspectorOpen', p.inspectorOpen);
  prefs.set('bottomOpen', p.bottomOpen);
  setState({ layout, ...p });
}

export function setActiveSession(id: string | undefined): void {
  prefs.set('activeSession', id);
  setState({ activeSessionId: id });
}

// ---------------------------------------------------------------- data loading

export async function refreshHealth(): Promise<void> {
  try {
    const health = await api.get<Health>('/api/health');
    setState({ health, connected: true, connectionError: undefined, llama: health.llama });
  } catch (err) {
    setState({ connected: false, connectionError: errorMessage(err) });
  }
}

export async function refreshSettings(): Promise<void> {
  try {
    const { settings } = await api.get<{ settings: StudioSettings }>('/api/settings');
    setState({ settings });
  } catch {
    // connection status is reported by refreshHealth
  }
}

/** Saves a partial settings patch; resolves only after the backend confirms. */
export async function saveSettings(patch: unknown): Promise<StudioSettings> {
  const { settings } = await api.put<{ settings: StudioSettings }>('/api/settings', patch);
  setState({ settings });
  return settings;
}

export async function refreshLlama(): Promise<void> {
  try {
    setState({ llama: await api.get<LlamaStatus>('/api/models/server/status') });
  } catch {
    // offline
  }
}

export async function refreshMetrics(): Promise<void> {
  try {
    setState({ metrics: await api.get<SystemMetrics>('/api/system/metrics') });
  } catch {
    // offline
  }
}

export async function refreshProviders(): Promise<void> {
  try {
    const { providers } = await api.get<{ providers: ProviderInfo[] }>('/api/providers');
    setState({ providers });
  } catch {
    // offline
  }
}

export async function refreshSessions(): Promise<void> {
  try {
    const { sessions } = await api.get<{ sessions: SessionSummary[] }>('/api/sessions?archived=1');
    setState({ sessions });
  } catch {
    // offline
  }
}

export async function refreshTasks(): Promise<void> {
  try {
    const { tasks } = await api.get<{ tasks: TaskInfo[] }>('/api/agent/active');
    setState({ tasks });
  } catch {
    // offline
  }
}

/**
 * Background polling, paused while the tab is hidden. Intervals are chosen for
 * a 4-core CPU: health 15 s, tasks 4 s, llama-server 2 s only while starting.
 */
export function startPolling(): () => void {
  const timers: number[] = [];
  const every = (ms: number, fn: () => void) => timers.push(window.setInterval(() => !document.hidden && fn(), ms));
  void Promise.all([refreshHealth(), refreshSettings(), refreshProviders(), refreshSessions(), refreshTasks(), refreshMetrics()]);
  every(15000, refreshHealth);
  // Sessions can also be created by the CLI or another window.
  every(15000, refreshSessions);
  every(4000, refreshTasks);
  every(2000, () => {
    if (state.llama?.state === 'starting') void refreshLlama();
  });
  let metricsTimer = 0;
  const scheduleMetrics = () => {
    const sec = state.settings?.performance.metricsIntervalSec ?? 3;
    metricsTimer = window.setTimeout(async () => {
      if (!document.hidden) await refreshMetrics();
      scheduleMetrics();
    }, sec * 1000);
  };
  scheduleMetrics();
  const onVisible = () => !document.hidden && void refreshHealth();
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    timers.forEach(clearInterval);
    clearTimeout(metricsTimer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
