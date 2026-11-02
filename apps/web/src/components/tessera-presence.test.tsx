import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AgentEvent } from '@mazz/shared';
import { presenceDynamics, runPresenceState, TesseraPresence } from './TesseraPresence';
import { MazzMark } from './brand';

const ev = (e: Record<string, unknown>) => ({ taskId: 't', timestamp: 0, ...e }) as unknown as AgentEvent;

describe('Tessera presence', () => {
  it('maps real run events to presence states, planning included', () => {
    expect(runPresenceState({ status: 'failed', events: [] })).toBe('error');
    expect(runPresenceState({ status: 'done', events: [] })).toBe('success');
    expect(runPresenceState({ status: 'reconnecting', events: [] })).toBe('listening');
    expect(runPresenceState({ status: 'running', events: [ev({ type: 'plan', items: [] })] })).toBe('planning');
    expect(runPresenceState({ status: 'running', events: [ev({ type: 'tool_start', toolName: 'fs.write', callId: 'a', params: {} })] })).toBe('coding');
    expect(runPresenceState({ status: 'running', events: [ev({ type: 'tool_start', toolName: 'code.search', callId: 'a', params: {} })] })).toBe('searching');
    expect(runPresenceState({ status: 'running', events: [ev({ type: 'tool_start', toolName: 'terminal.run', callId: 'a', params: {} })] })).toBe('tool');
    expect(runPresenceState({ status: 'running', events: [ev({ type: 'tool_start', toolName: 'terminal.run', callId: 'a', params: {} }), ev({ type: 'tool_result', toolName: 'terminal.run', callId: 'a', success: true, durationMs: 1, output: '' })] })).toBe('thinking');
  });

  it('errors contract in copper glow, never rotate', () => {
    const d = presenceDynamics('error', 1);
    expect(d.coreGlow).toBe('var(--mazz-copper-glow)');
    expect(d.scaleX).toBeLessThan(1);
    expect(readFileSync(new URL('../styles/mazz-tokens.css', import.meta.url), 'utf8')).toContain('--mazz-copper-glow:');
  });

  it('renders a labelled SVG with per-instance filter ids', () => {
    const html = renderToStaticMarkup(<><TesseraPresence state="planning" /><TesseraPresence state="planning" /></>);
    expect(html).toContain('role="img" aria-label="Planification"');
    const ids = [...html.matchAll(/filter id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(renderToStaticMarkup(<MazzMark presence="tool" />)).toContain('data-state="tool"');
  });
});
