import { useEffect, useState } from 'react';
import { Brain, Wrench } from 'lucide-react';
import { rollingRate } from '@mazz/shared';
import type { LiveRun } from '../../lib/agentRuns';
import { fmtInt, fmtRate } from '../../lib/format';
import { useApp } from '../../lib/store';

/** "4 min 05 s" style elapsed time, seconds only under a minute. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/**
 * Live Cognitive Presence Bar above the composer: stage, model tag, elapsed time,
 * measured output tokens of finished model calls, rolling estimate while streaming,
 * and the stop shortcut.
 */
export function LiveStatusLine({ run }: { run: LiveRun }) {
  const settings = useApp((s) => s.settings);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const windowMs = (settings?.performance.rollingWindowSec ?? 3) * 1000;
  const rate = rollingRate(run.tokenTimes, windowMs, now);
  const measured = run.telemetry.reduce((acc, t) => acc + (t.completionTokens ?? 0), 0);

  const stageLower = run.stage.toLowerCase();
  const isCascade = stageLower.includes('cascade');
  const isTool = stageLower.includes('outil') || stageLower.includes('exécute') || stageLower.includes('terminal') || stageLower.includes('fs.');
  const stateTitle = run.status === 'reconnecting'
    ? 'RECONNEXION FLUX'
    : isCascade
    ? 'BASCULE CASCADE'
    : isTool
    ? 'EXÉCUTION D’OUTIL'
    : 'RÉFLEXION DÉTAILLÉE';

  return (
    <div
      data-testid="live-status"
      className="cognitive-presence-bar-real mb-2.5 px-3.5 py-2.5 rounded-xl border border-brand/60 bg-panel shadow-[0_0_20px_rgba(201,165,122,0.18)] flex items-center justify-between gap-3 text-[12px] fade-up relative"
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <div className="w-6 h-6 rounded bg-sunk border border-line grid place-items-center shrink-0">
          {isTool ? (
            <Wrench className="w-3.5 h-3.5 text-brand animate-pulse" />
          ) : (
            <Brain className="w-3.5 h-3.5 text-brand animate-pulse" />
          )}
        </div>
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5 leading-none">
            <span className="font-mono text-[9.5px] uppercase tracking-wider text-brand font-semibold">
              {stateTitle}
            </span>
            <span className="font-mono text-[10px] text-faint truncate">
              · {run.modelId || 'Mazz Technos'}
            </span>
          </div>
          <span className="text-[12px] text-fg truncate mt-0.5">
            {run.status === 'reconnecting' ? 'Reconnexion au flux' : run.stage}
          </span>
        </div>
      </div>

      <div className="hidden sm:block w-28 h-1.5 rounded-full bg-sunk overflow-hidden border border-line shrink-0">
        <div className="h-full bg-gradient-to-r from-leaf to-brand progress-indeterminate" />
      </div>

      <div className="flex items-center gap-2 shrink-0 text-faint text-[11px] tabular">
        <span title="Temps écoulé depuis l’envoi" className="text-fg font-medium">{fmtElapsed(now - run.startedAt)}</span>
        {measured > 0 && <span title="Jetons de sortie mesurés sur les appels modèle terminés">{fmtInt(measured)} jetons</span>}
        {rate !== undefined && rate > 0 && <span title="Débit glissant estimé à partir des fragments reçus" className="text-leaf">~{fmtRate(rate)}</span>}
        <kbd className="hidden md:inline px-1 py-0.5 rounded border border-line text-[10px] font-mono bg-sunk">Échap</kbd>
        <span className="hidden md:inline">pour arrêter</span>
      </div>
    </div>
  );
}
