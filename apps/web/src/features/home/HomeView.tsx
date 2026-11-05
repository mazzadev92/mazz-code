import { useState } from 'react';
import { AlertTriangle, ArrowRight, Boxes, Copy, Cpu, FolderOpen, Info, KeyRound, MessagesSquare, Plus, RefreshCw, Sparkles } from '../../components/icons';
import { navigate, setActiveSession, useApp, refreshHealth, toast } from '../../lib/store';
import { api, qs } from '../../lib/api';
import type { Doctor } from '../../lib/types';
import { basename, fmtBytes, fmtRelative } from '../../lib/format';
import { Badge, Button, Card, ErrorBox, Skeleton, StatusDot, useAsync, cx } from '../../components/ui';
import { MazzEmblem } from '../../components/brand';
import { Meter } from '../../components/charts';
import { PathPicker } from '../../components/overlays';
import { SESSION_STATUS } from '../sessions/SessionsSidebar';
import { Onboarding } from './Onboarding';

function warningAction(code: string | undefined): (() => void) | undefined {
  if (!code) return undefined;
  if (code === 'models') return () => navigate('models');
  if (code === 'providers') return () => navigate('providers');
  if (code.startsWith('settings')) return () => navigate('settings', code.split(':')[1]);
  return undefined;
}

export default function HomeView() {
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const sessions = useApp((s) => s.sessions);
  const tasks = useApp((s) => s.tasks);
  const llama = useApp((s) => s.llama);
  const metrics = useApp((s) => s.metrics);
  const [refresh, setRefresh] = useState(0);
  const doctor = useAsync((signal) => api.get<Doctor>(`/api/doctor${qs({ refresh: refresh ? 1 : undefined })}`, signal), [refresh, llama?.state, settings?.models.library.length]);
  const [picker, setPicker] = useState(false);
  const recent = sessions.filter((s) => !s.archived).slice(0, 6);
  const running = tasks.filter((t) => !t.done);
  const showOnboarding = settings && !settings.general.onboardingDone;

  const copyReport = () => {
    if (!doctor.data) return;
    const lines = [
      '# Rapport de diagnostic MAZZ Agent Studio',
      `Date : ${new Date().toISOString()}`,
      `Version Studio : ${health?.version ?? 'N/D'}`,
      `Espace de travail : ${health?.workspace.name ?? 'aucun'} (${health?.workspace.workspaceRoot ?? 'N/D'})`,
      `Moteur local : ${llama?.state ?? 'inconnu'} (${llama?.modelPath ?? 'aucun modèle'})`,
      `RAM utilisée : ${metrics ? `${fmtBytes(metrics.memory.totalBytes - metrics.memory.availableBytes)} / ${fmtBytes(metrics.memory.totalBytes)}` : 'N/D'}`,
      `Avertissements (${doctor.data.warnings.length}) :`,
      ...doctor.data.warnings.map((w) => `  - [${w.level.toUpperCase()}] ${w.message}`),
    ];
    void navigator.clipboard.writeText(lines.join('\n'));
    toast('good', 'Rapport copié', 'Le rapport de diagnostic a été copié dans le presse-papier.');
  };

  return (
    <div className="h-full overflow-y-auto">
      <section className="relative border-b border-line deco-grid">
        <div className="max-w-[1180px] mx-auto px-6 py-8 flex items-center gap-8">
          <MazzEmblem size={110} />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-[0.22em] text-faint">MAZZ ÆNGENIUM / Agent Studio</div>
            <h1 className="font-display text-[26px] text-fg mt-1.5">Ingénierie logicielle locale, outillée et vérifiable.</h1>
            <p className="text-[13px] text-muted mt-1.5 max-w-2xl">
              Projet actif : <span className="font-mono text-fg">{health?.workspace.name ?? 'aucun'}</span>
              {health?.workspace.detectedLanguages.length ? ` - ${health.workspace.detectedLanguages.join(', ')}` : ''}
            </p>
            <div className="flex flex-wrap gap-2 mt-4">
              <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => (setActiveSession(undefined), navigate('agent'))}>
                Nouvelle session
              </Button>
              <Button icon={<FolderOpen className="w-4 h-4" />} onClick={() => setPicker(true)}>
                Ouvrir un dossier
              </Button>
              <Button icon={<Boxes className="w-4 h-4" />} onClick={() => navigate('models')}>
                Ajouter un GGUF
              </Button>
              <Button icon={<KeyRound className="w-4 h-4" />} onClick={() => navigate('providers')}>
                Configurer un fournisseur
              </Button>
            </div>
          </div>
        </div>
      </section>

      <div className="max-w-[1180px] mx-auto px-6 py-6 space-y-5">
        {showOnboarding && <Onboarding doctor={doctor.data} onChanged={() => setRefresh((n) => n + 1)} />}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card
            title="État du système"
            className="lg:col-span-2"
            actions={
              <div className="flex items-center gap-1.5">
                {doctor.data && (
                  <Button size="xs" variant="ghost" icon={<Copy className="w-3 h-3" />} onClick={copyReport}>
                    Copier le rapport
                  </Button>
                )}
                <Button size="xs" variant="ghost" icon={<RefreshCw className="w-3 h-3" />} loading={doctor.loading} onClick={() => setRefresh((n) => n + 1)}>
                  Diagnostiquer
                </Button>
              </div>
            }
          >
            {doctor.error != null && <ErrorBox error={doctor.error} onRetry={doctor.reload} />}
            {!doctor.data && !doctor.error && <Skeleton lines={4} />}
            {doctor.data && (
              <div className="space-y-3">
                {doctor.data.warnings.length === 0 ? (
                  <div className="flex items-center gap-2 text-[12.5px] text-good">
                    <StatusDot tone="good" /> Aucune action requise.
                  </div>
                ) : (
                  <ul className="space-y-1.5">
                    {doctor.data.warnings.map((w) => {
                      const act = warningAction(w.action);
                      return (
                        <li key={w.code} className={cx('flex items-center gap-2.5 px-3 py-2 rounded-md border text-[12.5px]', w.level === 'error' ? 'border-bad/35 bg-bad/5' : w.level === 'warn' ? 'border-warn/35 bg-warn/5' : 'border-line bg-sunk')}>
                          {w.level === 'info' ? <Info className="w-4 h-4 text-info shrink-0" /> : <AlertTriangle className={cx('w-4 h-4 shrink-0', w.level === 'error' ? 'text-bad' : 'text-warn')} />}
                          <span className="flex-1 text-fg">{w.message}</span>
                          {act && (
                            <Button size="xs" variant="ghost" icon={<ArrowRight className="w-3 h-3" />} onClick={act}>
                              Résoudre
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[12px]">
                  {doctor.data.toolchains.map((t) => (
                    <div key={t.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-line bg-sunk" title={t.path || 'non détecté'}>
                      <StatusDot tone={t.isAvailable ? 'good' : 'neutral'} />
                      <span className="font-mono text-fg">{t.name}</span>
                      <span className="text-faint truncate text-[11px]">{t.isAvailable ? (t.version?.split(' ').slice(-1)[0] ?? 'ok') : 'absent'}</span>
                    </div>
                  ))}
                  <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border border-line bg-sunk" title={doctor.data.llamaServer.discovered.join('\n')}>
                    <StatusDot tone={doctor.data.llamaServer.discovered.length || doctor.data.llamaServer.configuredPath ? 'good' : 'warn'} />
                    <span className="font-mono text-fg">llama-server</span>
                    <span className="text-faint text-[11px]">{doctor.data.llamaServer.discovered.length ? 'détecté' : 'absent'}</span>
                  </div>
                </div>
                <div className="text-[11.5px] text-faint">
                  {doctor.data.platform} - Node {doctor.data.node} - {doctor.data.cpu.model} ({doctor.data.cpu.logicalCores} threads) - GPU : {doctor.data.gpu.detected.map((g) => g.name).join(', ') || 'non détecté'} (aucune télémétrie GPU)
                </div>
              </div>
            )}
          </Card>

          <Card title="Moteur local">
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <StatusDot tone={llama?.state === 'ready' ? 'good' : llama?.state === 'starting' ? 'warn' : llama?.state === 'error' ? 'bad' : 'neutral'} pulse={llama?.state === 'starting'} />
                <span className="text-[13px] text-fg">{llama?.state === 'ready' ? 'llama-server prêt' : llama?.state === 'starting' ? 'Chargement en cours' : llama?.state === 'error' ? 'Erreur de démarrage' : 'Arrêté'}</span>
              </div>
              {llama?.state === 'ready' && (
                <div className="text-[12px] text-muted">
                  <div className="font-mono text-fg truncate">{basename(llama.modelPath ?? '')}</div>
                  <div>
                    {llama.metadata?.quantization} - contexte {llama.config?.contextSize} - {llama.config?.threads} threads - port {llama.port}
                  </div>
                </div>
              )}
              {llama?.lastError && <p className="text-[12px] text-bad break-words">{llama.lastError}</p>}
              <Meter label="RAM système utilisée" value={metrics ? metrics.memory.totalBytes - metrics.memory.availableBytes : undefined} max={metrics?.memory.totalBytes} detail={metrics ? `${fmtBytes(metrics.memory.availableBytes)} disponibles` : undefined} />
              <Button size="sm" className="w-full" icon={<Cpu className="w-3.5 h-3.5" />} onClick={() => navigate('models')}>
                {llama?.state === 'ready' ? 'Gérer le modèle' : 'Charger un modèle'}
              </Button>
              <div className="flex flex-wrap gap-1.5">
                <Badge tone={health?.hermes.isInstalled ? 'good' : 'neutral'}>Hermes : {health?.hermes.isInstalled ? 'installé' : 'absent'}</Badge>
              </div>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card
            title="Reprendre une session"
            className="lg:col-span-2"
            actions={
              <Button size="xs" variant="ghost" onClick={() => navigate('sessions')}>
                Toutes les sessions
              </Button>
            }
          >
            {recent.length === 0 ? (
              <p className="text-[12.5px] text-faint py-3">Aucune session pour l’instant. Les échanges avec l’agent sont enregistrés localement et reprennent après un redémarrage.</p>
            ) : (
              <ul className="divide-y divide-line">
                {recent.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => (setActiveSession(s.id), navigate('agent', s.id))} className="w-full flex items-center gap-3 py-2 text-left hover:bg-raised/60 rounded px-1.5 cursor-pointer">
                      <MessagesSquare className="w-4 h-4 text-faint shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-fg truncate">{s.title}</div>
                        <div className="text-[11.5px] text-faint truncate">
                          {basename(s.projectRoot)} - {s.turnCount} échange(s) - {s.modelId || s.providerId}
                        </div>
                      </div>
                      <Badge tone={SESSION_STATUS[s.status].tone}>{SESSION_STATUS[s.status].label}</Badge>
                      <span className="text-[11.5px] text-faint w-24 text-right">{fmtRelative(s.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Activité">
            <div className="space-y-3">
              <div className="text-[12.5px] text-muted">{running.length ? `${running.length} tâche(s) en cours` : 'Aucune tâche en cours.'}</div>
              {running.map((t) => (
                <button key={t.taskId} type="button" onClick={() => t.sessionId && (setActiveSession(t.sessionId), navigate('agent', t.sessionId))} className="w-full text-left text-[12px] px-2 py-1.5 rounded-md border border-line bg-sunk hover:border-line-strong cursor-pointer">
                  <div className="text-fg truncate">{t.stage}</div>
                  <div className="text-faint">
                    {t.mode} - {basename(t.modelId)}
                  </div>
                </button>
              ))}
              <div className="pt-1">
                <div className="text-[11.5px] text-faint mb-1.5">Projets récents</div>
                {(settings?.projects.recent ?? []).slice(0, 5).map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    onClick={() => api.post('/api/workspace/open', { path: p.path }).then(() => refreshHealth())}
                    className="w-full flex items-center gap-2 text-left text-[12px] text-muted hover:text-fg py-1 cursor-pointer"
                    title={p.path}
                  >
                    <FolderOpen className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{p.name}</span>
                  </button>
                ))}
                {!settings?.projects.recent.length && <p className="text-[12px] text-faint">Aucun projet ouvert récemment.</p>}
              </div>
              <Button size="sm" variant="ghost" icon={<Sparkles className="w-3.5 h-3.5" />} onClick={() => navigate('settings', 'general')}>
                Réafficher l’assistant de configuration
              </Button>
            </div>
          </Card>
        </div>
      </div>
      <PathPicker
        open={picker}
        mode="folder"
        title="Ouvrir un dossier de projet"
        onClose={() => setPicker(false)}
        onPick={(p) =>
          void api
            .post('/api/workspace/open', { path: p })
            .then(() => refreshHealth())
        }
      />
    </div>
  );
}
