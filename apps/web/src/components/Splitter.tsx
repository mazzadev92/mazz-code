// Resizable panel handle: pointer drag, keyboard arrows, double click resets.
// Sizes are persisted per key in local preferences.
import { useCallback, useRef, useState } from 'react';
import { prefs } from '../lib/prefs';

export function usePanelSize(key: string, initial: number, min: number, max: number) {
  const [size, setSizeState] = useState(() => clamp(prefs.get(`panel.${key}`, initial), min, max));
  const setSize = useCallback(
    (v: number) => {
      const c = clamp(v, min, max);
      setSizeState(c);
      prefs.set(`panel.${key}`, c);
    },
    [key, min, max]
  );
  return { size, setSize, reset: () => setSize(initial), min, max };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * `orientation="vertical"` is a vertical bar resizing widths; `invert` when the
 * panel sits on the right/bottom of the handle (dragging left grows it).
 */
export function Splitter({ orientation, size, onResize, onReset, min, max, invert, label }: {
  orientation: 'vertical' | 'horizontal';
  size: number;
  onResize: (v: number) => void;
  onReset: () => void;
  min: number;
  max: number;
  invert?: boolean;
  label: string;
}) {
  const start = useRef<{ pos: number; size: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = { pos: orientation === 'vertical' ? e.clientX : e.clientY, size };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const pos = orientation === 'vertical' ? e.clientX : e.clientY;
    const delta = (pos - start.current.pos) * (invert ? -1 : 1);
    onResize(start.current.size + delta);
  };
  const end = () => {
    start.current = null;
    setDragging(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = orientation === 'vertical' ? (invert ? 'ArrowLeft' : 'ArrowRight') : invert ? 'ArrowUp' : 'ArrowDown';
    const shrink = orientation === 'vertical' ? (invert ? 'ArrowRight' : 'ArrowLeft') : invert ? 'ArrowDown' : 'ArrowUp';
    if (e.key === grow) onResize(size + step);
    else if (e.key === shrink) onResize(size - step);
    else if (e.key === 'Home') onResize(min);
    else if (e.key === 'End') onResize(max);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(size)}
      aria-valuemin={min}
      aria-valuemax={max}
      title={`${label} (double clic : taille par défaut)`}
      className="splitter"
      data-orientation={orientation}
      data-dragging={dragging}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
