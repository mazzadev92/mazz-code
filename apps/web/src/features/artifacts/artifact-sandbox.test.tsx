import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_CSP, ArtifactSandbox, buildArtifactDocument, createNonce, parseArtifactMessage } from './ArtifactSandbox';
import { CodeBlock } from '../../components/Markdown';

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Runs the frame bootstrap against a fake window to exercise the handshake.
function bootFrame(nonce: string) {
  const doc = buildArtifactDocument('<p>x</p>', nonce);
  const script = doc.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const handlers: Record<string, Array<(e: unknown) => void>> = {};
  const parent = {};
  const win = { parent, addEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] ??= []).push(h), removeEventListener: (t: string, h: (e: unknown) => void) => (handlers[t] = (handlers[t] ?? []).filter((x) => x !== h)) };
  new Function('window', 'document', 'ResizeObserver', script)(win, { documentElement: { scrollHeight: 321 } }, undefined);
  const sent: unknown[] = [];
  const port = { postMessage: (m: unknown) => sent.push(m) };
  const fire = (t: string, e: unknown) => (handlers[t] ?? []).slice().forEach((h) => h(e));
  return { parent, port, sent, fire };
}

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
