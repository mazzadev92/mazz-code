import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_CSP, ArtifactSandbox, SANDBOX_NOTICE, buildArtifactDocument, createNonce, parseArtifactMessage } from './ArtifactSandbox';
import { CodeBlock } from '../../components/Markdown';

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Runs the frame bootstrap against a fake window to exercise the handshake.
function bootFrame(nonce: string) {
  const doc = buildArtifactDocument('<p>x</p>', nonce);
  const script = doc.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const parent = {};
  const docHandlers: Record<string, Array<(e: unknown) => void>> = {};
  const win: Record<string, unknown> = { parent, addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] ??= []).push(h), removeEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = (handlers[t] ?? []).filter((x) => x !== h)) };
  const document = { documentElement: { scrollHeight: 321 }, addEventListener: (t: string, h: (e: unknown) => void) => (docHandlers[t] ??= []).push(h) };
  new Function('window', 'document', 'ResizeObserver', script)(win, document, undefined);
  const sent: unknown[] = [];
  const port = { postMessage: (m: unknown) => sent.push(m) };
  const fire = (t: string, e: unknown) => (handlers[t] ?? []).slice().forEach((h) => h(e));
  const fireDoc = (t: string, e: unknown) => (docHandlers[t] ?? []).forEach((h) => h(e));
  return { win, parent, port, sent, fire, fireDoc };
}

describe('ArtifactSandbox security posture', () => {
  it('grants scripts only: no top navigation, popups, forms or same origin', () => {
    const html = renderToStaticMarkup(<ArtifactSandbox html="<p>a</p>" />);
    expect(html.match(/sandbox="([^"]*)"/)?.[1]).toBe('allow-scripts');
    for (const flag of ['allow-top-navigation', 'allow-same-origin', 'allow-popups', 'allow-forms']) expect(html).not.toContain(flag);
  });

  it('makes no offline claim and states that navigation can reach the network', () => {
    const html = renderToStaticMarkup(<ArtifactSandbox html="<p>a</p>" />);
    expect(html).not.toMatch(/sans réseau/i);
    expect(html).toContain(SANDBOX_NOTICE);
    expect(SANDBOX_NOTICE).toContain('peut atteindre le réseau');
  });

  it('bootstrap freezes window.open and cancels form submits and external link clicks', () => {
    const f = bootFrame('n');
    expect((f.win.open as () => unknown)()).toBeNull();
    let prevented = 0;
    const ev = (target: unknown) => ({ target, preventDefault: () => prevented++, stopImmediatePropagation: () => undefined });
    f.fireDoc('submit', ev({}));
    f.fireDoc('click', ev({ closest: () => ({ getAttribute: () => 'https://attacker.example/?d=1' }) }));
    f.fireDoc('click', ev({ closest: () => ({ getAttribute: () => '#section' }) }));
    f.fireDoc('click', ev({ closest: () => null }));
    expect(prevented).toBe(2);
  });
});

describe('ArtifactSandbox', () => {
  it('renders an allow-scripts only sandbox with the strict CSP and nonce in srcdoc', () => {
    const html = renderToStaticMarkup(<ArtifactSandbox html="<!doctype html><h1>Bonjour</h1>" />);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    const srcdoc = unescape(html.match(/srcDoc="([^"]*)"/i)?.[1] ?? '');
    expect(srcdoc.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc.match(/<!doctype/gi)).toHaveLength(1);
    expect(srcdoc).toMatch(/var expected="[0-9a-f]{32}"/);
    expect(srcdoc.endsWith('<h1>Bonjour</h1>')).toBe(true);
    expect(html).toContain('title="Aperçu HTML isolé"');
  });

  it('forbids network, framing, forms and base rewriting', () => {
    for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'"]) expect(ARTIFACT_CSP).toContain(d);
    expect(ARTIFACT_CSP).not.toMatch(/https?:|\*/);
  });

  it('generates distinct 128-bit nonces', () => {
    const a = createNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(createNonce()).not.toBe(a);
  });

  it('accepts only a ready message carrying the nonce before the handshake', () => {
    expect(parseArtifactMessage({ type: 'resize', height: 300 }, 'n1', false)).toBeNull();
    expect(parseArtifactMessage({ type: 'ready', nonce: 'other' }, 'n1', false)).toBeNull();
    expect(parseArtifactMessage({ type: 'ready', nonce: 'n1' }, 'n1', false)).toEqual({ type: 'ready' });
  });

  it('validates and clamps messages after the handshake', () => {
    expect(parseArtifactMessage({ type: 'resize', height: 99999 }, 'n1', true)).toEqual({ type: 'resize', height: 640 });
    expect(parseArtifactMessage({ type: 'resize', height: Number.NaN }, 'n1', true)).toBeNull();
    expect(parseArtifactMessage({ type: 'error', message: 'x'.repeat(1000) }, 'n1', true)).toEqual({ type: 'error', message: 'x'.repeat(300) });
    expect(parseArtifactMessage({ type: 'navigate', url: 'https://example.com' }, 'n1', true)).toBeNull();
    expect(parseArtifactMessage('ready', 'n1', true)).toBeNull();
  });

  it('frame bootstrap ignores foreign senders and wrong nonces, then binds the port', () => {
    const f = bootFrame('abc123');
    f.fire('error', { message: 'boom' });
    f.fire('message', { source: {}, data: { type: 'mazz-artifact-init', nonce: 'abc123' }, ports: [f.port] });
    f.fire('message', { source: f.parent, data: { type: 'mazz-artifact-init', nonce: 'wrong' }, ports: [f.port] });
    expect(f.sent).toEqual([]);
    f.fire('message', { source: f.parent, data: { type: 'mazz-artifact-init', nonce: 'abc123' }, ports: [f.port] });
    expect(f.sent).toEqual([{ type: 'ready', nonce: 'abc123' }, { type: 'error', message: 'boom' }, { type: 'resize', height: 321 }]);
    f.fire('message', { source: f.parent, data: { type: 'mazz-artifact-init', nonce: 'abc123' }, ports: [{ postMessage: () => { throw new Error('rebound'); } }] });
    expect(f.sent).toHaveLength(3);
  });
});

describe('CodeBlock preview entry point', () => {
  it('offers the isolated preview only for finished html blocks', () => {
    expect(renderToStaticMarkup(<CodeBlock code="<p>a</p>" lang="html" />)).toMatch(/aria-pressed="false"[^>]*>.*Aperçu<\/button>/);
    expect(renderToStaticMarkup(<CodeBlock code="<p>a</p>" lang="html" streaming />)).not.toContain('Aperçu');
    expect(renderToStaticMarkup(<CodeBlock code="let a = 1" lang="js" />)).not.toContain('Aperçu');
  });
});
