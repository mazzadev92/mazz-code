import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, Circle, Cpu, FileCode2, FlaskConical, Hammer, XCircle } from '../../components/icons';
import type { ForgeEvent } from '@mazz/shared';
import { Markdown } from '../../components/Markdown';
import { Badge, Spinner, cx } from '../../components/ui';
import { fmtInt } from '../../lib/format';

type UnitState = 'pending' | 'running' | 'done' | 'failed';

interface UnitView {
  id: string;
  file: string;
  lang: string;
  steps: string[];
  state: UnitState;
  candidates: Array<{ n: number; pass: boolean; strategy?: string; detail?: string; code?: string }>;
  code?: string;
  strategy?: string;
  /** False when the unit had no execution oracle and was accepted on syntax alone. */
  executed?: boolean;
}

/** Folds the Forge event stream of one turn into a per-unit view (pure, tested). */
export function foldForge(events: ForgeEvent[]) {
  const units = new Map<string, UnitView>();
  let title = '';
  let concurrency: number | undefined;
  let source: string | undefined;
  const verify: Array<{ label: string; pass: boolean }> = [];
  let summary: ForgeEvent | undefined;
  let written: string[] = [];
  for (const ev of events) {
    if (ev.phase === 'blueprint') {
      title = ev.detail ?? ev.blueprintId;
      concurrency = ev.concurrency;
      source = ev.source;
      for (const u of ev.units ?? []) units.set(u.id, { id: u.id, file: u.file, lang: u.lang, steps: [], state: 'pending', candidates: [] });
    }
    const unit = ev.unitId ? units.get(ev.unitId) : undefined;
    if (ev.phase === 'unit_start' && unit) { unit.state = 'running'; unit.steps = ev.steps ?? []; }
    if (ev.phase === 'candidate' && unit) unit.candidates.push({ n: ev.candidate ?? 0, pass: ev.verdict === 'pass', strategy: ev.strategy, detail: ev.detail, code: ev.code });
    if (ev.phase === 'unit_done' && unit) { unit.state = 'done'; unit.code = ev.code; unit.strategy = ev.strategy; unit.executed = ev.oracle !== false; }
    if (ev.phase === 'files') written = ev.files ?? [];
    if (ev.phase === 'verify') verify.push({ label: ev.detail ?? '', pass: ev.verdict === 'pass' });
    if (ev.phase === 'summary') {
      summary = ev;
      if (!ev.success) for (const u of units.values()) if (u.state === 'running') u.state = 'failed';
    }
  }
  return { title, concurrency, source, units: [...units.values()], verify, summary, written };
}

const STATE_LABEL: Record<UnitState, string> = { pending: 'en attente', running: 'en cours', done: 'validée', failed: 'échec' };

/** Counts measured from the candidate events of one unit (no estimate). */
export function unitStats(unit: UnitView) {
  const passes = unit.candidates.filter((c) => c.pass).length;
  return { passes, rejects: unit.candidates.length - passes, winner: unit.state === 'done' ? unit.strategy : undefined };
}

const FENCE: Record<string, string> = { c: 'c', python: 'python', markdown: 'markdown' };

function UnitTile({ unit, selected, onSelect }: { unit: UnitView; selected: boolean; onSelect: () => void }) {
  const icon = unit.state === 'done' ? <CheckCircle2 className="w-3.5 h-3.5 text-good" aria-label="Validée" />
    : unit.state === 'failed' ? <XCircle className="w-3.5 h-3.5 text-bad" aria-label="Échec" />
    : unit.state === 'running' ? <Spinner size={11} label="En cours" />
    : <Circle className="w-3.5 h-3.5 text-faint" aria-label="En attente" />;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Unité ${unit.id}, ${STATE_LABEL[unit.state]}, ${unit.candidates.length} candidat(s)`}
      data-forge-unit
      className={cx(
        'relative overflow-hidden text-left rounded-[var(--radius-md)] border px-2.5 py-2 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]',
        selected ? 'border-brand bg-brand/5' : 'border-line bg-sunk hover:border-brand/50',
        unit.state === 'running' && 'forge-running',
      )}
    >
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="font-mono text-[12px] text-fg truncate">{unit.id}</span>
        <span className="ml-auto text-[10px] uppercase tracking-wide text-faint">{unit.lang}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-[3px] min-h-[8px]" aria-label={`${unit.candidates.length} candidat(s)`}>
        {unit.candidates.map((c) => (
          <span
            key={c.n}
            title={`#${c.n} ${c.strategy ?? ''} : ${c.pass ? 'oracle réussi' : c.detail ?? 'rejeté'}`}
            className={cx('forge-dot w-2 h-2 rounded-full', c.pass ? 'bg-good' : 'bg-bad/70')}
          />
        ))}
      </div>
      {unit.state === 'running' && <div className="progress-indeterminate absolute left-0 right-0 bottom-0 h-[2px]" aria-hidden />}
    </button>
  );
}

export function ForgeBoard({ events, live, onOpenFile }: { events: ForgeEvent[]; live: boolean; onOpenFile?: (path: string) => void }) {
  const view = useMemo(() => foldForge(events), [events]);
  const gridRef = useRef<HTMLDivElement>(null);
  // Arrow keys / Home / End move focus across the tiles in reading order.
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const tiles = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('[data-forge-unit]') ?? [])];
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: tiles.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    tiles[Math.max(0, Math.min(tiles.length - 1, next))]?.focus();
  };
  const [picked, setPicked] = useState<string | undefined>();
  const active = view.units.find((u) => u.state === 'running') ?? [...view.units].reverse().find((u) => u.state !== 'pending');
  const shown = view.units.find((u) => u.id === picked) ?? active;
  const done = view.units.filter((u) => u.state === 'done').length;
  const syntaxOnly = view.units.filter((u) => u.state === 'done' && u.executed === false).length;
  const candidates = view.units.reduce((n, u) => n + u.candidates.length, 0);
  const files = [...new Set(view.units.map((u) => u.file))];
  const shownCode = shown?.code ?? shown?.candidates[shown.candidates.length - 1]?.code;
  const rejects = shown?.candidates.filter((c) => !c.pass).slice(-4) ?? [];
  const stats = view.summary?.stats;
  const shownStats = shown && unitStats(shown);

  return (
    <section className="rounded-[var(--radius-lg)] border border-line bg-raised fade-up" aria-label="MAZZ Forge">
      <header className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-line">
        <Hammer className="w-4 h-4 text-brand" aria-hidden />
        <span className="text-[13px] font-medium text-fg">MAZZ Forge</span>
        <span className="text-[12.5px] text-muted truncate">{view.title}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {view.concurrency !== undefined && <Badge tone="info" icon={<Cpu className="w-3 h-3" />} title="Générations simultanées (slots llama.cpp)">{view.concurrency} slot{view.concurrency > 1 ? 's' : ''}</Badge>}
          <Badge tone="neutral" title="Candidats générés puis exécutés">{fmtInt(candidates)} candidats</Badge>
          {stats && <Badge tone="neutral" title="Tokens générés, mesurés par llama.cpp">{fmtInt(stats.completionTokens)} tokens</Badge>}
        </span>
      </header>

      <div className="px-3 pt-2.5">
        <div className="flex items-center justify-between text-[11.5px] text-faint mb-1">
          <span>{done}/{view.units.length} unités validées par exécution{syntaxOnly ? ` (dont ${syntaxOnly} sur syntaxe seule, sans oracle)` : ''}</span>
          {view.source && <span className="truncate max-w-[50%] font-mono" title={view.source}>{view.source.split(/[\\/]/).slice(-2).join('/')}</span>}
        </div>
        <div className="h-1.5 rounded-full bg-sunk overflow-hidden">
          <div className="h-full bg-brand transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-propagate)]" style={{ width: `${view.units.length ? (100 * done) / view.units.length : 0}%` }} />
        </div>
      </div>

      <div ref={gridRef} onKeyDown={onGridKey} className="p-3 space-y-3">
        {files.map((file) => (
          <div key={file}>
            <div className="text-[11px] font-mono text-faint mb-1">{file}</div>
            <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {view.units.filter((u) => u.file === file).map((u) => (
                <UnitTile key={u.id} unit={u} selected={shown?.id === u.id} onSelect={() => setPicked(u.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {shown && (
        <div className="border-t border-line p-3 grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0">
            <div className="text-[12px] text-fg font-medium mb-1.5 flex items-center gap-1.5">
              <FlaskConical className="w-3.5 h-3.5 text-brand" aria-hidden />
              Étapes du blueprint · {shown.id}
            </div>
            <ol className="space-y-1 text-[12px] text-muted list-decimal pl-4">
              {shown.steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
            </ol>
            {shownStats && (
              <dl className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]" aria-label="Statistiques des candidats">
                <div className="flex gap-1"><dt className="text-faint">Réussis</dt><dd className="text-good font-mono">{shownStats.passes}</dd></div>
                <div className="flex gap-1"><dt className="text-faint">Rejetés</dt><dd className="text-bad font-mono">{shownStats.rejects}</dd></div>
                {shownStats.winner && <div className="flex gap-1"><dt className="text-faint">Stratégie retenue</dt><dd className="text-fg font-mono">{shownStats.winner}</dd></div>}
              </dl>
            )}
            {rejects.length > 0 && (
              <div className="mt-2.5">
                <div className="text-[11px] text-faint mb-1">Derniers rejets (raison réelle)</div>
                <ul className="space-y-1">
                  {rejects.map((c) => (
                    <li key={c.n} className="text-[11.5px] font-mono text-bad/90 break-words">#{c.n} {c.strategy} : {c.detail}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-faint mb-1">
              {shown.code ? `Code accepté (${shown.strategy}), écrit par le modèle sous les commentaires d’étape` : 'Dernier candidat'}
            </div>
            {shownCode ? <Markdown text={`\`\`\`${FENCE[shown.lang] ?? ''}\n${shownCode.trimEnd()}\n\`\`\``} streaming={false} /> : <div className="text-[12px] text-faint">Aucun candidat pour l’instant.</div>}
          </div>
        </div>
      )}

      {view.written.length > 0 && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="text-[11px] text-faint mb-1">Fichiers écrits</div>
          <ul className="flex flex-wrap gap-1.5">
            {view.written.map((f) => (
              <li key={f}>
                {onOpenFile ? (
                  <button type="button" onClick={() => onOpenFile(f)} title="Ouvrir dans l’éditeur" className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-line bg-sunk px-2 py-0.5 text-[11.5px] font-mono text-fg hover:border-brand/50 cursor-pointer">
                    <FileCode2 className="w-3 h-3 text-brand" aria-hidden />{f}
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11.5px] font-mono text-muted"><FileCode2 className="w-3 h-3" aria-hidden />{f}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(view.verify.length > 0 || view.summary) && (
        <footer className="border-t border-line px-3 py-2.5 space-y-1.5">
          {view.verify.map((v, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[12px]">
              {v.pass ? <CheckCircle2 className="w-3.5 h-3.5 text-good" /> : <XCircle className="w-3.5 h-3.5 text-bad" />}
              <span className={v.pass ? 'text-fg' : 'text-bad'}>{v.label}</span>
            </div>
          ))}
          {view.summary && <p className={cx('text-[12px]', view.summary.success ? 'text-muted' : 'text-bad')}>{view.summary.detail}</p>}
          {live && !view.summary && <div className="text-[11.5px] text-faint">Vérification en cours…</div>}
        </footer>
      )}
    </section>
  );
}
