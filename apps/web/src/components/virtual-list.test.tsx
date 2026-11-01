import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { computeWindow, VirtualList } from './VirtualList';
import { flattenTree } from '../features/code/FileTreeSidebar';
import type { TreeEntry } from '../lib/types';

const rendered = (html: string) => html.match(/data-vkey="/g)?.length ?? 0;

describe('computeWindow', () => {
  it('returns the visible slice plus overscan and spacers that preserve the total height', () => {
    const sizes = Array.from({ length: 200 }, () => 100);
    const w = computeWindow(sizes, 5000, 500, 2);
    expect(w).toEqual({ start: 48, end: 57, padTop: 4800, padBottom: 14300 });
    expect(w.padTop + (w.end - w.start) * 100 + w.padBottom).toBe(20000);
  });

  it('clamps past-the-end offsets to the last page and handles empty lists', () => {
    const w = computeWindow([50, 50, 50, 50], Number.POSITIVE_INFINITY, 100, 0);
    expect([w.start, w.end, w.padBottom]).toEqual([2, 4, 0]);
    expect(computeWindow([], 0, 100, 3)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it('honours measured variable heights', () => {
    const w = computeWindow([300, 20, 20, 20, 300], 310, 50, 0);
    expect([w.start, w.end, w.padTop]).toEqual([1, 4, 300]);
  });
});

describe('VirtualList', () => {
  const list = (anchor: 'start' | 'end') =>
    renderToStaticMarkup(
      <VirtualList count={200} scrollRef={createRef<HTMLElement>()} estimate={420} anchor={anchor} itemKey={(i) => `turn-${i}`} renderItem={(i) => <p>Tour {i}</p>} />,
    );

  it('keeps the DOM bounded for a 200-turn session', () => {
    const html = list('start');
    expect(rendered(html)).toBeLessThanOrEqual(10);
    expect(html).toContain('Tour 0');
    expect(html).not.toContain('Tour 199');
  });

  it('starts at the latest turns when anchored to the end', () => {
    const html = list('end');
    expect(rendered(html)).toBeLessThanOrEqual(10);
    expect(html).toContain('Tour 199');
    expect(html).not.toContain('Tour 0<');
    expect(html).toMatch(/aria-hidden="true" style="height:\d+px"/);
  });
});

describe('flattenTree', () => {
  const e = (path: string, isDirectory = false): TreeEntry => ({ path, name: path.split('/').pop() ?? path, isDirectory });

  it('emits rows only for open directories, with depth and notes', () => {
    const rows = flattenTree([e('src', true), e('lib', true), e('a.ts')], new Set(['src', 'lib']), {
      src: { entries: [e('src/main.ts')], error: 'Dossier tronqué à 2000 entrées.' },
      lib: { entries: [] },
    });
    expect(rows.map((r) => (r.kind === 'entry' ? `${r.depth}:${r.entry.path}` : `${r.depth}:${r.text}`))).toEqual([
      '0:src',
      '1:Dossier tronqué à 2000 entrées.',
      '1:src/main.ts',
      '0:lib',
      '1:Dossier vide',
      '0:a.ts',
    ]);
  });

  it('flattens 5000 files into rows the list windows', () => {
    const many = Array.from({ length: 5000 }, (_, i) => e(`f${i}.ts`));
    const rows = flattenTree(many, new Set(), {});
    const html = renderToStaticMarkup(
      <VirtualList count={rows.length} scrollRef={createRef<HTMLElement>()} estimate={26} overscan={12} itemKey={(i) => String(i)} renderItem={(i) => <span>{i}</span>} />,
    );
    expect(rendered(html)).toBeLessThan(60);
  });
});
