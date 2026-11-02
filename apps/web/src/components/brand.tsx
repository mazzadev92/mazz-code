// MAZZ brand mark (official Bioforge Leaf tile from the brand board) with the
// presence states of the art direction: idle breathes, thinking pulses the core
// without rotation, tool latches, error contracts in copper, offline desaturates.

import { TesseraPresence, type TesseraState } from './TesseraPresence';

export type MarkState = 'idle' | 'thinking' | 'tool' | 'error' | 'offline';

export function MazzMark({ size = 28, state = 'idle', label, presence }: { size?: number; state?: MarkState; label?: string; presence?: TesseraState }) {
  // Live presence (Tessera leaf) driven by real run events; the tile stays the static mark.
  if (presence) return <TesseraPresence state={presence} size={size} label={label} />;
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span {...a11y} data-state={state} className="mark relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <span className="mark-art block w-full h-full">
        <img src={size > 64 ? '/brand/app-icon-512.png' : '/brand/app-icon-192.png'} alt="" width={size} height={size} draggable={false} className="block w-full h-full rounded-[23%] select-none" />
      </span>
      <span className="mark-core" style={{ left: '50%', top: '47%', width: size * 0.38, height: size * 0.38 }} />
    </span>
  );
}

/**
 * Large emblem with ground reflection. The luminous artwork only reads on dark
 * backgrounds (art direction rule), so light mode shows the app tile instead.
 */
export function MazzEmblem({ size = 120 }: { size?: number }) {
  const h = Math.round(size * 1.17);
  return (
    <span className="relative inline-grid place-items-center germinate" style={{ width: size, height: h }}>
      <img src="/brand/emblem-leaf.webp" alt="" width={size} height={h} draggable={false} className="on-dark block w-full h-full object-contain select-none" />
      <img src="/brand/app-icon-512.png" alt="" width={Math.round(size * 0.78)} height={Math.round(size * 0.78)} draggable={false} className="on-light rounded-[23%] select-none shadow-[var(--shadow-2)]" />
    </span>
  );
}

export function Wordmark({ compact }: { compact?: boolean }) {
  return (
    <span className="inline-flex flex-col leading-none select-none">
      <span className="font-display text-[13px] font-semibold tracking-[0.22em] text-fg">MAZZ</span>
      {!compact && <span className="text-[9.5px] tracking-[0.16em] text-faint mt-0.5">ÆNGENIUM STUDIO</span>}
    </span>
  );
}
