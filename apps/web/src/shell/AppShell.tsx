import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Bot,
  Boxes,
  Cpu,
  Database,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Home,
  KeyRound,
  LayoutPanelLeft,
  ListTree,
  MessagesSquare,
  PanelBottom,
  PanelRight,
  Plus,
  Search,
  Settings,
  Code2,
  Wrench,
  Microchip,
} from 'lucide-react';
import { navigate, setLayout, setState, togglePanel, useApp, setActiveSession, type ViewId, type LayoutMode, toast } from '../lib/store';
import { t, type I18nKey } from '../lib/i18n';
import { MazzMark } from '../components/brand';
import { CommandPalette, Toasts, type Command } from '../components/overlays';
import { IconButton, Kbd, Spinner, StatusDot } from '../components/ui';
import { Splitter, usePanelSize } from '../components/Splitter';
import { basename, fmtBytes, fmtRate } from '../lib/format';
import { allRuns, getRun, useRunsVersion } from '../lib/agentRuns';
import { api } from '../lib/api';
import { rollingRate } from '@mazz/shared';
import { SessionsSidebar, SidebarRail } from '../features/sessions/SessionsSidebar';

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
const ToolsView = lazy(() => import('../features/tools/ToolsView'));
const MemoryView = lazy(() => import('../features/memory/MemoryView'));
const PerformanceView = lazy(() => import('../features/performance/PerformanceView'));
const MuceView = lazy(() => import('../features/muce/MuceView'));
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
  { id: 'tools', key: 'nav.tools', icon: <Wrench className="w-[18px] h-[18px]" /> },
  { id: 'memory', key: 'nav.memory', icon: <Database className="w-[18px] h-[18px]" /> },
  { id: 'performance', key: 'nav.performance', icon: <Activity className="w-[18px] h-[18px]" />, shortcut: 'Alt+8' },
  { id: 'muce', key: 'nav.muce', icon: <Microchip className="w-[18px] h-[18px]" /> },
];

const SIDEBAR_VIEWS: ViewId[] = ['home', 'agent', 'sessions', 'projects', 'code', 'git', 'models', 'providers', 'tools', 'memory', 'performance', 'muce', 'settings'];
const INSPECTOR_VIEWS: ViewId[] = ['agent', 'code'];

function ViewFallback() {
  return (
    <div className="h-full grid place-items-center">
      <Spinner size={18} label="Chargement de la vue" />
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
    case 'tools':
      return <ToolsView />;
    case 'memory':
      return <MemoryView />;
    case 'performance':
      return <PerformanceView />;
    case 'muce':
      return <MuceView />;
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
  const view = useApp((s) => s.view);
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
      <button
        type="button"
        onClick={() => navigate('providers')}
        className={`flex items-center gap-1.5 h-6 px-2 rounded text-[11px] font-mono cursor-pointer transition-colors ${view === 'providers' ? 'bg-raised text-fg border border-line' : 'text-muted hover:text-fg hover:bg-raised/60'}`}
        title="Configurer les fournisseurs LLM (Groq, OVHcloud, llmfaucet, OpenAI, Gemini...)"
      >
        <KeyRound className="w-3 h-3 text-[var(--post-audit)]" />
        <span>Fournisseurs</span>
      </button>
      <button
        type="button"
        onClick={() => navigate('models')}
        className={`flex items-center gap-1.5 h-6 px-2 rounded text-[11px] font-mono cursor-pointer transition-colors ${view === 'models' ? 'bg-raised text-fg border border-line' : 'text-muted hover:text-fg hover:bg-raised/60'}`}
        title="Hub des modèles locaux GGUF"
      >
        <Boxes className="w-3 h-3 text-[var(--post-reverse)]" />
        <span>Modèles</span>
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
  const ctxMax = llama?.config?.contextSize;
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
    const load = () =>
      api
        .get<{ servers: Array<{ status?: { tools?: unknown[] } }> }>('/api/mcp/servers')
        .then((r) => alive && setCount(r.servers.reduce((n, sv) => n + (sv.status?.tools?.length ?? 0), 0)))
        .catch(() => alive && setCount(undefined));
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return count;
}

// ---------------------------------------------------------------- shell

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.closest('.cm-editor');
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
      } else if (e.altKey && /^[1-8]$/.test(e.key)) {
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
    <div className="h-full flex flex-col app-halo">
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
        {!showSidebar && SIDEBAR_VIEWS.includes(view) && <SidebarRail />}
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
