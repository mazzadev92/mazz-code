import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useReducer, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';

// DOM windowing for long lists (spec 02: 200-turn sessions, large file trees).
// Variable heights: each rendered item is measured with one shared ResizeObserver,
// unmeasured items count as `estimate`. Spacers keep scrollHeight equal to the
// full list so scroll position, scrollbars and stick-to-bottom keep working.
// ponytail: linear scan over item sizes, fine for thousands of rows; switch to a
// prefix-sum + binary search if lists reach 100k.

export interface WindowRange {
  start: number;
  end: number; // exclusive
  padTop: number;
  padBottom: number;
}

export function computeWindow(sizes: readonly number[], scrollTop: number, viewport: number, overscan: number): WindowRange {
  const total = sizes.reduce((a, b) => a + b, 0);
  const top = Math.max(0, Math.min(scrollTop, total - viewport));
  let start = 0;
  let offset = 0;
  while (start < sizes.length && offset + sizes[start] <= top) offset += sizes[start++];
  let end = start;
  let bottom = offset;
  while (end < sizes.length && bottom < top + viewport) bottom += sizes[end++];
  const first = Math.max(0, start - overscan);
  const last = Math.min(sizes.length, end + overscan);
  const padTop = sizes.slice(0, first).reduce((a, b) => a + b, 0);
  const padBottom = sizes.slice(last).reduce((a, b) => a + b, 0);
  return { start: first, end: last, padTop, padBottom };
}

// Viewport assumed before the scroller has been laid out (and during SSR/tests).
const DEFAULT_VIEWPORT = 1000;

export interface VirtualListHandle {
  /** Re-read scrollTop/clientHeight synchronously (call after setting scrollTop). */
  sync(): void;
}

export function VirtualList({
  count,
  scrollRef,
  estimate,
  overscan = 3,
  anchor = 'start',
  resetKey,
  itemKey,
  renderItem,
  itemClassName,
  handle,
}: {
  count: number;
  scrollRef: RefObject<HTMLElement | null>;
  estimate: number;
  overscan?: number;
  anchor?: 'start' | 'end';
  resetKey?: unknown;
  itemKey: (index: number) => string;
  renderItem: (index: number) => ReactNode;
  itemClassName?: string;
  handle?: Ref<VirtualListHandle>;
}) {
  const sizes = useRef(new Map<string, number>());
  const [, remeasured] = useReducer((n: number) => n + 1, 0);
  const [view, setView] = useState<{ top: number; height: number } | null>(null);
  const keyAt = useRef(itemKey);
  keyAt.current = itemKey;

  useEffect(() => {
    sizes.current.clear();
    setView(null);
  }, [resetKey]);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = { top: el.scrollTop, height: el.clientHeight };
    setView((v) => (v && v.top === next.top && v.height === next.height ? v : next));
  }, [scrollRef]);
  useImperativeHandle(handle, () => ({ sync }), [sync]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : undefined;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', sync);
      ro?.disconnect();
    };
  }, [scrollRef, sync]);

  const observer = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => {
    if (typeof ResizeObserver !== 'function') return;
    observer.current = new ResizeObserver((items) => {
      let changed = false;
      for (const it of items) {
        const key = (it.target as HTMLElement).dataset.vkey;
        const h = (it.target as HTMLElement).offsetHeight;
        if (key !== undefined && h > 0 && sizes.current.get(key) !== h) {
          sizes.current.set(key, h);
          changed = true;
        }
      }
      if (changed) remeasured();
    });
    return () => observer.current?.disconnect();
  }, []);
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node || !observer.current) return;
    observer.current.observe(node);
    return () => observer.current?.unobserve(node);
  }, []);

  const list: number[] = [];
  for (let i = 0; i < count; i++) list.push(sizes.current.get(keyAt.current(i)) ?? estimate);
  const height = view?.height || DEFAULT_VIEWPORT;
  const top = view ? view.top : anchor === 'end' ? Number.POSITIVE_INFINITY : 0;
  const win = computeWindow(list, top, height, overscan);

  const items: ReactNode[] = [];
  for (let i = win.start; i < win.end; i++) {
    const key = itemKey(i);
    items.push(
      <div key={key} ref={measure} data-vkey={key} className={itemClassName}>
        {renderItem(i)}
      </div>,
    );
  }
  return (
    <div data-virtual-count={count}>
      {win.padTop > 0 && <div aria-hidden style={{ height: win.padTop }} />}
      {items}
      {win.padBottom > 0 && <div aria-hidden style={{ height: win.padBottom }} />}
    </div>
  );
}
