import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { diffLines, diffStats, foldContext, parseUnifiedPatch } from './diff';
import { parseInline, parseMarkdown, safeHref } from './markdown';
import { SseParser } from './sse';
import { fmtBytes, fmtRate, fmtMs, redactSecrets, ND } from './format';
import { fuzzyScore } from '../components/overlays';
import { segmentEvents } from '../features/agent/TurnView';
import type { AgentEvent } from '@mazz/shared';

describe('diff', () => {
  it('detects added, removed and unchanged lines with numbering', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['context:a', 'add:B', 'del:b', 'context:c', 'add:d']);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
    const added = lines.find((l) => l.text === 'd')!;
    expect(added.newNo).toBe(4);
  });

  it('treats a null original as a new file', () => {
    const lines = diffLines(null, 'x\ny');
    expect(diffStats(lines)).toEqual({ added: 2, removed: 0 });
  });

  it('folds long unchanged regions into hunk markers', () => {
    const old = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
    const next = old.replace('l25', 'CHANGED');
    const folded = foldContext(diffLines(old, next), 2);
    expect(folded.filter((l) => l.kind === 'hunk').length).toBe(2);
    expect(folded.length).toBeLessThan(12);
  });

  it('parses git unified patches with line numbers', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+more';
    const lines = parseUnifiedPatch(patch);
    expect(lines.find((l) => l.kind === 'del')?.oldNo).toBe(4);
    expect(lines.find((l) => l.text === 'more')?.newNo).toBe(5);
  });

  it('stays fast on large inputs (fallback beyond the LCS budget)', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const t0 = performance.now();
    const lines = diffLines(a, b);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(diffStats(lines)).toEqual({ added: 3000, removed: 3000 });
  });
});

describe('markdown (safe)', () => {
  it('only keeps http(s) and mailto links', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('https://example.org')).toBe('https://example.org');
    const nodes = parseInline('[clic](javascript:alert(1))');
    expect(nodes.some((n) => n.t === 'link')).toBe(false);
    expect(nodes[0]).toEqual({ t: 'text', v: 'clic' });
  });

  it('keeps raw HTML as text (never markup)', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)>');
    expect(blocks[0]).toEqual({ t: 'p', c: [{ t: 'text', v: '<img src=x onerror=alert(1)>' }] });
  });

  it('parses fences, including an unclosed fence while streaming', () => {
    const closed = parseMarkdown('Texte\n```c\nint x;\n```\nFin');
    expect(closed.map((b) => b.t)).toEqual(['p', 'code', 'p']);
    const open = parseMarkdown('```py\nprint(1)');
    expect(open[0]).toMatchObject({ t: 'code', lang: 'py', closed: false });
  });

  it('parses GFM tables, lists and headings', () => {
    const blocks = parseMarkdown('# Titre\n\n- a\n- b\n\n| x | y |\n|---|--:|\n| 1 | 2 |');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'list', 'table']);
    const table = blocks[2] as Extract<(typeof blocks)[number], { t: 'table' }>;
    expect(table.align).toEqual([undefined, 'right']);
  });
});

describe('markdown math', () => {
  it('parses an inline dollar formula with surrounding spaces', () => {
    const nodes = parseInline(String.raw`$ \frac{5}{12} + \frac{7}{18} $`);
    expect(nodes).toEqual([{ t: 'math', v: String.raw`\frac{5}{12} + \frac{7}{18}` }]);
  });

  it('parses formulas inside a sentence', () => {
    const nodes = parseInline(String.raw`Donc $x^2$ vaut neuf.`);
    expect(nodes.map((n) => n.t)).toEqual(['text', 'math', 'text']);
    expect(nodes[1]).toEqual({ t: 'math', v: 'x^2' });
  });

  it('keeps currency and escaped dollars as text', () => {
    expect(parseInline('$5 and $10').every((n) => n.t === 'text')).toBe(true);
    expect(parseInline(String.raw`\$x\$`).every((n) => n.t === 'text')).toBe(true);
  });

  it('keeps dollars inside inline code literal', () => {
    expect(parseInline('`$x$`')).toEqual([{ t: 'code', v: '$x$' }]);
  });

  it('never parses math inside a fenced code block', () => {
    const blocks = parseMarkdown('```tex\n$\\frac{1}{2}$\n```');
    expect(blocks).toEqual([{ t: 'code', lang: 'tex', v: '$\\frac{1}{2}$', closed: true }]);
  });

  it('parses \\(...\\) and inline \\[...\\] delimiters', () => {
    expect(parseInline(String.raw`\(a+b\)`)).toEqual([{ t: 'math', v: 'a+b' }]);
    expect(parseInline(String.raw`\[a+b\]`)).toEqual([{ t: 'math', v: 'a+b', display: true }]);
  });

  it('parses multi-line display blocks', () => {
    expect(parseMarkdown('$$\n' + String.raw`\frac{1}{2}` + '\n$$')).toEqual([
      { t: 'math', v: String.raw`\frac{1}{2}`, display: true },
    ]);
    expect(parseMarkdown('\\[\na = b\n\\]')).toEqual([{ t: 'math', v: 'a = b', display: true }]);
  });

  it('keeps \\begin...\\end environments intact', () => {
    const src = '\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}';
    const blocks = parseMarkdown(src);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'math', display: true });
    const tex = (blocks[0] as { v: string }).v;
    expect(tex).toContain('\\begin{align}');
    expect(tex).toContain('\\end{align}');
  });

  it('leaves an unterminated display formula as text while streaming', () => {
    const blocks = parseMarkdown('$$\n' + String.raw`\frac{1}{2}`);
    expect(blocks[0].t).toBe('p');
    const text = (blocks[0] as { c: Array<{ t: string; v?: string }> }).c.map((n) => n.v ?? '').join('');
    expect(text).toContain('$$');
  });

  it('renders with KaTeX and refuses embedded links', () => {
    const html = katex.renderToString(String.raw`\frac{5}{12} + \frac{7}{18}`, {
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'html',
    });
    expect(html).toContain('class="katex"');
    const unsafe = katex.renderToString(String.raw`\href{javascript:alert(1)}{x}`, {
      throwOnError: false,
      trust: false,
      strict: 'ignore',
      output: 'html',
    });
    expect(unsafe).not.toContain('href="javascript');
  });
});

describe('SSE parser', () => {
  it('reassembles events split across chunks and keeps event names and ids', () => {
    const p = new SseParser();
    expect(p.push('event: meta\ndata: {"a"')).toEqual([]);
    const out = p.push(':1}\n\nid: 7\ndata: {"b":2}\n\n: heartbeat\n\n');
    expect(out).toEqual([
      { event: 'meta', data: '{"a":1}' },
      { id: '7', data: '{"b":2}' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const p = new SseParser();
    expect(p.push('data: x\r\n\r\n')).toEqual([{ data: 'x' }]);
  });
});

describe('formatting', () => {
  it('never renders a missing measurement as zero', () => {
    expect(fmtRate(undefined)).toBe(ND);
    expect(fmtMs(undefined)).toBe(ND);
    expect(fmtBytes(null)).toBe(ND);
    expect(fmtRate(0)).not.toBe(ND);
  });

  it('redacts secrets in tool arguments', () => {
    const out = redactSecrets({ apiKey: 'abc', nested: { token: 'zzz' }, note: 'clé sk-ant-api03-ABCDEFGHIJ ici' }) as Record<string, any>;
    expect(out.apiKey).toBe('••••');
    expect(out.nested.token).toBe('••••');
    expect(out.note).not.toContain('ABCDEFGHIJ');
  });
});

describe('command palette ranking', () => {
  it('ranks substring and word-start matches, ignores accents', () => {
    expect(fuzzyScore('param', 'Paramètres')).toBeGreaterThan(fuzzyScore('param', 'Configurer une clé API'));
    expect(fuzzyScore('memoire', 'Mémoire')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'Accueil')).toBe(0);
  });
});

describe('agent event segmentation', () => {
  it('pairs tool start/result and merges text runs', () => {
    const ev = (e: Partial<AgentEvent> & { type: AgentEvent['type'] }) => ({ taskId: 't', timestamp: 1, ...e }) as AgentEvent;
    const segs = segmentEvents(
      [
        ev({ type: 'token', delta: 'Bon' } as never),
        ev({ type: 'token', delta: 'jour' } as never),
        ev({ type: 'tool_start', toolName: 'fs.read', callId: 'c1', params: { path: 'a' } } as never),
        ev({ type: 'tool_result', toolName: 'fs.read', callId: 'c1', success: true, durationMs: 3, output: {} } as never),
        ev({ type: 'token', delta: 'Fin' } as never),
      ],
      true
    );
    expect(segs.map((s) => s.kind)).toEqual(['text', 'tool', 'text']);
    expect((segs[0] as { text: string }).text).toBe('Bonjour');
    expect((segs[1] as { result?: unknown }).result).toBeTruthy();
    expect((segs[2] as { streaming: boolean }).streaming).toBe(true);
  });
});
