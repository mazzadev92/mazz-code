import { useMemo, useState } from 'react';
import { Activity, Bot, Boxes, Code2, FolderOpen, KeyRound, PanelLeftOpen, Pin, Plus, Search, Settings, Wrench } from 'lucide-react';
import { navigate, setActiveSession, togglePanel, useApp } from '../../lib/store';
import { useRunsVersion, getRun } from '../../lib/agentRuns';
import { basename, fmtRelative } from '../../lib/format';
import type { SessionSummary } from '../../lib/types';
import { Button, IconButton, Spinner, StatusDot, cx, type Tone } from '../../components/ui';

export const SESSION_STATUS: Record<SessionSummary['status'], { label: string; tone: Tone }> = {
  idle: { label: 'Nouvelle', tone: 'neutral' },
  running: { label: 'En cours', tone: 'brand' },
  completed: { label: 'Terminée', tone: 'good' },
  failed: { label: 'Échec', tone: 'bad' },
  interrupted: { label: 'Interrompue', tone: 'warn' },
};

function group(s: SessionSummary, now: number): string {
  if (s.pinned) return 'Épinglées';
  const d = now - s.updatedAt;
  if (d < 86400000) return 'Aujourd’hui';
  if (d < 7 * 86400000) return 'Cette semaine';
  return 'Plus anciennes';
}

export function SessionsSidebar() {
  useRunsVersion();
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeSessionId);
  const view = useApp((s) => s.view);
  const health = useApp((s) => s.health);
  const llama = useApp((s) => s.llama);
  const ws = health?.workspace;
  const workspace = ws?.workspaceRoot;
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const now = Date.now();

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => !s.archived)
      .filter((s) => scope === 'all' || !workspace || s.projectRoot === workspace)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || (s.lastPrompt ?? '').toLowerCase().includes(q));
  }, [sessions, query, scope, workspace]);

  const groups = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of list) {
      const g = group(s, now);
      if (!m.has(g)) m.set(g, []);
      m.get(g)!.push(s);
    }
    return Array.from(m.entries());
  }, [list, now]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-2.5 space-y-2 border-b border-line">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          icon={<Plus className="w-3.5 h-3.5" />}
          onClick={() => {
            setActiveSession(undefined);
            navigate('agent');
          }}
        >
          Nouvelle session
        </Button>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrer les sessions"
            aria-label="Filtrer les sessions"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-sunk border border-line text-[12.5px] placeholder:text-faint focus:outline-none focus:border-brand/60"
          />
        </div>
        <div className="flex gap-1 text-[11.5px]">
          {(['project', 'all'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={cx('px-2 h-6 rounded-md cursor-pointer', scope === s ? 'bg-raised text-fg' : 'text-muted hover:text-fg')}>
              {s === 'project' ? 'Ce projet' : 'Tous les projets'}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1" role="list" aria-label="Sessions">
        {groups.length === 0 && (
          <p className="px-3 py-6 text-[12px] text-faint text-center leading-relaxed">
            {sessions.length === 0 ? 'Aucune session. Démarrez une conversation avec l’agent.' : 'Aucune session ne correspond au filtre.'}
          </p>
        )}
        {groups.map(([name, items]) => (
          <div key={name} className="mb-1">
            <div className="px-3 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.12em] text-faint">{name}</div>
            {items.map((s) => {
              const run = getRun(s.id);
              const live = run && (run.status === 'running' || run.status === 'reconnecting' || run.status === 'connecting');
              const st = SESSION_STATUS[live ? 'running' : s.status];
              const active = s.id === activeId && view === 'agent';
              return (
                <button
                  key={s.id}
                  role="listitem"
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    setActiveSession(s.id);
                    navigate('agent', s.id);
                  }}
                  className={cx('w-full text-left px-3 py-1.5 flex flex-col gap-0.5 cursor-pointer border-l-2', active ? 'bg-raised border-brand' : 'border-transparent hover:bg-raised/60')}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {live ? <Spinner size={9} /> : <StatusDot tone={st.tone} label={st.label} />}
                    <span className="truncate text-[12.5px] text-fg flex-1">{s.title}</span>
                    {/* Background sessions: what needs the person, and results not seen yet. */}
                    {live && (run?.approvals.length ?? 0) > 0 && <span className="shrink-0 text-[10.5px] text-warn">Attend votre accord</span>}
                    {!live && run && !run.seen && !active && (run.status === 'done' || run.status === 'failed') && (
                      <span className={cx('shrink-0 w-1.5 h-1.5 rounded-full', run.status === 'done' ? 'bg-brand' : 'bg-bad')} aria-label={run.status === 'done' ? 'Résultat non consulté' : 'Échec non consulté'} />
                    )}
                    {s.pinned && <Pin className="w-3 h-3 text-faint shrink-0" aria-label="Épinglée" />}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11px] text-faint pl-3.5">
                    <span className="truncate">{scope === 'all' ? basename(s.projectRoot) : s.modelId || s.providerId}</span>
                    <span className="ml-auto shrink-0">{fmtRelative(s.updatedAt, now)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {/* Bottom section: Active Project & Model Engine & Quick Nav */}
      <div className="p-2 border-t border-line space-y-1.5 bg-panel/80 shrink-0">
        {ws && (
          <button
            type="button"
            onClick={() => navigate('projects')}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-muted hover:text-fg hover:bg-raised transition-colors cursor-pointer text-left"
            title={ws.workspaceRoot}
          >
            <FolderOpen className="w-3.5 h-3.5 text-brand shrink-0" />
            <span className="truncate font-medium flex-1">{ws.name}</span>
            {ws.isGitRepo && <span className="text-[10.5px] font-mono text-faint shrink-0">{ws.gitBranch}</span>}
          </button>
        )}
        <button
          type="button"
          onClick={() => navigate('models')}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-muted hover:text-fg hover:bg-raised transition-colors cursor-pointer text-left"
          title="Moteur d'inférence (Hub de modèles)"
        >
          <StatusDot tone={llama?.state === 'ready' ? 'good' : llama?.state === 'starting' ? 'warn' : 'neutral'} pulse={llama?.state === 'starting'} />
          <span className="truncate flex-1 text-[11.5px]">{llama?.state === 'ready' ? (llama.metadata?.modelName || basename(llama.modelPath || '')) : 'Modèles & Moteurs'}</span>
          <span className="text-[10px] font-mono uppercase text-brand shrink-0">{llama?.state === 'ready' ? 'LOCAL' : 'HUB'}</span>
        </button>
        <div className="flex items-center justify-between pt-1 border-t border-line/60 px-1">
          <IconButton size="sm" active={view === 'agent'} label="Discussion (Alt+2)" onClick={() => navigate('agent')}>
            <Bot className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton size="sm" active={view === 'code'} label="Explorateur de code (Alt+5)" onClick={() => navigate('code')}>
            <Code2 className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton size="sm" active={view === 'providers'} label="Fournisseurs LLM & API" onClick={() => navigate('providers')}>
            <KeyRound className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton size="sm" active={view === 'tools'} label="Outils & MCP" onClick={() => navigate('tools')}>
            <Wrench className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton size="sm" active={view === 'performance'} label="Télémétrie & Performance (Alt+8)" onClick={() => navigate('performance')}>
            <Activity className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton size="sm" active={view === 'settings'} label="Paramètres (Ctrl+,)" onClick={() => navigate('settings')}>
            <Settings className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/** Collapsed sidebar: a 48 px rail of icons with tooltips (Ctrl+B expands it again). */
export function SidebarRail() {
  useRunsVersion();
  const view = useApp((s) => s.view);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeSessionId);
  const recent = sessions.filter((s) => !s.archived).slice(0, 6);
  const nav: Array<{ id: Parameters<typeof navigate>[0]; label: string; icon: typeof Bot }> = [
    { id: 'agent', label: 'Discussion (Alt+2)', icon: Bot },
    { id: 'code', label: 'Explorateur de code (Alt+5)', icon: Code2 },
    { id: 'models', label: 'Modèles', icon: Boxes },
    { id: 'providers', label: 'Fournisseurs LLM et API', icon: KeyRound },
    { id: 'tools', label: 'Outils et MCP', icon: Wrench },
    { id: 'performance', label: 'Télémétrie (Alt+8)', icon: Activity },
  ];
  return (
    <nav className="w-12 shrink-0 h-full flex flex-col items-center gap-1 py-2 border-r border-line bg-panel" aria-label="Barre latérale réduite">
      <IconButton label="Déplier la barre latérale (Ctrl+B)" tipSide="right" onClick={() => togglePanel('sidebarOpen')}>
        <PanelLeftOpen className="w-4 h-4" />
      </IconButton>
      <IconButton
        label="Nouvelle session (Ctrl+Maj+N)"
        tipSide="right"
        className="text-brand"
        onClick={() => {
          setActiveSession(undefined);
          navigate('agent');
        }}
      >
        <Plus className="w-4 h-4" />
      </IconButton>
      <div className="w-6 h-px bg-line my-1" />
      {recent.map((s) => {
        const run = getRun(s.id);
        const live = run && (run.status === 'running' || run.status === 'reconnecting' || run.status === 'connecting');
        const active = s.id === activeId && view === 'agent';
        return (
          <IconButton
            key={s.id}
            label={s.title}
            tipSide="right"
            active={active}
            onClick={() => {
              setActiveSession(s.id);
              navigate('agent', s.id);
            }}
          >
            {live ? <Spinner size={10} /> : <span className={cx('text-[10.5px] font-mono uppercase', active ? 'text-brand' : '')}>{s.title.trim().slice(0, 2) || '--'}</span>}
          </IconButton>
        );
      })}
      <div className="flex-1" />
      {nav.map(({ id, label, icon: Icon }) => (
        <IconButton key={id} label={label} tipSide="right" active={view === id} onClick={() => navigate(id)}>
          <Icon className="w-4 h-4" />
        </IconButton>
      ))}
      <IconButton label="Paramètres (Ctrl+,)" tipSide="right" active={view === 'settings'} onClick={() => navigate('settings')}>
        <Settings className="w-4 h-4" />
      </IconButton>
    </nav>
  );
}
