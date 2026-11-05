import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, X } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { streamSse } from '../../lib/sse';
import { prefs } from '../../lib/prefs';
import { Button, ErrorBox, IconButton, Select, cx } from '../../components/ui';

// Spec 02 §3.3: xterm scrollback capped at 10 000 lines.
export const TERMINAL_SCROLLBACK = 10_000;

interface PtyInfo {
  id: string;
  shell: string;
  cwd: string;
  running: boolean;
}

/** Theme from the Studio's CSS tokens (Bioforge / Blueprint, light or dark). */
function themeFromCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  return { background: v('--code', v('--bg', '#0a0e0b')), foreground: v('--fg', '#ebe5d8'), cursor: v('--brand', '#c9a57a'), selectionBackground: 'rgba(201,165,122,0.3)' };
}

function TerminalView({ id, active }: { id: string; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const [exit, setExit] = useState<number | null>(null);

  useEffect(() => {
    const term = new XTerm({ fontFamily: 'JetBrains Mono, Consolas, monospace', fontSize: 12.5, cursorBlink: true, theme: themeFromCss(), scrollback: TERMINAL_SCROLLBACK, allowProposedApi: false });
    const f = new FitAddon();
    term.loadAddon(f);
    fit.current = f;
    term.open(host.current!);
    // Keystrokes are batched per animation frame: one request per burst, not per key.
    let buffer = '';
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const data = buffer;
      buffer = '';
      if (data) void api.post(`/api/pty/${id}/input`, { data }).catch(() => undefined);
    };
    const sub = term.onData((d) => {
      buffer += d;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    });
    const resize = () => {
      try {
        f.fit();
        void api.post(`/api/pty/${id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => undefined);
      } catch {
        // hidden container: fitted when shown
      }
    };
    // Spec 02 §3.3: 100 ms debounce, so dragging the window edge never floods fit() and the PTY resize endpoint.
    let resizeTimer: number | undefined;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resize, 100);
    });
    ro.observe(host.current!);
    const ctrl = new AbortController();
    void streamSse(`/api/pty/${id}/stream`, {
      method: 'GET',
      signal: ctrl.signal,
      onMessage: (m) => {
        const msg = JSON.parse(m.data) as { type: 'data'; data: string } | { type: 'exit'; exitCode: number };
        if (msg.type === 'data') term.write(msg.data);
        else setExit(msg.exitCode);
      },
    }).catch(() => undefined);
    return () => {
      ctrl.abort();
      window.clearTimeout(resizeTimer);
      ro.disconnect();
      sub.dispose();
      term.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fit.current?.fit());
  }, [active]);

  return (
    <div className={cx('h-full flex flex-col', !active && 'hidden')}>
      <div ref={host} className="flex-1 min-h-0 px-2 py-1" />
      {exit !== null && <div className="px-3 py-1 text-[11.5px] text-faint border-t border-line">Processus terminé (code {exit}).</div>}
    </div>
  );
}

/** Interactive terminals: REPLs, prompts, TUIs (Windows ConPTY). */
export function InteractiveTerminals() {
  const [list, setList] = useState<PtyInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [shell, setShell] = useState(() => prefs.get('pty.shell', 'powershell'));
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ available: boolean; terminals: PtyInfo[] }>('/api/pty')
      .then((r) => {
        setAvailable(r.available);
        setList(r.terminals);
        setActive(r.terminals[0]?.id ?? null);
      })
      .catch((e) => setError(e));
  }, []);

  const create = async () => {
    setError(null);
    try {
      const t = await api.post<PtyInfo>('/api/pty', { shell, cols: 100, rows: 30 });
      prefs.set('pty.shell', shell);
      setList((l) => [...l, { ...t, running: true }]);
      setActive(t.id);
    } catch (e) {
      setError(e);
    }
  };
  const close = async (id: string) => {
    await api.del(`/api/pty/${id}`).catch((e) => setError(errorMessage(e)));
    setList((l) => l.filter((x) => x.id !== id));
    setActive((a) => (a === id ? list.find((x) => x.id !== id)?.id ?? null : a));
  };

  if (!available) return <div className="p-3 text-[12.5px] text-faint">Terminal interactif indisponible : module node-pty absent de cette installation.</div>;
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 h-8 border-b border-line">
        {list.map((t, i) => (
          <div key={t.id} className={cx('flex items-center gap-1 h-6 pl-2 pr-0.5 rounded text-[12px] cursor-pointer', active === t.id ? 'bg-raised text-fg' : 'text-muted hover:text-fg')} onClick={() => setActive(t.id)}>
            {t.shell} {i + 1}
            <IconButton size="sm" label={`Fermer le terminal ${i + 1}`} onClick={(e) => (e.stopPropagation(), void close(t.id))}>
              <X className="w-3 h-3" />
            </IconButton>
          </div>
        ))}
        <Select value={shell} onChange={(e) => setShell(e.target.value)} aria-label="Shell" className="ml-auto h-6 text-[11.5px]">
          <option value="powershell">PowerShell</option>
          <option value="pwsh">PowerShell 7</option>
          <option value="cmd">cmd</option>
        </Select>
        <Button size="xs" variant="ghost" icon={<Plus className="w-3 h-3" />} onClick={() => void create()}>
          Nouveau
        </Button>
      </div>
      {error != null && <ErrorBox error={error} />}
      <div className="flex-1 min-h-0">
        {list.length === 0 && (
          <div className="p-3 text-[12.5px] text-faint">
            Terminal interactif dans le dossier du projet : saisie au clavier, programmes qui posent des questions, REPL.{' '}
            <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => void create()}>
              Ouvrir un terminal
            </button>
          </div>
        )}
        {list.map((t) => (
          <TerminalView key={t.id} id={t.id} active={active === t.id} />
        ))}
      </div>
    </div>
  );
}
