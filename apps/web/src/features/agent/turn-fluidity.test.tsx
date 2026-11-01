import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@mazz/shared';
import { Markdown, splitStable } from '../../components/Markdown';
import { applyBlocks, changeBlocks, diffLines } from '../../lib/diff';
import { fmtElapsed } from './LiveStatusLine';
import { TurnView, segmentEvents, toolGroupLabel, toolOutcome } from './TurnView';

const base = { taskId: 't1' };
const start = (callId: string, toolName: string, t: number): AgentEvent => ({ ...base, type: 'tool_start', timestamp: t, toolName, callId, params: {} });
const result = (callId: string, toolName: string, t: number, success: boolean, output: unknown, error?: string): AgentEvent =>
  ({ ...base, type: 'tool_result', timestamp: t, toolName, callId, success, output, durationMs: 10, ...(error ? { error } : {}) });

function render(events: AgentEvent[], live = false) {
  return renderToStaticMarkup(
    <TurnView turn={{ prompt: 'p', mode: 'agent', modelId: 'm', providerId: 'local', status: 'done', startedAt: 1, events }} live={live} showStatus={live} />
  );
}

describe('streaming Markdown split', () => {
  it('keeps finished paragraphs in the stable prefix and the open block in the tail', () => {
    expect(splitStable('Un.\n\nDeux en cours')).toEqual(['Un.\n\n', 'Deux en cours']);
    expect(splitStable('sans ligne vide')).toEqual(['', 'sans ligne vide']);
  });

  it('never cuts inside an open code fence', () => {
    const text = 'Intro.\n\n```c\nint a;\n\nint b;';
    expect(splitStable(text)).toEqual(['Intro.\n\n', '```c\nint a;\n\nint b;']);
  });

  it('never cuts inside a multi-line display formula', () => {
    const dollars = 'Intro.\n\n$$\na = b\n\nc = d\n$$\n\nFin.';
    expect(splitStable(dollars)).toEqual(['Intro.\n\n$$\na = b\n\nc = d\n$$\n\n', 'Fin.']);
    const brackets = 'Intro.\n\n\\[\na = b\n\nc = d\n\\]\n\nFin.';
    expect(splitStable(brackets)).toEqual(['Intro.\n\n\\[\na = b\n\nc = d\n\\]\n\n', 'Fin.']);
  });

  it('renders inline and display formulas with KaTeX, never as raw TeX', () => {
    const html = renderToStaticMarkup(
      <Markdown text={'Donc $\\frac{5}{12}$ vaut moins de un.\n\n$$\na = b\n$$'} />
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain('role="math"');
    expect(html).toContain('aria-label="\\frac{5}{12}"');
    expect(html).not.toContain('$\\frac');
  });
});

describe('hunk review', () => {
  const old = 'a\nb\nc\nd\ne\nf\ng\n';
  const proposed = 'A\nb\nc\nd\ne\nf\nG\n';
  const lines = diffLines(old, proposed);

  it('splits a diff into separate change blocks', () => {
    expect(changeBlocks(lines)).toHaveLength(2);
  });

  it('writes only the accepted blocks, the current text elsewhere', () => {
    expect(applyBlocks(lines, new Set([0, 1]))).toBe(proposed);
    expect(applyBlocks(lines, new Set())).toBe(old);
    expect(applyBlocks(lines, new Set([1]))).toBe('a\nb\nc\nd\ne\nf\nG\n');
  });

  it('handles a new file', () => {
    const created = diffLines(null, 'x\ny\n');
    expect(applyBlocks(created, new Set([0]))).toBe('x\ny\n');
    expect(applyBlocks(created, new Set())).toBe('');
  });
});

describe('sub-agents', () => {
  it('keep their own tool calls inside their card', () => {
    const events: AgentEvent[] = [
      { ...base, type: 'tool_start', timestamp: 1, toolName: 'agent.delegate', callId: 'd', params: { role: 'explorer', task: 'Explorer src' } },
      { ...base, type: 'tool_start', timestamp: 2, toolName: 'fs.read', callId: 'r', params: { path: 'a.c' }, agent: 'Explorateur' },
      { ...base, type: 'tool_result', timestamp: 3, toolName: 'fs.read', callId: 'r', success: true, durationMs: 1, output: { content: 'x' }, agent: 'Explorateur' },
      { ...base, type: 'tool_result', timestamp: 4, toolName: 'agent.delegate', callId: 'd', success: true, durationMs: 3, output: { role: 'explorer', summary: 'ok', toolCalls: 1 } },
    ];
    const segs = segmentEvents(events, false);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe('agent');
    const html = render(events);
    expect(html).toContain('Sous-agent Explorateur');
    expect(html).toContain('1 outil');
  });
});

describe('tool calls', () => {
  it('summarise a closed call in one line', () => {
    expect(toolOutcome({ ...base, type: 'tool_result', timestamp: 0, toolName: 'terminal.run', callId: 'c', success: true, durationMs: 1, output: { exitCode: 0, stdout: 'a\nb\n' } })).toBe('code 0 · 2 lignes');
    expect(toolOutcome({ ...base, type: 'tool_result', timestamp: 0, toolName: 'fs.read', callId: 'c', success: false, durationMs: 1, output: null, error: '\nENOENT: no such file\nstack' })).toBe('ENOENT: no such file');
    expect(toolOutcome({ ...base, type: 'tool_result', timestamp: 0, toolName: 'code.search', callId: 'c', success: true, durationMs: 1, output: { matches: [1, 2, 3] } })).toBe('3 résultats');
  });

  it('fold consecutive calls into one labelled group, usage chips included', () => {
    const events: AgentEvent[] = [
      start('a', 'fs.read', 1), result('a', 'fs.read', 2, true, { content: 'x' }),
      start('b', 'fs.read', 3), result('b', 'fs.read', 4, true, { content: 'y' }),
      start('c', 'terminal.run', 5), result('c', 'terminal.run', 6, false, null, 'boom'),
      { ...base, type: 'complete', timestamp: 7, success: false, durationMs: 6, summary: '' },
    ];
    const tools = segmentEvents(events, false).filter((s) => s.kind === 'tool');
    expect(toolGroupLabel(tools as never)).toBe('2 lectures, 1 commande, 1 échec');
    const html = render(events);
    expect(html).toContain('2 lectures, 1 commande, 1 échec');
    // Collapsed by default: the individual cards are not rendered.
    expect(html).not.toContain('>terminal.run<');
  });

  it('render a lone call as a plain card with its outcome', () => {
    const html = render([start('a', 'terminal.run', 1), result('a', 'terminal.run', 2, true, { exitCode: 0, stdout: 'ok' })]);
    expect(html).toContain('terminal.run');
    expect(html).toContain('code 0 · 1 ligne');
  });
});

describe('live turn', () => {
  it('leaves the task list to the pinned bar while running, keeps it once finished', () => {
    const plan: AgentEvent = { ...base, type: 'plan', timestamp: 1, items: [{ content: 'Lire', status: 'in_progress' }] } as AgentEvent;
    expect(render([plan], true)).not.toContain('Liste de tâches de l’agent');
    expect(render([plan], false)).toContain('Liste de tâches de l’agent');
  });

  it('labels reasoning with its measured duration', () => {
    const html = render([
      { ...base, type: 'thought', timestamp: 1000, delta: 'je pense' },
      { ...base, type: 'thought', timestamp: 4000, delta: ' encore' },
      { ...base, type: 'token', timestamp: 4100, delta: 'Réponse.' },
    ]);
    expect(html).toMatch(/Réflexion · 3[,.]0\s?s|Réflexion · 3 s|Réflexion · 3000/);
  });

  it('offers to run a finished plan, only in Plan mode', () => {
    const events: AgentEvent[] = [
      { ...base, type: 'token', timestamp: 1, delta: '1. Lire\n2. Écrire' },
      { ...base, type: 'complete', timestamp: 2, success: true, durationMs: 1, summary: '' },
    ];
    const html = (mode: string) => renderToStaticMarkup(
      <TurnView turn={{ prompt: 'p', mode, modelId: 'm', providerId: 'local', status: 'done', startedAt: 1, events }} live={false} showStatus={false} onExecutePlan={() => undefined} />
    );
    expect(html('plan')).toContain('Exécuter ce plan');
    expect(html('agent')).not.toContain('Exécuter ce plan');
  });

  it('hides successful plan.update calls but keeps a refused one', () => {
    const ok = render([start('p', 'plan.update', 1), result('p', 'plan.update', 2, true, {})]);
    expect(ok).not.toContain('plan.update');
    const refused = render([start('p', 'plan.update', 1), result('p', 'plan.update', 2, false, null, 'plan invalide')]);
    expect(refused).toContain('plan.update');
  });

  it('formats elapsed time', () => {
    expect(fmtElapsed(4_200)).toBe('4 s');
    expect(fmtElapsed(245_000)).toBe('4 min 05 s');
  });
});
