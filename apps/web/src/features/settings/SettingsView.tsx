import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, FolderOpen, RotateCcw, Search } from 'lucide-react';
import { ApiError, api, errorMessage } from '../../lib/api';
import { AGENT_MODE_OPTIONS, type StudioSettings } from '../../lib/types';
import { navigate, saveSettings, setState, toast, useApp } from '../../lib/store';
import { Badge, Button, Card, ConfirmDialog, Input, Kbd, Notice, Segmented, Select, Toggle, cx } from '../../components/ui';
import { PathPicker } from '../../components/overlays';
import { FolderListEditor } from '../agent/AccessDialog';

type Rule = StudioSettings['permissions']['rules'][number];

/** Allow/deny rules by tool and pattern, checked before the category permissions. */
function RulesEditor({ settings }: { settings: StudioSettings }) {
  const rules = settings.permissions.rules ?? [];
  const [draft, setDraft] = useState<Rule>({ tool: 'terminal.run', pattern: '', decision: 'allow' });
  const save = async (next: Rule[]) => {
    try {
      await saveSettings({ permissions: { rules: next } });
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    }
  };
  return (
    <Card title="Règles par outil et motif" subtitle="Vérifiées avant les permissions ci-dessus. Le motif (* = n’importe quoi) porte sur la commande, le chemin, l’adresse ou la requête. Une règle « Refuser » l’emporte toujours. Les réponses « Toujours » sur une commande ajoutent ici une règle pour sa famille (ex. git *).">
      <div className="space-y-1.5">
        {rules.length === 0 && <div className="text-[12px] text-faint">Aucune règle.</div>}
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-[12.5px]">
            <Badge tone={r.decision === 'allow' ? 'good' : 'bad'}>{r.decision === 'allow' ? 'Autoriser' : 'Refuser'}</Badge>
            <span className="font-mono">{r.tool}</span>
            <span className="text-faint">:</span>
            <span className="font-mono flex-1 truncate">{r.pattern || '*'}</span>
            <Button size="sm" variant="ghost" onClick={() => void save(rules.filter((_, j) => j !== i))}>
              Retirer
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Select value={draft.decision} onChange={(e) => setDraft({ ...draft, decision: e.target.value as Rule['decision'] })} aria-label="Décision">
            <option value="allow">Autoriser</option>
            <option value="deny">Refuser</option>
          </Select>
          <Input value={draft.tool} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} className="w-44 font-mono text-[12px]" aria-label="Outil" placeholder="terminal.run, fs.*, mcp.github.*" />
          <Input value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} className="w-64 font-mono text-[12px]" aria-label="Motif" placeholder="git *, *.env, https://docs.*" />
          <Button
            size="sm"
            disabled={!draft.tool.trim()}
            onClick={() => {
              void save([...rules, { ...draft, pattern: draft.pattern.trim() || '*', tool: draft.tool.trim() }]);
              setDraft({ ...draft, pattern: '' });
            }}
          >
            Ajouter
          </Button>
        </div>
      </div>
    </Card>
  );
}

function BraveKey() {
  const [hint, setHint] = useState<string | null>(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    api.get<{ hint: string | null }>('/api/web/brave-key').then((r) => setHint(r.hint)).catch(() => undefined);
  }, []);
  const save = async (key: string) => {
    try {
      setHint((await api.put<{ hint: string | null }>('/api/web/brave-key', { key })).hint);
      setValue('');
      toast('good', key ? 'Clé Brave enregistrée' : 'Clé Brave retirée');
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    }
  };
  return (
    <Card title="Clé Brave Search">
      <div className="flex items-center gap-2">
        <Input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hint ? `Enregistrée : ${hint}` : 'Clé API'} className="w-[320px]" aria-label="Clé Brave Search" />
        <Button size="sm" disabled={!value} onClick={() => void save(value)}>
          Enregistrer
        </Button>
        {hint && (
          <Button size="sm" variant="ghost" onClick={() => void save('')}>
            Retirer
          </Button>
        )}
      </div>
      <p className="text-[11.5px] text-faint mt-2">Chiffrée dans le coffre (DPAPI), jamais renvoyée à l’interface.</p>
    </Card>
  );
}

function AccessFolders({ settings }: { settings: StudioSettings }) {
  const save = async (patch: Partial<StudioSettings['access']> | { remoteAcknowledged: string[] }) => {
    try {
      await saveSettings('remoteAcknowledged' in patch ? { ai: patch } : { access: patch });
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    }
  };
  return (
    <>
      <Card title="Dossiers de confiance">
        <p className="text-[12px] text-muted mb-2">Accessibles sans demande dans toutes les sessions. Les réponses « Toujours » à une demande d’accès les ajoutent ici.</p>
        <FolderListEditor folders={settings.access.extraRoots} onChange={(next) => save({ extraRoots: next })} empty="Aucun dossier de confiance : seul le projet est accessible sans demande." />
      </Card>
      <Card title="Dossiers protégés">
        <p className="text-[12px] text-muted mb-2">Jamais accessibles, quel que soit le mode. Toujours protégés : les données du Studio (coffre des clés) et les dossiers d’identifiants du profil (.ssh, .gnupg, .aws, .azure, .kube, .docker).</p>
        <FolderListEditor folders={settings.access.protectedRoots} onChange={(next) => save({ protectedRoots: next })} empty="Aucun dossier protégé supplémentaire." addLabel="Protéger un dossier" />
      </Card>
      <Card title="Fournisseurs distants confirmés">
        {settings.ai.remoteAcknowledged.length === 0 ? (
          <p className="text-[12px] text-faint">Aucun.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {settings.ai.remoteAcknowledged.map((p) => (
              <Button key={p} size="sm" variant="ghost" title="Retirer : la confirmation sera redemandée" onClick={() => void save({ remoteAcknowledged: settings.ai.remoteAcknowledged.filter((x) => x !== p) })}>
                {p} (retirer)
              </Button>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

type FieldType = 'toggle' | 'select' | 'number' | 'text' | 'segmented' | 'path-exe' | 'path-folder' | 'path-gguf' | 'range' | 'provider';

interface FieldDef {
  path: string;
  label: string;
  hint?: string;
  type: FieldType;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

interface SectionDef {
  id: string;
  title: string;
  description?: string;
  /** Settings section reset by "Réinitialiser" (backend section name). */
  resetKey?: keyof StudioSettings;
  fields: FieldDef[];
  extra?: ReactNode;
}

const PERM_OPTIONS = [
  { value: 'ask', label: 'Demander' },
  { value: 'allow', label: 'Autoriser dans le projet' },
  { value: 'deny', label: 'Refuser' },
];

export const AGENT_DEFAULT_MODE_OPTIONS = AGENT_MODE_OPTIONS.map(({ value, label }) => ({ value, label }));

const SECTIONS: SectionDef[] = [
  {
    id: 'general',
    title: 'Général',
    resetKey: 'general',
    fields: [
      { path: 'general.language', label: 'Langue de l’interface', hint: 'Le français couvre toute l’interface ; l’anglais couvre la navigation et les actions communes.', type: 'segmented', options: [{ value: 'fr', label: 'Français' }, { value: 'en', label: 'English' }] },
      { path: 'general.startView', label: 'Vue au démarrage', type: 'select', options: [{ value: 'home', label: 'Accueil' }, { value: 'agent', label: 'Agent' }, { value: 'last', label: 'Dernière vue' }] },
      { path: 'general.notifications', label: 'Notifications de fin de tâche', hint: 'Notification dans l’interface quand une tâche se termine.', type: 'toggle' },
      { path: 'general.onboardingDone', label: 'Assistant de configuration terminé', hint: 'Désactivez pour le réafficher sur l’accueil.', type: 'toggle' },
    ],
  },
  {
    id: 'appearance',
    title: 'Apparence',
    resetKey: 'appearance',
    fields: [
      { path: 'appearance.theme', label: 'Identité visuelle', type: 'segmented', options: [{ value: 'bioforge', label: 'Bioforge Leaf' }, { value: 'blueprint', label: 'Blueprint Engineer' }] },
      { path: 'appearance.mode', label: 'Luminosité', type: 'segmented', options: [{ value: 'dark', label: 'Sombre' }, { value: 'light', label: 'Clair' }, { value: 'system', label: 'Système' }] },
      { path: 'appearance.density', label: 'Densité', type: 'segmented', options: [{ value: 'comfortable', label: 'Confortable' }, { value: 'compact', label: 'Compacte' }] },
      { path: 'appearance.uiScale', label: 'Zoom de l’interface', type: 'range', min: 80, max: 140, step: 5, unit: '%' },
      { path: 'appearance.codeFontSize', label: 'Taille du code', type: 'range', min: 10, max: 22, step: 1, unit: 'px' },
      { path: 'appearance.motion', label: 'Animations', hint: '« Système » suit le réglage Windows de réduction des animations.', type: 'segmented', options: [{ value: 'system', label: 'Système' }, { value: 'reduced', label: 'Réduites' }, { value: 'full', label: 'Complètes' }] },
      { path: 'appearance.highContrast', label: 'Contraste élevé', type: 'toggle' },
    ],
  },
  {
    id: 'ai',
    title: 'IA et inférence',
    resetKey: 'ai',
    fields: [
      { path: 'ai.executionMode', label: 'Mode d’exécution', hint: 'Local strict : le backend refuse tout fournisseur distant.', type: 'segmented', options: [{ value: 'local_strict', label: 'Local strict' }, { value: 'hybrid_opt_in', label: 'Hybride' }, { value: 'cloud', label: 'API' }] },
      { path: 'ai.temperature', label: 'Température par défaut', type: 'range', min: 0, max: 2, step: 0.05 },
      { path: 'ai.topP', label: 'Top-p', hint: 'Échantillonnage nucleus ; la valeur 0,8 convient au profil Qwen3 sans raisonnement.', type: 'range', min: 0, max: 1, step: 0.05 },
      { path: 'ai.topK', label: 'Top-k', hint: 'Limite les candidats de génération ; les fournisseurs qui ne le prennent pas en charge l’ignorent.', type: 'number', min: 1, max: 200 },
      { path: 'ai.presencePenalty', label: 'Pénalité de présence', hint: 'Réduit les répétitions ; Qwen3 quantifié recommande 1,5, mais une valeur plus faible peut convenir à d’autres modèles.', type: 'range', min: -2, max: 2, step: 0.1 },
      { path: 'ai.maxOutputTokens', label: 'Jetons de sortie maximum par appel', type: 'number', min: 16, max: 131072 },
      { path: 'ai.auxProviderId', label: 'Modèle des tâches auxiliaires', hint: 'Messages de commit proposés dans Git. Par défaut : le modèle local chargé. Un petit modèle ou une API rapide évite d’occuper le modèle principal.', type: 'provider' },
      { path: 'ai.auxModelId', label: 'Identifiant du modèle auxiliaire', hint: 'Requis si un fournisseur est choisi ci-dessus (ex. llama-3.1-8b-instant).', type: 'text' },
    ],
  },
  {
    id: 'cascade',
    title: 'Cascade et Résilience (Modèles Anonymes)',
    resetKey: 'cascade' as any,
    fields: [
      { path: 'cascade.enabled', label: 'Cascade automatique activée', hint: 'Bascule automatiquement vers le modèle suivant en cas de panne, 429 ou indisponibilité.', type: 'toggle' },
      { path: 'cascade.maxFallbacks', label: 'Nombre maximum de bascules par tour', hint: 'Limite le nombre de replis successifs (défaut 3).', type: 'number', min: 1, max: 10 },
      { path: 'cascade.cooldownSec', label: 'Temps de cooldown par défaut après erreur', hint: 'Délai d’attente avant de réutiliser un fournisseur ayant échoué (respecte Retry-After si fourni).', type: 'number', min: 5, max: 600, unit: 's' },
    ],
  },
  {
    id: 'agent',
    title: 'Agents',
    resetKey: 'agent',
    fields: [
      { path: 'agent.defaultMode', label: 'Mode par défaut', hint: 'Auto exécute les opérations prévues dans les autorisations configurées ; les refus, confirmations et garde-fous du backend restent actifs.', type: 'segmented', options: AGENT_DEFAULT_MODE_OPTIONS },
      { path: 'agent.maxIterations', label: 'Étapes maximum par tâche', hint: 'Chaque étape est un appel au modèle suivi des outils demandés.', type: 'number', min: 1, max: 50 },
      { path: 'agent.approvalTimeoutSec', label: 'Délai de réponse aux approbations', hint: 'Sans réponse, l’action est refusée.', type: 'number', min: 10, max: 3600, unit: 's' },
      { path: 'agent.maxConcurrentTasks', label: 'Tâches simultanées maximum', hint: '2 recommandé sur un processeur 4 cœurs.', type: 'number', min: 1, max: 4 },
      { path: 'agent.modelProfile', label: 'Profil du harnais', hint: 'Petit modèle : la tâche est découpée par le Studio, plan imposé, peu d’outils à la fois (0,6B à 4B locaux). Grand modèle : le modèle planifie seul et voit tous les outils (API distantes, modèles 14B et plus). Automatique : choisi à chaque tâche selon le modèle. Les permissions et points de restauration restent actifs dans les deux cas.', type: 'segmented', options: [{ value: 'auto', label: 'Automatique' }, { value: 'small', label: 'Petit modèle' }, { value: 'large', label: 'Grand modèle' }] },
      { path: 'agent.toolSelection', label: 'Sélection des outils par tâche', hint: 'Automatique : outils essentiels toujours proposés, les autres selon la demande ou via tools.request. Indispensable avec de nombreux outils MCP et un petit modèle.', type: 'segmented', options: [{ value: 'auto', label: 'Automatique' }, { value: 'all', label: 'Tous les outils' }] },
      { path: 'agent.projectInstructions', label: 'Instructions de projet', hint: 'Lit MAZZ.md, AGENTS.md, CLAUDE.md et .mazz/MAZZ.md du projet, et le MAZZ.md global du dossier de données, à chaque tâche.', type: 'toggle' },
      { path: 'agent.memory', label: 'Mémoire durable de l’agent', hint: 'L’agent garde des faits d’une session à l’autre (page Mémoire et données) ; leur index est ajouté à chaque tâche.', type: 'toggle' },
      { path: 'agent.autoCompact', label: 'Résumé automatique des longues conversations', hint: 'Au-delà du seuil, les anciens échanges sont remplacés par un résumé (modèle auxiliaire s’il est configuré). Manuel : /compact.', type: 'toggle' },
      { path: 'agent.compactAfterTurns', label: 'Seuil de résumé', type: 'number', min: 4, max: 50, unit: 'échanges' },
      { path: 'agent.toolProfile', label: 'Définitions d’outils envoyées au modèle', hint: 'Compactes : 788 jetons au lieu de 1 073 avec Qwen3 (-27 % de prefill à chaque appel). Les outils acceptent exactement les mêmes arguments.', type: 'segmented', options: [{ value: 'compact', label: 'Compactes' }, { value: 'full', label: 'Complètes' }] },
    ],
  },
  {
    id: 'web',
    title: 'Internet',
    description: 'Recherche et lecture de pages par l’agent. Désactivé en mode « Local strict ».',
    resetKey: 'web',
    fields: [
      { path: 'web.engine', label: 'Moteur de recherche', hint: 'DuckDuckGo sans clé ; SearXNG si vous en hébergez un ; Brave Search avec une clé (gratuite jusqu’à un quota).', type: 'segmented', options: [{ value: 'duckduckgo', label: 'DuckDuckGo' }, { value: 'searxng', label: 'SearXNG' }, { value: 'brave', label: 'Brave Search' }] },
      { path: 'web.searxngUrl', label: 'Adresse SearXNG', hint: 'Ex. http://127.0.0.1:8888', type: 'text' },
    ],
  },
  {
    id: 'access',
    title: 'Accès au PC',
    description: 'Dossiers que l’agent peut atteindre en plus du projet, pour tous les modèles (locaux et API). Le contrôle est fait par le Studio avant chaque outil.',
    resetKey: 'access',
    fields: [
      {
        path: 'access.mode',
        label: 'Accès hors du projet',
        hint: 'Sur demande : un chemin hors du projet et des dossiers de confiance déclenche une demande (une fois, pour la session, toujours). Complet : tout le PC sans demande, sauf dossiers protégés.',
        type: 'segmented',
        options: [{ value: 'project', label: 'Projet uniquement' }, { value: 'ask', label: 'Sur demande' }, { value: 'full', label: 'Complet' }],
      },
      { path: 'ai.confirmRemoteSend', label: 'Confirmer chaque nouveau fournisseur distant', hint: 'Une seule confirmation par fournisseur, au moment où il est choisi.', type: 'toggle' },
    ],
  },
  {
    id: 'permissions',
    title: 'Permissions',
    description: 'Appliquées par le backend à chaque appel d’outil. « Refuser » l’emporte sur tout, y compris le mode « Sans confirmation » d’une session. Les écritures et commandes hors du projet suivent aussi l’accès au PC.',
    resetKey: 'permissions',
    fields: [
      { path: 'permissions.write', label: 'Écriture de fichiers', hint: 'fs.write, enregistrement dans l’éditeur, restauration.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.delete', label: 'Suppression de fichiers', hint: 'fs.delete.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.terminal', label: 'Commandes et compilation', hint: 'terminal.run, compiler.gcc, terminal intégré.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.git', label: 'Écritures Git', hint: 'Indexation, annulation, commit.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.network', label: 'Fournisseurs distants', hint: '« Refuser » bloque toute exécution sur une API.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.web', label: 'Internet (recherche et lecture de pages)', hint: 'web.search et web.fetch. Les adresses locales et privées sont toujours refusées.', type: 'select', options: PERM_OPTIONS },
      { path: 'permissions.mcp', label: 'Outils des serveurs MCP', hint: 'Appels aux outils mcp.* par l’agent et tests depuis la page Outils.', type: 'select', options: PERM_OPTIONS },
    ],
  },
  {
    id: 'models',
    title: 'Modèles locaux',
    resetKey: 'models',
    fields: [
      { path: 'models.llamaServerPath', label: 'Exécutable llama-server', hint: 'Vide : recherche dans le PATH puis dans le dossier MUCE.', type: 'path-exe' },
      { path: 'models.contextSize', label: 'Contexte par défaut', type: 'number', min: 256, max: 262144, unit: 'jetons' },
      { path: 'models.memoryReserveMb', label: 'Réserve RAM système', hint: 'Le Studio refuse un chargement insuffisamment provisionné et arrête son propre runtime si la RAM disponible descend sous cette réserve.', type: 'number', min: 512, max: 8192, unit: 'Mo' },
      { path: 'models.threads', label: 'Threads par défaut', type: 'number', min: 1, max: 64 },
      { path: 'models.batchSize', label: 'Batch par défaut', type: 'number', min: 16, max: 8192 },
      { path: 'models.port', label: 'Port de llama-server', type: 'number', min: 1024, max: 65535 },
      { path: 'models.jinja', label: 'Activer --jinja (appel d’outils)', type: 'toggle' },
      { path: 'models.kvPersist', label: 'Cache KV par session sur disque', hint: 'Reprend une longue conversation sans recalculer son prompt (mesuré : 13,9 s ramenés à 0,37 s pour 1 516 jetons). Exige un seul slot. Appliqué au prochain démarrage du modèle.', type: 'toggle' },
      { path: 'models.kvMaxDiskMb', label: 'Espace disque maximum des caches KV', hint: 'Les caches les plus anciens sont supprimés au-delà. Environ 115 Ko par jeton pour Qwen3 0.6B.', type: 'number', min: 256, max: 65536, unit: 'Mo' },
      { path: 'models.cacheRamMb', label: 'Cache de prompt en RAM (--cache-ram)', hint: 'llama.cpp en réserve jusqu’à 8 192 Mo par défaut, trop pour 16 Go.', type: 'number', min: 0, max: 16384, unit: 'Mo' },
      { path: 'models.parallel', label: 'Slots du serveur (--parallel)', hint: '1 recommandé sur 4 cœurs ; plus de 1 désactive le cache KV par session.', type: 'number', min: 1, max: 8 },
      { path: 'models.draftModelPath', label: 'Modèle brouillon (décodage spéculatif)', hint: 'Même famille que le modèle principal. Mesuré sur i5-6500 avec Qwen3 1.7B + 0.6B : aucun gain (les deux modèles se partagent le CPU). Laisser vide sauf essai.', type: 'path-gguf' },
      { path: 'models.draftMax', label: 'Jetons proposés par le brouillon', type: 'number', min: 1, max: 32 },
    ],
  },
  {
    id: 'muce-accel',
    title: 'Accélération MUCE',
    description: 'Profil d’accélération MUCE appliqué à llama-server au prochain chargement d’un modèle local : décodage spéculatif sans modèle brouillon (recherche n-gram dans le contexte), attente active et priorité haute. Mesures dans docs/MUCE_INTEGRATION.md.',
    fields: [
      { path: 'models.acceleration.enabled', label: 'Activer le profil MUCE', type: 'toggle' },
      {
        path: 'models.acceleration.specType',
        label: 'Décodage spéculatif',
        hint: 'ngram-mod : propose les suites déjà présentes dans le contexte (code réécrit, JSON, citations) et les vérifie en un seul passage. Sans répétition, aucun gain ni perte notable.',
        type: 'select',
        options: [
          { value: 'ngram-mod', label: 'ngram-mod (recommandé)' },
          { value: 'ngram-simple', label: 'ngram-simple' },
          { value: 'ngram-map-k', label: 'ngram-map-k' },
          { value: 'ngram-cache', label: 'ngram-cache' },
          { value: 'none', label: 'Aucun' },
        ],
      },
      { path: 'models.acceleration.ngramMatch', label: 'Longueur de recherche n-gram', type: 'number', min: 4, max: 64 },
      { path: 'models.acceleration.ngramMin', label: 'Jetons proposés minimum', type: 'number', min: 1, max: 32 },
      { path: 'models.acceleration.ngramMax', label: 'Jetons proposés maximum', type: 'number', min: 2, max: 128 },
      { path: 'models.acceleration.poll', label: 'Attente active (--poll)', hint: '100 : les threads ne s’endorment pas entre deux étapes (latence plus faible, CPU occupé pendant la génération).', type: 'range', min: 0, max: 100, step: 10 },
      { path: 'models.acceleration.prio', label: 'Priorité du processus (--prio)', type: 'select', options: [{ value: '-1', label: 'Basse' }, { value: '0', label: 'Normale' }, { value: '1', label: 'Moyenne' }, { value: '2', label: 'Haute' }] },
      { path: 'models.acceleration.reasoning', label: 'Raisonnement des modèles hybrides (--reasoning)', hint: 'Off : Qwen3 et équivalents répondent sans phase de réflexion, bien plus vite sur CPU. Auto : selon le modèle.', type: 'segmented', options: [{ value: 'off', label: 'Off' }, { value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }] },
      { path: 'models.acceleration.kvCacheType', label: 'Précision du cache KV', hint: 'q8_0 divise par deux la mémoire du contexte (contextes longs, grands prompts) pour une perte de qualité négligeable ; active Flash Attention.', type: 'segmented', options: [{ value: 'f16', label: 'f16' }, { value: 'q8_0', label: 'q8_0' }, { value: 'q4_0', label: 'q4_0' }] },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal et éditeur',
    fields: [
      { path: 'terminal.shell', label: 'Shell par défaut', type: 'segmented', options: [{ value: 'powershell', label: 'PowerShell' }, { value: 'pwsh', label: 'PowerShell 7' }, { value: 'cmd', label: 'cmd' }] },
      { path: 'terminal.timeoutSec', label: 'Délai maximum par commande', type: 'number', min: 1, max: 3600, unit: 's' },
      { path: 'terminal.maxLines', label: 'Lignes conservées par terminal', type: 'number', min: 500, max: 50000 },
      { path: 'editor.tabSize', label: 'Largeur de tabulation', type: 'number', min: 1, max: 8 },
      { path: 'editor.wordWrap', label: 'Retour à la ligne automatique', type: 'toggle' },
    ],
  },
  {
    id: 'tools',
    title: 'Outils, Hermes et MUCE',
    fields: [
      { path: 'hermes.pythonPath', label: 'Python utilisé pour Hermes', hint: 'Vide : « python » du PATH.', type: 'text' },
      { path: 'muce.home', label: 'Dossier MUCE', hint: 'Doit contenir INTEGRATION_MANIFEST.json.', type: 'path-folder' },
    ],
  },
  {
    id: 'knowledge',
    title: 'Bibliothèque universelle (Bib1)',
    description: 'Documentation et méthodes locales partagées. Utilisé par /vault-search et /vault.',
    resetKey: 'knowledge',
    fields: [
      { path: 'knowledge.home', label: 'Dossier Bib1', hint: 'Dossier contenant mazz_knowledge.', type: 'path-folder' },
      { path: 'knowledge.autoContext', label: 'Injection documentaire automatique', hint: 'Désactivé : les requêtes de code restent directes sans fiches encyclopédiques dans le prompt. Activé : recherche automatique avant chaque tâche.', type: 'toggle' },
    ],
  },
  {
    id: 'privacy',
    title: 'Confidentialité et données',
    resetKey: 'privacy',
    fields: [
      { path: 'privacy.telemetryRetention', label: 'Mesures conservées', hint: 'Les plus anciennes sont supprimées au-delà.', type: 'number', min: 10, max: 10000 },
      { path: 'privacy.auditRetention', label: 'Entrées d’audit conservées en mémoire', type: 'number', min: 100, max: 100000 },
    ],
  },
  {
    id: 'performance',
    title: 'Performance',
    resetKey: 'performance',
    fields: [
      { path: 'performance.metricsIntervalSec', label: 'Fréquence de la télémétrie système', hint: '3 s recommandé : chaque mesure lance tasklist.', type: 'number', min: 1, max: 60, unit: 's' },
      { path: 'performance.rollingWindowSec', label: 'Fenêtre du débit live', type: 'number', min: 1, max: 30, unit: 's' },
      { path: 'performance.recordRuns', label: 'Enregistrer les mesures des tâches', type: 'toggle' },
    ],
  },
];

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function patchFor(path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const out: Record<string, unknown> = {};
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else cur = (cur[k] = {}) as Record<string, unknown>;
  });
  return out;
}

function ProviderSelect({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const providers = useApp((s) => s.providers);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">Modèle local chargé</option>
      {providers
        .filter((p) => !p.synthetic && p.id !== 'llama-local')
        .map((p) => (
          <option key={p.id} value={p.id} disabled={p.requiresApiKey && !p.hasApiKey}>
            {p.name}
            {p.requiresApiKey && !p.hasApiKey ? ' (clé requise)' : ''}
          </option>
        ))}
    </Select>
  );
}

function FieldRow({ def, settings }: { def: FieldDef; settings: StudioSettings }) {
  const value = getPath(settings, def.path);
  const [local, setLocal] = useState<unknown>(value);
  const [state, setFieldState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  useEffect(() => setLocal(value), [value]);

  const commit = async (v: unknown) => {
    setLocal(v);
    setFieldState('saving');
    setError(null);
    try {
      await saveSettings(patchFor(def.path, v));
      if (def.path === 'muce.home') await api.post('/api/muce/configure', { path: v });
      setFieldState('saved');
      setTimeout(() => setFieldState((s) => (s === 'saved' ? 'idle' : s)), 1600);
    } catch (e) {
      setFieldState('error');
      const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as Array<{ path: string; message: string }>).find((d) => d.path === def.path) : undefined;
      setError(details?.message ?? errorMessage(e));
      setLocal(value);
    }
  };

  let control: ReactNode;
  switch (def.type) {
    case 'toggle':
      control = <Toggle checked={!!local} onChange={(v) => void commit(v)} label={def.label} />;
      break;
    case 'segmented':
      control = <Segmented label={def.label} value={String(local)} onChange={(v) => void commit(v)} options={def.options!} />;
      break;
    case 'select':
      control = (
        <Select value={String(local)} onChange={(e) => void commit(typeof value === 'number' ? Number(e.target.value) : e.target.value)} aria-label={def.label}>
          {def.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case 'range':
      control = (
        <div className="flex items-center gap-2 w-[260px]">
          <input type="range" min={def.min} max={def.max} step={def.step} value={Number(local)} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={() => void commit(local)} onKeyUp={() => void commit(local)} className="flex-1 accent-[var(--brand)]" aria-label={def.label} />
          <span className="w-14 text-right tabular text-[12.5px]">
            {Number(local)}
            {def.unit ? ` ${def.unit}` : ''}
          </span>
        </div>
      );
      break;
    case 'number':
      control = (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            value={String(local)}
            min={def.min}
            max={def.max}
            onChange={(e) => setLocal(e.target.value === '' ? '' : Number(e.target.value))}
            onBlur={() => local !== value && void commit(local)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="w-28"
            aria-label={def.label}
            invalid={state === 'error'}
          />
          {def.unit && <span className="text-[12px] text-faint">{def.unit}</span>}
        </div>
      );
      break;
    case 'text':
      control = <Input value={String(local ?? '')} onChange={(e) => setLocal(e.target.value)} onBlur={() => local !== value && void commit(local)} className="w-[320px] font-mono text-[12px]" aria-label={def.label} />;
      break;
    case 'provider':
      control = <ProviderSelect value={String(local ?? '')} onChange={(v) => void commit(v)} label={def.label} />;
      break;
    case 'path-gguf':
    case 'path-exe':
    case 'path-folder':
      control = (
        <div className="flex items-center gap-1.5">
          <Input value={String(local ?? '')} onChange={(e) => setLocal(e.target.value)} onBlur={() => local !== value && void commit(local)} className="w-[300px] font-mono text-[12px]" aria-label={def.label} placeholder="Non configuré" />
          <Button size="sm" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => setPicker(true)}>
            Parcourir
          </Button>
          {def.type === 'path-gguf' && local ? (
            <Button size="sm" variant="ghost" onClick={() => void commit('')}>
              Retirer
            </Button>
          ) : null}
          <PathPicker open={picker} mode={def.type === 'path-folder' ? 'folder' : 'file'} ext={def.type === 'path-exe' ? '.exe' : def.type === 'path-gguf' ? '.gguf' : undefined} title={def.label} onClose={() => setPicker(false)} onPick={(p) => void commit(p)} />
        </div>
      );
      break;
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3" data-setting={def.path}>
      <div className="min-w-0 max-w-[460px]">
        <div className="text-[13px] text-fg flex items-center gap-2">
          {def.label}
          {state === 'saving' && <span className="text-[11px] text-faint">Enregistrement</span>}
          {state === 'saved' && (
            <span className="text-[11px] text-good inline-flex items-center gap-1" role="status">
              <Check className="w-3 h-3" /> Enregistré
            </span>
          )}
        </div>
        {def.hint && <div className="text-[11.5px] text-faint mt-0.5">{def.hint}</div>}
        {error && (
          <div className="text-[11.5px] text-bad mt-0.5" role="alert">
            {error}
          </div>
        )}
      </div>
      {control}
    </div>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+K', 'Palette de commandes'],
  ['Ctrl+Maj+N', 'Nouvelle session'],
  ['Ctrl+B', 'Afficher ou masquer la barre latérale'],
  ['Ctrl+J', 'Afficher ou masquer le terminal'],
  ['Ctrl+I', 'Afficher ou masquer l’inspecteur'],
  ['Ctrl+,', 'Paramètres'],
  ['Alt+1 à Alt+8', 'Accueil, Agent, Sessions, Projets, Code, Git, Modèles, Performance'],
  ['Entrée / Maj+Entrée', 'Envoyer / nouvelle ligne dans le composer'],
  ['Flèche haut', 'Rappeler la demande précédente (composer vide)'],
  ['@', 'Citer un fichier du projet'],
  ['Ctrl+S', 'Enregistrer le fichier dans l’éditeur'],
  ['Ctrl+F', 'Rechercher dans l’éditeur'],
  ['Ctrl+C', 'Annuler la commande du terminal'],
  ['Double clic sur un séparateur', 'Taille par défaut du panneau'],
];

export default function SettingsView() {
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const viewParam = useApp((s) => s.viewParam);
  const [section, setSection] = useState(viewParam ?? 'general');
  const [query, setQuery] = useState('');
  const [reset, setReset] = useState<SectionDef | 'all' | null>(null);

  useEffect(() => {
    if (viewParam) setSection(viewParam);
  }, [viewParam]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return SECTIONS.flatMap((s) => s.fields.filter((f) => `${f.label} ${f.hint ?? ''} ${s.title}`.toLowerCase().includes(q)).map((f) => ({ section: s, field: f })));
  }, [query]);

  if (!settings) {
    return <div className="p-6 text-[13px] text-muted">Paramètres indisponibles : serveur non joignable.</div>;
  }

  const current = SECTIONS.find((s) => s.id === section);
  const nav = [...SECTIONS.map((s) => ({ id: s.id, title: s.title })), { id: 'shortcuts', title: 'Raccourcis' }, { id: 'about', title: 'À propos' }];

  return (
    <div className="h-full flex min-h-0">
      <nav aria-label="Catégories de paramètres" className="w-[230px] shrink-0 border-r border-line bg-panel p-3 space-y-0.5 overflow-y-auto">
        <div className="relative mb-3">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un paramètre" aria-label="Rechercher un paramètre" className="pl-7" />
        </div>
        {nav.map((n) => (
          <button key={n.id} type="button" aria-current={section === n.id && !results ? 'page' : undefined} onClick={() => (setQuery(''), setSection(n.id), navigate('settings', n.id))} className={cx('w-full text-left px-2.5 h-8 rounded-md text-[13px] cursor-pointer', section === n.id && !results ? 'bg-raised text-fg' : 'text-muted hover:text-fg hover:bg-raised/60')}>
            {n.title}
          </button>
        ))}
        <div className="pt-3">
          <Button size="xs" variant="ghost" icon={<RotateCcw className="w-3 h-3" />} onClick={() => setReset('all')}>
            Tout réinitialiser
          </Button>
        </div>
      </nav>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[860px] mx-auto px-6 py-6 space-y-4">
          {results ? (
            <Card title={`Résultats pour « ${query} » (${results.length})`}>
              {results.length === 0 && <p className="text-[12.5px] text-faint">Aucun paramètre ne correspond.</p>}
              <div className="divide-y divide-line">
                {results.map(({ section: s, field }) => (
                  <div key={field.path}>
                    <div className="text-[10.5px] uppercase tracking-[0.12em] text-faint pt-2">{s.title}</div>
                    <FieldRow def={field} settings={settings} />
                  </div>
                ))}
              </div>
            </Card>
          ) : current ? (
            <>
              <div className="flex items-end justify-between gap-4">
                <div>
                  <h1 className="text-[20px] font-medium text-fg">{current.title}</h1>
                  {current.description && <p className="text-[12.5px] text-muted mt-1 max-w-2xl">{current.description}</p>}
                </div>
                {current.resetKey && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => setReset(current)}>
                    Réinitialiser la section
                  </Button>
                )}
              </div>
              <Card>
                <div className="divide-y divide-line">
                  {current.fields.map((f) => (
                    <FieldRow key={f.path} def={f} settings={settings} />
                  ))}
                </div>
              </Card>
              {current.id === 'access' && <AccessFolders settings={settings} />}
              {current.id === 'web' && <BraveKey />}
              {current.id === 'permissions' && <RulesEditor settings={settings} />}
              {current.id === 'permissions' && (
                <Notice tone="info" title="Journal d’audit">
                  Chaque décision (autorisation, refus, expiration) est enregistrée.{' '}
                  <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => setState({ bottomOpen: true, bottomTab: 'audit' })}>
                    Ouvrir le journal
                  </button>
                </Notice>
              )}
              {current.id === 'models' && (
                <Notice tone="info" title="Bibliothèque et dossiers scannés">
                  {settings.models.library.length} modèle(s) référencé(s), {settings.models.scanFolders.length} dossier(s) mémorisé(s). Gestion dans le Model Hub.
                </Notice>
              )}
              {current.id === 'privacy' && (
                <Notice tone="info" title="Inventaire et suppression">
                  Données stockées dans {health?.dataDir}.{' '}
                  <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => navigate('memory')}>
                    Voir et effacer les données
                  </button>
                </Notice>
              )}
            </>
          ) : section === 'shortcuts' ? (
            <Card title="Raccourcis clavier">
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-line">
                  {SHORTCUTS.map(([k, v]) => (
                    <tr key={k}>
                      <td className="py-2 w-56">
                        <Kbd>{k}</Kbd>
                      </td>
                      <td className="py-2 text-muted">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <Card title="À propos">
              <div className="space-y-3 text-[13px] text-muted">
                <div>
                  <div className="text-fg font-medium">MAZZ ÆNGENIUM — Agent Studio</div>
                  <div>
                    Version {health?.version ?? 'N/D'} - interface web React servie localement sur 127.0.0.1
                  </div>
                </div>
                <div>Données : <span className="font-mono">{health?.dataDir}</span></div>
                <div>
                  Bibliothèques : React, Vite, Tailwind CSS, Lucide (ISC), CodeMirror 6 (MIT), highlight.js (BSD-3), polices Inter, Sora et JetBrains Mono (OFL). Moteur local : llama.cpp (MIT). Détails : THIRD_PARTY_NOTICES et docs/OPEN_SOURCE_AUDIT.md.
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>Mises à jour : manuelles (aucun service distant)</Badge>
                  <Badge>Télémétrie d’usage : aucune</Badge>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={reset !== null}
        title={reset === 'all' ? 'Réinitialiser tous les paramètres ?' : `Réinitialiser « ${typeof reset === 'object' && reset ? reset.title : ''} » ?`}
        confirmLabel="Réinitialiser"
        danger
        onClose={() => setReset(null)}
        onConfirm={async () => {
          const r = await api.post<{ settings: StudioSettings }>('/api/settings/reset', { section: typeof reset === 'object' && reset ? reset.resetKey : 'all' });
          setState({ settings: r.settings });
          toast('good', 'Paramètres réinitialisés');
        }}
      >
        Les valeurs par défaut sont rétablies. La bibliothèque de modèles, les projets récents et les fournisseurs personnalisés sont conservés.
      </ConfirmDialog>
    </div>
  );
}
