import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCompactLayout, getState, setState, useCompactLayout, COMPACT_QUERY } from '../lib/store';
import { InspectorRail } from './AppShell';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function Probe() {
  return <span>{useCompactLayout() ? 'compact' : 'wide'}</span>;
}

describe('compact layout (spec 02, <= 1366x768)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    setState({ sidebarOpen: true, inspectorOpen: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the 1366 px media query', () => {
    const queries: string[] = [];
    vi.stubGlobal('window', {
      matchMedia: (q: string) => {
        queries.push(q);
        return { matches: true, addEventListener: () => undefined, removeEventListener: () => undefined };
      },
    });
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>compact</span>');
    expect(queries).toContain(COMPACT_QUERY);
    expect(COMPACT_QUERY).toBe('(max-width: 1366px)');
  });

  it('is wide when matchMedia is unavailable', () => {
    expect(renderToStaticMarkup(<Probe />)).toBe('<span>wide</span>');
  });

  it('collapses both side panels on entering compact mode and keeps a later user choice', () => {
    applyCompactLayout(true);
    expect(getState().sidebarOpen).toBe(false);
    expect(getState().inspectorOpen).toBe(false);
    expect(localStorage.getItem('mazz.studio.sidebarOpen')).toBe('false');

    setState({ sidebarOpen: true });
    applyCompactLayout(true);
    expect(getState().sidebarOpen).toBe(true);

    applyCompactLayout(false);
    expect(getState().inspectorOpen).toBe(true);
  });

  it('does not reopen a panel the user had closed before compact mode', () => {
    setState({ inspectorOpen: false });
    applyCompactLayout(true);
    applyCompactLayout(false);
    expect(getState().inspectorOpen).toBe(false);
    expect(getState().sidebarOpen).toBe(true);
  });

  it('renders the inspector as a keyboard reachable 48 px rail', () => {
    const html = renderToStaticMarkup(<InspectorRail />);
    expect(html).toContain('w-12');
    expect(html).toContain('aria-label="Inspecteur réduit"');
    expect(html).toMatch(/<button type="button" aria-label="Déplier l’inspecteur \(Ctrl\+I\)"/);
  });
});
