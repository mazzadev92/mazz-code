import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ForgeEvent } from '@mazz/shared';
import { ForgeBoard, foldForge, unitStats } from './ForgeBoard';
import { segmentEvents } from './TurnView';

const base = { type: 'forge' as const, taskId: 't', timestamp: 1, blueprintId: 'crc32-ctypes' };
const events: ForgeEvent[] = [
  { ...base, phase: 'blueprint', detail: 'CRC-32', concurrency: 4, units: [{ id: 'crc32_update', file: 'src/crc32.c', lang: 'c', steps: 2 }, { id: '_load', file: 'src/crc32.py', lang: 'python', steps: 1 }] },
  { ...base, phase: 'unit_start', unitId: 'crc32_update', steps: ['crc <- ~seed', 'return ~crc'] },
  { ...base, phase: 'candidate', unitId: 'crc32_update', candidate: 1, strategy: 'stepwise', verdict: 'reject', detail: 'check vector' },
  { ...base, phase: 'candidate', unitId: 'crc32_update', candidate: 2, strategy: 'stepwise', verdict: 'pass', code: 'uint32_t crc = ~seed;' },
  { ...base, phase: 'unit_done', unitId: 'crc32_update', strategy: 'stepwise', code: 'uint32_t crc = ~seed;' },
  { ...base, phase: 'unit_start', unitId: '_load', steps: ['return lib'] },
];

describe('Forge board', () => {
  it('folds the event stream into unit states, candidates and accepted code', () => {
    const view = foldForge(events);
    expect(view.concurrency).toBe(4);
    expect(view.units.map((u) => [u.id, u.state, u.candidates.length])).toEqual([['crc32_update', 'done', 2], ['_load', 'running', 0]]);
    expect(view.units[0].code).toBe('uint32_t crc = ~seed;');
    const failed = foldForge([...events, { ...base, phase: 'summary', success: false, detail: 'échec' }]);
    expect(failed.units[1].state).toBe('failed');
  });

  it('renders one board per exchange, with real reject reasons, and hides the duplicated plan list', () => {
    const plan: AgentEvent = { type: 'plan', taskId: 't', timestamp: 2, items: [{ content: 'src/crc32.c : crc32_update', status: 'completed' }] };
    const segments = segmentEvents([events[0], plan, ...events.slice(1)], true);
    expect(segments.filter((s) => s.kind === 'forge')).toHaveLength(1);
    expect(segments.some((s) => s.kind === 'plan')).toBe(false);
    const html = renderToStaticMarkup(<ForgeBoard events={events} live />);
    expect(html).toContain('1/2 unités validées par exécution');
    expect(html).toContain('4 slots');
    expect(html).toContain('_load');
    expect(html).toContain('forge-running');
  });

  it('computes per-unit candidate stats from events only', () => {
    const [crc, load] = foldForge(events).units;
    expect(unitStats(crc)).toEqual({ passes: 1, rejects: 1, winner: 'stepwise' });
    expect(unitStats(load)).toEqual({ passes: 0, rejects: 0, winner: undefined });
    const html = renderToStaticMarkup(<ForgeBoard events={events} live />);
    expect(html).toContain('Statistiques des candidats');
    expect(html).toContain('Unité _load, en cours, 0 candidat(s)');
    expect(html).toContain('Unité crc32_update, validée, 2 candidat(s)');
  });

  it('lists written files as buttons only once the files phase arrived', () => {
    expect(renderToStaticMarkup(<ForgeBoard events={events} live onOpenFile={() => {}} />)).not.toContain('Fichiers écrits');
    const withFiles: ForgeEvent[] = [...events, { ...base, phase: 'files', files: ['src/crc32.c', 'src/crc32.py'] }];
    expect(foldForge(withFiles).written).toEqual(['src/crc32.c', 'src/crc32.py']);
    const html = renderToStaticMarkup(<ForgeBoard events={withFiles} live onOpenFile={() => {}} />);
    expect(html).toContain('Fichiers écrits');
    expect(html.match(/title="Ouvrir dans l’éditeur"/g)).toHaveLength(2);
  });
});
