/**
 * Shell page for model-generated artifacts. The Studio's own CSP is `script-src 'self'`, which a srcdoc
 * frame inherits, so artifact scripts never run. This route has its own policy instead: inline scripts
 * and styles only, no network, no forms, and a sandbox without allow-same-origin (opaque origin, no
 * access to the Studio API or storage). The parent frame sends the artifact with
 * `postMessage({ type: 'mazz-artifact', html }, '*')` after receiving `{ type: 'mazz-artifact-ready' }`.
 */

export const ARTIFACT_SHELL_PATH = '/sandbox/artifact';

export const ARTIFACT_SHELL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

const SHELL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Artefact</title></head><body><script>
function onArtifact(e) {
  if (e.source !== parent || !e.data || e.data.type !== 'mazz-artifact' || typeof e.data.html !== 'string') return;
  removeEventListener('message', onArtifact);
  document.open(); document.write(e.data.html); document.close();
}
addEventListener('message', onArtifact);
parent.postMessage({ type: 'mazz-artifact-ready' }, '*');
</script></body></html>`;

export function artifactShellResponse(): { headers: Record<string, string>; body: string } {
  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': ARTIFACT_SHELL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    },
    body: SHELL_HTML,
  };
}
