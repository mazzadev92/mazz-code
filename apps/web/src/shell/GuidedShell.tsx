import { lazy, Suspense, type ReactNode } from 'react';
import {
  IconContext,
  House as Home,
  Cloud,
  Plugs,
  Robot as Bot,
  Cube as Boxes,
  FolderOpen,
  Gear as Settings,
} from '@phosphor-icons/react';
import { errorMessage } from '../lib/api';
import { navigate, saveSettings, toast, useApp, type ViewId } from '../lib/store';
import { MazzMark } from '../components/brand';
import { Button, IconButton, Spinner, StatusDot } from '../components/ui';
import { Toasts } from '../components/overlays';
import { basename } from '../lib/format';

const GuidedHome = lazy(() => import('../features/home/GuidedHome'));
const ModelsView = lazy(() => import('../features/models/ModelsView'));
const GuidedServices = lazy(() => import('../features/services/GuidedServices'));
const ServicesView = lazy(() => import('../features/services/ServicesView'));
const ComputeView = lazy(() => import('../features/compute/ComputeView'));
const AgentView = lazy(() => import('../features/agent/AgentView'));
const ProjectsView = lazy(() => import('../features/projects/ProjectsView'));
const SettingsView = lazy(() => import('../features/settings/SettingsView'));
const GuidedAdvanced = lazy(() => import('./GuidedAdvanced').then((m) => ({ default: m.GuidedAdvanced })));

const GUIDED_NAV: Array<{ id: ViewId; label: string; hint: string; icon: ReactNode }> = [
  { id: 'home', label: 'Accueil', hint: 'Votre progression', icon: <Home className="w-[18px] h-[18px]" /> },
  { id: 'models', label: 'Modèles', hint: 'Télécharger et charger', icon: <Boxes className="w-[18px] h-[18px]" /> },
  { id: 'services', label: 'Services', hint: 'Comptes et clés', icon: <Plugs className="w-[18px] h-[18px]" /> },
  { id: 'compute', label: 'Calcul GPU', hint: 'Kaggle, Colab, Modal', icon: <Cloud className="w-[18px] h-[18px]" /> },
  { id: 'agent', label: 'Assistant', hint: 'Discuter et agir', icon: <Bot className="w-[18px] h-[18px]" /> },
  { id: 'projects', label: 'Projets', hint: 'Ouvrir un dossier', icon: <FolderOpen className="w-[18px] h-[18px]" /> },
  { id: 'settings', label: 'Paramètres', hint: 'Tout régler', icon: <Settings className="w-[18px] h-[18px]" /> },
];

function Fallback() {
  return (
    <div className="h-full grid place-items-center">
      <Spinner size={22} variant="brand" label="Chargement de la page" />
    </div>
  );
}

function renderGuided(view: ViewId, param: string | undefined) {
  switch (view) {
    case 'home':
      return <GuidedHome />;
    case 'models':
      return <ModelsView guided />;
    case 'services':
      return param === 'all' ? <ServicesView /> : <GuidedServices />;
    case 'compute':
      return <ComputeView />;
    case 'agent':
      return <AgentView />;
    case 'projects':
      return <ProjectsView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <GuidedAdvanced view={view} />;
  }
}

/**
 * Guided shell: labelled navigation, no advanced sidebars, inspector or terminal.
 * It is the default for a fresh install; Settings switches to the full AppShell at any time.
 */
export function GuidedShell() {
  const settings = useApp((s) => s.settings);
  const view = useApp((s) => s.view);
  const viewParam = useApp((s) => s.viewParam);
  const connected = useApp((s) => s.connected);
  const llama = useApp((s) => s.llama);

  if (!settings) {
    return (
      <div className="h-full grid place-items-center">
        <Spinner size={22} variant="brand" label="Chargement de MAZZ Studio" />
      </div>
    );
  }

  const firstRun = !settings.general.onboardingDone;
  const effectiveView: ViewId = firstRun ? 'home' : view;
  const toFull = async () => {
    try {
      await saveSettings({ general: { uiMode: 'advanced' } });
      navigate('home');
      toast('info', 'Interface complète activée', 'Vous pouvez revenir au mode guidé dans Paramètres, section Général.');
    } catch (e) {
      toast('bad', 'Changement impossible', errorMessage(e));
    }
  };

  return (
    <div className="h-full flex flex-col app-halo">
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-line bg-panel">
        <button type="button" onClick={() => navigate('home')} className="flex items-center gap-2 cursor-pointer" aria-label="Accueil MAZZ Studio">
          <MazzMark size={24} state={connected === false ? 'offline' : llama?.state === 'ready' ? 'thinking' : 'idle'} />
          <span className="font-bold tracking-tight text-fg text-[13px]">MAZZ STUDIO</span>
          <span className="hidden sm:inline text-[11px] text-faint border border-line rounded px-1.5 py-0.5">mode guidé</span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={() => navigate('settings', 'general')}>
            Aide et réglages
          </Button>
          <Button size="xs" variant="secondary" onClick={() => void toFull()}>
            Interface complète
          </Button>
          <IconButton label="Paramètres" onClick={() => navigate('settings')}>
            <Settings className="w-4 h-4" />
          </IconButton>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {!firstRun && (
          <nav className="w-[190px] shrink-0 border-r border-line bg-panel p-2 space-y-0.5 overflow-y-auto" aria-label="Navigation guidée">
            <IconContext.Provider value={{ weight: 'duotone' }}>
              {GUIDED_NAV.map((item) => {
                const active = effectiveView === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left cursor-pointer transition-colors ${active ? 'bg-raised text-brand border border-line-strong' : 'text-muted hover:text-fg hover:bg-raised/60 border border-transparent'}`}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium leading-tight">{item.label}</span>
                      <span className="block text-[10.5px] text-faint leading-tight mt-0.5">{item.hint}</span>
                    </span>
                  </button>
                );
              })}
            </IconContext.Provider>
            <div className="pt-2 mt-2 border-t border-line">
              <Button size="xs" variant="ghost" className="w-full justify-start" onClick={() => navigate('settings', 'general')}>
                Revoir le guide
              </Button>
            </div>
          </nav>
        )}
        <main className="flex-1 min-w-0 min-h-0" tabIndex={-1}>
          <Suspense fallback={<Fallback />}>{renderGuided(effectiveView, viewParam)}</Suspense>
        </main>
      </div>

      <footer className="h-8 shrink-0 flex items-center gap-3 px-4 border-t border-line bg-panel text-[11px] text-muted">
        <StatusDot tone={connected === false ? 'bad' : connected ? 'good' : 'neutral'} />
        <span>{connected === false ? 'Serveur déconnecté' : 'Connecté en local'}</span>
        <span className="text-faint">·</span>
        <span className="truncate">
          {llama?.state === 'ready' ? `Modèle : ${basename(llama.modelPath ?? '')}` : llama?.state === 'starting' ? 'Modèle en cours de chargement…' : 'Aucun modèle chargé'}
        </span>
        <span className="ml-auto text-faint">Mode guidé · passez en interface complète dans Paramètres</span>
      </footer>
      <Toasts />
    </div>
  );
}
