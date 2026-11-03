import { useMemo, useState } from 'react';
import { FolderOpen, Pin, Plus, Search } from 'lucide-react';
import { navigate, setActiveSession, useApp } from '../../lib/store';
import { useRunsVersion, getRun } from '../../lib/agentRuns';
import { basename, fmtRelative } from '../../lib/format';
import type { SessionSummary } from '../../lib/types';
import { Button, Spinner, StatusDot, cx, type Tone } from '../../components/ui';

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
    <div className="flex flex-col h-full min-h-0 select-none">
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
      </div>
    </div>
  );
}
