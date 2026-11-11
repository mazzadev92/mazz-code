import { useState } from 'react';
import { ArrowRight, Boxes, Cloud, FolderOpen, MessagesSquare, Sparkles } from '../../components/icons';
import { api } from '../../lib/api';
import { basename, fmtRelative } from '../../lib/format';
import { navigate, refreshHealth, setActiveSession, useApp } from '../../lib/store';
import type { Doctor } from '../../lib/types';
import { Badge, Button, Card, Notice, StatusDot, useAsync } from '../../components/ui';
import { Meter } from '../../components/charts';
import { MazzEmblem } from '../../components/brand';
import { PathPicker } from '../../components/overlays';
import { SESSION_STATUS } from '../sessions/SessionsSidebar';
import { Onboarding } from './Onboarding';

/**
 * Guided home: the default face of the app. It shows the three things a newcomer must do
 * (a model, a service, a project) and one obvious action (talk to the assistant).
 * The full engineering shell remains one click away in Settings.
 */
export default function GuidedHome() {
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const llama = useApp((s) => s.llama);
  const providers = useApp((s) => s.providers);
  const sessions = useApp((s) => s.sessions);
  const [refresh, setRefresh] = useState(0);
  const [picker, setPicker] = useState(false);
  const doctor = useAsync(
    (signal) => api.get<Doctor>('/api/doctor', signal),
    [refresh, llama?.state, settings?.models.library.length],
  );

  if (!settings) return <div className="p-6 text-[13px] text-muted">Chargement de vos réglages…</div>;

  if (!settings.general.onboardingDone) {
    return (
      <div className="h-full overflow-y-auto">
        <section className="border-b border-line deco-grid">
          <div className="max-w-[980px] mx-auto px-6 py-8 flex flex-wrap items-center gap-6">
            <MazzEmblem size={96} />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] uppercase tracking-[0.22em] text-faint">Première configuration</div>
              <h1 className="font-display text-[28px] text-fg mt-1">Bienvenue dans MAZZ Studio</h1>
              <p className="text-[13.5px] text-muted mt-2 max-w-2xl">
                L’assistant vous guide pas à pas : votre ordinateur, un modèle, les services gratuits, la sécurité et un test final.
                Chaque étape est facultative et se reprend plus tard dans Paramètres.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <Badge tone="good">1. Un modèle</Badge>
                <Badge tone="info">2. Un service gratuit</Badge>
                <Badge tone="neutral">3. Une conversation</Badge>
              </div>
            </div>
          </div>
        </section>
        <div className="max-w-[980px] mx-auto px-6 py-6 space-y-4">
          <Notice tone="info" title="Ce qu’il vous faut avant de commencer">
            <ul className="list-disc pl-5 space-y-1">
              <li>Un PC Windows 10 ou 11, avec 8 Go de RAM minimum (16 Go recommandés pour un modèle 4B).</li>
              <li>Environ 10 Go d’espace libre sur le disque pour les modèles et les conversations.</li>
              <li>Une connexion Internet pour télécharger un modèle. Ensuite, tout fonctionne hors ligne.</li>
              <li>Aucun compte n’est obligatoire : les modèles MAZZ publics se téléchargent sans jeton. Les comptes servent seulement aux services gratuits (GPU distant, API rapide).</li>
            </ul>
          </Notice>
          <Onboarding doctor={doctor.data} onChanged={() => setRefresh((n) => n + 1)} />
          <p className="text-[11.5px] text-faint">
            Rien n’est envoyé à l’éditeur. Les clés restent chiffrées sur cette machine ; les modèles et les conversations restent dans votre dossier de données.
          </p>
        </div>
      </div>
    );
  }

  const hasModel = (doctor.data?.library.usable ?? 0) > 0;
  const modelLoaded = llama?.state === 'ready';
  const hasProvider = (doctor.data?.providers.remoteWithKey ?? 0) > 0 || providers.some((p) => !p.synthetic && p.hasApiKey);
  const hasProject = (settings.projects.recent?.length ?? 0) > 0;
  const done = [hasModel, hasProvider, hasProject].filter(Boolean).length;
  const recent = sessions.filter((s) => !s.archived).slice(0, 3);
  const newChat = () => {
    setActiveSession(undefined);
    navigate('agent');
  };

  return (
    <div className="h-full overflow-y-auto">
      <section className="border-b border-line deco-grid">
        <div className="max-w-[1100px] mx-auto px-6 py-7 flex flex-wrap items-center gap-6">
          <MazzEmblem size={84} />
          <div className="min-w-0 flex-1">
            <div className="text-[11px] uppercase tracking-[0.22em] text-faint">Mode guidé</div>
            <h1 className="font-display text-[26px] text-fg mt-1">Votre atelier IA, en trois étapes.</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-2xl">
              {done === 3
                ? 'Tout est prêt. Ouvrez une conversation ou reprenez une session récente.'
                : 'Choisissez un modèle, connectez un service gratuit si vous le souhaitez, puis ouvrez votre projet. Vous pouvez tout modifier ensuite.'}
            </p>
            <div className="max-w-md mt-3">
              <Meter label="Progression de la configuration" value={done} max={3} detail={`${done} / 3 étapes prêtes`} tone={done === 3 ? 'good' : 'brand'} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="primary" icon={<MessagesSquare className="w-4 h-4" />} onClick={newChat}>
              Nouvelle conversation
            </Button>
            <Button icon={<FolderOpen className="w-4 h-4" />} onClick={() => setPicker(true)}>
              Ouvrir un dossier
            </Button>
          </div>
        </div>
      </section>

      <div className="max-w-[1100px] mx-auto px-6 py-6 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card
            title="1. Un modèle"
            actions={<Badge tone={hasModel ? 'good' : 'warn'}>{hasModel ? 'Prêt' : 'À faire'}</Badge>}
          >
            <div className="space-y-3">
              <div className="flex items-start gap-2.5">
                <Boxes className="w-5 h-5 text-brand shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-muted">
                  Téléchargez un modèle MAZZ public (sans compte) ou ajoutez un fichier GGUF déjà présent sur votre disque.
                </p>
              </div>
              {modelLoaded ? (
                <div className="rounded-md border border-good/30 bg-good/5 px-3 py-2 text-[12px]">
                  <div className="flex items-center gap-2 text-good"><StatusDot tone="good" /> Modèle chargé</div>
                  <div className="font-mono text-fg truncate mt-1">{basename(llama?.modelPath ?? '')}</div>
                  <div className="text-faint mt-0.5">{llama?.metadata?.quantization ?? ''} · contexte {llama?.config?.contextSize ?? 'N/D'}</div>
                </div>
              ) : (
                <div className="text-[12px] text-faint">{hasModel ? 'Un modèle est disponible : chargez-le pour discuter.' : 'Aucun modèle pour l’instant.'}</div>
              )}
              <Button size="sm" variant={hasModel ? 'secondary' : 'primary'} icon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('models')}>
                {modelLoaded ? 'Gérer le modèle' : hasModel ? 'Charger un modèle' : 'Télécharger un modèle'}
              </Button>
            </div>
          </Card>

          <Card
            title="2. Un service gratuit"
            actions={<Badge tone={hasProvider ? 'good' : 'neutral'}>{hasProvider ? 'Connecté' : 'Facultatif'}</Badge>}
          >
            <div className="space-y-3">
              <div className="flex items-start gap-2.5">
                <Cloud className="w-5 h-5 text-leaf shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-muted">
                  Un modèle local suffit pour commencer. Ajoutez un service gratuit (Groq, Hugging Face, Kaggle, Modal) pour aller plus vite ou utiliser un GPU distant.
                </p>
              </div>
              <div className="text-[12px] text-faint">{hasProvider ? 'Au moins un service est disponible.' : 'Aucune clé enregistrée : le local fonctionne sans service.'}</div>
              <Button size="sm" variant="secondary" icon={<ArrowRight className="w-3.5 h-3.5" />} onClick={() => navigate('services')}>
                Configurer un service
              </Button>
            </div>
          </Card>

          <Card
            title="3. Un projet"
            actions={<Badge tone={hasProject ? 'good' : 'warn'}>{hasProject ? 'Ouvert' : 'À faire'}</Badge>}
          >
            <div className="space-y-3">
              <div className="flex items-start gap-2.5">
                <FolderOpen className="w-5 h-5 text-info shrink-0 mt-0.5" />
                <p className="text-[12.5px] text-muted">
                  Ouvrez le dossier de votre code : l’assistant lit les fichiers, propose des modifications et lance les commandes avec votre accord.
                </p>
              </div>
              <div className="text-[12px] text-faint font-mono truncate" title={health?.workspace.workspaceRoot}>
                {hasProject ? health?.workspace.workspaceRoot : 'Aucun dossier ouvert.'}
              </div>
              <Button size="sm" variant="secondary" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => setPicker(true)}>
                Ouvrir un dossier
              </Button>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card
            title="Discuter avec l’assistant"
            className="lg:col-span-2"
            actions={<Button size="xs" variant="primary" icon={<MessagesSquare className="w-3.5 h-3.5" />} onClick={newChat}>Nouvelle conversation</Button>}
          >
            <div className="space-y-3">
              <p className="text-[12.5px] text-muted">
                Posez une question, demandez une modification de code ou un audit. En mode « demander avant d’agir », chaque action sensible attend votre accord.
              </p>
              {recent.length > 0 ? (
                <ul className="divide-y divide-line">
                  {recent.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => (setActiveSession(s.id), navigate('agent', s.id))}
                        className="w-full flex items-center gap-3 py-2 text-left hover:bg-raised/60 rounded px-1.5 cursor-pointer"
                      >
                        <MessagesSquare className="w-4 h-4 text-faint shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] text-fg truncate">{s.title}</div>
                          <div className="text-[11.5px] text-faint truncate">{basename(s.projectRoot)} · {s.turnCount} échange(s)</div>
                        </div>
                        <Badge tone={SESSION_STATUS[s.status].tone}>{SESSION_STATUS[s.status].label}</Badge>
                        <span className="text-[11.5px] text-faint w-24 text-right">{fmtRelative(s.updatedAt)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-faint">Aucune conversation pour l’instant. La première est à un clic.</p>
              )}
            </div>
          </Card>

          <Card title="Aide et réglages">
            <div className="space-y-3 text-[12.5px] text-muted">
              <p>Vous pouvez relancer le guide complet ou passer à l’interface complète, avec toutes les pages d’ingénierie.</p>
              <Button
                size="sm"
                variant="secondary"
                icon={<Sparkles className="w-3.5 h-3.5" />}
                onClick={() => navigate('settings', 'general')}
              >
                Ouvrir les paramètres
              </Button>
              <Notice tone="info" title="Interface guidée">
                Ce mode simplifie la navigation. Vos réglages avancés restent disponibles dans Paramètres, section Général.
              </Notice>
            </div>
          </Card>
        </div>
      </div>

      <PathPicker
        open={picker}
        mode="folder"
        title="Ouvrir un dossier de projet"
        onClose={() => setPicker(false)}
        onPick={(p) => void api.post('/api/workspace/open', { path: p }).then(() => refreshHealth())}
      />
    </div>
  );
}
