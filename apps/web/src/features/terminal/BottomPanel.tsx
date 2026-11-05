import { InteractiveTerminals } from './InteractiveTerminal';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Download, Eraser, Play, Plus, Square, X } from '../../components/icons';
import { streamSse } from '../../lib/sse';
import { api, errorMessage } from '../../lib/api';
import type { AuditEntry, ShellInfo } from '../../lib/types';
import { setState, togglePanel, useApp } from '../../lib/store';
import { fmtMs, fmtTime } from '../../lib/format';
import { Badge, IconButton, Input, Select, Spinner, Tabs, cx } from '../../components/ui';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const LINE_H = 18;

interface TermLine {
  text: string;
  kind: 'out' | 'err' | 'cmd' | 'info';
}

/** Fixed-height line virtualization: only visible lines are in the DOM. */
export function VirtualLog({ lines, follow }: { lines: TermLine[]; follow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(200);
  const stick = useRef(true);
  // Scrolls caused by following the output must not be mistaken for the user scrolling up.
  const programmatic = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow && stick.current && el.scrollTop !== el.scrollHeight - el.clientHeight) {
      programmatic.current = true;
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [lines.length, follow]);
  const start = Math.max(0, Math.floor(scrollTop / LINE_H) - 20);
  const end = Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_H) + 20);
  return (
    <div
      ref={ref}
      className="h-full overflow-auto font-mono text-[12px] bg-code"
      onScroll={(e) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        if (programmatic.current) {
          programmatic.current = false;
          return;
        }
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      role="log"
      aria-live="off"
    >
      <div style={{ height: lines.length * LINE_H, position: 'relative', minWidth: '100%' }}>
        {lines.slice(start, end).map((l, i) => (
          <div key={start + i} className={cx('absolute left-0 px-3 whitespace-pre', l.kind === 'err' ? 'text-bad' : l.kind === 'cmd' ? 'text-brand' : l.kind === 'info' ? 'text-faint' : 'text-fg')} style={{ top: (start + i) * LINE_H, height: LINE_H, lineHeight: `${LINE_H}px` }}>
            {l.text || ' '}
          </div>
        ))}
      </div>
    </div>
  );
}

interface TermTab {
  id: string;
  title: string;
  lines: TermLine[];
  history: string[];
  running?: { runId: string; ctrl: AbortController; startedAt: number };
  lastExit?: { code: number | null; durationMs: number; timedOut?: boolean; cancelled?: boolean };
  shell: ShellInfo['id'];
}

function Terminal() {
  const settings = useApp((s) => s.settings);
  const workspace = useApp((s) => s.health?.workspace.workspaceRoot);
  const maxLines = settings?.terminal.maxLines ?? 5000;
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [tabs, setTabs] = useState<TermTab[]>(() => [{ id: 't1', title: 'Terminal 1', lines: [{ kind: 'info', text: 'Exécution de commandes non interactive : chaque commande lance un processus, la sortie est diffusée en direct. Pas de PTY : un programme qui attend une saisie clavier bloquera jusqu’au délai maximal.' }], history: [], shell: 'powershell' }]);
  const [active, setActive] = useState('t1');
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState(-1);
  const tab = tabs.find((t) => t.id === active)!;

  useEffect(() => {
    api
      .get<{ shells: ShellInfo[] }>('/api/terminal/shells')
      .then((r) => setShells(r.shells))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (settings) setTabs((ts) => ts.map((t) => (t.history.length === 0 && t.shell === 'powershell' ? { ...t, shell: settings.terminal.shell } : t)));
  }, [settings?.terminal.shell]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id: string, fn: (t: TermTab) => TermTab) => setTabs((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  const append = (id: string, chunk: string, kind: TermLine['kind']) =>
    update(id, (t) => {
      const parts = chunk.replace(ANSI, '').replace(/\r\n/g, '\n').split('\n');
      const lines = [...t.lines];
      // A chunk continues the last line (empty after a trailing newline) of the same stream.
      if (lines.length && lines[lines.length - 1].kind === kind) {
        lines[lines.length - 1] = { kind, text: lines[lines.length - 1].text + parts.shift() };
      }
      for (const p of parts) lines.push({ kind, text: p });
      return { ...t, lines: lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines };
    });

  const run = async () => {
    const command = input.trim();
    if (!command || tab.running) return;
    const id = tab.id;
    const runId = `run_${Date.now().toString(36)}`;
    const ctrl = new AbortController();
    setInput('');
    setHistIdx(-1);
    update(id, (t) => ({ ...t, history: [...t.history.filter((h) => h !== command), command].slice(-100), running: { runId, ctrl, startedAt: Date.now() }, lastExit: undefined, lines: [...t.lines, { kind: 'cmd', text: `${t.shell === 'cmd' ? '>' : 'PS>'} ${command}` }] }));
    try {
      await streamSse('/api/terminal/run', {
        body: { command, shell: tab.shell, runId },
        signal: ctrl.signal,
        onMessage: (m) => {
          const c = JSON.parse(m.data);
          if (c.type === 'stdout') append(id, c.data, 'out');
          else if (c.type === 'stderr') append(id, c.data, 'err');
          else if (c.type === 'error') append(id, `Erreur : ${c.data}`, 'err');
          else if (c.type === 'exit') {
            update(id, (t) => ({ ...t, lastExit: { code: c.exitCode, durationMs: c.durationMs, timedOut: c.timedOut, cancelled: c.cancelled }, lines: [...t.lines, { kind: 'info', text: `[code ${c.exitCode ?? 'N/D'} - ${fmtMs(c.durationMs)}${c.timedOut ? ' - délai dépassé' : ''}${c.cancelled ? ' - annulé' : ''}]` }] }));
          }
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') append(id, errorMessage(err), 'err');
    } finally {
      update(id, (t) => ({ ...t, running: undefined }));
    }
  };

  const cancel = async () => {
    if (!tab.running) return;
    await api.post('/api/terminal/cancel', { runId: tab.running.runId }).catch(() => undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void run();
    } else if (e.key === 'ArrowUp' && tab.history.length) {
      e.preventDefault();
      const n = Math.min(histIdx + 1, tab.history.length - 1);
      setHistIdx(n);
      setInput(tab.history[tab.history.length - 1 - n]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const n = histIdx - 1;
      setHistIdx(n);
      setInput(n < 0 ? '' : tab.history[tab.history.length - 1 - n]);
    } else if (e.key === 'c' && e.ctrlKey && tab.running) {
      e.preventDefault();
      void cancel();
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 h-8 border-b border-line">
        {tabs.map((t) => (
          <div key={t.id} className={cx('flex items-center gap-1 pl-2 pr-0.5 h-6 rounded text-[12px] cursor-pointer', t.id === active ? 'bg-raised text-fg' : 'text-muted hover:text-fg')} onClick={() => setActive(t.id)}>
            {t.running && <Spinner size={9} />}
            {t.title}
            {tabs.length > 1 && (
              <button
                type="button"
                aria-label={`Fermer ${t.title}`}
                className="w-4 h-4 grid place-items-center rounded hover:bg-sunk cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  t.running?.ctrl.abort();
                  const rest = tabs.filter((x) => x.id !== t.id);
                  setTabs(rest);
                  if (active === t.id) setActive(rest[0].id);
                }}
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
        <IconButton
          size="sm"
          label="Nouveau terminal"
          onClick={() => {
            const id = `t${Date.now()}`;
            setTabs((ts) => [...ts, { id, title: `Terminal ${ts.length + 1}`, lines: [], history: [], shell: settings?.terminal.shell ?? 'powershell' }]);
            setActive(id);
          }}
        >
          <Plus className="w-3.5 h-3.5" />
        </IconButton>
        <div className="ml-auto flex items-center gap-2">
          <Select value={tab.shell} onChange={(e) => update(tab.id, (t) => ({ ...t, shell: e.target.value as ShellInfo['id'] }))} aria-label="Shell" className="h-6 text-[11.5px]">
            {shells.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.available}>
                {s.label}
                {s.available ? '' : ' (absent)'}
              </option>
            ))}
          </Select>
          {tab.lastExit && <Badge tone={tab.lastExit.code === 0 ? 'good' : 'bad'}>code {tab.lastExit.code ?? 'N/D'}</Badge>}
          <IconButton size="sm" label="Effacer" onClick={() => update(tab.id, (t) => ({ ...t, lines: [] }))}>
            <Eraser className="w-3.5 h-3.5" />
          </IconButton>
          <IconButton
            size="sm"
            label="Exporter la sortie"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([tab.lines.map((l) => l.text).join('\n')], { type: 'text/plain' }));
              const a = document.createElement('a');
              a.href = url;
              a.download = `${tab.title}.log`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            <Download className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <VirtualLog lines={tab.lines} follow />
      </div>
      <div className="flex items-center gap-2 px-2 h-9 border-t border-line">
        <span className="text-[11px] text-faint font-mono truncate max-w-[200px]" title={workspace}>
          {workspace?.split(/[\\/]/).pop()}
        </span>
        <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder={tab.running ? 'Commande en cours (Ctrl+C pour annuler)' : 'Commande, puis Entrée'} aria-label="Commande" className="h-7 font-mono text-[12px]" disabled={!!tab.running} />
        {tab.running ? (
          <IconButton label="Annuler la commande" onClick={cancel}>
            <Square className="w-3.5 h-3.5 text-bad" />
          </IconButton>
        ) : (
          <IconButton label="Exécuter" onClick={() => void run()} disabled={!input.trim()}>
            <Play className="w-3.5 h-3.5" />
          </IconButton>
        )}
      </div>
    </div>
  );
}

function LlamaLogs() {
  const [lines, setLines] = useState<Array<{ t: number; stream: string; text: string }>>([]);
  const [filter, setFilter] = useState('');
  const seq = useRef(0);
  const llamaState = useApp((s) => s.llama?.state);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.get<{ lines: Array<{ t: number; stream: string; text: string }>; seq: number }>(`/api/models/server/logs?since=${seq.current}`);
        if (!alive) return;
        if (r.seq < seq.current) setLines(r.lines);
        else if (r.lines.length) setLines((l) => [...l, ...r.lines].slice(-2000));
        seq.current = r.seq;
      } catch {
        // offline
      }
    };
    void poll();
    const id = window.setInterval(() => !document.hidden && poll(), llamaState === 'starting' ? 1000 : 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [llamaState]);
  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return lines.filter((l) => !q || l.text.toLowerCase().includes(q)).map((l) => ({ kind: (l.stream === 'system' ? 'info' : /error|failed|erreur/i.test(l.text) ? 'err' : 'out') as TermLine['kind'], text: `${fmtTime(l.t)}  ${l.text}` }));
  }, [lines, filter]);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 h-8 border-b border-line">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer le journal llama-server" aria-label="Filtrer" className="h-6 max-w-xs text-[12px]" />
        <span className="text-[11px] text-faint">{shown.length} ligne(s), 600 conservées côté serveur</span>
      </div>
      <div className="flex-1 min-h-0">
        {lines.length === 0 ? <p className="p-3 text-[12px] text-faint">Aucune sortie : llama-server n’a pas été démarré depuis le lancement du Studio.</p> : <VirtualLog lines={shown} follow />}
      </div>
    </div>
  );
}

function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [kind, setKind] = useState('all');
  useEffect(() => {
    const load = () =>
      api
        .get<{ entries: AuditEntry[] }>('/api/audit?limit=500')
        .then((r) => setEntries(r.entries))
        .catch(() => setEntries([]));
    void load();
    const id = window.setInterval(() => !document.hidden && load(), 5000);
    return () => clearInterval(id);
  }, []);
  const kinds = Array.from(new Set(entries?.map((e) => e.kind) ?? []));
  const shown = (entries ?? []).filter((e) => kind === 'all' || e.kind === kind);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 h-8 border-b border-line">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type d’événement" className="h-6 text-[11.5px]">
          <option value="all">Tous</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <span className="text-[11px] text-faint">Journal d’audit local : approbations, refus, écritures, commandes, Git, clés (masquées).</span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[12px]">
          <tbody className="divide-y divide-line">
            {shown.map((e, i) => (
              <tr key={i}>
                <td className="px-3 py-1 text-faint tabular whitespace-nowrap">{fmtTime(e.t)}</td>
                <td className="px-2 py-1 font-mono text-muted">{e.kind}</td>
                <td className="px-2 py-1 font-mono text-fg">{e.action}</td>
                <td className="px-2 py-1">{e.decision && <Badge tone={e.decision === 'allowed' ? 'good' : e.decision === 'denied' ? 'bad' : 'warn'}>{e.decision === 'allowed' ? 'autorisé' : e.decision === 'denied' ? 'refusé' : 'expiré'}</Badge>}</td>
                <td className="px-2 py-1 text-muted truncate max-w-[600px]">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries && shown.length === 0 && <p className="p-3 text-[12px] text-faint">Aucune entrée.</p>}
      </div>
    </div>
  );
}

export default function BottomPanel() {
  const tab = useApp((s) => s.bottomTab);
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center pr-1 border-b border-line">
        <Tabs<'terminal' | 'interactive' | 'logs' | 'audit'>
          className="flex-1 border-b-0 px-2"
          value={tab}
          onChange={(t) => setState({ bottomTab: t })}
          tabs={[
            { id: 'terminal', label: 'Terminal' },
            { id: 'interactive', label: 'Interactif' },
            { id: 'logs', label: 'Journal llama-server' },
            { id: 'audit', label: 'Audit' },
          ]}
        />
        <IconButton size="sm" label="Fermer le panneau (Ctrl+J)" onClick={() => togglePanel('bottomOpen', false)}>
          <X className="w-3.5 h-3.5" />
        </IconButton>
      </div>
      <div className="flex-1 min-h-0">
        {/* Terminal stays mounted to keep running commands and history across tab switches. */}
        <div className={cx('h-full', tab !== 'terminal' && 'hidden')}>
          <Terminal />
        </div>
        <div className={cx('h-full', tab !== 'interactive' && 'hidden')}>
          <InteractiveTerminals />
        </div>
        {tab === 'logs' && <LlamaLogs />}
        {tab === 'audit' && <AuditLogPanel />}
      </div>
    </div>
  );
}
