import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, ArrowUp, Check, ChevronRight, File, Folder, HardDrive, Info, Search, X } from 'lucide-react';
import { dismissToast, useApp } from '../lib/store';
import { api, qs } from '../lib/api';
import { basename, fmtBytes } from '../lib/format';
import { Button, Dialog, ErrorBox, Input, Kbd, Spinner, cx } from './ui';

// ---------------------------------------------------------------- toasts

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="fixed bottom-9 right-4 z-[var(--z-toast)] flex flex-col gap-2 w-[340px] pointer-events-none" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => {
        const Icon = t.tone === 'good' ? Check : t.tone === 'info' ? Info : AlertTriangle;
        const color = { good: 'text-good', info: 'text-info', warn: 'text-warn', bad: 'text-bad' }[t.tone];
        return (
          <div key={t.id} role={t.tone === 'bad' ? 'alert' : 'status'} className="pointer-events-auto flex gap-2.5 p-3 rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] fade-up">
            <Icon className={cx('w-4 h-4 mt-0.5 shrink-0', color)} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-fg">{t.title}</div>
              {t.detail && <div className="text-[12px] text-muted mt-0.5 break-words">{t.detail}</div>}
            </div>
            <button type="button" aria-label="Fermer la notification" onClick={() => dismissToast(t.id)} className="text-faint hover:text-fg cursor-pointer self-start">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- command palette

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon?: ReactNode;
  keywords?: string;
  run: () => void;
}

/** Subsequence match score: consecutive and word-start matches rank higher. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!q) return 1;
  if (t.includes(q)) return 100 - t.indexOf(q);
  let score = 0;
  let ti = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak * 2 + (found === 0 || /\W/.test(t[found - 1]) ? 3 : 0);
    ti = found + 1;
  }
  return score;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, s: Math.max(fuzzyScore(query, c.label), fuzzyScore(query, `${c.group} ${c.keywords ?? ''}`) * 0.6) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
      .slice(0, 60);
  }, [query, commands]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };
  return (
    <div className="fixed inset-0 z-[var(--z-palette)] flex items-start justify-center pt-[12vh] px-4 bg-black/45 fade-in" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Palette de commandes" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-[580px] rounded-[var(--radius-xl)] border border-line bg-panel shadow-[var(--shadow-2)] overflow-hidden fade-up">
        <div className="flex items-center gap-3 px-4 h-12 border-b border-line">
          <Search className="w-4 h-4 text-brand shrink-0" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder="Aller à une page, une session, une action..."
            aria-label="Rechercher une commande"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={`palette-${active}`}
            className="flex-1 bg-transparent outline-none text-[14px] text-fg placeholder:text-faint"
          />
          <Kbd>Échap</Kbd>
        </div>
        <div id="palette-list" ref={listRef} role="listbox" className="max-h-[52vh] overflow-y-auto py-1">
          {results.length === 0 && <p className="px-4 py-6 text-[13px] text-muted text-center">Aucune commande ne correspond.</p>}
          {results.map((c, i) => {
            const header = !query.trim() && c.group !== results[i - 1]?.group;
            return (
              <div key={c.id}>
                {header && <div className="px-4 pt-2.5 pb-1 text-[10.5px] uppercase tracking-[0.14em] text-faint">{c.group}</div>}
                <button
                  id={`palette-${i}`}
                  data-index={i}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cx('w-full flex items-center gap-3 px-4 h-9 text-left text-[13px] cursor-pointer', i === active ? 'bg-raised text-fg' : 'text-muted')}
                >
                  <span className="w-4 h-4 shrink-0 text-faint grid place-items-center">{c.icon}</span>
                  <span className="truncate flex-1">{c.label}</span>
                  <span className="shrink-0 text-[11px] text-faint">{c.hint ?? (query.trim() ? c.group : '')}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- path picker

interface BrowseResult {
  path: string | null;
  parent: string | null;
  entries: Array<{ name: string; path: string; isDirectory: boolean; sizeBytes?: number }>;
}

/**
 * Picks a folder (or a file with `ext`) on the local machine. Offers the native
 * Windows dialog and an in-app browser backed by /api/fs/browse.
 */
export function PathPicker({ open, onClose, onPick, mode, ext, title, initial }: { open: boolean; onClose: () => void; onPick: (path: string) => void; mode: 'folder' | 'file'; ext?: string; title: string; initial?: string }) {
  const [current, setCurrent] = useState<string | undefined>(initial);
  const [data, setData] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(initial || '');
  const [nativeBusy, setNativeBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<BrowseResult>(`/api/fs/browse${qs({ path: current, ext: mode === 'file' ? ext : undefined })}`, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => (e as Error).name !== 'AbortError' && setError(e))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [open, current, ext, mode]);

  useEffect(() => {
    if (open) {
      setCurrent(initial && mode === 'folder' ? initial : undefined);
      setManual(initial || '');
    }
  }, [open, initial, mode]);

  const native = async () => {
    setNativeBusy(true);
    try {
      const { path } = await api.post<{ path: string | null }>(mode === 'folder' ? '/api/dialog/folder' : '/api/dialog/file', { filter: ext === '.gguf' ? 'gguf' : ext === '.exe' ? 'exe' : 'any', initial: current });
      if (path) {
        onPick(path);
        onClose();
      }
    } catch (err) {
      setError(err);
    } finally {
      setNativeBusy(false);
    }
  };

  const crumbs = data?.path ? data.path.split(/[\\/]/).filter(Boolean) : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width={640}
      description={mode === 'folder' ? 'Sélectionnez un dossier local. Rien n’est copié ni déplacé.' : `Sélectionnez un fichier ${ext ?? ''}. Le fichier reste à son emplacement.`}
      footer={
        <>
          <Button variant="ghost" onClick={native} loading={nativeBusy} className="mr-auto">
            Dialogue Windows
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          {mode === 'folder' && (
            <Button
              variant="primary"
              disabled={!data?.path}
              onClick={() => {
                if (data?.path) {
                  onPick(data.path);
                  onClose();
                }
              }}
            >
              Choisir ce dossier
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!manual.trim()) return;
            if (mode === 'file' && ext && manual.toLowerCase().endsWith(ext)) {
              onPick(manual.trim());
              onClose();
            } else setCurrent(manual.trim());
          }}
        >
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={mode === 'folder' ? 'D:\\Projets\\mon-projet' : `D:\\modeles\\modele${ext ?? ''}`} aria-label="Chemin" className="font-mono text-[12px]" />
          <Button type="submit" variant="secondary">
            Aller
          </Button>
        </form>
        <div className="flex items-center gap-1 text-[12px] text-muted flex-wrap min-h-6">
          <button type="button" className="inline-flex items-center gap-1 hover:text-fg cursor-pointer" onClick={() => setCurrent(undefined)}>
            <HardDrive className="w-3.5 h-3.5" /> Lecteurs
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              <ChevronRight className="w-3 h-3 text-faint" />
              <button
                type="button"
                className="hover:text-fg cursor-pointer"
                onClick={() => {
                  const sep = data?.path?.includes('\\') ? '\\' : '/';
                  let p = crumbs.slice(0, i + 1).join(sep);
                  if (/^[A-Za-z]:$/.test(p)) p += sep;
                  else if (sep === '/') p = '/' + p;
                  setCurrent(p);
                }}
              >
                {c}
              </button>
            </span>
          ))}
          {data?.parent && (
            <Button size="xs" variant="ghost" className="ml-auto" icon={<ArrowUp className="w-3 h-3" />} onClick={() => setCurrent(data.parent!)}>
              Parent
            </Button>
          )}
        </div>
        {error != null && <ErrorBox error={error} />}
        <div className="h-[300px] overflow-y-auto rounded-md border border-line bg-sunk">
          {loading && (
            <div className="p-4 flex items-center gap-2 text-[12px] text-muted">
              <Spinner /> Lecture du dossier
            </div>
          )}
          {!loading && data && data.entries.length === 0 && <p className="p-4 text-[12px] text-faint">Dossier vide{mode === 'file' ? ` (aucun fichier ${ext})` : ''}.</p>}
          {!loading &&
            data?.entries.map((e) => (
              <button
                key={e.path}
                type="button"
                onClick={() => {
                  if (e.isDirectory) setCurrent(e.path);
                  else {
                    onPick(e.path);
                    onClose();
                  }
                }}
                className="w-full flex items-center gap-2 px-3 h-8 text-left text-[12.5px] text-fg hover:bg-raised cursor-pointer"
              >
                {e.isDirectory ? <Folder className="w-4 h-4 text-brand shrink-0" /> : <File className="w-4 h-4 text-leaf shrink-0" />}
                <span className="truncate flex-1">{e.name}</span>
                {!e.isDirectory && <span className="text-[11px] text-faint tabular">{fmtBytes(e.sizeBytes)}</span>}
              </button>
            ))}
        </div>
        {data?.path && mode === 'folder' && <p className="text-[11.5px] text-faint truncate">Sélection : {basename(data.path)}</p>}
      </div>
    </Dialog>
  );
}
