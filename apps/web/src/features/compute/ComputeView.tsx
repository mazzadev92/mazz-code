import { useCallback, useEffect, useMemo, useState } from 'react';
import { Cloud, HardDrive, Rocket, Square } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { navigate, toast } from '../../lib/store';
import { Badge, Button, Card, ErrorBox, Field, Input, Notice, Page, PageHeader, Segmented, Select } from '../../components/ui';
import {
  JOB_STATUS_LABELS,
  buildSendBody,
  isJobActive,
  jobPercent,
  jobTone,
  providerAcceptsSource,
  type ComputeJob,
  type SendSource,
} from './compute-format';

interface ProviderState { configured: boolean; ok: boolean | null; detail?: string }
interface Deployment { id: string; name: string; status?: string }
interface ComputeProvider {
  id: string; label: string; summary: string; free_note: string; accepts: string[];
  setup: string[]; needs_token: boolean; token_label: string; state: ProviderState; deployments: Deployment[];
}
interface Sources {
  local: Array<{ filename: string; size_bytes: number; quant?: string | null; size_label?: string | null }>;
  hf: { repo: string; files: Array<{ path?: string; filename?: string; size?: number; size_bytes?: number }>; error: string | null };
}
interface CatalogModel {
  id: string; name: string; modality: string; repo: string; file: string; size_gb: number; license: string;
  engine: 'gguf' | 'vllm' | null; note: string; api_alternatives: string[]; fits: Record<string, boolean>;
}
const MODALITIES: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Tout' }, { value: 'text', label: 'Texte' }, { value: 'image', label: 'Image' },
  { value: 'video', label: 'Vidéo' }, { value: '3d', label: '3D' }, { value: 'audio', label: 'Audio' }, { value: 'embed', label: 'Embeddings' },
];
interface Backend { id: string; kind?: string; models?: string[]; url?: string; healthy?: boolean }

const POLL_MS = 3000;

function hfFileName(f: Sources['hf']['files'][number]): string {
  return f.path ?? f.filename ?? '';
}

export default function ComputeView() {
  const [providers, setProviders] = useState<ComputeProvider[] | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [backends, setBackends] = useState<Backend[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [origin, setOrigin] = useState<'local' | 'hf'>('local');
  const [pick, setPick] = useState('');
  const [target, setTarget] = useState('');
  const [servedName, setServedName] = useState('');
  const [job, setJob] = useState<ComputeJob | null>(null);
  const [sending, setSending] = useState(false);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [modality, setModality] = useState('all');
  const [hfRepo, setHfRepo] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    // Independent loads: the slow provider checks must not hold back the lists that are already available.
    await Promise.all([
      api.get<{ providers: ComputeProvider[] }>('/api/compute/providers').then((r) => setProviders(r.providers), setError),
      api.get<Sources>('/api/compute/sources').then(setSources, setError),
      api.get<{ backends: Backend[] }>('/api/compute/serving').then((r) => setBackends(r.backends), setError),
      api.get<{ models: CatalogModel[] }>('/api/compute/catalog').then((r) => setCatalog(r.models), setError),
    ]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Poll the running job until it ends, then refresh the serving list.
  useEffect(() => {
    if (!job || !isJobActive(job.status)) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.get<ComputeJob>(`/api/compute/jobs/${job.id}`);
        setJob(next);
        if (!isJobActive(next.status)) {
          void load();
          if (next.status === 'done') toast('good', 'Modèle en ligne', next.message || next.title);
        }
      } catch (e) { setError(e); }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job, load]);

  const source: SendSource | null = useMemo(() => {
    if (!pick) return null;
    return origin === 'local' ? { type: 'local', filename: pick } : { type: 'hf', repo: hfRepo ?? sources?.hf.repo, file: pick === '(repo)' ? '' : pick };
  }, [origin, pick, sources, hfRepo]);

  const compatible = useMemo(() => (providers ?? []).filter((p) => !source || providerAcceptsSource(p.accepts, source)), [providers, source]);
  const targetOk = compatible.some((p) => p.id === target);

  const send = async () => {
    if (!source || !targetOk) return;
    setSending(true); setError(null);
    try {
      setJob(await api.post<ComputeJob>('/api/compute/send', buildSendBody(source, target, servedName)));
    } catch (e) { setError(e); }
    finally { setSending(false); }
  };

  const saveToken = async (id: string) => {
    setBusy(id);
    try {
      await api.post(`/api/compute/providers/${id}/configure`, { token: tokens[id] ?? '' });
      setTokens((t) => ({ ...t, [id]: '' }));
      toast('good', 'Jeton enregistré');
      await load();
    } catch (e) { toast('bad', 'Jeton refusé', errorMessage(e)); }
    finally { setBusy(null); }
  };

  const stop = async (providerId: string, deploymentId: string) => {
    setBusy(deploymentId);
    try {
      await api.post(`/api/compute/providers/${providerId}/stop`, { deployment_id: deploymentId });
      toast('good', 'Arrêt demandé');
      await load();
    } catch (e) { toast('bad', 'Arrêt impossible', errorMessage(e)); }
    finally { setBusy(null); }
  };

  const hfOptions = sources?.hf.files ?? [];

  return (
    <Page>
      <PageHeader title="Calcul GPU" subtitle="Envoie un modèle de ton PC ou de Hugging Face vers un GPU gratuit. Il apparaît ensuite dans la liste des modèles, prêt à répondre." icon="hub" actions={<Button size="sm" variant="ghost" onClick={() => void load()}>Actualiser</Button>} />
      {error != null && <ErrorBox error={error} />}

      <Card title="Envoyer un modèle" subtitle="Aucun paiement : seuls les paliers gratuits sont utilisés, avec arrêt automatique.">
        <div className="space-y-3">
          <Segmented label="Origine du modèle" value={origin} onChange={(v) => { setOrigin(v); setPick(''); setHfRepo(null); }} options={[{ value: 'local', label: <span className="inline-flex items-center gap-1.5"><HardDrive className="w-3.5 h-3.5" />Mon PC</span> }, { value: 'hf', label: <span className="inline-flex items-center gap-1.5"><Cloud className="w-3.5 h-3.5" />Hugging Face</span> }]} />
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Modèle" htmlFor="cmp-model">
              <Select id="cmp-model" className="w-full" value={pick} onChange={(e) => { setPick(e.target.value); setHfRepo(null); }}>
                <option value="">Choisir…</option>
                {origin === 'local' && sources?.local.map((m) => <option key={m.filename} value={m.filename}>{m.filename} · {fmtBytes(m.size_bytes)}</option>)}
                {origin === 'hf' && hfRepo && <option value={pick}>{hfRepo}{pick !== '(repo)' ? ` / ${pick}` : ''}</option>}
                {origin === 'hf' && !hfRepo && <option value="(repo)">Dépôt vLLM (sans fichier GGUF)</option>}
                {origin === 'hf' && hfOptions.map((f) => <option key={hfFileName(f)} value={hfFileName(f)}>{hfFileName(f)}{f.size ?? f.size_bytes ? ` · ${fmtBytes(f.size ?? f.size_bytes)}` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Fournisseur" htmlFor="cmp-target" hint={source && !compatible.length ? 'Aucun fournisseur ne sert ce format.' : undefined}>
              <Select id="cmp-target" className="w-full" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choisir…</option>
                {compatible.map((p) => <option key={p.id} value={p.id}>{p.label}{p.state.ok ? '' : ' (à configurer)'}</option>)}
              </Select>
            </Field>
            <Field label="Nom servi (facultatif)" htmlFor="cmp-name">
              <Input id="cmp-name" value={servedName} onChange={(e) => setServedName(e.target.value)} placeholder="déduit du fichier" spellCheck={false} />
            </Field>
          </div>
          {origin === 'hf' && sources?.hf.error && <Notice tone="warn" title="Hugging Face injoignable">Jeton HF absent ou invalide ({sources.hf.error}). Dépôt visé : {sources.hf.repo}.</Notice>}
          <div className="flex items-center gap-3">
            <Button icon={<Rocket className="w-4 h-4" />} onClick={() => void send()} loading={sending} disabled={!source || !targetOk || (job != null && isJobActive(job.status))}>Envoyer et démarrer</Button>
            {origin === 'local' && <span className="text-[12px] text-faint">Le fichier passe d’abord par ton dépôt Hugging Face ({sources?.hf.repo ?? 'N/D'}).</span>}
          </div>
          {job && (
            <div className="rounded-md border border-line p-3 space-y-2" aria-live="polite">
              <div className="flex items-center gap-2 text-[13px]">
                <span className="font-medium text-fg">{job.title}</span>
                <Badge tone={jobTone(job.status)}>{JOB_STATUS_LABELS[job.status]}</Badge>
                <span className="ml-auto text-faint">{jobPercent(job.progress)} %</span>
              </div>
              <div className="h-1.5 rounded bg-sunk overflow-hidden" role="progressbar" aria-valuenow={jobPercent(job.progress)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-brand transition-[width]" style={{ width: `${jobPercent(job.progress)}%` }} />
              </div>
              <ul className="text-[12px] text-muted space-y-0.5">
                {job.steps.map((s) => <li key={s.name}>{s.status === 'done' ? '✓' : s.status === 'running' ? '…' : '·'} {s.name}{s.detail ? ` — ${s.detail}` : ''}</li>)}
              </ul>
              {job.message && <p className={job.status === 'failed' ? 'text-[12px] text-bad' : 'text-[12px] text-muted'}>{job.message}</p>}
              {job.status === 'done' && <Button size="sm" variant="secondary" onClick={() => navigate('agent')}>Utiliser dans une session</Button>}
            </div>
          )}
        </div>
      </Card>

      <Card title="Catalogue de modèles" subtitle="Dépôts, fichiers et tailles vérifiés sur Hugging Face. Texte : envoi direct. Image, vidéo, 3D, audio : pas encore de moteur GPU, utilise les API du routeur en attendant.">
        <div className="space-y-3">
          <Segmented label="Type de modèle" value={modality} onChange={setModality} options={MODALITIES} size="xs" />
          <ul className="divide-y divide-line">
            {catalog.filter((m) => modality === 'all' || m.modality === modality).map((m) => {
              const targets = Object.entries(m.fits).filter(([, ok]) => ok).map(([id]) => id);
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-2 py-2 text-[12.5px]">
                  <span className="font-medium text-fg">{m.name}</span>
                  <Badge>{m.size_gb.toLocaleString('fr-FR')} Go</Badge>
                  <Badge tone={m.license === 'other' ? 'warn' : 'neutral'}>{m.license === 'other' ? 'licence spécifique' : m.license}</Badge>
                  {m.engine && <Badge tone="info">{m.engine === 'gguf' ? 'GGUF' : 'vLLM'}</Badge>}
                  <span className="text-faint truncate">{m.note}</span>
                  <span className="ml-auto flex items-center gap-2">
                    {m.engine && targets.length > 0 && (
                      <Button size="xs" variant="secondary" onClick={() => { setOrigin('hf'); setHfRepo(m.repo); setPick(m.file || '(repo)'); setTarget(targets[0]); window.scrollTo?.({ top: 0 }); }}>Préparer l’envoi</Button>
                    )}
                    {m.engine && targets.length === 0 && <span className="text-faint">trop gros pour un GPU gratuit</span>}
                    {!m.engine && <span className="text-faint">{m.api_alternatives.length ? `Via API : ${m.api_alternatives.join(', ')}` : 'N/D'}</span>}
                  </span>
                </li>
              );
            })}
            {!catalog.length && <li className="py-2 text-faint text-[12px]">Chargement du catalogue…</li>}
          </ul>
        </div>
      </Card>

      <Card title="Modèles qui tournent" subtitle="Annoncés par les GPU distants ; disponibles sous le nom fournisseur/modèle.">
        {backends.length ? (
          <ul className="divide-y divide-line">
            {backends.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                <span className="font-medium text-fg">{b.id}</span>
                {b.kind && <Badge>{b.kind}</Badge>}
                {b.healthy != null && <Badge tone={b.healthy ? 'good' : 'warn'}>{b.healthy ? 'En ligne' : 'Hors ligne'}</Badge>}
                <span className="text-faint">{b.models?.join(', ')}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-[12px] text-faint">Aucun modèle distant en ligne pour l’instant.</p>}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {(providers ?? []).map((p) => (
          <Card key={p.id} title={p.label} actions={<Badge tone={p.state.ok ? 'good' : p.state.configured ? 'warn' : 'neutral'}>{p.state.ok ? 'Prêt' : p.state.configured ? 'À vérifier' : 'À configurer'}</Badge>}>
            <div className="space-y-2.5 text-[12.5px]">
              <p className="text-muted">{p.summary}</p>
              <p className="text-faint">{p.free_note}</p>
              {p.state.detail && <p className={p.state.ok ? 'text-good' : 'text-warn'}>{p.state.detail}</p>}
              {!p.state.ok && <ol className="list-decimal pl-4 text-muted space-y-0.5">{p.setup.map((s) => <li key={s}>{s}</li>)}</ol>}
              {p.needs_token && (
                <div className="flex items-end gap-2">
                  <Field label={p.token_label || 'Jeton'} htmlFor={`tok-${p.id}`}>
                    <Input id={`tok-${p.id}`} type="password" autoComplete="off" spellCheck={false} value={tokens[p.id] ?? ''} onChange={(e) => setTokens((t) => ({ ...t, [p.id]: e.target.value }))} />
                  </Field>
                  <Button size="sm" onClick={() => void saveToken(p.id)} loading={busy === p.id} disabled={!(tokens[p.id] ?? '').trim()}>Enregistrer</Button>
                </div>
              )}
              {p.deployments.length > 0 && (
                <ul className="divide-y divide-line">
                  {p.deployments.map((d) => (
                    <li key={d.id} className="flex items-center gap-2 py-1.5">
                      <span className="truncate text-fg">{d.name}</span>
                      {d.status && <Badge>{d.status}</Badge>}
                      <Button className="ml-auto" size="xs" variant="ghost" icon={<Square className="w-3 h-3" />} loading={busy === d.id} onClick={() => void stop(p.id, d.id)}>Arrêter</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        ))}
      </div>
      {!providers && !error && <p className="text-[12px] text-faint">Vérification des fournisseurs…</p>}
    </Page>
  );
}
