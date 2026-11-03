import { useEffect, useMemo, useState } from 'react';
import { Download, Play, Trash2 } from 'lucide-react';
import { rollingRate } from '@mazz/shared';
import { api, errorMessage } from '../../lib/api';
import type { BenchmarkResult, SystemMetrics, TelemetryRecord } from '../../lib/types';
import { setState, toast, useApp } from '../../lib/store';
import { allRuns, useRunsVersion } from '../../lib/agentRuns';
import { basename, fmtBytes, fmtDate, fmtInt, fmtMs, fmtNum, fmtRate, fmtTime, SOURCE_LABEL } from '../../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBox, Field, Input, Notice, Page, PageHeader, Select, Stat, Tabs, useAsync } from '../../components/ui';
import { LineChart, Meter, Sparkline } from '../../components/charts';

type Tab = 'live' | 'history' | 'benchmarks' | 'method';

// System samples collected while the app is open (kept across page switches, capped).
const samples: SystemMetrics[] = [];

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toCsv(rows: TelemetryRecord[]): string {
  const cols = ['endedAt', 'kind', 'providerId', 'modelId', 'locality', 'tgTokS', 'ppTokS', 'ttftMs', 'e2eMs', 'promptTokens', 'completionTokens', 'speedSource', 'tokenSource', 'stopReason', 'partial'] as const;
  const esc = (v: unknown) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(c === 'endedAt' ? new Date(r.endedAt).toISOString() : r[c])).join(','))].join('\n');
}

function LiveTab() {
  useRunsVersion();
  const metrics = useApp((s) => s.metrics);
  const llama = useApp((s) => s.llama);
  const settings = useApp((s) => s.settings);
  const [, setTick] = useState(0);
  const [now, setNow] = useState(Date.now());
  const run = allRuns().find((r) => r.status === 'running');

  useEffect(() => {
    if (metrics && samples[samples.length - 1]?.sampledAt !== metrics.sampledAt) {
      samples.push(metrics);
      if (samples.length > 240) samples.shift();
      setTick((t) => t + 1);
    }
  }, [metrics]);
  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [run]);

  const windowMs = (settings?.performance.rollingWindowSec ?? 3) * 1000;
  const live = run ? rollingRate(run.tokenTimes, windowMs, now) : undefined;
  const lastTel = run?.telemetry[run.telemetry.length - 1];
  const memUsed = metrics ? metrics.memory.totalBytes - metrics.memory.availableBytes : undefined;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Génération en cours" value={run ? fmtRate(live) : 'Aucune génération'} hint={run ? `fenêtre glissante ${windowMs / 1000} s, estimation` : 'lancez une tâche ou un test'} tone="brand" />
        <Stat label="Dernier tg mesuré (runtime)" value={fmtRate(lastTel?.tgTokS)} hint={lastTel ? SOURCE_LABEL[lastTel.speedSource] : 'N/D'} />
        <Stat label="CPU (tous cœurs)" value={metrics?.cpu.usagePercent !== undefined ? `${metrics.cpu.usagePercent.toFixed(0)} %` : 'N/D'} hint={metrics ? `${metrics.cpu.logicalCores} threads - ${metrics.cpu.model.replace(/\(R\)|\(TM\)|CPU/g, '').trim()}` : undefined} />
        <Stat label="llama-server (working set)" value={fmtBytes(metrics?.llamaServer?.workingSetBytes)} hint={llama?.state === 'ready' ? basename(llama.modelPath ?? '') : 'arrêté'} />
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Mémoire">
          <div className="space-y-3">
            <Meter label="RAM système utilisée" value={memUsed} max={metrics?.memory.totalBytes} detail={metrics ? `${fmtBytes(memUsed)} / ${fmtBytes(metrics.memory.totalBytes)}` : undefined} />
            <Meter label="Part de llama-server" value={metrics?.llamaServer?.workingSetBytes} max={metrics?.memory.totalBytes} detail={fmtBytes(metrics?.llamaServer?.workingSetBytes)} tone="good" />
            <div className="grid grid-cols-2 gap-2 text-[12px] text-muted">
              <div>Serveur Studio (RSS) : {fmtBytes(metrics?.studio.rssBytes)}</div>
              <div>Disponible : {fmtBytes(metrics?.memory.availableBytes)}</div>
            </div>
            <Sparkline values={samples.map((s) => (s.memory.totalBytes - s.memory.availableBytes) / 1073741824)} width={420} height={40} label="RAM utilisée (Go)" />
          </div>
        </Card>
        <Card title="Processeur et GPU">
          <div className="space-y-3">
            <Sparkline values={samples.map((s) => s.cpu.usagePercent)} width={420} height={40} label="Utilisation CPU (%)" color="var(--leaf)" />
            <p className="text-[12px] text-muted">Échantillonnage toutes les {settings?.performance.metricsIntervalSec ?? 3} s, mis en pause quand l’onglet est masqué. {samples.length} échantillon(s) depuis l’ouverture.</p>
            <p className="text-[12px] text-muted">
              GPU détecté : {metrics?.gpu.detected.map((g) => g.name).join(', ') || 'aucun'}. Aucune jauge VRAM ni charge GPU n’est affichée : le pilote ne fournit pas de télémétrie fiable pour ce GPU et le build llama.cpp actif calcule sur CPU.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function HistoryTab() {
  const [kind, setKind] = useState('all');
  const [nonce, setNonce] = useState(0);
  const runs = useAsync((signal) => api.get<{ runs: TelemetryRecord[] }>(`/api/telemetry/runs?limit=500${kind !== 'all' ? `&kind=${kind}` : ''}`, signal), [kind, nonce]);
  const [model, setModel] = useState('all');
  const [confirm, setConfirm] = useState(false);
  const data = useMemo(() => (runs.data?.runs ?? []).filter((r) => model === 'all' || r.modelId === model), [runs.data, model]);
  const models = useMemo(() => Array.from(new Set(runs.data?.runs.map((r) => r.modelId) ?? [])), [runs.data]);
  const measured = data.filter((r) => r.speedSource !== 'synthetic');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="all">Toutes les mesures</option>
          <option value="agent">Tâches agent</option>
          <option value="inference_test">Tests d’inférence</option>
          <option value="benchmark">Benchmarks</option>
        </Select>
        <Select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Modèle">
          <option value="all">Tous les modèles</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {basename(m)}
            </option>
          ))}
        </Select>
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={<Download className="w-3.5 h-3.5" />} disabled={!data.length} onClick={() => download('mazz-telemetrie.json', JSON.stringify(data, null, 2), 'application/json')}>
            JSON
          </Button>
          <Button size="sm" icon={<Download className="w-3.5 h-3.5" />} disabled={!data.length} onClick={() => download('mazz-telemetrie.csv', toCsv(data), 'text/csv')}>
            CSV
          </Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={!data.length} onClick={() => setConfirm(true)}>
            Effacer
          </Button>
        </div>
      </div>
      {runs.error != null && <ErrorBox error={runs.error} onRetry={runs.reload} />}
      <Card title="Débits par appel de modèle" subtitle="Chaque point est un appel mesuré. Les appels du moteur de test sont exclus.">
        <LineChart
          label="Débits de génération et de traitement du prompt"
          yLabel="tok/s"
          xFormat={(x) => fmtTime(x)}
          series={[
            { name: 'tg (génération)', color: 'var(--brand)', points: measured.map((r) => ({ x: r.endedAt, y: r.tgTokS })) },
            { name: 'pp (prompt)', color: 'var(--leaf)', points: measured.map((r) => ({ x: r.endedAt, y: r.ppTokS })) },
          ]}
        />
      </Card>
      <Card padded={false}>
        {data.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Aucune mesure">Les mesures apparaissent après une tâche agent, un test d’inférence ou un benchmark.</EmptyState>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[460px]">
            <table className="w-full text-[12px]">
              <thead className="text-left text-faint bg-sunk sticky top-0">
                <tr>
                  <th className="px-3 py-2 font-medium">Heure</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Modèle</th>
                  <th className="px-3 py-2 font-medium">tg</th>
                  <th className="px-3 py-2 font-medium">pp</th>
                  <th className="px-3 py-2 font-medium">TTFT</th>
                  <th className="px-3 py-2 font-medium">Durée</th>
                  <th className="px-3 py-2 font-medium">Jetons</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {[...data].reverse().map((r) => (
                  <tr key={r.id} title={r.notes.join('\n')}>
                    <td className="px-3 py-1.5 text-faint tabular">{fmtDate(r.endedAt)}</td>
                    <td className="px-3 py-1.5 text-muted">{r.kind === 'agent' ? 'agent' : r.kind === 'benchmark' ? 'bench' : 'test'}</td>
                    <td className="px-3 py-1.5 font-mono truncate max-w-[200px]">{basename(r.modelId)}</td>
                    <td className="px-3 py-1.5 tabular">{r.speedSource === 'synthetic' ? '-' : fmtRate(r.tgTokS)}</td>
                    <td className="px-3 py-1.5 tabular">{fmtRate(r.ppTokS)}</td>
                    <td className="px-3 py-1.5 tabular">{fmtMs(r.ttftMs)}</td>
                    <td className="px-3 py-1.5 tabular">{fmtMs(r.e2eMs)}</td>
                    <td className="px-3 py-1.5 tabular">
                      {fmtInt(r.promptTokens)} / {fmtInt(r.completionTokens)}
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge tone={r.speedSource === 'runtime_timings' ? 'good' : r.speedSource === 'synthetic' ? 'warn' : 'neutral'}>{r.speedSource === 'runtime_timings' ? 'runtime' : r.speedSource === 'client_estimate' ? 'estimation' : r.speedSource === 'synthetic' ? 'test' : 'N/D'}</Badge>
                      {r.partial && <Badge tone="warn" className="ml-1">partiel</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={confirm}
        danger
        title="Effacer l’historique des mesures ?"
        confirmLabel="Effacer"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          await api.del('/api/telemetry/runs');
          setNonce((n) => n + 1);
        }}
      >
        Toutes les mesures enregistrées seront supprimées. Les benchmarks sont conservés.
      </ConfirmDialog>
    </div>
  );
}

function BenchmarksTab() {
  const llama = useApp((s) => s.llama);
  const tasks = useApp((s) => s.tasks);
  const [promptTokens, setPromptTokens] = useState(256);
  const [nPredict, setNPredict] = useState(128);
  const [reps, setReps] = useState(3);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const results = useAsync((signal) => api.get<{ results: BenchmarkResult[] }>('/api/bench/results', signal), [nonce]);
  const [group, setGroup] = useState<string>('');
  const groups = useMemo(() => Array.from(new Set(results.data?.results.map((r) => r.methodologyKey) ?? [])), [results.data]);
  const comparable = (results.data?.results ?? []).filter((r) => r.methodologyKey === (group || groups[0]));
  const running = tasks.some((t) => !t.done);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<BenchmarkResult>('/api/bench/run', { promptTokens, nPredict, repetitions: reps });
      toast('good', 'Benchmark terminé', `tg ${fmtRate(r.meanTgTokS)} - pp ${fmtRate(r.meanPpTokS)}`);
      setGroup(r.methodologyKey);
      setNonce((n) => n + 1);
    } catch (e) {
      toast('bad', 'Benchmark impossible', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Nouveau benchmark llama.cpp" subtitle="Prompt de longueur fixe mesurée par le tokenizer du modèle, cache de prompt désactivé, température 0, fin de séquence ignorée pour générer exactement N jetons.">
        {llama?.state !== 'ready' ? (
          <p className="text-[12.5px] text-faint">Chargez un modèle dans le Model Hub pour lancer un benchmark.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Jetons de prompt">
              <Input type="number" value={promptTokens} min={16} max={4096} onChange={(e) => setPromptTokens(Number(e.target.value))} className="w-28" />
            </Field>
            <Field label="Jetons générés">
              <Input type="number" value={nPredict} min={8} max={2048} onChange={(e) => setNPredict(Number(e.target.value))} className="w-28" />
            </Field>
            <Field label="Répétitions">
              <Input type="number" value={reps} min={1} max={5} onChange={(e) => setReps(Number(e.target.value))} className="w-20" />
            </Field>
            <Button variant="primary" icon={<Play className="w-3.5 h-3.5" />} loading={busy} disabled={running} onClick={run} title={running ? 'Une tâche agent est en cours' : undefined}>
              Lancer
            </Button>
            <span className="text-[12px] text-muted">
              Modèle : <span className="font-mono">{basename(llama.modelPath ?? '')}</span> - contexte {llama.config?.contextSize} - {llama.config?.threads} threads
            </span>
          </div>
        )}
      </Card>
      {results.error != null && <ErrorBox error={results.error} />}
      {groups.length > 0 && (
        <Card title="Comparaison à méthodologie identique" subtitle="Seuls les résultats partageant le même modèle, contexte, threads, batch et tailles de prompt/génération sont comparés.">
          <div className="space-y-3">
            <Select value={group || groups[0]} onChange={(e) => setGroup(e.target.value)} aria-label="Méthodologie" className="max-w-full font-mono text-[11.5px]">
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
            <LineChart
              label="Benchmarks comparables"
              yLabel="tok/s"
              xFormat={(x) => fmtDate(x)}
              series={[
                { name: 'tg moyen', color: 'var(--brand)', points: [...comparable].reverse().map((r) => ({ x: r.createdAt, y: r.meanTgTokS })) },
                { name: 'pp moyen', color: 'var(--leaf)', points: [...comparable].reverse().map((r) => ({ x: r.createdAt, y: r.meanPpTokS })) },
              ]}
            />
          </div>
        </Card>
      )}
      <Card title="Résultats" padded={false}>
        {(results.data?.results.length ?? 0) === 0 ? (
          <div className="p-4">
            <EmptyState title="Aucun benchmark">Les résultats sont enregistrés localement avec leur méthodologie.</EmptyState>
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="text-left text-faint bg-sunk">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Modèle</th>
                <th className="px-3 py-2 font-medium">Config</th>
                <th className="px-3 py-2 font-medium">pp moyen</th>
                <th className="px-3 py-2 font-medium">tg moyen</th>
                <th className="px-3 py-2 font-medium">Essais (tg)</th>
                <th className="px-3 py-2 font-medium">RAM mesurée</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {results.data!.results.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-1.5 text-faint">{fmtDate(r.createdAt)}</td>
                  <td className="px-3 py-1.5 font-mono">{r.modelFile}</td>
                  <td className="px-3 py-1.5 text-muted">
                    ctx {r.contextSize} - t{r.threads} - pp{r.promptTokens} - tg{r.nPredict}
                  </td>
                  <td className="px-3 py-1.5 tabular">{fmtRate(r.meanPpTokS)}</td>
                  <td className="px-3 py-1.5 tabular font-semibold text-brand">{fmtRate(r.meanTgTokS)}</td>
                  <td className="px-3 py-1.5 tabular text-muted">{r.runs.map((x) => fmtNum(x.tgTokS, 1)).join(' / ')}</td>
                  <td className="px-3 py-1.5 tabular text-muted">{r.serverWorkingSetMb ? `${r.serverWorkingSetMb} Mo` : 'N/D'}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Button size="xs" variant="ghost" onClick={() => api.del(`/api/bench/results/${r.id}`).then(() => setNonce((n) => n + 1))}>
                      Supprimer
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Notice tone="info" title="Comparaison llama.cpp / MUCE">
        Aucune comparaison n’est proposée : le manifeste MUCE déclare l’accélération générative non prise en charge. Elle sera activée lorsqu’un runtime MUCE pourra générer à paramètres identiques.
      </Notice>
    </div>
  );
}

function MethodTab() {
  const rows = [
    ['tg_tok_s (génération)', 'Jetons de sortie / temps de décodage. Source prioritaire : predicted_per_second de llama.cpp (le premier jeton, issu du prefill, est exclu). À défaut : jetons déclarés par le fournisseur, divisés par la durée entre le premier et le dernier fragment reçu (n - 1 intervalles) : estimation qui inclut le réseau.'],
    ['pp_tok_s (prompt)', 'Jetons d’entrée / temps de prefill, uniquement depuis les timings du runtime local. Jamais calculé pour une API (non mesurable de l’extérieur).'],
    ['TTFT', 'Délai entre l’envoi de la requête par le Studio et la réception du premier fragment de sortie.'],
    ['Débit live', 'Fenêtre glissante sur les horodatages des fragments reçus. Libellé « estimation » : un fragment n’est pas toujours un jeton. Remplacé par la mesure runtime à la fin de l’appel.'],
    ['Mémoire', 'Working set du processus llama-server (tasklist) distinct de la RAM système (GlobalMemoryStatusEx via Node). Les estimations du Model Hub sont calculées depuis l’en-tête GGUF et étiquetées comme telles.'],
    ['Moteur de test', 'Aucun chiffre de vitesse n’est produit : les enregistrements portent la source « synthetic ».'],
    ['Embeddings', 'Débit d’encodage non mesuré dans cette version : aucune valeur n’est affichée.'],
  ];
  return (
    <Card title="Sources et méthode de calcul">
      <dl className="space-y-3">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[13px] font-medium text-fg font-mono">{k}</dt>
            <dd className="text-[12.5px] text-muted mt-0.5 leading-relaxed">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] text-faint mt-4">Spécification complète : docs/TELEMETRY_SPEC.md.</p>
    </Card>
  );
}

export default function PerformanceView() {
  const viewParam = useApp((s) => s.viewParam);
  const [tab, setTab] = useState<Tab>(viewParam === 'benchmarks' ? 'benchmarks' : 'live');
  useEffect(() => {
    if (viewParam === 'benchmarks') setTab('benchmarks');
  }, [viewParam]);
  return (
    <Page wide>
      <PageHeader
        title="Performance"
        subtitle="Mesures réelles du moteur et de la machine, avec leur provenance. Une valeur absente s’affiche N/D, jamais 0."
        icon="monitor"
        actions={
          <Button size="sm" variant="ghost" onClick={() => setState({ bottomOpen: true, bottomTab: 'logs' })}>
            Journal llama-server
          </Button>
        }
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'live', label: 'Temps réel' },
          { id: 'history', label: 'Historique' },
          { id: 'benchmarks', label: 'Benchmarks' },
          { id: 'method', label: 'Diagnostic des sources' },
        ]}
      />
      {tab === 'live' && <LiveTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'benchmarks' && <BenchmarksTab />}
      {tab === 'method' && <MethodTab />}
    </Page>
  );
}
