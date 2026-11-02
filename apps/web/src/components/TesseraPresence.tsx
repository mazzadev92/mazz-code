import { useEffect, useId, useState } from 'react';
import type { AgentEvent } from '@mazz/shared';
import { motionAllowed } from '../motion/motion';
import { TESSERA_CENTER, TESSERA_HIGHLIGHT, TESSERA_OUTLINE, TESSERA_VIEWBOX } from './tesseraPaths';

// Port of the Laef TesseraPresenceController: the leaf logo as a live presence.
// Fixes from the audit: 'planning' is part of the union, COPPER_GLOW exists in the
// synced tokens, SVG ids come from useId, time comes from a rAF clock (not
// Remotion), motion stops under prefers-reduced-motion, and the figure is labelled.

export type TesseraState = 'idle' | 'listening' | 'thinking' | 'planning' | 'searching' | 'tool' | 'coding' | 'memory' | 'success' | 'error' | 'sleep';

export const TESSERA_LABEL: Record<TesseraState, string> = {
  idle: 'Agent au repos',
  listening: 'Connexion au flux',
  thinking: 'Réflexion',
  planning: 'Planification',
  searching: 'Recherche',
  tool: 'Exécution d’outil',
  coding: 'Écriture de code',
  memory: 'Accès mémoire',
  success: 'Tâche terminée',
  error: 'Tâche en échec',
  sleep: 'Hors ligne',
};

export interface PresenceDynamics {
  scaleX: number;
  scaleY: number;
  coreScale: number;
  coreColor: string;
  coreGlow: string;
  veinActivity: number;
  mechanical: boolean;
}

/** Shape of the logo at time `t` (seconds). Pure: no rotation in any state (DA rule). */
export function presenceDynamics(state: TesseraState, t: number): PresenceDynamics {
  const d: PresenceDynamics = { scaleX: 1, scaleY: 1, coreScale: 1, coreColor: 'var(--mazz-bone)', coreGlow: 'var(--mazz-champagne-glow)', veinActivity: 0.1, mechanical: false };
  switch (state) {
    case 'idle': {
      const breath = Math.sin(((t % 5.5) / 5.5) * Math.PI * 2);
      return { ...d, scaleX: 1 + breath * 0.009, scaleY: 1 + breath * 0.012, coreScale: 0.95 + breath * 0.04, veinActivity: 0.04 };
    }
    case 'listening':
      return { ...d, scaleX: 1.02, scaleY: 1.03, coreScale: 1.05, veinActivity: 0.4 };
    case 'thinking':
      return { ...d, coreScale: 1 + (Math.sin(t * 7.3) * 0.04 + Math.sin(t * 13.7) * 0.03) * 0.75, coreColor: 'var(--mazz-champagne)', veinActivity: 0.65 };
    case 'planning':
      return { ...d, scaleX: 1.02, scaleY: 0.98 + (Math.sin(t * 4) * 0.5 + 0.5) * 0.04, coreColor: 'var(--mazz-sage)', veinActivity: 0.85 };
    case 'searching':
      return { ...d, scaleX: 1.03 + Math.sin(t * 5) * 0.02, scaleY: 1.03 + Math.cos(t * 5) * 0.02, coreColor: 'var(--mazz-white)', veinActivity: 0.9 };
    case 'tool':
      return { ...d, scaleX: 1.01, scaleY: 1.01, coreColor: 'var(--mazz-champagne)', veinActivity: 0.7, mechanical: true };
    case 'coding':
      return { ...d, coreScale: Math.sin(t * 9) > 0 ? 1.04 : 1, veinActivity: 0.75 };
    case 'memory':
      return { ...d, coreScale: 1.08 + Math.sin(t * 6) * 0.06, coreColor: 'var(--mazz-living-green)', veinActivity: 0.6 };
    case 'success':
      return { ...d, scaleX: 1.06, scaleY: 1.06, coreScale: 1.18, coreColor: 'var(--mazz-champagne)', veinActivity: 0.95 };
    case 'error':
      return { ...d, scaleX: 0.96, scaleY: 0.96, coreScale: 0.9, coreColor: 'var(--mazz-copper)', coreGlow: 'var(--mazz-copper-glow)', veinActivity: 0.2 };
    case 'sleep': {
      const b = Math.sin(t * 0.8) * 0.015;
      return { ...d, scaleX: 0.98 + b, scaleY: 0.97 + b, coreScale: 0.85, coreColor: 'var(--mazz-forest)', veinActivity: 0.02 };
    }
  }
}

const STATIC_STATES: ReadonlySet<TesseraState> = new Set(['listening', 'tool', 'success', 'error']);

/** Seconds since mount from requestAnimationFrame; frozen at 0 when motion is reduced or the state is static. */
function usePresenceClock(state: TesseraState): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (STATIC_STATES.has(state) || !motionAllowed() || typeof requestAnimationFrame !== 'function') {
      setT(0);
      return;
    }
    const start = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      setT((now - start) / 1000);
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [state]);
  return t;
}

const SEARCH_TOOL = /search|grep|find|glob|web\.|index/i;
const CODE_TOOL = /write|patch|edit|code\.|create/i;
const MEMORY_TOOL = /memory|knowledge|bib1|semantic/i;

/** Presence state from the real events of a live run (agentRuns.LiveRun). */
export function runPresenceState(run: { status: string; events: readonly AgentEvent[] }): TesseraState {
  if (run.status === 'failed') return 'error';
  if (run.status === 'done') return 'success';
  if (run.status === 'aborted') return 'idle';
  if (run.status === 'connecting' || run.status === 'reconnecting') return 'listening';
  const finished = new Set<string>();
  for (let i = run.events.length - 1; i >= 0; i--) {
    const ev = run.events[i];
    if (ev.type === 'tool_result') finished.add(ev.callId);
    else if (ev.type === 'tool_start') {
      if (finished.has(ev.callId)) return 'thinking';
      if (MEMORY_TOOL.test(ev.toolName)) return 'memory';
      if (SEARCH_TOOL.test(ev.toolName)) return 'searching';
      if (CODE_TOOL.test(ev.toolName)) return 'coding';
      return 'tool';
    } else if (ev.type === 'plan') return 'planning';
    else if (ev.type === 'error') return 'error';
    else if (ev.type === 'thought' || ev.type === 'token') return 'thinking';
  }
  return 'thinking';
}

export function TesseraPresence({ state = 'idle', size = 28, label }: { state?: TesseraState; size?: number; label?: string }) {
  const t = usePresenceClock(state);
  const bloom = `tessera-bloom-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const d = presenceDynamics(state, t);
  const { x, y } = TESSERA_CENTER;
  return (
    <svg role="img" aria-label={label ?? TESSERA_LABEL[state]} data-state={state} viewBox={TESSERA_VIEWBOX} width={size} height={size} className="shrink-0 overflow-visible">
      <defs>
        <filter id={bloom} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g transform={`translate(${x} ${y}) scale(${d.scaleX} ${d.scaleY}) translate(${-x} ${-y})`}>
        {TESSERA_OUTLINE.map((p, i) => (
          <path key={`o${i}`} d={p} style={{ fill: 'var(--mazz-bone)', stroke: d.mechanical ? 'var(--mazz-champagne)' : 'none' }} strokeWidth={d.mechanical ? 1.5 : 0} opacity={d.mechanical ? 0.95 : 0.88} />
        ))}
        {TESSERA_HIGHLIGHT.map((p, i) => (
          <path key={`h${i}`} d={p} style={{ fill: d.coreColor }} opacity={0.3 + d.veinActivity * 0.7} />
        ))}
        <circle cx={x} cy={y} r={42 * d.coreScale * 1.3} style={{ fill: d.coreGlow }} filter={`url(#${bloom})`} />
        <circle cx={x} cy={y} r={42 * d.coreScale} style={{ fill: d.coreColor }} />
        <circle cx={x} cy={y} r={22 * d.coreScale} style={{ fill: 'var(--mazz-obsidian)' }} opacity={0.8} />
      </g>
    </svg>
  );
}
