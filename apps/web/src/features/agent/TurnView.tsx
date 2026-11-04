import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { align, useGerminate } from '../../motion/motion';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Copy,
  FileDiff,
  FileText,
  History,
  PencilLine,
  RefreshCw,
  RotateCcw,
  ListChecks,
  Circle,
  MessageCircleQuestion,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { StatusIndicator, toolIndicatorKind } from './StatusIndicators';
import { groupOrchestration } from './orchestration';
import type { AgentEvent, ApprovalRequestEvent, ForgeEvent, InferenceTelemetry, PlanItem } from '@mazz/shared';
import { Markdown } from '../../components/Markdown';
import { DiffView } from '../../components/DiffView';
import { diffLines, diffStats } from '../../lib/diff';
import { Badge, Button, ConfirmDialog, IconButton, Spinner, cx } from '../../components/ui';
import { fmtMs, fmtRate, fmtInt, fmtTime, redactSecrets, SOURCE_LABEL } from '../../lib/format';
import { api, errorMessage } from '../../lib/api';
import { navigate, toast } from '../../lib/store';
import type { AttachmentMeta } from '../../lib/types';
import { AttachmentChip, AttachmentTextDialog } from './attachments';
import { ApprovalCard, type ApprovalAnswerFn } from './ApprovalCard';
import { ForgeBoard } from './ForgeBoard';
import { Model3DViewer, model3dUrl } from '../artifacts/Model3DViewer';

type Segment =
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thought'; text: string }
  | { kind: 'status'; message: string; t: number }
  | { kind: 'tool'; start: Extract<AgentEvent, { type: 'tool_start' }>; result?: Extract<AgentEvent, { type: 'tool_result' }> }
  | { kind: 'diff'; ev: Extract<AgentEvent, { type: 'diff' }> }
  | { kind: 'checkpoint'; ev: Extract<AgentEvent, { type: 'checkpoint' }> }
  | { kind: 'approval'; ev: ApprovalRequestEvent; result?: Extract<AgentEvent, { type: 'approval_result' }> }
  | { kind: 'plan'; ev: Extract<AgentEvent, { type: 'plan' }> }
  | { kind: 'question'; ev: Extract<AgentEvent, { type: 'question' }>; result?: Extract<AgentEvent, { type: 'question_result' }> }
  | { kind: 'forge'; events: ForgeEvent[] }
  | { kind: 'agent'; start: Extract<AgentEvent, { type: 'tool_start' }>; result?: Extract<AgentEvent, { type: 'tool_result' }>; events: AgentEvent[] }
  | { kind: 'usage'; t: InferenceTelemetry }
  | { kind: 'error'; ev: Extract<AgentEvent, { type: 'error' }> }
  | { kind: 'complete'; ev: Extract<AgentEvent, { type: 'complete' }> };

/** Extracts inline <think>...</think> blocks from streamed text so they appear in the reasoning card. */
function splitInlineThink(raw: string): { thoughts: string[]; cleanText: string; thinkingStreaming: boolean } {
  const thoughts: string[] = [];
  let working = raw;
  const closedRe = /<think>([\s\S]*?)<\/think>/gi;
  working = working.replace(closedRe, (_m, inner: string) => {
    if (inner.trim()) thoughts.push(inner.trim());
    return '';
  });
  let thinkingStreaming = false;
  const openIdx = working.toLowerCase().lastIndexOf('<think>');
  if (openIdx !== -1) {
    const partial = working.slice(openIdx + 7).trim();
    if (partial) thoughts.push(partial);
    working = working.slice(0, openIdx);
    thinkingStreaming = true;
  }
  return { thoughts, cleanText: working.trimStart(), thinkingStreaming };
}

/** Groups the flat event stream into display segments (tool start/result pairs, text runs). */
export function segmentEvents(events: AgentEvent[], live: boolean): Segment[] {
  const out: Segment[] = [];
  const tools = new Map<string, Extract<Segment, { kind: 'tool' }>>();
  const approvals = new Map<string, Extract<Segment, { kind: 'approval' }>>();
  const questions = new Map<string, Extract<Segment, { kind: 'question' }>>();
  let plan: Extract<Segment, { kind: 'plan' }> | undefined;
  let forge: Extract<Segment, { kind: 'forge' }> | undefined;
  const subAgents = new Map<string, Extract<Segment, { kind: 'agent' }>>();
  let openAgent: Extract<Segment, { kind: 'agent' }> | undefined;
  for (const ev of events) {
    // A specialist's own tool calls, statuses and usage live inside its card; approvals, diffs,
    // questions and errors stay in the main flow, where they can be acted on.
    if (ev.agent && openAgent && (ev.type === 'tool_start' || ev.type === 'tool_result' || ev.type === 'status' || ev.type === 'usage')) {
      openAgent.events.push(ev);
      continue;
    }
    if (ev.type === 'tool_start' && ev.toolName === 'agent.delegate') {
      openAgent = { kind: 'agent', start: ev, events: [] };
      subAgents.set(ev.callId, openAgent);
      out.push(openAgent);
      continue;
    }
    if (ev.type === 'tool_result' && ev.toolName === 'agent.delegate' && subAgents.has(ev.callId)) {
      subAgents.get(ev.callId)!.result = ev;
      if (openAgent?.start.callId === ev.callId) openAgent = undefined;
      continue;
    }
    switch (ev.type) {
      case 'token': {
        const last = out[out.length - 1];
        if (last?.kind === 'text') last.text += ev.delta;
        else out.push({ kind: 'text', text: ev.delta, streaming: false });
        break;
      }
      case 'thought': {
        const last = out[out.length - 1];
        if (last?.kind === 'thought') last.text += ev.delta;
        else out.push({ kind: 'thought', text: ev.delta });
        break;
      }
      case 'status':
        out.push({ kind: 'status', message: ev.message, t: ev.timestamp });
        break;
      case 'tool_start': {
        const seg = { kind: 'tool' as const, start: ev };
        tools.set(ev.callId, seg);
        out.push(seg);
        break;
      }
      case 'tool_result': {
        const seg = tools.get(ev.callId);
        if (seg) seg.result = ev;
        else out.push({ kind: 'tool', start: { type: 'tool_start', taskId: ev.taskId, timestamp: ev.timestamp, toolName: ev.toolName, callId: ev.callId, params: {} }, result: ev });
        break;
      }
      case 'diff':
        out.push({ kind: 'diff', ev });
        break;
      case 'checkpoint':
        out.push({ kind: 'checkpoint', ev });
        break;
      case 'approval_request': {
        const seg = { kind: 'approval' as const, ev };
        approvals.set(ev.callId, seg);
        out.push(seg);
        break;
      }
      case 'approval_result': {
        const seg = approvals.get(ev.callId);
        if (seg) seg.result = ev;
        else if (ev.decidedBy === 'policy') out.push({ kind: 'status', message: `${ev.toolName} refusé par la politique de permissions.`, t: ev.timestamp });
        break;
      }
      case 'forge':
        // One Forge board per exchange; it already shows the units, so its plan list is not repeated.
        if (forge) forge.events.push(ev);
        else {
          forge = { kind: 'forge', events: [ev] };
          out.push(forge);
        }
        break;
      case 'plan':
        // One task list per exchange, kept where it first appeared and updated in place.
        if (forge) break;
        if (plan) plan.ev = ev;
        else {
          plan = { kind: 'plan', ev };
          out.push(plan);
        }
        break;
      case 'question': {
        const seg = { kind: 'question' as const, ev };
        questions.set(ev.callId, seg);
        out.push(seg);
        break;
      }
      case 'question_result': {
        const seg = questions.get(ev.callId);
        if (seg) seg.result = ev;
        break;
      }
      case 'usage':
        if (ev.telemetry) out.push({ kind: 'usage', t: ev.telemetry });
        break;
      case 'error':
        out.push({ kind: 'error', ev });
        break;
      case 'complete':
        out.push({ kind: 'complete', ev });
        break;
      default:
        break;
    }
  }
  if (live) {
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.streaming = true;
  }
  return out;
}

type ToolSeg = Extract<Segment, { kind: 'tool' }>;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** One-line outcome of a finished tool call, shown while its card is closed. */
export function toolOutcome(result: ToolSeg['result']): string {
  if (!result) return '';
  if (!result.success) return (result.error ?? 'échec').split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? 'échec';
  const out = result.output as Record<string, unknown> | null | undefined;
  if (!out || typeof out !== 'object') return '';
  const lines = (s: string) => s.split('\n').filter((l) => l.trim()).length;
  const parts: string[] = [];
  if (typeof out.exitCode === 'number') parts.push(`code ${out.exitCode}`);
  if (typeof out.stdout === 'string' && out.stdout.trim()) parts.push(plural(lines(out.stdout), 'ligne', 'lignes'));
  else if (typeof out.content === 'string') parts.push(plural(lines(out.content), 'ligne', 'lignes'));
  else {
    const list = Object.values(out).find(Array.isArray) as unknown[] | undefined;
    if (list) parts.push(plural(list.length, 'résultat', 'résultats'));
  }
  return parts.join(' · ');
}

const TOOL_KIND: Array<[RegExp, string, string]> = [
  [/^(fs\.read|attachments\.read|terminal\.read)$/, 'lecture', 'lectures'],
  [/^(fs\.(list|search_text)|code\.|git\.status)/, 'recherche', 'recherches'],
  [/^fs\.(write|patch|delete)$/, 'modification', 'modifications'],
  [/^(terminal\.|compiler\.)/, 'commande', 'commandes'],
];

/** "3 lectures, 1 commande, 1 échec" for a run of consecutive tool calls. */
export function toolGroupLabel(tools: ToolSeg[]): string {
  const counts = new Map<string, { n: number; one: string; many: string }>();
  for (const t of tools) {
    const [, one, many] = TOOL_KIND.find(([re]) => re.test(t.start.toolName)) ?? [null, 'autre outil', 'autres outils'];
    const c = counts.get(one) ?? { n: 0, one, many };
    c.n++;
    counts.set(one, c);
  }
  const parts = [...counts.values()].map((c) => plural(c.n, c.one, c.many));
  const failed = tools.filter((t) => t.result && !t.result.success).length;
  if (failed) parts.push(plural(failed, 'échec', 'échecs'));
  return parts.join(', ');
}

function ToolGroup({ tools, usages }: { tools: ToolSeg[]; usages: InferenceTelemetry[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.find((t) => !t.result);
  const failed = tools.some((t) => t.result && !t.result.success);
  const total = tools.reduce((acc, t) => acc + (t.result?.durationMs ?? 0), 0);
  return (
    <div className={cx(
      'rounded-[var(--radius-md)] border transition-[border-color,background-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-soft-snap)] fade-up',
      running ? 'border-brand/50 bg-brand/[0.03] shadow-[0_0_12px_var(--glow)]' : 'border-line bg-sunk/60'
    )}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 h-8 text-left cursor-pointer">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-faint" />}
        <StatusIndicator kind={toolIndicatorKind((running ?? tools[tools.length - 1])?.start.toolName ?? '')} active={!!running} />
        <span className="text-[12px] text-fg truncate">{toolGroupLabel(tools)}</span>
        {running && <span className="truncate text-[12px] text-brand/90 font-mono flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-brand animate-ping" />{running.start.toolName}</span>}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {!running && <span className="text-[11px] text-faint tabular">{fmtMs(total)}</span>}
          {running ? (
            <div className="flex items-center gap-1.5 text-brand text-[11px] font-medium">
              <Spinner size={11} label="Exécution" />
              <span className="animate-pulse">en cours</span>
            </div>
          ) : failed ? (
            <XCircle className="w-3.5 h-3.5 text-warn" aria-label="Au moins un échec" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5 text-good" aria-label="Succès" />
          )}
        </span>
      </button>
      {open && (
        <div className="px-2 pb-2 pt-1 space-y-1.5 border-t border-line">
          {tools.map((t, i) => <ToolCard key={t.start.callId + i} seg={t} />)}
          {usages.map((u, i) => <TelemetryChip key={`u${i}`} t={u} />)}
        </div>
      )}
    </div>
  );
}

/** Delegated specialist: its task, live latest action, its own tool calls and its summary. */
function SubAgentCard({ seg, live }: { seg: Extract<Segment, { kind: 'agent' }>; live: boolean }) {
  const [open, setOpen] = useState(false);
  const params = seg.start.params as { label?: unknown; role?: unknown; task?: unknown };
  // The forwarded events carry the specialist's display label; the call itself only has its role.
  const label = seg.events.find((e) => e.agent)?.agent ?? String(params.label ?? params.role ?? 'Spécialiste');
  const task = String(params.task ?? '');
  const inner = segmentEvents(seg.events, false);
  const tools = inner.filter((s): s is ToolSeg => s.kind === 'tool');
  const running = live && !seg.result;
  const current = [...tools].reverse().find((t) => !t.result) ?? tools[tools.length - 1];
  const summary = (seg.result?.output as { summary?: unknown } | null | undefined)?.summary;
  return (
    <div className={cx('rounded-[var(--radius-md)] border bg-sunk/60 fade-up', running ? 'border-brand/40' : 'border-line')} aria-label={`Sous-agent ${label}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left cursor-pointer">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-faint shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-faint shrink-0" />}
        <Bot className="w-3.5 h-3.5 text-leaf shrink-0" />
        <span className="text-[12px] font-medium text-fg shrink-0">{label}</span>
        <span className="truncate text-[12px] text-muted">{running && current ? `${current.start.toolName} ${String((current.start.params as { path?: unknown }).path ?? '')}` : task}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-faint tabular">{tools.length ? `${tools.length} outil${tools.length > 1 ? 's' : ''}` : ''}</span>
          {seg.result && <span className="text-[11px] text-faint tabular">{fmtMs(seg.result.timestamp - seg.start.timestamp)}</span>}
          {running ? <Spinner size={11} label="Sous-agent en cours" /> : seg.result?.success ? <CheckCircle2 className="w-3.5 h-3.5 text-good" aria-label="Terminé" /> : <XCircle className="w-3.5 h-3.5 text-bad" aria-label="Échec ou interrompu" />}
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-2 space-y-2 border-t border-line">
          {task && <div className="text-[12px] text-muted whitespace-pre-wrap">{task}</div>}
          {tools.length > 0 && <div className="space-y-1.5">{tools.map((t, i) => <ToolCard key={t.start.callId + i} seg={t} />)}</div>}
          {typeof summary === 'string' && summary && (
            <div className="rounded border border-line bg-raised p-2">
              <div className="text-[11px] text-faint mb-1">Synthèse du spécialiste</div>
              <Markdown text={summary} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCard({ seg }: { seg: ToolSeg }) {
  const [open, setOpen] = useState(false);
  const { start, result } = seg;
  const outcome = toolOutcome(result);
  const args = redactSecrets(start.params) as Record<string, unknown>;
  const path = typeof args.path === 'string' ? args.path : undefined;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const output = result?.output as Record<string, unknown> | null | undefined;
  const stdout = typeof output?.stdout === 'string' ? output.stdout : undefined;
  const stderr = typeof output?.stderr === 'string' ? output.stderr : undefined;
  const Icon = start.toolName.startsWith('terminal') || start.toolName.startsWith('compiler') ? Terminal : Wrench;
  const isRunning = !result;
  // Tool start: brief lock-in (ressort MICRO), only for a call seen live.
  const cardRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (isRunning && cardRef.current) align(cardRef.current);
    // Mount only: a finished call replayed from history does not move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div ref={cardRef} className={cx(
      'rounded-[var(--radius-md)] border transition-[border-color,background-color,box-shadow] duration-[var(--dur-base)] ease-[var(--ease-soft-snap)] fade-up',
      isRunning ? 'border-brand/50 bg-brand/[0.02] shadow-[0_0_8px_var(--glow)]' : 'border-line bg-sunk'
    )}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 h-8 text-left cursor-pointer">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-faint" />}
        <Icon className={cx('w-3.5 h-3.5 shrink-0 text-brand', isRunning && 'anim-tool-pulse')} />
        <span className="font-mono text-[12px] text-fg">{start.toolName}</span>
        <span className="truncate text-[12px] text-muted font-mono">{command ?? path ?? ''}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {result ? (
            <>
              {!open && outcome && <span className={cx('hidden sm:inline max-w-[260px] truncate text-[11px]', result.success ? 'text-faint' : 'text-bad')}>{outcome}</span>}
              <span className="text-[11px] text-faint tabular">{fmtMs(result.durationMs)}</span>
              {result.success ? <CheckCircle2 className="w-3.5 h-3.5 text-good" aria-label="Succès" /> : <XCircle className="w-3.5 h-3.5 text-bad" aria-label="Échec" />}
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-brand text-[11px] font-medium">
              <Spinner size={11} label="Exécution" />
              <span className="animate-pulse">en cours</span>
            </div>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t border-line pt-2">
          <div className="text-[11px] text-faint">
            Appel {start.callId} - {fmtTime(start.timestamp)}
          </div>
          <pre className="text-[11.5px] font-mono bg-code border border-line rounded p-2 overflow-x-auto max-h-48">{JSON.stringify(args, null, 2)}</pre>
          {result?.error && <pre className="text-[11.5px] font-mono text-bad whitespace-pre-wrap break-words">{result.error}</pre>}
          {stdout !== undefined && stdout !== '' && (
            <div>
              <div className="text-[11px] text-faint mb-1">stdout</div>
              <pre className="text-[11.5px] font-mono bg-code border border-line rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap">{stdout}</pre>
            </div>
          )}
          {stderr !== undefined && stderr !== '' && (
            <div>
              <div className="text-[11px] text-faint mb-1">stderr</div>
              <pre className="text-[11.5px] font-mono bg-code border border-bad/30 rounded p-2 overflow-auto max-h-60 whitespace-pre-wrap text-bad">{stderr}</pre>
            </div>
          )}
          {start.toolName === 'agent.delegate' && typeof (output as { summary?: unknown } | null | undefined)?.summary === 'string' && (
            <div className="rounded border border-line bg-raised p-2">
              <div className="text-[11px] text-faint mb-1">Synthèse du spécialiste</div>
              <Markdown text={String((output as { summary: string }).summary)} />
            </div>
          )}
          {start.toolName === 'extract_game_3d' && typeof (output as { glbPath?: unknown } | null | undefined)?.glbPath === 'string' && (
            <Model3DViewer
              src={model3dUrl(String((output as { glbPath: string }).glbPath))}
              label={String((output as { glbPath: string }).glbPath).split(/[\\/]/).pop() ?? 'modèle.glb'}
            />
          )}
          {output && stdout === undefined && start.toolName !== 'agent.delegate' && (
            <pre className="text-[11.5px] font-mono bg-code border border-line rounded p-2 overflow-auto max-h-60">{JSON.stringify(redactSecrets(output), null, 2).slice(0, 20000)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function DiffCard({ ev, onOpenFile, defaultOpen = true }: { ev: Extract<AgentEvent, { type: 'diff' }>; onOpenFile?: (p: string) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-[var(--radius-md)] border border-line fade-up">
      <div className="flex items-center gap-2 px-2.5 h-8 bg-sunk border-b border-line">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 cursor-pointer min-w-0">
          {open ? <ChevronDown className="w-3.5 h-3.5 text-faint" /> : <ChevronRight className="w-3.5 h-3.5 text-faint" />}
          <FileDiff className="w-3.5 h-3.5 text-leaf" />
          <span className="font-mono text-[12px] truncate">{ev.filePath}</span>
        </button>
        <Badge tone={ev.oldContent === null ? 'good' : 'info'}>{ev.oldContent === null ? 'Créé' : 'Modifié'}</Badge>
        {onOpenFile && (
          <Button size="xs" variant="ghost" className="ml-auto" onClick={() => onOpenFile(ev.filePath)}>
            Ouvrir
          </Button>
        )}
      </div>
      {open && <DiffView oldText={ev.oldContent} newText={ev.newContent} maxHeight={320} />}
    </div>
  );
}

/**
 * End-of-turn box, built from what actually happened (no model call): files
 * changed with line counts, commands and failures, and the follow-up actions.
 */
function TurnRecap({ events, onContinue }: { events: AgentEvent[]; onContinue?: (prompt: string) => void }) {
  const [confirm, setConfirm] = useState(false);
  const files = new Map<string, { add: number; del: number; created: boolean }>();
  for (const e of events) {
    if (e.type !== 'diff') continue;
    const cur = files.get(e.filePath) ?? { add: 0, del: 0, created: e.oldContent === null };
    // Counted from the contents: `patch` can be a short summary rather than a unified diff.
    const stats = diffStats(diffLines(e.oldContent, e.newContent));
    cur.add += stats.added;
    cur.del += stats.removed;
    files.set(e.filePath, cur);
  }
  const results = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  const commands = results.filter((r) => r.toolName.startsWith('terminal.') || r.toolName === 'compiler.gcc');
  const attachmentReads = results.filter((r) => r.toolName === 'attachments.read' && r.success);
  const failed = results.filter((r) => !r.success);
  const checkpoint = events.find((e): e is Extract<AgentEvent, { type: 'checkpoint' }> => e.type === 'checkpoint');
  if (!files.size && !commands.length && !attachmentReads.length && !failed.length) return null;
  return (
    <div className="rounded-[var(--radius-md)] border border-line bg-raised/60 p-3 space-y-2" aria-label="Bilan de l’échange">
      <div className="text-[11.5px] uppercase tracking-wide text-faint">Bilan</div>
      {files.size > 0 && (
        <ul className="space-y-0.5 text-[12.5px]">
          {[...files].map(([f, c]) => (
            <li key={f} className="flex items-center gap-2">
              <FileDiff className="w-3.5 h-3.5 text-brand shrink-0" />
              <span className="font-mono truncate">{f}</span>
              {c.created && <Badge tone="info">créé</Badge>}
              <span className="text-good tabular">+{c.add}</span>
              <span className="text-bad tabular">-{c.del}</span>
            </li>
          ))}
        </ul>
      )}
      {attachmentReads.length > 0 && (
        <ul className="space-y-0.5 text-[12px] text-muted" aria-label="Pièces jointes consultées">
          {attachmentReads.map((read, idx) => {
            const out = read.output as { name?: string; id?: string; offset?: number; length?: number; total?: number; done?: boolean } | null;
            const label = out?.name || out?.id || 'Pièce jointe';
            const progress = out && out.total ? `${Math.min(100, Math.round(((out.offset ?? 0) + (out.length ?? 0)) / out.total * 100))}%` : '';
            return (
              <li key={`${read.callId}-${idx}`} className="flex items-center gap-2">
                <FileText className="w-3.5 h-3.5 text-brand shrink-0" />
                <span className="font-mono truncate">{label}</span>
                <span className="text-faint">({out?.length ?? 0} car. lus{progress ? ` · ${progress}` : ''}{out?.done ? ' · complet' : ''})</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="text-[12px] text-muted">
        {results.length} appel(s) d’outil{commands.length ? `, ${commands.length} commande(s)` : ''}{attachmentReads.length ? `, ${attachmentReads.length} lecture(s) de pièce(s) jointe(s)` : ''}
        {failed.length ? <span className="text-warn">, {failed.length} en échec ({[...new Set(failed.map((f) => f.toolName))].join(', ')})</span> : ''}.
      </div>
      <div className="flex flex-wrap gap-2">
        {onContinue && (
          <Button size="xs" variant="primary" onClick={() => onContinue(failed.length ? 'Corrige les échecs de l’étape précédente puis vérifie.' : 'Continue : ')}>
            {failed.length ? 'Corriger les échecs' : 'Continuer'}
          </Button>
        )}
        {files.size > 0 && (
          <Button size="xs" onClick={() => navigate('git')}>
            Revoir dans Git
          </Button>
        )}
        {checkpoint && (
          <Button size="xs" variant="ghost" icon={<RotateCcw className="w-3 h-3" />} onClick={() => setConfirm(true)}>
            Annuler les modifications
          </Button>
        )}
      </div>
      {checkpoint && (
        <ConfirmDialog
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Annuler les modifications de cet échange ?"
          confirmLabel="Restaurer les fichiers"
          danger
          onConfirm={async () => {
            const r = await api.post<{ success: boolean; restoredFiles: string[]; errors: string[] }>(`/api/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}/rollback`);
            if (r.success) toast('good', 'Fichiers restaurés', r.restoredFiles.join(', ') || 'Aucun fichier à restaurer');
            else throw new Error(r.errors.join('\n'));
          }}
        >
          Les fichiers modifiés reprennent leur contenu d’avant l’échange ; les fichiers créés sont supprimés.
        </ConfirmDialog>
      )}
    </div>
  );
}

function CheckpointRow({ ev }: { ev: Extract<AgentEvent, { type: 'checkpoint' }> }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <History className="w-3.5 h-3.5 text-brand" />
      <span>Point de restauration créé avant la première modification.</span>
      <Button size="xs" variant="ghost" icon={<RotateCcw className="w-3 h-3" />} onClick={() => setConfirm(true)}>
        Restaurer
      </Button>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Restaurer l’état d’avant la tâche ?"
        confirmLabel="Restaurer les fichiers"
        danger
        onConfirm={async () => {
          const r = await api.post<{ success: boolean; restoredFiles: string[]; errors: string[] }>(`/api/checkpoints/${encodeURIComponent(ev.checkpointId)}/rollback`);
          if (r.success) toast('good', 'Fichiers restaurés', r.restoredFiles.join(', ') || 'Aucun fichier à restaurer');
          else throw new Error(r.errors.join('\n'));
        }}
      >
        Les fichiers modifiés par l’agent pendant cette tâche reprennent leur contenu d’origine ; les fichiers créés par la tâche sont supprimés. Les modifications faites ensuite à la main sur ces fichiers seront perdues.
      </ConfirmDialog>
    </div>
  );
}

/** Task list kept by the agent (plan.update). */
export function PlanList({ items, compact }: { items: PlanItem[]; compact?: boolean }) {
  const done = items.filter((x) => x.status === 'completed').length;
  return (
    <div className={cx('rounded-[var(--radius-md)] border border-line bg-sunk', compact ? 'px-3 py-2' : 'p-3')} aria-label="Liste de tâches de l’agent">
      <div className="flex items-center gap-2 text-[11.5px] text-faint mb-1.5">
        <ListChecks className="w-3.5 h-3.5" />
        Tâches {done}/{items.length}
      </div>
      <ol className="space-y-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-[12.5px]">
            {it.status === 'completed' ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 text-good shrink-0" /> : it.status === 'in_progress' ? <Spinner size={13} /> : <Circle className="w-3.5 h-3.5 mt-0.5 text-faint shrink-0" />}
            <span className={cx(it.status === 'completed' ? 'text-muted line-through decoration-faint' : it.status === 'in_progress' ? 'text-fg font-medium' : 'text-muted')}>{it.content}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** user.ask: question with choices; a free answer is always possible. */
function QuestionCard({ seg, live }: { seg: Extract<Segment, { kind: 'question' }>; live: boolean }) {
  const [busy, setBusy] = useState(false);
  const [free, setFree] = useState('');
  const pending = live && !seg.result;
  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await api.post('/api/agent/answer', { questionId: seg.ev.callId, answer });
    } catch (e) {
      toast('bad', 'Réponse non transmise', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role={pending ? 'alertdialog' : undefined} aria-label={pending ? 'Question de l’agent' : undefined} className={cx('rounded-[var(--radius-md)] border p-3 space-y-2', pending ? 'border-brand/50 bg-brand/5' : 'border-line bg-sunk')}>
      <div className="flex items-start gap-2 text-[13px] text-fg">
        <MessageCircleQuestion className="w-4 h-4 mt-0.5 text-brand shrink-0" />
        <span className="whitespace-pre-wrap">{seg.ev.question}</span>
      </div>
      {seg.result ? (
        <div className="text-[12.5px] text-muted">
          Réponse : <span className="text-fg">{seg.result.answer}</span>
          {seg.result.answeredBy === 'timeout' && <Badge tone="warn" className="ml-2">Sans réponse</Badge>}
        </div>
      ) : pending ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {seg.ev.options.map((o, i) => (
              <Button key={o} size="sm" variant={i === 0 ? 'primary' : 'secondary'} disabled={busy} onClick={() => void send(o)}>
                {o}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(free);
            }}
          >
            <input value={free} onChange={(e) => setFree(e.target.value)} placeholder="Autre réponse" aria-label="Autre réponse" className="flex-1 h-8 px-2.5 rounded-md bg-sunk border border-line text-[12.5px] focus:outline-none focus:border-brand/60" />
            <Button size="sm" type="submit" disabled={busy || !free.trim()}>
              Répondre
            </Button>
          </form>
        </div>
      ) : (
        <div className="text-[12px] text-faint">Question restée sans réponse.</div>
      )}
    </div>
  );
}

/** Claude-style collapsible reasoning & MCOS orchestration card shown at the top of the assistant response. */
function ReasoningTraceCard({
  live,
  thinkingStreaming,
  statuses,
  thoughts,
  toolCallsCount,
  thoughtMs,
}: {
  live: boolean;
  thinkingStreaming: boolean;
  statuses: Array<{ message: string; t: number }>;
  thoughts: string[];
  toolCallsCount: number;
  thoughtMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const combinedThought = thoughts.join('\n\n').trim();
  const isActivelyThinking = live && thinkingStreaming;

  const [liveSec, setLiveSec] = useState(0);
  useEffect(() => {
    if (!isActivelyThinking) {
      setLiveSec(0);
      return;
    }
    const t0 = Date.now();
    const interval = setInterval(() => {
      setLiveSec(Math.max(1, Math.round((Date.now() - t0) / 1000)));
    }, 500);
    return () => clearInterval(interval);
  }, [isActivelyThinking]);

  if (statuses.length === 0 && !combinedThought && !live) return null;

  const steps = groupOrchestration(statuses, live);
  const allStatusText = statuses.map((s) => s.message).join(' | ');
  const mcosMatch = /MCOS \[Chemin=([^,\]]+),\s*Rôle=([^\]]+)\]/i.exec(allStatusText);
  const ctxMatch = /Contexte actif ([\d\s/]+jetons \([\d.,]+%\))/i.exec(allStatusText);
  const uieMatch = /moteur UIE vérifié \(([^)]+)\)|voie rapide déterministe \(([^)]+)\)/i.exec(allStatusText);

  return (
    <div className={cx(
      'rounded-[var(--radius-md)] border overflow-hidden transition-[border-color,background-color,box-shadow] duration-[var(--dur-slow)] ease-[var(--ease-organic)]',
      isActivelyThinking
        ? 'border-brand/50 bg-gradient-to-r from-brand/[0.04] via-raised to-brand/[0.04] shadow-[0_0_16px_var(--glow)] ring-1 ring-brand/20'
        : 'border-line bg-sunk/80'
    )}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-muted hover:text-fg cursor-pointer select-none"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5 text-faint shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-faint shrink-0" />}
        <StatusIndicator kind="thinking" active={isActivelyThinking} />
        <span className="font-medium text-fg truncate">
          {isActivelyThinking
            ? `Réflexion en cours${liveSec > 0 ? ` (${liveSec} s)` : ''}…`
            : combinedThought
              ? `Réflexion${thoughtMs ? ` · ${fmtMs(thoughtMs)}` : ''}`
              : statuses.length
                ? `Orchestration · ${statuses.length} étape${statuses.length > 1 ? 's' : ''}`
                : 'Préparation…'}
        </span>
        <span className="ml-auto flex items-center gap-1.5 flex-wrap justify-end">
          {mcosMatch && (
            <Badge tone="info">
              {mcosMatch[1]} · {mcosMatch[2]}
            </Badge>
          )}
          {uieMatch && <Badge tone="good">UIE {uieMatch[1] || uieMatch[2]}</Badge>}
          {ctxMatch && <span className="hidden md:inline font-mono text-[10.5px] text-faint">{ctxMatch[1]}</span>}
          {toolCallsCount > 0 && <span className="text-[11px] text-faint tabular">{toolCallsCount} outil(s)</span>}
          {combinedThought.length > 0 && <span className="text-[11px] text-faint tabular">{combinedThought.length} car.</span>}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2.5 pt-2 border-t border-line space-y-2 text-[12px]">
          {steps.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10.5px] uppercase tracking-wide text-faint">Déroulé de la tâche</div>
              <ol className="relative ml-1.5 border-l border-line space-y-1.5">
                {steps.map((st) => (
                  <li key={st.key} className="relative pl-4">
                    <span aria-hidden className={cx('absolute -left-[4.5px] top-[7px] w-2 h-2 rounded-full border border-panel', st.active ? 'bg-brand animate-pulse' : 'bg-good/70')} />
                    <details className="group">
                      <summary className="flex items-center gap-2 cursor-pointer list-none text-[12px] text-fg select-none">
                        <span className={cx('font-medium', st.active && 'text-brand')}>{st.title}</span>
                        {st.tools.map((tool, i) => <Badge key={`${tool}-${i}`} tone="info">{tool}</Badge>)}
                        <span className="ml-auto tabular text-[11px] text-faint">{st.active ? 'en cours…' : fmtMs(st.durationMs)}</span>
                      </summary>
                      {st.lines.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[11px] text-muted font-mono">
                          {st.lines.map((line, i) => <li key={i} className="break-words">{line}</li>)}
                        </ul>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {combinedThought && (
            <div className="space-y-1">
              <div className="text-[10.5px] uppercase tracking-wide text-faint flex items-center justify-between">
                <span>Flux de raisonnement interne</span>
                <span className="text-[10px] text-faint font-mono">{combinedThought.length} car.</span>
              </div>
              <div className="text-[12px] text-fg/90 bg-code border border-line rounded p-2.5 whitespace-pre-wrap break-words max-h-72 overflow-y-auto font-sans leading-relaxed selection:bg-brand/20">
                {combinedThought}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TelemetryChip({ t }: { t: InferenceTelemetry }) {
  const parts: string[] = [];
  if (t.speedSource !== 'synthetic') {
    parts.push(`tg ${fmtRate(t.tgTokS)}`);
    if (t.locality === 'local') parts.push(`pp ${fmtRate(t.ppTokS)}`);
    parts.push(`TTFT ${fmtMs(t.ttftMs)}`);
    parts.push(`${fmtInt(t.promptTokens)} entrée / ${fmtInt(t.completionTokens)} sortie`);
    if (t.cachedTokens) parts.push(`${fmtInt(t.cachedTokens)} jetons repris du cache`);
    if (t.draftTokens) parts.push(`spéculation : ${fmtInt(t.draftAccepted ?? 0)}/${fmtInt(t.draftTokens)} jetons acceptés (${Math.round(((t.draftAccepted ?? 0) / t.draftTokens) * 100)} %)`);
  } else parts.push('moteur de test, aucune mesure');
  parts.push(`total ${fmtMs(t.e2eMs)}`);
  return (
    <div className="flex items-center gap-2 text-[11px] text-faint tabular" title={`${SOURCE_LABEL[t.speedSource]}${t.notes.length ? `\n${t.notes.join('\n')}` : ''}`}>
      <span className="w-1 h-1 rounded-full bg-faint" />
      {parts.join(' - ')}
      <Badge tone={t.speedSource === 'runtime_timings' ? 'good' : t.speedSource === 'synthetic' ? 'warn' : 'neutral'}>{t.speedSource === 'runtime_timings' ? 'mesuré' : t.speedSource === 'client_estimate' ? 'estimation' : t.speedSource === 'synthetic' ? 'test' : 'N/D'}</Badge>
      {t.partial && <Badge tone="warn">partiel</Badge>}
    </div>
  );
}

export interface TurnLike {
  prompt: string;
  attachments?: AttachmentMeta[];
  mode: string;
  modelId: string;
  providerId: string;
  startedAt: number;
  status: string;
  events: AgentEvent[];
}

type AnswerFn = ApprovalAnswerFn;

export const TurnView = memo(function TurnView({ turn, live, pendingApprovals, onAnswer, onSaveCode, onOpenFile, onEditPrompt, onRetry, onExecutePlan, showStatus }: {
  turn: TurnLike;
  live: boolean;
  pendingApprovals?: Set<string>;
  onAnswer?: AnswerFn;
  onSaveCode?: (code: string, lang: string) => void;
  onOpenFile?: (path: string) => void;
  onEditPrompt?: (prompt: string) => void;
  onRetry?: (prompt: string) => void;
  /** Plan mode: run the proposed plan in Agent mode. */
  onExecutePlan?: (plan: string) => void;
  showStatus: boolean;
}) {
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null);
  // A turn that starts live germinates once; turns replayed from history appear still.
  const userRef = useGerminate<HTMLDivElement>(live, 'MEDIUM_ORGANIC');
  const answerRef = useGerminate<HTMLDivElement>(live, 'SOFT_ORGANIC');
  // A finished turn keeps the same `turn` object, so its segmentation is computed once.
  const { segments, statuses, extractedThoughts, thinkingStreaming, toolCallsCount, thoughtMs, finalText, cleanTextByIndex } = useMemo(() => {
    const segments = segmentEvents(turn.events, live);
    const statuses: Array<{ message: string; t: number }> = [];
    const extractedThoughts: string[] = [];
    let thinkingStreaming = false;
    let toolCallsCount = 0;
    const cleanedTextSegments: Array<{ index: number; text: string; streaming: boolean }> = [];
    segments.forEach((seg, i) => {
      if (seg.kind === 'status') {
        statuses.push({ message: seg.message, t: seg.t });
      } else if (seg.kind === 'thought') {
        if (seg.text.trim()) extractedThoughts.push(seg.text.trim());
      } else if (seg.kind === 'tool') {
        toolCallsCount += 1;
      } else if (seg.kind === 'text') {
        const sp = splitInlineThink(seg.text);
        if (sp.thoughts.length) extractedThoughts.push(...sp.thoughts);
        if (sp.thinkingStreaming) thinkingStreaming = true;
        if (sp.cleanText || !sp.thoughts.length) {
          cleanedTextSegments.push({ index: i, text: sp.cleanText, streaming: seg.streaming });
        }
      }
    });
    // Thinking is "in progress" only while a thought is the latest visible thing, not during tools or approvals.
    const lastVisible = [...segments].reverse().find((s) => s.kind !== 'status' && s.kind !== 'usage');
    if (lastVisible?.kind === 'thought') thinkingStreaming = true;
    const thoughtTimes = turn.events.filter((e) => e.type === 'thought').map((e) => e.timestamp);
    const thoughtMs = thoughtTimes.length > 1 ? thoughtTimes[thoughtTimes.length - 1] - thoughtTimes[0] : undefined;
    return {
      segments, statuses, extractedThoughts, thinkingStreaming, toolCallsCount, thoughtMs,
      finalText: cleanedTextSegments.map((s) => s.text).filter(Boolean).join('\n\n'),
      cleanTextByIndex: new Map(cleanedTextSegments.map((s) => [s.index, s])),
    };
  }, [turn, live]);

  const rendered: ReactNode[] = [];
  if (statuses.length > 0 || extractedThoughts.length > 0 || live) {
    rendered.push(
      <ReasoningTraceCard
        key="reasoning-trace"
        live={live}
        thinkingStreaming={thinkingStreaming}
        statuses={statuses}
        thoughts={extractedThoughts}
        toolCallsCount={toolCallsCount}
        thoughtMs={thoughtMs}
      />
    );
  }

  const diffCount = segments.filter((s) => s.kind === 'diff').length;
  // Consecutive tool calls fold into one group; usage chips and hidden statuses between them do not break it.
  let group: { tools: ToolSeg[]; usages: InferenceTelemetry[]; key: number } | null = null;
  const flush = () => {
    if (!group) return;
    if (group.tools.length > 1) rendered.push(<ToolGroup key={`g${group.key}`} tools={group.tools} usages={group.usages} />);
    else {
      rendered.push(<ToolCard key={group.tools[0].start.callId + group.key} seg={group.tools[0]} />);
      group.usages.forEach((u, j) => rendered.push(<TelemetryChip key={`gu${group!.key}_${j}`} t={u} />));
    }
    group = null;
  };

  segments.forEach((seg, i) => {
    // The task list renders the plan; only a refused plan.update stays visible as a tool call.
    if (seg.kind === 'tool' && seg.start.toolName === 'plan.update' && (!seg.result || seg.result.success)) return;
    if (seg.kind === 'tool') {
      if (!group) group = { tools: [], usages: [], key: i };
      group.tools.push(seg);
      return;
    }
    if (group && (seg.kind === 'usage' || seg.kind === 'thought' || (seg.kind === 'status' && !(showStatus && statuses.length === 0)))) {
      if (seg.kind === 'usage') group.usages.push(seg.t);
      return;
    }
    flush();
    switch (seg.kind) {
      case 'text': {
        const cleaned = cleanTextByIndex.get(i);
        if (cleaned && cleaned.text) {
          rendered.push(<Markdown key={i} text={cleaned.text} streaming={cleaned.streaming} onSaveAs={onSaveCode} />);
        }
        break;
      }
      case 'thought':
        // Consolidated inside ReasoningTraceCard above
        break;
      case 'status':
        if (showStatus && statuses.length === 0) rendered.push(<div key={i} className="text-[11.5px] text-faint">{seg.message}</div>);
        break;
      case 'diff':
        // Beyond three files the diffs start folded: the recap lists them all.
        rendered.push(<DiffCard key={i} ev={seg.ev} onOpenFile={onOpenFile} defaultOpen={diffCount <= 3} />);
        break;
      case 'checkpoint':
        rendered.push(<CheckpointRow key={i} ev={seg.ev} />);
        break;
      case 'approval':
        rendered.push(<ApprovalCard key={i} ev={seg.ev} result={seg.result} pending={!!pendingApprovals?.has(seg.ev.callId) && !seg.result} onAnswer={onAnswer} />);
        break;
      case 'plan':
        // While live the list is pinned above the composer; it lands here once the turn ends.
        if (!live) rendered.push(<PlanList key={i} items={seg.ev.items} />);
        break;
      case 'question':
        rendered.push(<QuestionCard key={i} seg={seg} live={live} />);
        break;
      case 'agent':
        rendered.push(<SubAgentCard key={`agent${seg.start.callId}`} seg={seg} live={live} />);
        break;
      case 'forge':
        rendered.push(<ForgeBoard key={i} events={seg.events} live={live} onOpenFile={onOpenFile} />);
        break;
      case 'usage':
        rendered.push(<TelemetryChip key={i} t={seg.t} />);
        break;
      case 'error':
        rendered.push(
          <div key={i} role="alert" className={cx('flex items-start gap-2 text-[12.5px] rounded-[var(--radius-md)] border p-2.5', seg.ev.fatal ? 'border-bad/40 bg-bad/5 text-bad' : 'border-warn/40 bg-warn/5 text-warn')}>
            {seg.ev.code === 'TASK_ABORTED' ? <CircleSlash className="w-4 h-4 shrink-0" /> : <StatusIndicator kind="error" size={16} />}
            <span className="whitespace-pre-wrap break-words">
              <span className="font-mono text-[11px] mr-1.5">{seg.ev.code}</span>
              {seg.ev.message}
            </span>
          </div>
        );
        break;
      case 'complete':
        if (!live) rendered.push(<TurnRecap key={`recap${i}`} events={turn.events} onContinue={onEditPrompt} />);
        if (!live && turn.mode === 'plan' && seg.ev.success && finalText && onExecutePlan) {
          rendered.push(
            <div key={`plan-go${i}`} className="flex flex-wrap items-center gap-2 rounded-[var(--radius-md)] border border-brand/40 bg-brand/5 p-2.5 fade-up" aria-label="Validation du plan">
              <ListChecks className="w-4 h-4 text-brand shrink-0" />
              <span className="text-[12.5px] text-fg">Plan prêt. Rien n’a été modifié.</span>
              <Button size="xs" variant="primary" className="ml-auto" onClick={() => onExecutePlan(finalText)}>
                Exécuter ce plan
              </Button>
              <span className="w-full text-[11.5px] text-faint">Ou répondez pour l’affiner : la session reste en mode Plan.</span>
            </div>
          );
        }
        rendered.push(
          <div key={i} className="flex items-center gap-2 text-[11.5px] text-faint">
            {seg.ev.success ? <CheckCircle2 className="w-3.5 h-3.5 text-good" /> : <XCircle className="w-3.5 h-3.5 text-bad" />}
            {seg.ev.success ? 'Exécution terminée · résultat à vérifier' : 'Non terminé'} en {fmtMs(seg.ev.durationMs)}
          </div>
        );
        break;
    }
  });
  flush();

  return (
    // Off-screen finished turns skip layout and paint (content-visibility); the live turn always renders.
    <article className={cx('space-y-3', !live && 'turn-offscreen')} aria-label={`Échange du ${fmtTime(turn.startedAt)}`}>
      <div ref={userRef} className="user-turn-block group">
        <div className="user-turn-bubble">
          <div className="user-bubble-header">
            <span>VOUS · {turn.mode.toUpperCase()}</span>
            <span>{fmtTime(turn.startedAt)}</span>
          </div>
          <div className="text-[13.5px] text-fg whitespace-pre-wrap break-words">{turn.prompt}</div>
          {turn.attachments?.length ? (
            <div className="flex flex-wrap gap-1.5 mt-2" aria-label="Pièces jointes">
              {turn.attachments.map((a) => (
                <AttachmentChip
                  key={a.id}
                  item={a}
                  onPreviewText={a.chars > 0 ? () => setPreviewAttachment(a) : undefined}
                />
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-line text-[11px] text-faint">
            <span className="truncate max-w-[220px] font-mono text-[10px] text-brand">{turn.modelId}</span>
            <span className="ml-auto flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              {onEditPrompt && (
                <IconButton size="sm" label="Modifier et relancer" onClick={() => onEditPrompt(turn.prompt)}>
                  <PencilLine className="w-3 h-3" />
                </IconButton>
              )}
              {onRetry && !live && (
                <IconButton size="sm" label="Relancer cette demande" onClick={() => onRetry(turn.prompt)}>
                  <RotateCcw className="w-3 h-3" />
                </IconButton>
              )}
            </span>
          </div>
        </div>
      </div>
      <div ref={answerRef} className="flex gap-3">
        <div className="w-6 shrink-0 pt-0.5">
          <img src="/brand/app-icon-32.png" alt="" width={22} height={22} className="rounded-[23%]" />
        </div>
        <div className="flex-1 min-w-0 space-y-2.5">
          {(() => {
            const cascadeFallback = turn.events.find((e): e is Extract<AgentEvent, { type: 'status' }> => e.type === 'status' && e.stage === 'cascade_fallback');
            return cascadeFallback ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-brand/10 border border-brand/30 text-[11.5px] text-brand">
                <RefreshCw className="w-3.5 h-3.5 shrink-0" />
                <span>{cascadeFallback.message}</span>
              </div>
            ) : null;
          })()}
          {rendered.length === 0 && live && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <Spinner size={12} /> En attente du premier événement
            </div>
          )}
          {rendered}
          {!live && finalText && (
            <div className="flex gap-0.5">
              <IconButton
                size="sm"
                label="Copier la réponse"
                onClick={() =>
                  navigator.clipboard
                    .writeText(finalText)
                    .then(() => toast('good', 'Réponse copiée'))
                    .catch(() => toast('bad', 'Copie impossible', 'Le presse-papiers est indisponible.'))
                }
              >
                <Copy className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          )}
        </div>
      </div>
      <AttachmentTextDialog
        open={previewAttachment !== null}
        meta={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </article>
  );
});
