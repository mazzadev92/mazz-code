import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderSearch, Play, Plus, Power, RefreshCw, Sparkles, Square, Trash2 } from '../../components/icons';
import { estimateRam, kvBytesPerToken, type GgufMetadata, type InferenceTelemetry } from '@mazz/shared';
import { api, ApiError, errorMessage } from '../../lib/api';
import { streamSse } from '../../lib/sse';
import { getState, navigate, refreshLlama, refreshSettings, toast, useApp, setState } from '../../lib/store';
import { basename, fmtBytes, fmtInt, fmtMb, fmtMs, fmtParams, fmtRate, SOURCE_LABEL } from '../../lib/format';
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorBox, Field, IconButton, Input, Notice, Page, PageHeader, Segmented, Spinner, Stat, StatusDot, Toggle, useAsync, cx } from '../../components/ui';
import { Meter } from '../../components/charts';
import { PathPicker } from '../../components/overlays';
import { TelemetryChip } from '../agent/TurnView';
import { AutotuneDialog, HardwareCard, KvCacheInfo } from './Tuning';
import { ForgePresetCard } from './ForgePreset';
import type { StudioSettings } from '../../lib/types';

function modelState(m: GgufMetadata): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (!m.isValidGguf) return { label: 'Invalide', tone: 'bad' };
  if (m.vocabOnly) return { label: 'Vocabulaire seul', tone: 'bad' };
  if (m.architecture === 'clip') return { label: 'Projecteur vision (mmproj)', tone: 'neutral' };
  if (m.likelyEmbeddingModel) return { label: 'Embeddings', tone: 'neutral' };
  return { label: 'Prêt à charger', tone: 'good' };
}

// ---------------------------------------------------------------- launch dialog

function LaunchDialog({ model, onClose, library }: { model: GgufMetadata | null; onClose: () => void; library: GgufMetadata[] }) {
  const settings = useApp((s) => s.settings);
  const metrics = useApp((s) => s.metrics);
  const [ctx, setCtx] = useState(4096);
  const [threads, setThreads] = useState(4);
  const [batch, setBatch] = useState(512);
  const [gpuLayers, setGpuLayers] = useState(0);
  const [port, setPort] = useState(8080);
  const [jinja, setJinja] = useState(true);
  const [embeddings, setEmbeddings] = useState(false);
  const [draft, setDraft] = useState('');
  const [mmproj, setMmproj] = useState('');
  const [accel, setAccel] = useState(true);
  const [kvType, setKvType] = useState<'f16' | 'q8_0' | 'q4_0'>('f16');
  const [mmprojPicker, setMmprojPicker] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [memoryBlock, setMemoryBlock] = useState<{ estimate: { totalMb: number }; availableMb: number } | null>(null);

  useEffect(() => {
    if (!model || !settings) return;
    setCtx(Math.min(settings.models.contextSize, model.contextLength ?? settings.models.contextSize));
    setThreads(settings.models.threads);
    setBatch(settings.models.batchSize);
    setGpuLayers(settings.models.gpuLayers);
    setPort(settings.models.port);
    setJinja(settings.models.jinja);
    setEmbeddings(!!model.likelyEmbeddingModel);
    setDraft(settings.models.draftModelPath);
    setAccel(settings.models.acceleration.enabled);
    setKvType(settings.models.acceleration.kvCacheType);
    // A projector stored next to the model (mmproj*.gguf) is proposed by default.
    const dir = model.filePath.replace(/[\\/][^\\/]*$/, '').toLowerCase();
    setMmproj(library.find((m) => m.architecture === 'clip' && m.filePath.replace(/[\\/][^\\/]*$/, '').toLowerCase() === dir)?.filePath ?? '');
    setError(null);
    setMemoryBlock(null);
  }, [model, settings]);

  if (!model) return null;
  // Draft candidates share the tokenizer (llama.cpp requires the same vocabulary) and are smaller.
  const draftCandidates = library.filter((m) => m.filePath !== model.filePath && m.isValidGguf && !m.vocabOnly && m.tokenizerModel === model.tokenizerModel && m.vocabSize === model.vocabSize && m.fileSizeBytes < model.fileSizeBytes);
  const draftMeta = library.find((m) => m.filePath.toLowerCase() === draft.toLowerCase());
  const mmprojCandidates = library.filter((m) => m.architecture === 'clip' && m.isValidGguf);
  const mmprojMeta = library.find((m) => m.filePath.toLowerCase() === mmproj.toLowerCase());
  const mmprojMb = mmprojMeta ? mmprojMeta.fileSizeBytes / 1048576 : 0;
  const rawEst = estimateRam(model, ctx);
  // A quantised KV cache shrinks the context memory (q8_0 about 1/2, q4_0 about 1/4 of f16).
  const kvFactor = kvType === 'q8_0' ? 0.53 : kvType === 'q4_0' ? 0.28 : 1;
  const kvMb = rawEst.kvKnown ? (rawEst.kvCacheMb ?? 0) * kvFactor : rawEst.kvCacheMb;
  const baseEst = rawEst.kvKnown ? { ...rawEst, kvCacheMb: kvMb, totalMb: rawEst.totalMb - (rawEst.kvCacheMb ?? 0) + (kvMb ?? 0) } : rawEst;
  const mainEst = { ...baseEst, weightsMb: baseEst.weightsMb + mmprojMb, totalMb: baseEst.totalMb + mmprojMb };
  const draftEst = draftMeta ? estimateRam(draftMeta, ctx) : undefined;
  const est = draftEst ? { ...mainEst, weightsMb: mainEst.weightsMb + draftEst.weightsMb, kvCacheMb: (mainEst.kvCacheMb ?? 0) + (draftEst.kvCacheMb ?? 0), totalMb: mainEst.totalMb + draftEst.totalMb - draftEst.overheadMb } : mainEst;
  const availMb = metrics ? metrics.memory.availableBytes / (1024 * 1024) : undefined;
  const tooBig = availMb !== undefined && est.totalMb > availMb;
  const cores = metrics?.cpu.logicalCores ?? 4;

  const start = async (force = false) => {
    setBusy(true);
    setError(null);
    setState({ llama: { ...(getState().llama ?? { port, host: '127.0.0.1', isRunning: false }), state: 'starting' } });
    try {
      await api.post('/api/models/server/start', { modelPath: model.filePath, contextSize: ctx, threads, batchSize: batch, gpuLayers, port, jinja, embeddings, force, draftModelPath: draft, mmprojPath: mmproj || undefined, acceleration: accel, kvCacheType: kvType });
      toast('good', 'Modèle chargé', `${model.fileName} prêt sur le port ${port}${accel ? ', décodage spéculatif actif' : ''}`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.details as { code?: string })?.code === 'INSUFFICIENT_MEMORY') {
        setMemoryBlock(err.details as { estimate: { totalMb: number }; availableMb: number });
      } else setError(err);
    } finally {
      setBusy(false);
      void refreshLlama();
    }
  };

  return (
    <Dialog
      open
      onClose={() => !busy && onClose()}
      title={`Charger ${model.fileName}`}
      width={600}
      description="Démarre llama-server avec ce modèle. Les valeurs par défaut sont réglées pour un processeur 4 cœurs et 16 Go de RAM."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Play className="w-3.5 h-3.5" />} loading={busy} onClick={() => start(false)}>
            Démarrer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Taille de contexte" hint={`Contexte d’entraînement déclaré : ${fmtInt(model.contextLength)} jetons. Le cache KV grandit linéairement avec ce réglage.`}>
          <div className="flex items-center gap-2">
            <Segmented
              label="Préréglages de contexte"
              value={String(ctx) as '2048' | '4096' | '8192' | '16384' | '32768'}
              onChange={(v) => setCtx(Number(v))}
              options={(['2048', '4096', '8192', '16384', '32768'] as const).map((v) => ({ value: v, label: `${Number(v) / 1024}k`, disabled: !!model.contextLength && Number(v) > model.contextLength }))}
            />
            <Input type="number" value={ctx} min={256} max={model.contextLength ?? 262144} onChange={(e) => setCtx(Number(e.target.value) || 2048)} className="w-28" aria-label="Contexte personnalisé" />
          </div>
        </Field>
        <div className="rounded-[var(--radius-md)] border border-line bg-sunk p-3 space-y-2">
          <div className="text-[12px] text-muted">Estimation mémoire (calculée depuis l’en-tête, non mesurée)</div>
          <div className="grid grid-cols-4 gap-2 text-[12px]">
            <div>
              <div className="text-faint">Poids</div>
              <div className="tabular text-fg">{fmtMb(est.weightsMb)}</div>
            </div>
            <div>
              <div className="text-faint">Cache KV (f16)</div>
              <div className="tabular text-fg">{est.kvKnown ? fmtMb(est.kvCacheMb) : 'inconnu'}</div>
            </div>
            <div>
              <div className="text-faint">Marge runtime</div>
              <div className="tabular text-fg">{fmtMb(est.overheadMb)}</div>
            </div>
            <div>
              <div className="text-faint">Total estimé</div>
              <div className={cx('tabular font-semibold', tooBig ? 'text-bad' : 'text-fg')}>{fmtMb(est.totalMb)}</div>
            </div>
          </div>
          <Meter label="Mémoire disponible maintenant" value={est.totalMb} max={availMb ?? est.totalMb} detail={availMb !== undefined ? `${fmtMb(est.totalMb)} / ${fmtMb(availMb)} disponibles` : 'N/D'} />
          {tooBig && <p className="text-[12px] text-bad">La mémoire disponible est insuffisante pour cette estimation : réduisez le contexte ou fermez des applications.</p>}
        </div>
        <div className="rounded-[var(--radius-md)] border border-brand/30 bg-brand/5 p-3 space-y-3">
          <div className="flex items-center gap-2 text-[12.5px]">
            <Toggle checked={accel} onChange={setAccel} label="Décodage spéculatif n-gram" />
            <span className="text-fg">Décodage spéculatif n-gram</span>
            <span className="text-muted">spéculation n-gram, attente active, priorité haute</span>
          </div>
          <Field label="Précision du cache KV" hint="q8_0 : mémoire du contexte divisée par deux, pour les longs prompts et documents. Active Flash Attention.">
            <Segmented label="Précision du cache KV" value={kvType} onChange={setKvType} options={[{ value: 'f16', label: 'f16' }, { value: 'q8_0', label: 'q8_0' }, { value: 'q4_0', label: 'q4_0' }]} />
          </Field>
        </div>
        <Field
          label="Vision : projecteur multimodal (mmproj)"
          hint={mmprojCandidates.length ? 'Permet au modèle de lire les images jointes. Le projecteur doit correspondre au modèle (même famille et taille).' : 'Aucun fichier mmproj dans la bibliothèque. Les modèles vision (Qwen2.5-VL, Gemma 3, SmolVLM...) sont fournis avec un fichier mmproj-*.gguf.'}
        >
          <div className="flex items-center gap-1.5">
            <select value={mmproj} onChange={(e) => setMmproj(e.target.value)} className="h-8 px-2 rounded-md bg-sunk border border-line text-[13px] flex-1 min-w-0" aria-label="Projecteur multimodal">
              <option value="">Aucun (texte seulement)</option>
              {mmproj && !mmprojCandidates.some((m) => m.filePath === mmproj) && <option value={mmproj}>{basename(mmproj)}</option>}
              {mmprojCandidates.map((m) => (
                <option key={m.filePath} value={m.filePath}>
                  {m.fileName}
                </option>
              ))}
            </select>
            <Button size="sm" icon={<FolderSearch className="w-3.5 h-3.5" />} onClick={() => setMmprojPicker(true)}>
              Parcourir
            </Button>
          </div>
          <PathPicker open={mmprojPicker} mode="file" ext=".gguf" title="Projecteur multimodal (mmproj)" onClose={() => setMmprojPicker(false)} onPick={(p) => setMmproj(p)} />
        </Field>
        <Field label="Threads" hint={`${cores} threads logiques détectés. Au-delà du nombre de cœurs physiques, le débit baisse généralement.`}>
          <div className="flex items-center gap-3">
            <input type="range" min={1} max={cores} value={threads} onChange={(e) => setThreads(Number(e.target.value))} className="flex-1 accent-[var(--brand)]" aria-label="Threads" />
            <span className="w-8 text-right tabular text-[13px]">{threads}</span>
          </div>
        </Field>
        <Field label="Appel d’outils (--jinja)" hint="Active les gabarits Jinja nécessaires au tool calling de llama.cpp. Le support réel dépend du modèle." inline>
          <Toggle checked={jinja} onChange={setJinja} label="Activer --jinja" />
        </Field>
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[12.5px] text-muted hover:text-fg cursor-pointer" aria-expanded={advanced}>
          {advanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} Réglages avancés
        </button>
        {advanced && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Batch (--batch-size)">
              <Input type="number" value={batch} min={16} max={8192} onChange={(e) => setBatch(Number(e.target.value))} />
            </Field>
            <Field label="Port local">
              <Input type="number" value={port} min={1024} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
            </Field>
            <Field label="Couches GPU (--n-gpu-layers)" hint="Utile seulement avec un build llama.cpp GPU (CUDA, Vulkan). Le GPU intégré HD 530 n’accélère pas un build CPU.">
              <Input type="number" value={gpuLayers} min={0} max={999} onChange={(e) => setGpuLayers(Number(e.target.value))} />
            </Field>
            <Field label="Modèle brouillon (décodage spéculatif)" hint={draftCandidates.length ? 'Mesuré sur i5-6500 (Qwen3 1.7B + 0.6B) : aucun gain, les deux modèles partagent le CPU. Utile surtout avec un GPU.' : 'Aucun modèle compatible (même vocabulaire, plus petit) dans la bibliothèque.'}>
              <select value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 px-2 rounded-md bg-sunk border border-line text-[13px] w-full" aria-label="Modèle brouillon">
                <option value="">Aucun</option>
                {draftCandidates.map((m) => (
                  <option key={m.filePath} value={m.filePath}>
                    {m.modelName || m.fileName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Mode embeddings (--embeddings)" inline>
              <Toggle checked={embeddings} onChange={setEmbeddings} label="Mode embeddings" />
            </Field>
          </div>
        )}
        {memoryBlock && (
          <Notice
            tone="bad"
            title="Démarrage bloqué : mémoire insuffisante"
            action={
              <Button size="sm" variant="danger" onClick={() => start(true)} loading={busy}>
                Forcer
              </Button>
            }
          >
            Estimation {fmtMb(memoryBlock.estimate.totalMb)} pour {fmtMb(memoryBlock.availableMb)} disponibles. Forcer peut provoquer une forte utilisation du fichier d’échange.
          </Notice>
        )}
        {error != null && <ErrorBox error={error} title="Échec du démarrage" />}
        {busy && <LiveLogTail />}
      </div>
    </Dialog>
  );
}

function LiveLogTail() {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        const r = await api.get<{ lines: Array<{ text: string }> }>('/api/models/server/logs');
        if (alive) setLines(r.lines.slice(-8).map((l) => l.text));
      } catch {
        // offline
      }
    }, 700);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return (
    <div className="rounded-md border border-line bg-code p-2 font-mono text-[11px] text-muted h-32 overflow-hidden">
      <div className="flex items-center gap-2 text-faint mb-1">
        <Spinner size={10} /> Chargement du modèle, journal en direct
      </div>
      {lines.map((l, i) => (
        <div key={i} className="truncate">
          {l}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- inference test

function InferenceTest() {
  const llama = useApp((s) => s.llama);
  const [prompt, setPrompt] = useState('Écris une fonction C qui calcule la factorielle de n de façon itérative. Réponds brièvement.');
  const [maxTokens, setMaxTokens] = useState(256);
  const [output, setOutput] = useState('');
  const [thought, setThought] = useState('');
  const [telemetry, setTelemetry] = useState<InferenceTelemetry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const ready = llama?.state === 'ready';

  const run = async () => {
    setOutput('');
    setThought('');
    setTelemetry(null);
    setError(null);
    setRunning(true);
    ctrl.current = new AbortController();
    let buffer = '';
    let thoughtBuf = '';
    let timer: number | null = null;
    const flush = () => {
      setOutput(buffer);
      setThought(thoughtBuf);
      timer = null;
    };
    try {
      await streamSse('/api/inference/test', {
        body: { providerId: 'llama-local', prompt, maxTokens, temperature: 0.2 },
        signal: ctrl.current.signal,
        onMessage: (m) => {
          const ev = JSON.parse(m.data);
          if (m.event === 'meta') return setRunId(ev.runId);
          if (ev.type === 'token') buffer += ev.delta;
          else if (ev.type === 'thought') thoughtBuf += ev.delta;
          else if (ev.type === 'usage' && ev.telemetry) setTelemetry(ev.telemetry);
          else if (ev.type === 'error') setError(ev.message);
          if (timer === null) timer = window.setTimeout(flush, 60);
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(errorMessage(err));
    } finally {
      if (timer !== null) clearTimeout(timer);
      flush();
      setRunning(false);
      setRunId(null);
    }
  };

  return (
    <Card title="Test d’inférence" subtitle="Appel direct du modèle chargé, sans outils, avec la télémétrie du runtime.">
      {!ready ? (
        <p className="text-[12.5px] text-faint">Démarrez un modèle pour le tester.</p>
      ) : (
        <div className="space-y-3">
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} aria-label="Prompt de test" className="w-full resize-y rounded-md bg-sunk border border-line px-3 py-2 text-[13px] focus:outline-none focus:border-brand/60" />
          <div className="flex items-center gap-2">
            <label className="text-[12px] text-muted flex items-center gap-2">
              Jetons max
              <Input type="number" value={maxTokens} min={1} max={4096} onChange={(e) => setMaxTokens(Number(e.target.value))} className="w-24 h-7" />
            </label>
            <div className="ml-auto flex gap-2">
              {running ? (
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Square className="w-3 h-3" />}
                  onClick={() => {
                    if (runId) void api.post('/api/inference/cancel', { runId });
                    else ctrl.current?.abort();
                  }}
                >
                  Arrêter
                </Button>
              ) : (
                <Button variant="primary" size="sm" icon={<Play className="w-3 h-3" />} onClick={run} disabled={!prompt.trim()}>
                  Lancer le test
                </Button>
              )}
            </div>
          </div>
          {thought && (
            <details className="rounded-md border border-line bg-sunk px-3 py-2 text-[12px] text-muted">
              <summary className="cursor-pointer">Raisonnement transmis par le modèle ({thought.length} caractères)</summary>
              <div className="whitespace-pre-wrap mt-2">{thought}</div>
            </details>
          )}
          {!running && !output && thought && telemetry && <p className="text-[12px] text-warn">Aucun texte de réponse : tous les jetons générés ont servi au raisonnement. Augmentez « Jetons max » ou ajoutez /no_think pour les modèles Qwen3.</p>}
          {(output || running) && <pre className="rounded-md border border-line bg-code p-3 text-[12.5px] font-mono whitespace-pre-wrap max-h-72 overflow-auto">{output || ' '}</pre>}
          {error && <ErrorBox error={error} />}
          {telemetry && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Stat label="Génération (tg)" value={fmtRate(telemetry.tgTokS)} hint={SOURCE_LABEL[telemetry.speedSource]} tone="brand" />
                <Stat label="Prompt (pp)" value={fmtRate(telemetry.ppTokS)} hint={SOURCE_LABEL[telemetry.tokenSource]} />
                <Stat label="TTFT" value={fmtMs(telemetry.ttftMs)} hint="mesuré par le Studio" />
                <Stat label="Jetons" value={`${fmtInt(telemetry.promptTokens)} / ${fmtInt(telemetry.completionTokens)}`} hint="entrée / sortie" />
              </div>
              <TelemetryChip t={telemetry} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- server panel

function ServerPanel() {
  const llama = useApp((s) => s.llama);
  const metrics = useApp((s) => s.metrics);
  const [stopping, setStopping] = useState(false);
  const props = useAsync(
    (signal) => (llama?.state === 'ready' ? api.get<{ props: Record<string, unknown>; capabilities: Record<string, { value: boolean; source: string }> }>('/api/models/server/props', signal) : Promise.resolve(null)),
    [llama?.state, llama?.pid]
  );
  const stateLabel = { stopped: 'Arrêté', starting: 'Chargement', ready: 'Chargé et prêt', error: 'Erreur', exited: 'Processus terminé' }[llama?.state ?? 'stopped'];
  const tone = llama?.state === 'ready' ? 'good' : llama?.state === 'starting' ? 'warn' : llama?.state === 'error' || llama?.state === 'exited' ? 'bad' : 'neutral';
  const capLabel: Record<string, string> = { chat: 'Chat', toolCalling: 'Appel d’outils', embeddings: 'Embeddings', completion: 'Complétion' };
  return (
    <Card
      title="Serveur llama.cpp"
      actions={
        <>
          <Button size="xs" variant="ghost" onClick={() => setState({ bottomOpen: true, bottomTab: 'logs' })}>
            Journal
          </Button>
          {(llama?.state === 'ready' || llama?.state === 'starting') && (
            <Button
              size="xs"
              variant="danger"
              icon={<Power className="w-3 h-3" />}
              loading={stopping}
              onClick={async () => {
                setStopping(true);
                try {
                  await api.post('/api/models/server/stop');
                  toast('info', 'llama-server arrêté');
                } catch (e) {
                  toast('bad', 'Arrêt impossible', errorMessage(e));
                } finally {
                  setStopping(false);
                  void refreshLlama();
                }
              }}
            >
              Arrêter
            </Button>
          )}
        </>
      }
    >
      <div className="grid md:grid-cols-[1fr_auto] gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <StatusDot tone={tone} pulse={llama?.state === 'starting'} />
            <span className="text-[13px] text-fg font-medium">{stateLabel}</span>
            {llama?.pid && <span className="text-[11.5px] text-faint">PID {llama.pid}</span>}
          </div>
          {llama?.modelPath && <div className="font-mono text-[12px] text-muted break-all">{llama.modelPath}</div>}
          {llama?.lastError && <p className="text-[12px] text-bad whitespace-pre-wrap break-words">{llama.lastError}</p>}
          {llama?.args && <div className="text-[11px] text-faint font-mono break-all">{basename(llama.binaryPath ?? '')} {llama.args.filter((_a, i, arr) => arr[i - 1] !== "-m").join(' ')}</div>}
          {props.data && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {Object.entries(props.data.capabilities).map(([k, v]) => (
                <Badge key={k} tone={v.value ? 'good' : 'neutral'} title={v.source}>
                  {capLabel[k] ?? k} : {v.value ? 'oui' : 'non'}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {llama?.state === 'ready' && (
          <div className="grid grid-cols-2 gap-2 min-w-[300px]">
            <Stat label="Mémoire mesurée (working set)" value={fmtBytes(metrics?.llamaServer?.workingSetBytes)} hint="tasklist, processus llama-server" />
            <Stat label="Temps de chargement" value={fmtMs(llama.loadMs)} hint="lancement jusqu’à /health" />
            <Stat label="Contexte runtime" value={fmtInt(llama.config?.contextSize)} hint="--ctx-size" />
            <Stat label="Threads" value={fmtInt(llama.config?.threads)} hint={llama.metadata?.quantization} />
          </div>
        )}
      </div>
      <KvCacheInfo />
    </Card>
  );
}

// ---------------------------------------------------------------- page

export default function ModelsView() {
  const settings = useApp((s) => s.settings);
  const llama = useApp((s) => s.llama);
  const [nonce, setNonce] = useState(0);
  const library = useAsync((signal) => api.get<{ items: GgufMetadata[]; scanFolders: string[] }>('/api/models/library', signal), [nonce, settings?.models.library.length]);
  const [picker, setPicker] = useState<'file' | 'folder' | null>(null);
  const [launch, setLaunch] = useState<GgufMetadata | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [remove, setRemove] = useState<GgufMetadata | null>(null);
  const [tune, setTune] = useState<GgufMetadata | null>(null);
  const [scan, setScan] = useState<{ folder: string; items: GgufMetadata[] } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const ctxForEstimate = settings?.models.contextSize ?? 4096;

  useEffect(() => {
    void refreshLlama();
  }, []);

  const add = async (paths: string[]) => {
    let ok = 0;
    for (const p of paths) {
      try {
        await api.post('/api/models/library', { path: p });
        ok++;
      } catch (e) {
        toast('bad', `Ajout refusé : ${basename(p)}`, errorMessage(e));
      }
    }
    if (ok) toast('good', `${ok} modèle(s) ajouté(s)`);
    await refreshSettings();
    setNonce((n) => n + 1);
  };

  const items = useMemo(() => library.data?.items ?? [], [library.data]);

  return (
    <Page wide>
      <PageHeader
        title="Model Hub"
        subtitle="Bibliothèque de modèles GGUF locaux. Les fichiers restent à leur emplacement : le Studio ne lit que leurs en-têtes et ne déplace ni ne supprime jamais les poids."
        icon="models"
        actions={
          <>
            <Button icon={<FolderSearch className="w-4 h-4" />} onClick={() => setPicker('folder')}>
              Scanner un dossier
            </Button>
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setPicker('file')}>
              Ajouter un fichier GGUF
            </Button>
          </>
        }
      />
      <ServerPanel />
      <ModelCalibrationCard />
      <HardwareCard />
      <ForgePresetCard />
      {llama?.state === 'ready' && <InferenceTest />}
      <Card
        title={`Bibliothèque (${items.length})`}
        subtitle={`Estimations RAM calculées pour ${ctxForEstimate} jetons de contexte (Paramètres, Modèles).`}
        actions={
          <IconButton label="Relire les en-têtes" onClick={() => setNonce((n) => n + 1)}>
            {library.loading ? <Spinner size={12} /> : <RefreshCw className="w-3.5 h-3.5" />}
          </IconButton>
        }
        padded={false}
      >
        {library.error != null && (
          <div className="p-4">
            <ErrorBox error={library.error} onRetry={library.reload} />
          </div>
        )}
        {library.data && items.length === 0 && (
          <div className="p-4">
            <EmptyState
              title="Aucun modèle dans la bibliothèque"
              actions={
                <>
                  <Button variant="primary" onClick={() => setPicker('file')}>
                    Ajouter un fichier GGUF
                  </Button>
                  <Button onClick={() => setPicker('folder')}>Scanner un dossier</Button>
                </>
              }
            >
              Ajoutez un modèle quantifié existant (Q4_K_M recommandé pour 16 Go de RAM). Aucun téléchargement n’est effectué.
            </EmptyState>
          </div>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead className="text-faint text-left border-y border-line bg-sunk">
                <tr>
                  <th className="px-3 py-2 font-medium w-6" />
                  <th className="px-3 py-2 font-medium">Modèle</th>
                  <th className="px-3 py-2 font-medium">Architecture</th>
                  <th className="px-3 py-2 font-medium">Paramètres</th>
                  <th className="px-3 py-2 font-medium">Quantification</th>
                  <th className="px-3 py-2 font-medium">Taille</th>
                  <th className="px-3 py-2 font-medium">Contexte</th>
                  <th className="px-3 py-2 font-medium" title="Estimation, pas une mesure">
                    RAM estimée
                  </th>
                  <th className="px-3 py-2 font-medium">État</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {items.map((m) => {
                  const st = modelState(m);
                  const loaded = llama?.state === 'ready' && llama.modelPath === m.filePath;
                  const est = m.isValidGguf && !m.vocabOnly ? estimateRam(m, Math.min(ctxForEstimate, m.contextLength ?? ctxForEstimate)) : null;
                  const open = expanded === m.filePath;
                  return [
                    <tr key={m.filePath} className={cx('hover:bg-raised/40', loaded && 'bg-good/5')}>
                      <td className="px-2">
                        <IconButton size="sm" label={open ? 'Masquer les détails' : 'Afficher les détails'} onClick={() => setExpanded(open ? null : m.filePath)}>
                          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </IconButton>
                      </td>
                      <td className="px-3 py-2 max-w-[280px]">
                        <div className="text-fg truncate" title={m.filePath}>
                          {m.modelName || m.fileName}
                        </div>
                        <div className="text-[11px] text-faint font-mono truncate">{m.fileName}</div>
                      </td>
                      <td className="px-3 py-2 font-mono text-muted">{m.architecture}</td>
                      <td className="px-3 py-2 tabular">{fmtParams(m.parameterCount)}</td>
                      <td className="px-3 py-2">
                        <Badge>{m.quantization}</Badge>
                      </td>
                      <td className="px-3 py-2 tabular text-muted">{fmtBytes(m.fileSizeBytes)}</td>
                      <td className="px-3 py-2 tabular text-muted">{fmtInt(m.contextLength)}</td>
                      <td className="px-3 py-2 tabular text-muted">{est ? `~${fmtMb(est.totalMb)}` : 'N/D'}</td>
                      <td className="px-3 py-2">{loaded ? <Badge tone="good">Chargé</Badge> : <Badge tone={st.tone}>{st.label}</Badge>}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          {!loaded && (
                            <Button size="xs" variant="primary" disabled={!m.isValidGguf || m.vocabOnly || llama?.state === 'starting'} onClick={() => setLaunch(m)} title={llama?.state === 'ready' ? 'Arrêtez d’abord le modèle chargé' : undefined}>
                              Charger
                            </Button>
                          )}
                          {!loaded && llama?.state !== 'ready' && llama?.state !== 'starting' && m.isValidGguf && !m.vocabOnly && (
                            <Button size="xs" variant="ghost" onClick={() => setTune(m)} title="Mesurer le meilleur nombre de threads avec llama-bench">
                              Auto-régler
                            </Button>
                          )}
                          {loaded && (
                            <Button size="xs" onClick={() => navigate('agent')}>
                              Utiliser
                            </Button>
                          )}
                          <IconButton size="sm" label="Retirer de la bibliothèque" onClick={() => setRemove(m)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </IconButton>
                        </div>
                      </td>
                    </tr>,
                    open && (
                      <tr key={`${m.filePath}-d`} className="bg-sunk">
                        <td />
                        <td colSpan={9} className="px-3 py-3">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1.5 text-[12px]">
                            {[
                              ['Chemin', m.filePath],
                              ['Version GGUF', m.ggufVersion],
                              ['Libellé de taille', m.sizeLabel],
                              ['Paramètres exacts', fmtInt(m.parameterCount)],
                              ['Tenseurs', fmtInt(m.tensorCount)],
                              ['Couches', m.blockCount],
                              ['Dimension', m.embeddingLength],
                              ['Têtes / KV', m.headCount ? `${m.headCount} / ${m.headCountKv ?? m.headCount}` : undefined],
                              ['Vocabulaire', fmtInt(m.vocabSize)],
                              ['Tokenizer', m.tokenizerModel],
                              ['Gabarit de chat', m.hasChatTemplate ? 'présent' : 'absent'],
                              ['Cache KV / jeton', kvBytesPerToken(m) ? fmtBytes(kvBytesPerToken(m)) : 'N/D'],
                            ].map(([k, v]) => (
                              <div key={String(k)} className="min-w-0">
                                <span className="text-faint">{k} : </span>
                                <span className="text-fg font-mono break-all">{v ?? 'N/D'}</span>
                              </div>
                            ))}
                          </div>
                          {m.error && <p className="text-[12px] text-bad mt-2">{m.error}</p>}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Notice tone="info" title="Capacités et performances">
        Les capacités affichées dans le panneau serveur proviennent du runtime lancé (gabarit exposé par /props, options de lancement), pas d’hypothèses sur le fichier. Les débits réels sont mesurés lors des tests et des benchmarks (page Performance).
      </Notice>
      <PathPicker open={picker === 'file'} mode="file" ext=".gguf" title="Ajouter un fichier GGUF" onClose={() => setPicker(null)} onPick={(p) => void add([p])} />
      <PathPicker
        open={picker === 'folder'}
        mode="folder"
        title="Scanner un dossier de modèles"
        onClose={() => setPicker(null)}
        onPick={async (folder) => {
          setScanning(true);
          try {
            const r = await api.post<{ folder: string; items: GgufMetadata[] }>('/api/models/scan', { path: folder, remember: true });
            setScan(r);
            setSelected(new Set(r.items.filter((i) => i.isValidGguf && !i.vocabOnly).map((i) => i.filePath)));
          } catch (e) {
            toast('bad', 'Scan impossible', errorMessage(e));
          } finally {
            setScanning(false);
          }
        }}
      />
      {scanning && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-2 rounded-md border border-line bg-panel text-[12.5px] shadow-[var(--shadow-2)]">
          <Spinner /> Scan du dossier (en-têtes uniquement, 3 niveaux)
        </div>
      )}
      <Dialog
        open={!!scan}
        onClose={() => setScan(null)}
        title={`Résultats du scan (${scan?.items.length ?? 0})`}
        description={scan?.folder}
        width={680}
        footer={
          <>
            <Button variant="ghost" onClick={() => setScan(null)}>
              Fermer
            </Button>
            <Button
              variant="primary"
              disabled={selected.size === 0}
              onClick={async () => {
                await add([...selected]);
                setScan(null);
              }}
            >
              Ajouter {selected.size} modèle(s)
            </Button>
          </>
        }
      >
        {scan?.items.length === 0 ? (
          <p className="text-[12.5px] text-faint">Aucun fichier .gguf trouvé.</p>
        ) : (
          <ul className="space-y-1 max-h-[360px] overflow-y-auto">
            {scan?.items.map((i) => {
              const usable = i.isValidGguf && !i.vocabOnly;
              return (
                <li key={i.filePath}>
                  <label className={cx('flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px]', usable ? 'cursor-pointer hover:bg-raised' : 'opacity-60')}>
                    <input
                      type="checkbox"
                      disabled={!usable}
                      checked={selected.has(i.filePath)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(i.filePath);
                          else n.delete(i.filePath);
                          return n;
                        })
                      }
                    />
                    <span className="truncate flex-1 font-mono">{i.fileName}</span>
                    <span className="text-faint">{fmtBytes(i.fileSizeBytes)}</span>
                    <Badge tone={modelState(i).tone}>{modelState(i).label}</Badge>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
      {launch && <LaunchDialog model={launch} library={items} onClose={() => setLaunch(null)} />}
      {tune && <AutotuneDialog model={tune} onClose={() => setTune(null)} />}
      <ConfirmDialog
        open={!!remove}
        title="Retirer ce modèle de la bibliothèque ?"
        confirmLabel="Retirer"
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          await api.del('/api/models/library', { path: remove!.filePath });
          await refreshSettings();
          setNonce((n) => n + 1);
        }}
      >
        Seule la référence est retirée. Le fichier {remove?.fileName} reste sur le disque.
      </ConfirmDialog>
    </Page>
  );
}

function ModelCalibrationCard() {
  const settings = useApp((s) => s.settings);
  const llama = useApp((s) => s.llama);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [latest, setLatest] = useState<NonNullable<StudioSettings['models']['calibrations']>[number] | null>(null);
  const saved = useAsync(
    (signal) => api.get<{
      profile: NonNullable<StudioSettings['models']['calibrations']>[number] | null;
      runtime: NonNullable<StudioSettings['models']['calibrations'][number]['runtime']> | null;
      runtimeMatches: boolean | null;
    }>('/api/models/calibration', signal),
    [llama?.modelPath, llama?.pid, settings?.models.calibrations.length],
  );
  const latestForModel = latest && latest.modelPath === llama?.modelPath ? latest : null;
  const profile = latestForModel ?? saved.data?.profile;
  const runtimeMatches = latestForModel
    ? !!latestForModel.runtime && !!saved.data?.runtime && JSON.stringify(latestForModel.runtime) === JSON.stringify(saved.data.runtime)
    : saved.data?.runtimeMatches ?? null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ profile: NonNullable<StudioSettings['models']['calibrations']>[number] }>('/api/models/calibrate', {});
      setLatest(result.profile);
      await refreshSettings();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  if (llama?.state !== 'ready' || !llama.modelPath) return null;
  const strategyLabel = { autonomous: 'Autonome', hybrid: 'Hybride', guided: 'Guidé' };
  const labels: Record<string, string> = {
    toolCalling: 'Appel JSON d’outil',
    constrainedGrammar: 'Grammaire contrainte',
    codeContinuation: 'Continuation de code C',
  };
  const runtimeLabel = (runtime: NonNullable<StudioSettings['models']['calibrations'][number]['runtime']>) => [
    `contexte ${runtime.contextSize ?? 'N/D'}`,
    `${runtime.threads ?? 'N/D'} threads`,
    `batch ${runtime.batchSize ?? 'N/D'}`,
    `GPU layers ${runtime.gpuLayers ?? 'N/D'}`,
    `Jinja ${runtime.jinja ? 'oui' : 'non'}`,
    `raisonnement ${runtime.reasoning ?? 'défaut'}`,
    `KV ${runtime.kvCacheType ?? 'défaut'}`,
    runtime.draftModelPath ? 'brouillon spéculatif' : runtime.specType && runtime.specType !== 'none' ? runtime.specType : 'sans spéculation',
  ].join(' · ');
  return (
    <Card
      title="Profil d’exécution du modèle"
      subtitle="Trois sondes indépendantes valent chacune un point. L’appel JSON passe à partir de 2 réponses valides sur 3."
      actions={<Button size="sm" variant="secondary" icon={<Sparkles className="w-3.5 h-3.5" />} loading={busy} onClick={() => void run()}>Calibrer le modèle</Button>}
    >
      {error != null && <ErrorBox error={error} />}
      {!profile && <p className="text-[12px] text-muted">Ce modèle n’a pas encore été calibré. Le résultat sera conservé pour ce fichier GGUF.</p>}
      {profile && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <Badge tone={profile.strategy === 'autonomous' ? 'good' : profile.strategy === 'hybrid' ? 'warn' : 'info'}>{strategyLabel[profile.strategy]}</Badge>
            <span className="text-fg">Score {profile.score.passed}/{profile.score.total} ({profile.score.percent} %)</span>
            <span className="text-faint">Calibré le {new Date(profile.calibratedAt).toLocaleString()}</span>
            {profile.strategy === 'autonomous'
              ? <span className="text-muted">Préférences d’outils de l’agent conservées.</span>
              : <span className="text-muted">Schémas compacts et sélection automatique d’outils appliqués à ce modèle.</span>}
          </div>
          {runtimeMatches === false && (
            <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-[11.5px] text-warn">
              Profil périmé ou ancien : il n’est pas appliqué aux tâches. Recalibrez avec le runtime actuellement chargé.
            </div>
          )}
          {profile.runtime && <p className="text-[10.5px] text-faint">Configuration mesurée : {runtimeLabel(profile.runtime)}</p>}
          {saved.data?.runtime && runtimeMatches === false && <p className="text-[10.5px] text-faint">Runtime courant : {runtimeLabel(saved.data.runtime)}</p>}
          {!profile.runtime && saved.data?.runtimeMatches === false && !latestForModel && <p className="text-[10.5px] text-faint">Ce profil ancien ne contient pas la configuration utilisée ; recalibrez-le pour pouvoir le réutiliser.</p>}
          <div className="grid md:grid-cols-3 gap-2">
            {Object.entries(profile.checks).map(([key, check]) => (
              <div key={key} className="rounded-md border border-line bg-sunk px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] text-fg">{labels[key] ?? key}</span>
                  <Badge tone={check.status === 'passed' ? 'good' : check.status === 'unsupported' ? 'neutral' : 'warn'}>{check.status === 'passed' ? 'Réussi' : check.status === 'unsupported' ? 'Non pris en charge' : 'Échec'}</Badge>
                </div>
                <p className="mt-1 text-[11px] text-faint">{check.summary}{check.durationMs ? ` · ${fmtMs(check.durationMs)}` : ''}</p>
                {key === 'toolCalling' && check.attempts !== undefined && <p className="mt-1 text-[10px] text-muted">{check.passedAttempts ?? 0}/{check.attempts} essais valides ; 2 sont requis pour le point.</p>}
                {check.outputPreview && <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded bg-panel px-1.5 py-1 text-[10px] text-muted">Sortie observée : {check.outputPreview}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
