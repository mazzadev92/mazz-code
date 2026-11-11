import { ArrowRight, Code as Code2, GitBranch, ChatsCircle, Plugs, Wrench, Database, Gauge, Timer } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { openFullInterface, toast, useApp, type ViewId } from '../lib/store';
import { Button, Card } from '../components/ui';

const SCREENS: Partial<Record<ViewId, { title: string; intro: string; bullets: string[]; icon: ReactNode }>> = {
  code: {
    title: 'Explorateur de code',
    intro: 'Parcourir les fichiers de votre projet, les ouvrir et les modifier dans l’éditeur intégré.',
    bullets: [
      'Arborescence complète du dossier ouvert, recherche plein texte et coloration syntaxique.',
      'Les modifications passent par les autorisations d’accès définies dans Paramètres.',
    ],
    icon: <Code2 className="w-5 h-5" />,
  },
  git: {
    title: 'Git',
    intro: 'Voir l’état du dépôt, les différences, les branches et créer un commit.',
    bullets: [
      'Fonctionne sur le dossier de projet ouvert ; aucun dépôt distant n’est requis.',
      'Les commits restent locaux tant que vous ne poussez pas explicitement.',
    ],
    icon: <GitBranch className="w-5 h-5" />,
  },
  sessions: {
    title: 'Tâches et sessions',
    intro: 'Retrouver les conversations, les tâches longues et les exécutions passées de l’assistant.',
    bullets: [
      'Chaque session conserve son historique, ses outils appelés et sa consommation de jetons.',
      'Vous pouvez reprendre une session ou en supprimer une depuis cette page.',
    ],
    icon: <ChatsCircle className="w-5 h-5" />,
  },
  providers: {
    title: 'Fournisseurs IA',
    intro: 'Gérer les connexions aux fournisseurs (Groq, Mistral, OpenAI-compatible, serveurs locaux) et l’ordre de secours.',
    bullets: [
      'Le mode guidé configure déjà les services gratuits ; cet écran expose tous les réglages fins.',
      'Vous y ajoutez un fournisseur personnalisé avec sa propre URL et son modèle.',
    ],
    icon: <Plugs className="w-5 h-5" />,
  },
  tools: {
    title: 'Outils de l’assistant',
    intro: 'Choisir les outils que l’assistant peut appeler : terminal, fichiers, recherche, navigateur, MCP.',
    bullets: [
      'Chaque outil sensible demande une autorisation avant de s’exécuter.',
      'Les serveurs MCP et les dossiers de compétences se configurent ici.',
    ],
    icon: <Wrench className="w-5 h-5" />,
  },
  memory: {
    title: 'Mémoire et données',
    intro: 'Consulter ce que MAZZ retient entre deux sessions et effacer des données précises.',
    bullets: [
      'Mémoire de projet, préférences et journaux d’audit sont listés séparément.',
      'La suppression est immédiate et ne touche pas à vos fichiers de travail.',
    ],
    icon: <Database className="w-5 h-5" />,
  },
  performance: {
    title: 'Performances',
    intro: 'Suivre la vitesse de génération, la RAM, le GPU et la VRAM pendant l’exécution.',
    bullets: [
      'Les mesures viennent du processus llama-server réel, pas d’une estimation.',
      'Vous y lancez aussi un benchmark local du modèle chargé.',
    ],
    icon: <Gauge className="w-5 h-5" />,
  },
  quotas: {
    title: 'Quotas et sessions cloud',
    intro: 'Suivre le temps consommé sur Kaggle, Colab, Modal et Saturn, et arrêter une session distante.',
    bullets: [
      'Le temps restant est calculé à partir des sessions réellement démarrées par MAZZ.',
      'Une session oubliée peut être arrêtée depuis cette page.',
    ],
    icon: <Timer className="w-5 h-5" />,
  },
};

/**
 * Landing screen for advanced-only views while the guided shell is active.
 * Reaching one of these views is never a dead end: the screen says what lives there and
 * switches to the full interface in one click, keeping the requested destination.
 */
export function GuidedAdvanced({ view }: { view: ViewId }) {
  const screen = SCREENS[view];
  const settings = useApp((s) => s.settings);
  const open = async () => {
    try {
      await openFullInterface(view);
    } catch (e) {
      toast('bad', 'Passage en interface complète impossible', errorMessage(e));
    }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-6 py-8 space-y-4">
        <Card
          title={screen?.title ?? 'Fonction avancée'}
          subtitle="Cette page fait partie de l’interface complète."
          actions={
            <Button variant="primary" icon={<ArrowRight className="w-4 h-4" />} onClick={() => void open()}>
              Ouvrir ici
            </Button>
          }
        >
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-brand shrink-0 mt-0.5">{screen?.icon ?? <Wrench className="w-5 h-5" />}</span>
              <p className="text-[13px] text-muted">{screen?.intro ?? 'Cette section n’est disponible que dans l’interface complète.'}</p>
            </div>
            {screen && (
              <ul className="text-[12.5px] text-muted space-y-1.5 pl-8 list-disc marker:text-faint">
                {screen.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <p className="text-[12px] text-faint">
              Le mode guidé reste le mode par défaut. Vous pourrez revenir à tout moment via{' '}
              <span className="text-fg">Paramètres → Général → Mode d’interface</span>
              {settings?.general.uiMode === 'guided' ? ' (actuellement : guidé).' : '.'}
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
