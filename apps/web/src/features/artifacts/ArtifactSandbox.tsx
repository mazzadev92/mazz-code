import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui';

// Isolated preview of agent-produced HTML, built only on web standards:
// - iframe sandbox="allow-scripts" WITHOUT allow-same-origin: opaque origin, no
//   cookies/storage of the Studio, no top navigation, no popups, no forms;
// - strict CSP injected as the first element of the srcdoc (no network at all);
// - handshake: the parent transfers a MessagePort with a per-render nonce, the
//   frame bootstrap accepts it only from window.parent with that nonce, and the
//   parent never listens to window "message" events (only to its own port);
// - the frame loads the Studio's ARTIFACT_SHELL_PATH, served with its own CSP and
//   `sandbox allow-scripts` (a srcdoc would inherit the Studio's script-src 'self'
//   and never run artifact scripts). Load 1 is the shell: the document is sent to
//   it and written in place. Load 2 is that written document: the port handshake
//   happens then. Any later load means the content navigated away: frame destroyed.
// Limits (stated in the UI): the frame can still navigate itself (location.href =
// ...), which reaches the network before that load fires; Location is
// unforgeable so this cannot be fully blocked in a browser. The bootstrap only
// neutralises window.open, form submission and link clicks as best effort.

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const INIT = 'mazz-artifact-init';
/** Served by packages/core (artifact-shell.ts); proxied by Vite in development. */
export const ARTIFACT_SHELL_PATH = '/sandbox/artifact';
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 640;
const MAX_ERRORS = 5;
// Without a handshake by then, the host CSP blocked the frame scripts.
const HANDSHAKE_TIMEOUT_MS = 1500;

export const SANDBOX_NOTICE =
  'Scripts non fiables exécutés dans un cadre isolé (origine opaque, sans accès au Studio). Une navigation du cadre peut atteindre le réseau : le navigateur ne permet pas de la bloquer entièrement, le cadre est détruit dès qu’elle survient.';
export const STATIC_NOTICE = 'Scripts bloqués par la politique de sécurité de la page hôte : rendu HTML et CSS seulement.';

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Runs inside the frame before any artifact script. Messages emitted before the
// handshake are queued (bounded) and flushed once the port arrives.
function bootstrap(nonce: string): string {
  return `(function(){var expected=${JSON.stringify(nonce)},port=null,queue=[];
try{Object.defineProperty(window,"open",{value:function(){return null;},writable:false,configurable:false});}catch(_){}
document.addEventListener("submit",function(e){e.preventDefault();e.stopImmediatePropagation();},true);
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(a&&a.getAttribute("href").charAt(0)!=="#"){e.preventDefault();e.stopImmediatePropagation();}},true);
function post(m){if(port)port.postMessage(m);else if(queue.length<20)queue.push(m);}
function report(){post({type:"resize",height:Math.ceil(document.documentElement.scrollHeight)});}
function onInit(e){var d=e.data;if(e.source!==window.parent||!d||d.type!==${JSON.stringify(INIT)}||d.nonce!==expected||!e.ports||!e.ports[0])return;
window.removeEventListener("message",onInit);port=e.ports[0];port.postMessage({type:"ready",nonce:expected});expected=null;
for(var i=0;i<queue.length;i++)port.postMessage(queue[i]);queue=[];report();}
window.addEventListener("message",onInit);
window.addEventListener("load",report);
window.addEventListener("error",function(ev){post({type:"error",message:String(ev.message||"Erreur de script")});});
if(typeof ResizeObserver==="function")new ResizeObserver(report).observe(document.documentElement);})();`;
}

export function buildArtifactDocument(html: string, nonce: string): string {
  const body = html.replace(/^\s*<!doctype[^>]*>/i, '');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><script>${bootstrap(nonce)}</script>${body}`;
}

export type ArtifactMessage = { type: 'ready' } | { type: 'resize'; height: number } | { type: 'error'; message: string };

/** Validates a message received on the port; anything unexpected is dropped. */
export function parseArtifactMessage(data: unknown, nonce: string, ready: boolean): ArtifactMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (!ready) return m.type === 'ready' && m.nonce === nonce ? { type: 'ready' } : null;
  if (m.type === 'resize' && typeof m.height === 'number' && Number.isFinite(m.height)) {
    return { type: 'resize', height: Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(m.height))) };
  }
  if (m.type === 'error' && typeof m.message === 'string') return { type: 'error', message: m.message.slice(0, 300) };
  return null;
}

type FrameState = { phase: 'loading' | 'ready' | 'static' | 'navigated'; height: number; errors: string[] };
const INITIAL: FrameState = { phase: 'loading', height: 240, errors: [] };

export function ArtifactSandbox({ html, title = 'Aperçu HTML isolé' }: { html: string; title?: string }) {
  const [generation, setGeneration] = useState(0);
  // A fresh nonce per document and per reload: an old port can never be reused.
  const nonce = useMemo(() => createNonce(), [html, generation]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = useMemo(() => buildArtifactDocument(html, nonce), [html, nonce]);
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const loads = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [state, setState] = useState<FrameState>(INITIAL);

  useEffect(() => {
    loads.current = 0;
    setState(INITIAL);
    return () => {
      clearTimeout(timer.current);
      port.current?.close();
      port.current = null;
    };
  }, [doc]);

  const onLoad = () => {
    loads.current += 1;
    const win = frame.current?.contentWindow;
    if (loads.current === 1 && win) {
      // The shell writes the document in place; it is model output, not a secret. Opaque origin: "*" is required.
      win.postMessage({ type: 'mazz-artifact', html: doc }, '*'); // nosemgrep: wildcard-postmessage-configuration
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState((s) => (s.phase === 'loading' ? { ...s, phase: 'static' } : s)), HANDSHAKE_TIMEOUT_MS);
      return;
    }
    if (loads.current > 2 || !win) {
      clearTimeout(timer.current);
      port.current?.close();
      port.current = null;
      setState((s) => ({ ...s, phase: 'navigated' }));
      return;
    }
    const channel = new MessageChannel();
    let ready = false;
    channel.port1.onmessage = (e: MessageEvent) => {
      const msg = parseArtifactMessage(e.data, nonce, ready);
      if (!msg) return;
      if (msg.type === 'ready') {
        ready = true;
        clearTimeout(timer.current);
        setState((s) => ({ ...s, phase: 'ready' }));
      } else if (msg.type === 'resize') {
        setState((s) => (s.height === msg.height ? s : { ...s, height: msg.height }));
      } else {
        setState((s) => ({ ...s, errors: [...s.errors, msg.message].slice(-MAX_ERRORS) }));
      }
    };
    port.current?.close();
    port.current = channel.port1;
    if (win !== frame.current?.contentWindow || loads.current !== 2) return;
    // Opaque origin (sandbox without allow-same-origin): "*" is the only valid target; payload is nonce + port only.
    win.postMessage({ type: INIT, nonce }, '*', [channel.port2]); // nosemgrep: wildcard-postmessage-configuration
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => (s.phase === 'loading' ? { ...s, phase: 'static' } : s)), HANDSHAKE_TIMEOUT_MS);
  };

  if (state.phase === 'navigated') {
    return (
      <div role="alert" className="flex items-center gap-3 px-3 py-2 text-[12px] text-warn border-t border-line bg-sunk">
        <span className="flex-1">L’aperçu a tenté de quitter son document : le cadre a été détruit.</span>
        <Button size="sm" variant="ghost" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => setGeneration((g) => g + 1)}>
          Recharger
        </Button>
      </div>
    );
  }

  return (
    <div className="border-t border-line bg-[var(--bg)]">
      <iframe
        key={generation}
        ref={frame}
        title={title}
        sandbox="allow-scripts"
        src={ARTIFACT_SHELL_PATH}
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        className="block w-full bg-white"
        style={{ height: state.height }}
      />
      <div className="px-3 py-1.5 space-y-0.5 text-[11px] text-faint">
        <p>{SANDBOX_NOTICE}</p>
        <p role="status" className="font-mono">
          {state.phase === 'ready' ? 'Cadre connecté.' : state.phase === 'static' ? STATIC_NOTICE : 'Connexion au cadre isolé'}
          {state.errors.length > 0 && <span className="text-bad"> Erreur : {state.errors[state.errors.length - 1]}</span>}
        </p>
      </div>
    </div>
  );
}
