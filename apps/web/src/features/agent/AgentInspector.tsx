import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, FileDiff, History, ListChecks, RotateCcw, Wrench, XCircle } from 'lucide-react';
import type { AgentEvent, InferenceTelemetry } from '@mazz/shared';
import { contextUsage, rollingRate } from '@mazz/shared';
import { useApp, navigate, toast } from '../../lib/store';
import { getRun, useRunsVersion } from '../../lib/agentRuns';
import { useSession } from './useSession';
import { api } from '../../lib/api';
import { fmtInt, fmtMs, fmtRate, fmtTime, SOURCE_LABEL, ND } from '../../lib/format';
import { Badge, Button, ConfirmDialog, EmptyState, Stat, Tabs } from '../../components/ui';
import { Meter, Sparkline } from '../../components/charts';
import type { CheckpointSummary } from '../../lib/types';
import { PromptRequirementsPanel } from './PromptRequirementsPanel';

/** Above this share of the window the model starts losing early turns (spec 02). */
export const CONTEXT_ALERT_PCT = 75;

type Tab = 'context' | 'activity' | 'files' | 'metrics' | 'checkpoints' | 'requirements';

export default function AgentInspector() {
  useRunsVersion();
  const sessionId = useApp((s) => s.activeSessionId);
  const llama = useApp((s) => s.llama);
  const settings = useApp((s) => s.settings);
  const { session } = useSession(sessionId);
  const run = getRun(sessionId);
  const [tab, setTab] = useState<Tab>('context');
  const [now, setNow] = useState(Date.now());
  const live = run?.status === 'running';
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [live]);

  const events: AgentEvent[] = useMemo(() => {
    const persisted = (session?.turns ?? []).filter((t) => !(run && t.taskId === run.taskId)).flatMap((t) => t.events);
    return [...persisted, ...(run?.events ?? [])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, run, run?.version]);

  const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  const diffs = events.filter((e): e is Extract<AgentEvent, { type: 'diff' }> => e.type === 'diff');
  const telemetry: InferenceTelemetry[] = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage' && !!e.telemetry).map((e) => e.telemetry!);
  const last = telemetry[telemetry.length - 1];
  const windowMs = (settings?.performance.rollingWindowSec ?? 3) * 1000;
  const liveRate = live && run ? rollingRate(run.tokenTimes, windowMs, now) : undefined;
  const toolMs = tools.reduce((a, t) => a + t.durationMs, 0);
  const snapshots=events.filter((e):e is Extract<AgentEvent,{type:'status'}>=>e.type==='status' && !!e.contextSnapshot);
  const sources=events.filter((e):e is Extract<AgentEvent,{type:'status'}>=>e.type==='status' && !!e.sourceEvidence);

  // Context: last prompt size versus the runtime window (llama-server n_ctx) when local.
  const ctxLimit = last?.providerId === 'llama-local' ? llama?.config?.contextSize : undefined;
  const ctxUsed = last ? (last.promptTokens ?? 0) + (last.completionTokens ?? 0) : undefined;
  const ctxPct = contextUsage(ctxUsed, ctxLimit);

  if (!sessionId) {
    return (
      <div className="p-4">
        <EmptyState title="Aucune session sélectionnée" decorative={false}>
          L’inspecteur affiche les outils appelés, les fichiers modifiés, les mesures et les points de restauration de la session active.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <Tabs<Tab>
        className="px-2 shrink-0"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'context', label: 'Contexte' },
          { id: 'activity', label: 'Activité', count: tools.length },
          { id: 'files', label: 'Fichiers', count: diffs.length },
          { id: 'metrics', label: 'Mesures' },
          { id: 'checkpoints', label: 'Restauration' },
          { id: 'requirements', label: <><ListChecks className="w-3.5 h-3.5" />Exigences</> },
        ]}
      />
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === 'activity' && (
          <>
            {run && (
              <div className="text-[12px] text-muted">{run.stage}</div>
            )}
            {tools.length === 0 && <p className="text-[12px] text-faint">Aucun outil appelé dans cette session.</p>}
            <ol className="space-y-1">
              {tools.map((t, i) => (
                <li key={`${t.callId}${i}`} className="flex items-center gap-2 text-[12px]">
                  {t.success ? <CheckCircle2 className="w-3.5 h-3.5 text-good shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-bad shrink-0" />}
                  <Wrench className="w-3 h-3 text-faint shrink-0" />
                  <span className="font-mono text-fg truncate">{t.toolName}</span>
                  <span className="ml-auto text-faint tabular shrink-0">{fmtMs(t.durationMs)}</span>
                </li>
              ))}
            </ol>
            {tools.length > 0 && <div className="text-[11.5px] text-faint">Temps total dans les outils : {fmtMs(toolMs)}</div>}
          </>
        )}

        {tab === 'files' && (
          <>
            {diffs.length === 0 && <p className="text-[12px] text-faint">Aucun fichier modifié par l’agent.</p>}
            {Array.from(new Map(diffs.map((d) => [d.filePath, d])).values()).map((d) => (
              <button key={d.filePath} type="button" onClick={() => navigate('code', d.filePath)} className="w-full flex items-center gap-2 text-left text-[12px] hover:bg-raised rounded px-1.5 py-1 cursor-pointer">
                <FileDiff className="w-3.5 h-3.5 text-leaf shrink-0" />
                <span className="font-mono truncate flex-1">{d.filePath}</span>
                <Badge tone={d.oldContent === null ? 'good' : 'info'}>{d.oldContent === null ? 'A' : 'M'}</Badge>
              </button>
            ))}
          </>
        )}

        {tab === 'metrics' && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Génération (tg)" value={live ? fmtRate(liveRate) : fmtRate(last?.tgTokS)} hint={live ? 'glissant, estimation' : last ? SOURCE_LABEL[last.speedSource] : ND} />
              <Stat label="Prompt (pp)" value={fmtRate(last?.ppTokS)} hint={last?.locality === 'remote' ? 'non mesurable en API' : last ? SOURCE_LABEL[last.tokenSource] : ND} />
              <Stat label="TTFT" value={fmtMs(last?.ttftMs)} />
              <Stat label="Durée totale" value={fmtMs(last?.e2eMs)} />
              <Stat label="Jetons d’entrée" value={fmtInt(last?.promptTokens)} />
              <Stat label="Jetons de sortie" value={fmtInt(last?.completionTokens)} />
            </div>
            <div>
              <div className="text-[11.5px] text-faint mb-1">tg par appel de modèle (session)</div>
              <Sparkline values={telemetry.map((t) => t.tgTokS)} width={300} height={36} label="Débit de génération par appel" />
            </div>
            {last && (
              <div className="text-[11.5px] text-faint space-y-0.5">
                <div>Source : {SOURCE_LABEL[last.speedSource]}</div>
                <div>Modèle : {last.modelId}</div>
                <div>Horodatage : {fmtTime(last.endedAt)}</div>
                {last.notes.map((n) => (
                  <div key={n}>{n}</div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'context' && (
          <>
            <Meter label="Fenêtre de contexte (dernier appel)" value={ctxUsed} max={ctxLimit ?? 1} detail={ctxLimit ? `${fmtInt(ctxUsed)} / ${fmtInt(ctxLimit)} jetons` : 'Limite inconnue'} />
            <p className="text-[11.5px] text-faint leading-relaxed">
              {ctxLimit
                ? `Limite issue de la configuration de llama-server (--ctx-size). ${ctxPct !== undefined && ctxPct >= CONTEXT_ALERT_PCT ? 'La fenêtre est presque pleine : démarrez une nouvelle session ou augmentez le contexte.' : ''}`
                : 'La limite de contexte n’est connue que pour le moteur local ; les fournisseurs API ne la communiquent pas dans les réponses.'}
            </p>
            <p className="text-[11.5px] text-faint">Les captures suivantes contiennent les messages textuels et schémas d’outils envoyés lors des appels. Les images binaires ne sont pas copiées dans cette vue.</p>
            {sources.at(-1)?.sourceEvidence?.map((source,i)=><details key={`${source.path}:${i}`} className="text-[11.5px] border border-line rounded p-2"><summary className="break-all cursor-pointer">[{i+1}] {source.path}:{source.line}</summary><p className="text-faint">{source.status} · SHA-256 {source.sha256 || 'non disponible'}</p><pre className="whitespace-pre-wrap break-words max-h-64 overflow-auto">{source.body}</pre></details>)}
            {snapshots.map((snapshot,i)=><details key={`${snapshot.timestamp}:${i}`} className="text-[11.5px] border border-line rounded p-2"><summary className="cursor-pointer">Appel {i+1} · {snapshot.contextSnapshot?.modelId} · {fmtTime(snapshot.timestamp)}</summary><pre className="whitespace-pre-wrap break-words max-h-96 overflow-auto">{JSON.stringify(snapshot.contextSnapshot,null,2)}</pre></details>)}
          </>
        )}

        {tab === 'checkpoints' && <CheckpointList sessionTaskIds={new Set((session?.turns ?? []).map((t) => t.taskId))} />}
        {tab === 'requirements' && sessionId && <PromptRequirementsPanel key={sessionId} sessionId={sessionId} workspaceRoot={session?.projectRoot} />}
      </div>
    </div>
  );
}

function CheckpointList({ sessionTaskIds }: { sessionTaskIds: Set<string> }) {
  const [items, setItems] = useState<CheckpointSummary[] | null>(null);
  const [confirm, setConfirm] = useState<CheckpointSummary | null>(null);
  const load = () =>
    api
      .get<{ checkpoints: CheckpointSummary[] }>('/api/checkpoints')
      .then((r) => setItems(r.checkpoints))
      .catch(() => setItems([]));
  useEffect(() => {
    void load();
  }, []);
  if (!items) return <p className="text-[12px] text-faint">Chargement</p>;
  const mine = items.filter((c) => [...sessionTaskIds].some((id) => c.id === `chk_${id}`));
  const others = items.filter((c) => !mine.includes(c));
  const row = (c: CheckpointSummary) => (
    <li key={c.id} className="p-2 rounded-md border border-line bg-sunk space-y-1">
      <div className="flex items-center gap-2 text-[12px]">
        <History className="w-3.5 h-3.5 text-brand shrink-0" />
        <span className="truncate flex-1 text-fg">{c.description}</span>
        <Button size="xs" variant="ghost" icon={<RotateCcw className="w-3 h-3" />} onClick={() => setConfirm(c)}>
          Restaurer
        </Button>
      </div>
      <div className="text-[11px] text-faint">
        {fmtTime(c.timestamp)} - {c.fileCount} fichier(s) : {c.files.slice(0, 4).join(', ')}
        {c.files.length > 4 ? '...' : ''}
      </div>
    </li>
  );
  return (
    <>
      <div className="text-[11.5px] text-faint">Cette session</div>
      {mine.length === 0 ? <p className="text-[12px] text-faint">Aucun point de restauration pour cette session.</p> : <ul className="space-y-1.5">{mine.map(row)}</ul>}
      {others.length > 0 && (
        <>
          <div className="text-[11.5px] text-faint pt-2">Autres (éditeur, autres sessions)</div>
          <ul className="space-y-1.5">{others.slice(0, 10).map(row)}</ul>
        </>
      )}
      <ConfirmDialog
        open={!!confirm}
        danger
        title="Restaurer ce point ?"
        confirmLabel="Restaurer"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const r = await api.post<{ success: boolean; restoredFiles: string[]; errors: string[] }>(`/api/checkpoints/${encodeURIComponent(confirm!.id)}/rollback`);
          if (!r.success) throw new Error(r.errors.join('\n'));
          toast('good', 'Restauration effectuée', r.restoredFiles.join(', '));
          void load();
        }}
      >
        Les {confirm?.fileCount} fichier(s) reprennent leur état capturé à {confirm ? fmtTime(confirm.timestamp) : ''}. Les fichiers créés après ce point sont supprimés.
      </ConfirmDialog>
    </>
  );
}
