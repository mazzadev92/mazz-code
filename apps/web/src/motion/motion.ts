// Interface motion built on anime.js and the official MAZZ springs (motion/tokens.ts).
// Hover, press and focus stay in CSS (no JS per frame); this module only drives the moments
// that carry meaning: something arrives (germinate), a tool locks in (align).
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { animate, spring } from 'animejs';
import { MAZZ_SPRINGS, type MazzSpring } from './tokens';

/** False when the user asked for reduced motion (setting or system preference). */
export function motionAllowed(): boolean {
  if (typeof document === 'undefined') return false;
  const pref = document.documentElement.dataset.motion;
  if (pref === 'reduced') return false;
  if (pref === 'full') return true;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

// anime.js clamps mass to >= 1; the DA springs keep their stiffness/damping ratio.
const ease = (name: MazzSpring) => {
  const s = MAZZ_SPRINGS[name];
  return spring({ mass: Math.max(1, s.mass), stiffness: s.stiffness, damping: s.damping });
};

/** Arrival of a message or card: seed to form, short enough never to slow reading. */
export function germinate(el: HTMLElement, name: MazzSpring = 'PRECISION', from = 8): void {
  if (!motionAllowed()) return;
  animate(el, { opacity: [0, 1], y: [from, 0], scale: [0.985, 1], ease: ease(name) });
}

/** Tool start: brief geometric lock-in (DA "rigidification"), then release. */
export function align(el: HTMLElement): void {
  if (!motionAllowed()) return;
  animate(el, { scale: [1.012, 1], ease: ease('MICRO') });
}

/** Runs `germinate` once on mount when `enabled` (live content only, never the history replay). */
export function useGerminate<T extends HTMLElement>(enabled: boolean, name: MazzSpring = 'PRECISION'): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!enabled || done.current || !ref.current) return;
    done.current = true;
    germinate(ref.current, name);
  }, [enabled, name]);
  return ref;
}
