// Segment micro-indicators ported from Laef (ai-status/StatusIndicators.tsx), remapped
// to the synced --mazz-* tokens. Decorative: the segment text carries the meaning,
// so they are aria-hidden. Motion only while `active`; reduced motion is frozen by CSS.

export type IndicatorKind = 'thinking' | 'tool' | 'search' | 'memory' | 'error';

const SEARCH = /search|grep|find|glob|web\.|index/i;
const MEMORY = /memory|knowledge|bib1|semantic/i;

/** Indicator for a tool name: memory and search tools get their own figure. */
export function toolIndicatorKind(toolName: string): IndicatorKind {
  if (MEMORY.test(toolName)) return 'memory';
  if (SEARCH.test(toolName)) return 'search';
  return 'tool';
}

export function StatusIndicator({ kind, active = false, size = 14 }: { kind: IndicatorKind; active?: boolean; size?: number }) {
  const spin = active ? 'seed-spin' : undefined;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden data-indicator={kind} className="shrink-0 overflow-visible">
      {kind === 'thinking' && (
        <g className={spin} style={{ transformBox: 'fill-box', transformOrigin: 'center' }}>
          <circle cx="50" cy="50" r="38" fill="none" style={{ stroke: 'var(--mazz-living-green)' }} strokeWidth="8" strokeDasharray="28 14" />
          <circle cx="50" cy="50" r="22" fill="none" style={{ stroke: 'var(--mazz-champagne)' }} strokeWidth="7" strokeDasharray="18 10" />
          <circle cx="50" cy="50" r="9" style={{ fill: 'var(--mazz-bone)' }} />
        </g>
      )}
      {kind === 'tool' && (
        <g>
          <rect x="18" y="18" width="64" height="64" rx="6" fill="none" style={{ stroke: 'var(--mazz-champagne)' }} strokeWidth="8" />
          <rect x="38" y="38" width="24" height="24" rx="3" className={active ? 'animate-pulse' : undefined} style={{ fill: 'var(--mazz-bone)' }} />
        </g>
      )}
      {kind === 'search' && (
        <g>
          <circle cx="44" cy="44" r="26" fill="none" style={{ stroke: 'var(--mazz-sage)' }} strokeWidth="8" />
          <path d="M63 63 L84 84" style={{ stroke: 'var(--mazz-sage)' }} strokeWidth="10" strokeLinecap="round" />
          <circle cx="44" cy="44" r="8" className={active ? 'animate-pulse' : undefined} style={{ fill: 'var(--mazz-white)' }} />
        </g>
      )}
      {kind === 'memory' && (
        <g>
          <path d="M50 12 L84 31 L84 69 L50 88 L16 69 L16 31 Z" fill="none" style={{ stroke: 'var(--mazz-living-green)' }} strokeWidth="8" strokeLinejoin="round" />
          <circle cx="50" cy="50" r="13" className={active ? 'animate-pulse' : undefined} style={{ fill: 'var(--mazz-sage)' }} />
        </g>
      )}
      {kind === 'error' && (
        <g>
          <circle cx="50" cy="50" r="36" fill="none" style={{ stroke: 'var(--mazz-copper)' }} strokeWidth="8" />
          <path d="M50 30 L50 56" style={{ stroke: 'var(--mazz-copper)' }} strokeWidth="9" strokeLinecap="round" />
          <circle cx="50" cy="70" r="5" style={{ fill: 'var(--mazz-copper)' }} />
        </g>
      )}
    </svg>
  );
}
