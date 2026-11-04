import { useState } from 'react';
import { Cpu, Gauge, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { AutotuneResult, GgufMetadata, HardwareProfile, KvCacheUsage } from '../../lib/types';
import { saveSettings, toast, useApp } from '../../lib/store';
import { fmtBytes, fmtMs, fmtRate } from '../../lib/format';
import { Badge, Button, Card, ConfirmDialog, Dialog, ErrorBox, IconButton, Skeleton, Spinner, useAsync, cx } from '../../components/ui';

/** Machine profile with documented recommendations, applied to settings on request. */
export function HardwareCard() {
  const settings = useApp((s) => s.settings);
  const [refresh, setRefresh] = useState(0);
  const hw = useAsync((signal) => api.get<HardwareProfile>(`/api/system/hardware${refresh ? '?refresh=1' : ''}`, signal), [refresh]);
  const [applying, setApplying] = useState(false);
  const rec = hw.data?.recommendations;
  const differs = rec && settings && (settings.models.threads !== rec.threads || settings.models.parallel !== rec.parallel || settings.models.cacheRamMb !== rec.cacheRamMb || settings.models.contextSize !== rec.contextSize);
  return (
    <Card
      title="Profil matériel"
      subtitle="Lu sur cette machine ; les recommandations sont des règles documentées, l’auto-réglage les mesure."
      actions={
        <IconButton label="Relire le matériel" onClick={() => setRefresh((n) => n + 1)}>
          {hw.loading ? <Spinner size={12} /> : <RefreshCw className="w-3.5 h-3.5" />}
        </IconButton>
      }
    >
      {hw.error != null && <ErrorBox error={hw.error} onRetry={hw.reload} />}
      {!hw.data && !hw.error && <Skeleton lines={3} />}
      {hw.data && rec && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="space-y-1.5 text-[12.5px]">
            <div className="flex items-center gap-2 text-fg">
              <Cpu className="w-4 h-4 text-brand" /> {hw.data.cpu.model}
            </div>
            <div className="text-muted">
              {hw.data.cpu.physicalCores ?? 'N/D'} cœurs physiques, {hw.data.cpu.logicalCores} threads logiques{hw.data.cpu.l3CacheKb ? `, cache L3 ${Math.round(hw.data.cpu.l3CacheKb / 1024)} Mo` : ''}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={hw.data.cpu.avx2 ? 'good' : hw.data.cpu.avx2 === false ? 'bad' : 'neutral'} title="Source indisponible">
                AVX2 : {hw.data.cpu.avx2 === undefined ? 'N/D' : hw.data.cpu.avx2 ? 'oui' : 'non'}
              </Badge>
              <Badge tone={hw.data.cpu.fma ? 'good' : 'neutral'}>FMA : {hw.data.cpu.fma === undefined ? 'N/D' : hw.data.cpu.fma ? 'oui' : 'non'}</Badge>
              <Badge>RAM {fmtBytes(hw.data.memory.totalBytes)}</Badge>
              {hw.data.gpu.map((g) => (
                <Badge key={g}>{g}</Badge>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-2 text-[12px]">
              {[
                ['Threads', rec.threads, settings?.models.threads],
                ['Slots', rec.parallel, settings?.models.parallel],
                ['Cache RAM', `${rec.cacheRamMb} Mo`, `${settings?.models.cacheRamMb} Mo`],
                ['Contexte', rec.contextSize, settings?.models.contextSize],
              ].map(([k, v, cur]) => (
                <div key={String(k)} className="px-2.5 py-2 rounded-md bg-sunk border border-line">
                  <div className="text-faint text-[11px]">{k}</div>
                  <div className="text-fg tabular font-semibold">{v}</div>
                  <div className="text-faint text-[10.5px]">actuel : {cur}</div>
                </div>
              ))}
            </div>
            <ul className="text-[11.5px] text-faint list-disc pl-4 space-y-0.5">
              {rec.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <Button
              size="sm"
              variant={differs ? 'primary' : 'secondary'}
              disabled={!differs}
              loading={applying}
              onClick={async () => {
                setApplying(true);
                try {
                  await saveSettings({ models: { threads: rec.threads, parallel: rec.parallel, cacheRamMb: rec.cacheRamMb, contextSize: rec.contextSize } });
                  toast('good', 'Profil appliqué', 'Pris en compte au prochain démarrage du modèle.');
                } catch (e) {
                  toast('bad', 'Enregistrement impossible', errorMessage(e));
                } finally {
                  setApplying(false);
                }
              }}
            >
              {differs ? 'Appliquer les recommandations' : 'Réglages déjà alignés'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Measures pp and tg per thread count with llama-bench, then applies the best value on request. */
export function AutotuneDialog({ model, onClose }: { model: GgufMetadata | null; onClose: () => void }) {
  const settings = useApp((s) => s.settings);
  const [result, setResult] = useState<AutotuneResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  if (!model) return null;
  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.post<AutotuneResult>('/api/models/autotune', { modelPath: model.filePath }));
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };
  const best = result?.recommended.threads;
  return (
    <Dialog
      open
      onClose={() => !running && onClose()}
      title={`Auto-réglage : ${model.modelName || model.fileName}`}
      description="llama-bench charge le modèle et mesure le traitement du prompt (pp) et la génération (tg) pour plusieurs nombres de threads. Durée typique : 30 s à 2 min. llama-server doit être arrêté."
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Fermer
          </Button>
          {result && best !== settings?.models.threads ? (
            <Button
              variant="primary"
              onClick={async () => {
                await saveSettings({ models: { threads: best } });
                toast('good', `${best} threads appliqués`, 'Pris en compte au prochain démarrage du modèle.');
                onClose();
              }}
            >
              Appliquer {best} threads
            </Button>
          ) : (
            <Button variant="primary" icon={<Gauge className="w-3.5 h-3.5" />} loading={running} onClick={run}>
              {result ? 'Relancer' : 'Mesurer'}
            </Button>
          )}
        </>
      }
    >
      {running && (
        <div className="flex items-center gap-2 text-[12.5px] text-muted">
          <Spinner /> Mesure en cours avec llama-bench...
        </div>
      )}
      {error != null && <ErrorBox error={error} />}
      {result && (
        <div className="space-y-3">
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-faint">
              <tr>
                <th className="py-1 font-medium">Threads</th>
                <th className="py-1 font-medium">pp (prompt)</th>
                <th className="py-1 font-medium">tg (génération)</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {result.rows.map((r) => (
                <tr key={r.threads} className={cx(r.threads === best && 'text-brand font-semibold')}>
                  <td className="py-1.5 tabular">{r.threads}</td>
                  <td className="py-1.5 tabular">{fmtRate(r.ppTokS)}</td>
                  <td className="py-1.5 tabular">{fmtRate(r.tgTokS)}</td>
                  <td className="py-1.5">{r.threads === best && <Badge tone="brand">Recommandé</Badge>}{r.threads === settings?.models.threads && <Badge className="ml-1">Actuel</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11.5px] text-faint">
            {result.method}. Critère : meilleur tg (le travail de l’agent est dominé par la génération), pp en départage à 3 % près. Durée {fmtMs(result.durationMs)}, build {result.build ?? 'N/D'}. Les mesures varient avec la charge des autres applications.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** Disk usage of the per-session KV caches, with the active owner. */
export function KvCacheInfo() {
  const llamaState = useApp((s) => s.llama?.state);
  const sessions = useApp((s) => s.sessions);
  const [nonce, setNonce] = useState(0);
  const kv = useAsync((signal) => api.get<KvCacheUsage>('/api/models/kv-cache', signal), [nonce, llamaState]);
  const [confirm, setConfirm] = useState(false);
  if (!kv.data) return null;
  const owner = sessions.find((s) => s.id === kv.data!.owner);
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted pt-2 border-t border-line mt-3">
      <Badge tone={kv.data.enabled ? 'good' : 'neutral'}>Cache KV par session : {kv.data.enabled ? 'actif' : llamaState === 'ready' ? 'inactif (voir Paramètres)' : 'au prochain démarrage'}</Badge>
      <span>
        {kv.data.files} fichier(s), {fmtBytes(kv.data.bytes)} / {fmtBytes(kv.data.maxBytes)}
      </span>
      {owner && <span className="text-faint">slot attribué à « {owner.title} »</span>}
      <IconButton size="sm" label="Actualiser" onClick={() => setNonce((n) => n + 1)}>
        <RefreshCw className="w-3 h-3" />
      </IconButton>
      {kv.data.files > 0 && (
        <Button size="xs" variant="ghost" icon={<Trash2 className="w-3 h-3" />} onClick={() => setConfirm(true)}>
          Vider
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        title="Vider les caches KV ?"
        confirmLabel="Vider"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api.del('/api/models/kv-cache');
          setNonce((n) => n + 1);
        }}
      >
        Les sessions recalculeront leur prompt au prochain message. Les conversations elles-mêmes sont conservées.
      </ConfirmDialog>
    </div>
  );
}
