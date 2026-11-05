import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  LayoutPanelLeft,
  ListTree,
  PanelBottom,
  PanelRight,
  PanelRightOpen,
  Plus,
  Search,
} from '../components/icons';
// Phosphor (duotone) for the navigation icons: a set of its own, not the Lucide look shared by most generated apps.
import {
  IconContext,
  Pulse as Activity,
  Cloud,
  Plugs,
  Gauge,
  Robot as Bot,
  Cube as Boxes,
  Cpu,
  Database,
  GitFork as FolderGit2,
  FolderOpen,
  GitBranch,
  House as Home,
  Key as KeyRound,
  ChatsCircle as MessagesSquare,
  Gear as Settings,
  Code as Code2,
  Wrench,
  CaretUp as ChevronUp,
} from '@phosphor-icons/react';
import { navigate, setLayout, setState, togglePanel, useApp, setActiveSession, applyCompactLayout, useCompactLayout, type ViewId, type LayoutMode, toast } from '../lib/store';
import { contextLimitFor } from '../lib/context-window';
import { t, type I18nKey } from '../lib/i18n';
import { MazzMark } from '../components/brand';
import { CommandPalette, Toasts, type Command } from '../components/overlays';
import { IconButton, Kbd, Spinner, StatusDot } from '../components/ui';
import { Splitter, usePanelSize } from '../components/Splitter';
import { basename, fmtBytes, fmtRate } from '../lib/format';
import { allRuns, getRun, useRunsVersion } from '../lib/agentRuns';
import { api } from '../lib/api';
import { rollingRate } from '@mazz/shared';
import { SessionsSidebar } from '../features/sessions/SessionsSidebar';

const HomeView = lazy(() => import('../features/home/HomeView'));
const AgentView = lazy(() => import('../features/agent/AgentView'));
const AgentInspector = lazy(() => import('../features/agent/AgentInspector'));
const SessionsView = lazy(() => import('../features/sessions/SessionsView'));
const ProjectsView = lazy(() => import('../features/projects/ProjectsView'));
const CodeView = lazy(() => import('../features/code/CodeView'));
const FileTreeSidebar = lazy(() => import('../features/code/FileTreeSidebar'));
const GitView = lazy(() => import('../features/git/GitView'));
const ModelsView = lazy(() => import('../features/models/ModelsView'));
const ProvidersView = lazy(() => import('../features/providers/ProvidersView'));
const ComputeView = lazy(() => import('../features/compute/ComputeView'));
const ServicesView = lazy(() => import('../features/services/ServicesView'));
const ToolsView = lazy(() => import('../features/tools/ToolsView'));
const MemoryView = lazy(() => import('../features/memory/MemoryView'));
const PerformanceView = lazy(() => import('../features/performance/PerformanceView'));
const QuotasView = lazy(() => import('../features/quotas/QuotasView'));
const SettingsView = lazy(() => import('../features/settings/SettingsView'));
const BottomPanel = lazy(() => import('../features/terminal/BottomPanel'));

interface NavItem {
  id: ViewId;
  key: I18nKey;
  icon: ReactNode;
  shortcut?: string;
}

const NAV: NavItem[] = [
  { id: 'home', key: 'nav.home', icon: <Home className="w-[18px] h-[18px]" />, shortcut: 'Alt+1' },
  { id: 'agent', key: 'nav.agent', icon: <Bot className="w-[18px] h-[18px]" />, shortcut: 'Alt+2' },
  { id: 'sessions', key: 'nav.sessions', icon: <MessagesSquare className="w-[18px] h-[18px]" />, shortcut: 'Alt+3' },
  { id: 'projects', key: 'nav.projects', icon: <FolderOpen className="w-[18px] h-[18px]" />, shortcut: 'Alt+4' },
  { id: 'code', key: 'nav.code', icon: <Code2 className="w-[18px] h-[18px]" />, shortcut: 'Alt+5' },
  { id: 'git', key: 'nav.git', icon: <FolderGit2 className="w-[18px] h-[18px]" />, shortcut: 'Alt+6' },
  { id: 'models', key: 'nav.models', icon: <Boxes className="w-[18px] h-[18px]" />, shortcut: 'Alt+7' },
  { id: 'providers', key: 'nav.providers', icon: <KeyRound className="w-[18px] h-[18px]" /> },
  { id: 'compute', key: 'nav.compute', icon: <Cloud className="w-[18px] h-[18px]" /> },
  { id: 'services', key: 'nav.services', icon: <Plugs className="w-[18px] h-[18px]" /> },
  { id: 'tools', key: 'nav.tools', icon: <Wrench className="w-[18px] h-[18px]" /> },
  { id: 'memory', key: 'nav.memory', icon: <Database className="w-[18px] h-[18px]" /> },
  { id: 'performance', key: 'nav.performance', icon: <Activity className="w-[18px] h-[18px]" />, shortcut: 'Alt+8' },
  { id: 'quotas', key: 'nav.quotas', icon: <Gauge className="w-[18px] h-[18px]" />, shortcut: 'Alt+9' },
];

const SIDEBAR_VIEWS: ViewId[] = ['home', 'agent', 'sessions', 'projects', 'code', 'git', 'models', 'providers', 'compute', 'services', 'tools', 'memory', 'performance', 'quotas', 'settings'];
const INSPECTOR_VIEWS: ViewId[] = ['agent', 'code'];

function ViewFallback() {
  return (
    <div className="h-full grid place-items-center">
      <Spinner size={22} variant="brand" label="Chargement de la vue" />
    </div>
  );
}

function renderView(view: ViewId): ReactNode {
  switch (view) {
    case 'home':
      return <HomeView />;
    case 'agent':
      return <AgentView />;
    case 'sessions':
      return <SessionsView />;
    case 'projects':
      return <ProjectsView />;
    case 'code':
      return <CodeView />;
    case 'git':
      return <GitView />;
    case 'models':
      return <ModelsView />;
    case 'providers':
      return <ProvidersView />;
    case 'compute':
      return <ComputeView />;
    case 'services':
      return <ServicesView />;
    case 'tools':
      return <ToolsView />;
    case 'memory':
      return <MemoryView />;
    case 'performance':
      return <PerformanceView />;
    case 'quotas':
      return <QuotasView />;
    case 'settings':
      return <SettingsView />;
  }
}

// ---------------------------------------------------------------- title bar

function TitleBar({ onPalette }: { onPalette: () => void }) {
  const health = useApp((s) => s.health);
  const connected = useApp((s) => s.connected);
  const llama = useApp((s) => s.llama);
  const tasks = useApp((s) => s.tasks);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const running = tasks.filter((x) => !x.done).length;
  const ws = health?.workspace;
  return (
    <header className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-line bg-[var(--panel-top)] select-none font-mono text-[12px]">
      <IconButton
        label="Barre latérale (Ctrl+B)"
        active={sidebarOpen}
        onClick={() => togglePanel('sidebarOpen')}
      >
        <LayoutPanelLeft className="w-3.5 h-3.5" />
      </IconButton>
      <button type="button" onClick={() => navigate('agent')} className="flex items-center gap-1.5 cursor-pointer" aria-label="MAZZ CODE">
        <MazzMark size={18} state={connected === false ? 'offline' : running ? 'thinking' : 'idle'} />
        <span className="font-bold tracking-tight text-fg text-[12px]">MAZZ CODE</span>
      </button>
      <div className="w-px h-4 bg-line mx-1" />
      <button type="button" onClick={() => navigate('projects')} className="flex items-center gap-1.5 min-w-0 text-[11.5px] text-muted hover:text-fg cursor-pointer" title={ws?.workspaceRoot}>
        <FolderOpen className="w-3.5 h-3.5 shrink-0 text-brand" />
        <span className="truncate max-w-[150px] text-fg font-medium">{ws ? ws.name : 'Aucun projet'}</span>
      </button>
      {ws?.isGitRepo && (
        <button type="button" onClick={() => navigate('git')} className="hidden sm:flex items-center gap-1 text-[11px] text-muted hover:text-fg cursor-pointer">
          <GitBranch className="w-3 h-3 text-leaf" />
          <span className="font-mono">{ws.gitBranch}</span>
          {ws.gitDirtyCount > 0 && <span className="text-warn tabular">*{ws.gitDirtyCount}</span>}
        </button>
      )}
      <button type="button" onClick={onPalette} className="ml-auto mr-auto hidden md:flex items-center gap-2 h-6 w-[min(300px,26vw)] px-2 rounded border border-line bg-sunk text-[11px] text-faint hover:border-line-strong cursor-pointer" aria-label="Ouvrir la palette de commandes">
        <Search className="w-3 h-3" />
        <span className="flex-1 text-left truncate">Commandes, sessions, fichiers...</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => navigate('models')} className="hidden lg:flex items-center gap-1.5 h-6 px-1.5 rounded text-[11px] text-muted hover:text-fg hover:bg-raised cursor-pointer" title="Moteur local">
          <StatusDot tone={llama?.state === 'ready' ? 'good' : llama?.state === 'starting' ? 'warn' : llama?.state === 'error' ? 'bad' : 'neutral'} pulse={llama?.state === 'starting'} />
          <span className="truncate max-w-[130px] font-mono text-[11px]">{llama?.state === 'ready' ? llama.metadata?.modelName || basename(llama.modelPath || '') : llama?.state === 'starting' ? 'Chargement…' : 'Moteur arrêté'}</span>
        </button>
        {running > 0 && (
          <button type="button" onClick={() => navigate('sessions')} className="flex items-center gap-1 h-6 px-1.5 rounded text-[11px] text-brand hover:bg-raised cursor-pointer" title="Tâches en cours">
            <Spinner size={10} /> {running} tâche{running > 1 ? 's' : ''}
          </button>
        )}
        <PanelToggles />
      </div>
    </header>
  );
}

function PanelToggles() {
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const bottomOpen = useApp((s) => s.bottomOpen);
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label="Panneau inférieur / Terminal (Ctrl+J)" active={bottomOpen} onClick={() => togglePanel('bottomOpen')}>
        <PanelBottom className="w-4 h-4" />
      </IconButton>
      <IconButton label="Inspecteur / Artefacts (Ctrl+I)" active={inspectorOpen} onClick={() => togglePanel('inspectorOpen')}>
        <PanelRight className="w-4 h-4" />
      </IconButton>
    </div>
  );
}

// ---------------------------------------------------------------- status bar

function StatusBar() {
  useRunsVersion();
  const connected = useApp((s) => s.connected);
  const health = useApp((s) => s.health);
  const llama = useApp((s) => s.llama);
  const metrics = useApp((s) => s.metrics);
  const settings = useApp((s) => s.settings);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const [now, setNow] = useState(Date.now());
  const run = getRun(activeSessionId) ?? allRuns().find((r) => r.status === 'running');
  const live = run && (run.status === 'running' || run.status === 'reconnecting');
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [live]);
  const windowMs = (settings?.performance.rollingWindowSec ?? 3) * 1000;
  // Server timestamps; the clock offset is negligible on 127.0.0.1.
  const liveRate = live && run ? rollingRate(run.tokenTimes, windowMs, now) : undefined;
  const lastTel = run?.telemetry[run.telemetry.length - 1];
  const memUsed = metrics ? metrics.memory.totalBytes - metrics.memory.availableBytes : undefined;
  const tokensUsed = (lastTel?.promptTokens ?? 0) + (lastTel?.completionTokens ?? 0);
  // Only measured values: anything the runtime has not reported is shown as N/D.
  const ctxMax = contextLimitFor(lastTel, llama?.config?.contextSize)?.limit ?? llama?.config?.contextSize;
  const budgetPct = ctxMax ? Math.max(0, Math.min(100, Math.round(((ctxMax - tokensUsed) / ctxMax) * 100))) : undefined;
  const rate = live ? liveRate : lastTel?.tgTokS;
  const mcpTools = useMcpToolCount();

  const item = 'flex items-center gap-1.5 px-2 h-full hover:bg-raised cursor-pointer whitespace-nowrap font-mono text-[11px]';
  return (
    <footer className="h-7 shrink-0 flex items-center text-[11px] text-muted border-t border-line bg-panel overflow-hidden select-none font-mono" aria-label="Barre d’état">
      <button type="button" className={item} onClick={() => navigate('home')} title={health ? `Serveur ${health.version}` : undefined}>
        <StatusDot tone={connected === false ? 'bad' : connected ? 'good' : 'neutral'} />
        {connected === false ? 'Déconnecté' : '127.0.0.1'}
      </button>
      <button type="button" className={item} onClick={() => navigate('models')}>
        <Cpu className="w-3 h-3 text-[var(--post-code)]" />
        {rate !== undefined ? `${fmtRate(rate)} tok/s` : 'N/D tok/s'}
      </button>
      <span className={item.replace('cursor-pointer', '')} title="Tokens consommés dans la session">
        Tokens: {tokensUsed} / {ctxMax ?? 'N/D'}
      </span>
      <span className={item.replace('cursor-pointer', '')} title="Budget de contexte restant">
        Budget: {budgetPct !== undefined ? `${budgetPct}%` : 'N/D'}
      </span>
      <button type="button" className={item} onClick={() => navigate('tools')} title="État des serveurs et outils MCP">
        <Wrench className="w-3 h-3 text-[var(--post-audit)]" />
        MCP: {mcpTools === undefined ? 'N/D' : `${mcpTools} outil${mcpTools > 1 ? 's' : ''}`}
      </button>
      <div className="flex-1" />
      <span className={item.replace('cursor-pointer', '')} title="Délai avant le premier token du dernier tour">
        TTFT: {lastTel?.ttftMs ? `${Math.round(lastTel.ttftMs)} ms` : 'N/D'}
      </span>
      <button type="button" className={item} onClick={() => navigate('performance')} title="RAM utilisée / totale">
        RAM {fmtBytes(memUsed)} / {fmtBytes(metrics?.memory.totalBytes)}
      </button>
      {metrics?.cpu.usagePercent !== undefined && (
        <span className={item.replace('cursor-pointer', '')}>CPU {metrics.cpu.usagePercent.toFixed(0)} %</span>
      )}
    </footer>
  );
}

// Tools exposed by running MCP servers, refreshed every 30 s; undefined until the first answer.
function useMcpToolCount(): number | undefined {
  const [count, setCount] = useState<number | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      api
        .get<{ servers: Array<{ status?: { tools?: unknown[] } }> }>('/api/mcp/servers')
        .then((r) => alive && setCount(r.servers.reduce((n, sv) => n + (sv.status?.tools?.length ?? 0), 0)))
        .catch(() => alive && setCount(undefined));
    };
    load();
    const id = window.setInterval(() => { if (!document.hidden) load(); }, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return count;
}

// ---------------------------------------------------------------- shell

// Collapsed inspector: the 48 px counterpart of SidebarRail.
export function InspectorRail() {
  return (
    <nav className="w-12 shrink-0 h-full flex flex-col items-center gap-1 py-2 border-l border-line bg-panel" aria-label="Inspecteur réduit">
      <IconButton label="Déplier l’inspecteur (Ctrl+I)" tipSide="left" onClick={() => togglePanel('inspectorOpen', true)}>
        <PanelRightOpen className="w-4 h-4" />
      </IconButton>
    </nav>
  );
}

/** Six MVP entries from spec 02 §1, then everything else behind "Mode avancé". */
const MVP_NAV = [
  { id: 'home', label: 'Workspaces', icon: <Home className="w-[18px] h-[18px]" /> },
  { id: 'sessions', label: 'Sessions', icon: <MessagesSquare className="w-[18px] h-[18px]" /> },
  { id: 'projects', label: 'Projets', icon: <FolderOpen className="w-[18px] h-[18px]" /> },
  { id: 'agent', label: 'Agents MVP', icon: <Bot className="w-[18px] h-[18px]" /> },
  { id: 'models', label: 'Modèles GGUF', icon: <Boxes className="w-[18px] h-[18px]" /> },
  { id: 'compute', label: 'Calcul GPU', icon: <Cloud className="w-[18px] h-[18px]" /> },
  { id: 'services', label: 'Services', icon: <Plugs className="w-[18px] h-[18px]" /> },
  { id: 'quotas', label: 'Quotas et santé', icon: <Gauge className="w-[18px] h-[18px]" /> },
] as const;

const ADVANCED_NAV = [
  { id: 'code', label: 'Code', icon: <Code2 className="w-[18px] h-[18px]" /> },
  { id: 'git', label: 'Git', icon: <FolderGit2 className="w-[18px] h-[18px]" /> },
  { id: 'providers', label: 'Fournisseurs', icon: <KeyRound className="w-[18px] h-[18px]" /> },
  { id: 'tools', label: 'Outils et MCP', icon: <Wrench className="w-[18px] h-[18px]" /> },
  { id: 'memory', label: 'Mémoire', icon: <Database className="w-[18px] h-[18px]" /> },
  { id: 'performance', label: 'Performance', icon: <Activity className="w-[18px] h-[18px]" /> },
  { id: 'settings', label: 'Paramètres', icon: <Settings className="w-[18px] h-[18px]" /> },
] as const;

export function PrimaryNavRail() {
  const view = useApp((s) => s.view);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!advanced) return;
    const close = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('[data-advanced-nav]')) setAdvanced(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [advanced]);

  const itemClass = (active: boolean) =>
    `w-9 h-9 rounded flex items-center justify-center cursor-pointer transition-colors ${active ? 'bg-raised text-brand border border-line-strong' : 'text-muted hover:text-fg hover:bg-raised/60'}`;

  return (
    <IconContext.Provider value={{ weight: 'duotone' }}>
    <nav className="w-12 shrink-0 h-full flex flex-col items-center justify-between py-2 border-r border-line bg-panel select-none z-10" aria-label="Navigation principale">
      <div className="flex flex-col items-center gap-1 w-full overflow-y-auto overflow-x-hidden">
        {MVP_NAV.map((n) => (
          <button key={n.id} type="button" aria-label={n.label} title={n.label} onClick={() => navigate(n.id as ViewId)} className={itemClass(view === n.id)}>
            {n.icon}
          </button>
        ))}
      </div>
      <div className="relative flex flex-col items-center gap-1 w-full pt-1 border-t border-line" data-advanced-nav>
        <button
          type="button"
          aria-label="Mode avancé"
          aria-expanded={advanced}
          title="Mode avancé"
          onClick={() => setAdvanced((open) => !open)}
          className={itemClass(advanced || ADVANCED_NAV.some((n) => n.id === view))}
        >
          <ChevronUp className={`w-[18px] h-[18px] transition-transform ${advanced ? 'rotate-180' : ''}`} />
        </button>
        {advanced && (
          <div className="absolute left-full bottom-0 ml-1 w-52 rounded-md border border-line bg-panel shadow-lg p-1 space-y-0.5" role="menu" aria-label="Mode avancé">
            {ADVANCED_NAV.map((n) => (
              <button
                key={n.id}
                type="button"
                role="menuitem"
                onClick={() => { navigate(n.id as ViewId); setAdvanced(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-[12px] cursor-pointer ${view === n.id ? 'bg-raised text-brand' : 'text-muted hover:text-fg hover:bg-raised/60'}`}
              >
                {n.icon}
                <span>{n.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </nav>
    </IconContext.Provider>
  );
}

export function AppShell() {
  const persistence = useApp((s) => s.health?.persistence);
  const view = useApp((s) => s.view);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const inspectorOpen = useApp((s) => s.inspectorOpen);
  const bottomOpen = useApp((s) => s.bottomOpen);
  const paletteOpen = useApp((s) => s.paletteOpen);
  const sessions = useApp((s) => s.sessions);
  const connected = useApp((s) => s.connected);
  const connectionError = useApp((s) => s.connectionError);
  const sidebar = usePanelSize('sidebar', 268, 200, 460);
  const inspector = usePanelSize('inspector', 340, 260, 620);
  const bottom = usePanelSize('bottom', 240, 120, 640);
  const openPalette = (open: boolean) => setState({ paletteOpen: open });
  const compact = useCompactLayout();

  useEffect(() => applyCompactLayout(compact), [compact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys dispatched on document or window have no element target: those are never typing.
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || !!target.closest('.cm-editor'));
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette(true);
      } else if (mod && e.key.toLowerCase() === 'b' && !typing) {
        e.preventDefault();
        togglePanel('sidebarOpen');
      } else if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        togglePanel('bottomOpen');
      } else if (mod && e.key.toLowerCase() === 'i' && !typing) {
        e.preventDefault();
        togglePanel('inspectorOpen');
      } else if (mod && e.key === ',') {
        e.preventDefault();
        navigate('settings');
      } else if (mod && e.key.toLowerCase() === 'n' && e.shiftKey) {
        e.preventDefault();
        setActiveSession(undefined);
        navigate('agent');
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        const withShortcut = NAV.filter((n) => n.shortcut);
        const target = withShortcut[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          navigate(target.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [...NAV, { id: 'settings' as ViewId, key: 'nav.settings' as I18nKey, icon: <Settings className="w-4 h-4" />, shortcut: 'Ctrl+,' }].map((n) => ({
      id: `nav:${n.id}`,
      label: t(n.key),
      group: 'Pages',
      hint: n.shortcut,
      icon: n.icon,
      run: () => navigate(n.id),
    }));
    const actions: Command[] = [
      { id: 'act:new', label: 'Nouvelle session agent', group: 'Actions', hint: 'Ctrl+Maj+N', icon: <Plus className="w-4 h-4" />, run: () => (setActiveSession(undefined), navigate('agent')) },
      { id: 'act:open', label: 'Ouvrir un dossier de projet', group: 'Actions', icon: <FolderOpen className="w-4 h-4" />, run: () => navigate('projects', 'open') },
      { id: 'act:model', label: 'Charger un modèle GGUF', group: 'Actions', icon: <Boxes className="w-4 h-4" />, run: () => navigate('models') },
      { id: 'act:terminal', label: 'Afficher le terminal', group: 'Actions', hint: 'Ctrl+J', icon: <PanelBottom className="w-4 h-4" />, run: () => togglePanel('bottomOpen', true) },
      { id: 'act:bench', label: 'Lancer un benchmark local', group: 'Actions', icon: <Activity className="w-4 h-4" />, run: () => navigate('performance', 'benchmarks') },
      { id: 'act:keys', label: 'Configurer une clé API', group: 'Actions', icon: <KeyRound className="w-4 h-4" />, run: () => navigate('providers') },
      { id: 'act:perm', label: 'Centre de permissions', group: 'Actions', icon: <ListTree className="w-4 h-4" />, run: () => navigate('settings', 'permissions') },
      ...(['focus', 'coding', 'review', 'monitoring'] as LayoutMode[]).map((l) => ({ id: `layout:${l}`, label: `Disposition : ${t(`layout.${l}` as I18nKey)}`, group: 'Disposition', run: () => setLayout(l) })),
    ];
    const sess: Command[] = sessions.slice(0, 40).map((s) => ({
      id: `session:${s.id}`,
      label: s.title,
      group: 'Sessions',
      hint: basename(s.projectRoot),
      icon: <MessagesSquare className="w-4 h-4" />,
      keywords: s.lastPrompt,
      run: () => {
        setActiveSession(s.id);
        navigate('agent', s.id);
      },
    }));
    return [...actions, ...nav, ...sess];
  }, [sessions]);

  const showSidebar = sidebarOpen && SIDEBAR_VIEWS.includes(view);
  const showInspector = inspectorOpen && INSPECTOR_VIEWS.includes(view);

  return (
    <div className="h-full flex flex-col app-halo" data-compact={compact || undefined}>
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-1 focus:left-1 focus:px-3 focus:py-1 focus:bg-panel focus:border focus:border-line focus:rounded">
        Aller au contenu
      </a>
      <TitleBar onPalette={() => openPalette(true)} />
      {persistence && !persistence.ok && (
        <div role="alert" className="shrink-0 px-4 py-2 text-[12px] bg-bad/10 border-b border-bad/30 text-bad">
          Sauvegarde impossible : {persistence.failures.map(f=>`${f.file} : ${f.message}`).join(' ; ')}. Les dernières modifications peuvent ne pas être enregistrées.
        </div>
      )}
      {connected === false && (
        <div role="alert" className="shrink-0 flex items-center gap-3 px-4 py-1.5 text-[12px] bg-bad/10 border-b border-bad/30 text-bad">
          <StatusDot tone="bad" />
          Serveur Studio déconnecté : {connectionError}. Relancez <code className="font-mono">scripts/start.ps1</code> ; reconnexion automatique toutes les 15 s.
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        <PrimaryNavRail />
        {showSidebar && (
          <>
            <aside className="shrink-0 min-w-0 border-r border-line bg-panel flex flex-col anim-panel-open" style={{ width: sidebar.size }} aria-label="Barre latérale">
              {view === 'code' || view === 'git' ? (
                <Suspense fallback={<ViewFallback />}>
                  <FileTreeSidebar />
                </Suspense>
              ) : (
                <SessionsSidebar />
              )}
            </aside>
            <Splitter orientation="vertical" size={sidebar.size} min={sidebar.min} max={sidebar.max} onResize={sidebar.setSize} onReset={sidebar.reset} label="Redimensionner la barre latérale" />
          </>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 flex">
            <main id="main-content" className="flex-1 min-w-0 min-h-0" tabIndex={-1}>
              <Suspense fallback={<ViewFallback />}>{renderView(view)}</Suspense>
            </main>
            {showInspector && (
              <>
                <Splitter orientation="vertical" invert size={inspector.size} min={inspector.min} max={inspector.max} onResize={inspector.setSize} onReset={inspector.reset} label="Redimensionner l’inspecteur" />
                <aside className="shrink-0 min-w-0 border-l border-line bg-panel" style={{ width: inspector.size }} aria-label="Inspecteur">
                  <Suspense fallback={<ViewFallback />}>
                    <AgentInspector />
                  </Suspense>
                </aside>
              </>
            )}
            {!showInspector && INSPECTOR_VIEWS.includes(view) && <InspectorRail />}
          </div>
          {bottomOpen && (
            <>
              <Splitter orientation="horizontal" invert size={bottom.size} min={bottom.min} max={bottom.max} onResize={bottom.setSize} onReset={bottom.reset} label="Redimensionner le panneau inférieur" />
              <section className="shrink-0 border-t border-line bg-panel min-h-0" style={{ height: bottom.size }} aria-label="Panneau inférieur">
                <Suspense fallback={<ViewFallback />}>
                  <BottomPanel />
                </Suspense>
              </section>
            </>
          )}
        </div>
      </div>
      <StatusBar />
      {paletteOpen && <CommandPalette commands={commands} onClose={() => openPalette(false)} />}
      <Toasts />
      <WelcomeToastOnce />
    </div>
  );
}

function WelcomeToastOnce() {
  const connected = useApp((s) => s.connected);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (connected && !shown) {
      setShown(true);
    } else if (connected === false && !shown) {
      setShown(true);
      toast('bad', 'Backend injoignable', 'Les données affichées ne peuvent pas être chargées tant que le serveur est arrêté.');
    }
  }, [connected, shown]);
  return null;
}
