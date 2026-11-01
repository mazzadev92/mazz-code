import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, ChevronRight, Copy, File, FileCode2, FileText, Folder, FolderOpen, RefreshCw, Search } from 'lucide-react';
import { api, errorMessage, qs } from '../../lib/api';
import type { GitStatus, TreeEntry } from '../../lib/types';
import { navigate, toast, useApp } from '../../lib/store';
import { IconButton, Spinner, cx } from '../../components/ui';
import { VirtualList } from '../../components/VirtualList';
import { bumpTree, openFile, resetCode, useCode } from './codeStore';

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|c|h|cpp|hpp|cc|rs|py|java|go|cs|json|css|html|ps1|sh|toml|yaml|yml)$/i;

function FileIcon({ name }: { name: string }) {
  if (CODE_EXT.test(name)) return <FileCode2 className="w-3.5 h-3.5 text-leaf shrink-0" />;
  if (/\.(md|txt|log)$/i.test(name)) return <FileText className="w-3.5 h-3.5 text-faint shrink-0" />;
  return <File className="w-3.5 h-3.5 text-faint shrink-0" />;
}

const GIT_BADGE: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'text-warn' },
  A: { label: 'A', cls: 'text-good' },
  D: { label: 'D', cls: 'text-bad' },
  R: { label: 'R', cls: 'text-info' },
  '?': { label: 'U', cls: 'text-good' },
};

type DirState = { entries?: TreeEntry[]; error?: string | null; loading?: boolean };

export type TreeRow =
  | { kind: 'entry'; entry: TreeEntry; depth: number }
  | { kind: 'note'; text: string; depth: number; tone: 'warn' | 'faint' };

// Open directories are flattened into rows so the tree can be windowed (spec 02).
export function flattenTree(entries: readonly TreeEntry[], open: ReadonlySet<string>, dirs: Readonly<Record<string, DirState>>, depth = 0, out: TreeRow[] = []): TreeRow[] {
  for (const entry of entries) {
    out.push({ kind: 'entry', entry, depth });
    if (!entry.isDirectory || !open.has(entry.path)) continue;
    const dir = dirs[entry.path];
    if (dir?.error) out.push({ kind: 'note', text: dir.error, depth: depth + 1, tone: 'warn' });
    if (dir?.entries?.length === 0) out.push({ kind: 'note', text: 'Dossier vide', depth: depth + 1, tone: 'faint' });
    else if (dir?.entries) flattenTree(dir.entries, open, dirs, depth + 1, out);
  }
  return out;
}

const ROW_H = 26;

function DirRow({ entry, depth, open, loading, onToggle, onContext }: { entry: TreeEntry; depth: number; open: boolean; loading: boolean; onToggle: (path: string) => void; onContext: (e: MouseEvent, entry: TreeEntry) => void }) {
  return (
    <div role="treeitem" aria-expanded={open} aria-level={depth + 1}>
      <button type="button" onClick={() => onToggle(entry.path)} onContextMenu={(e) => onContext(e, entry)} className="w-full flex items-center gap-1 h-[26px] pr-2 text-left text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer" style={{ paddingLeft: 6 + depth * 12 }} title={entry.heavy ? 'Dossier volumineux ou généré : chargé à la demande' : entry.path}>
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        {open ? <FolderOpen className="w-3.5 h-3.5 text-brand shrink-0" /> : <Folder className={cx('w-3.5 h-3.5 shrink-0', entry.heavy ? 'text-faint' : 'text-brand')} />}
        <span className={cx('truncate', entry.heavy && 'text-faint')}>{entry.name}</span>
        {loading && <Spinner size={9} />}
      </button>
    </div>
  );
}

function FileRow({ entry, depth, git, active, onContext }: { entry: TreeEntry; depth: number; git?: string; active: boolean; onContext: (e: MouseEvent, entry: TreeEntry) => void }) {
  const badge = git ? GIT_BADGE[git] : undefined;
  return (
    <div role="treeitem" aria-selected={active} aria-level={depth + 1}>
      <button
        type="button"
        onClick={() => {
          void openFile(entry.path);
          navigate('code', entry.path);
        }}
        onContextMenu={(e) => onContext(e, entry)}
        className={cx('w-full flex items-center gap-1.5 h-[26px] pr-2 text-left text-[12.5px] cursor-pointer', active ? 'bg-raised text-fg' : 'text-muted hover:text-fg hover:bg-raised/70')}
        style={{ paddingLeft: 22 + depth * 12 }}
        title={entry.path}
      >
        <FileIcon name={entry.name} />
        <span className="truncate flex-1">{entry.name}</span>
        {badge && <span className={cx('text-[10.5px] font-mono', badge.cls)}>{badge.label}</span>}
      </button>
    </div>
  );
}

export default function FileTreeSidebar() {
  const root = useApp((s) => s.health?.workspace);
  const version = useCode((s) => s.treeVersion);
  const active = useCode((s) => s.active);
  const recent = useCode((s) => s.recent);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const treeScroller = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const loadDir = useCallback(async (path: string) => {
    setDirs((d) => ({ ...d, [path]: { ...d[path], loading: true } }));
    try {
      const r = await api.get<{ entries: TreeEntry[]; truncated: boolean }>(`/api/files/tree${qs({ path })}`);
      setDirs((d) => ({ ...d, [path]: { entries: r.entries, error: r.truncated ? 'Dossier tronqué à 2000 entrées.' : null, loading: false } }));
    } catch (e) {
      setDirs((d) => ({ ...d, [path]: { ...d[path], error: errorMessage(e), loading: false } }));
    }
  }, []);

  const toggleDir = useCallback(
    (path: string) => {
      const wasOpen = openRef.current.has(path);
      setOpen((prev) => {
        const next = new Set(prev);
        if (wasOpen) next.delete(path);
        else next.add(path);
        return next;
      });
      if (!wasOpen) void loadDir(path);
    },
    [loadDir]
  );

  // A refresh reloads every open directory; a project switch starts collapsed.
  useEffect(() => {
    for (const path of openRef.current) void loadDir(path);
  }, [version, loadDir]);
  useEffect(() => {
    setOpen(new Set());
    setDirs({});
  }, [root?.workspaceRoot]);

  // Close editor tabs only when the user switches to another project (not on first load).
  const prevRoot = useRef<string | undefined>(undefined);
  useEffect(() => {
    const cur = root?.workspaceRoot;
    if (prevRoot.current && cur && prevRoot.current !== cur) resetCode();
    if (cur) prevRoot.current = cur;
  }, [root?.workspaceRoot]);

  useEffect(() => {
    let alive = true;
    api
      .get<{ entries: TreeEntry[] }>('/api/files/tree?path=.')
      .then((r) => alive && (setEntries(r.entries), setError(null)))
      .catch((e) => alive && setError(errorMessage(e)));
    api
      .get<GitStatus>('/api/git/status')
      .then((g) => alive && setGit(g))
      .catch(() => alive && setGit(null));
    return () => {
      alive = false;
    };
  }, [version, root?.workspaceRoot]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults(null);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      api
        .get<{ files: string[] }>(`/api/files/search${qs({ q: query.trim(), names: 1, max: 100 })}`, ctrl.signal)
        .then((r) => setResults(r.files))
        .catch(() => undefined);
    }, 180);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  const gitMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of git?.files ?? []) m.set(f.path, f.index !== ' ' && f.index !== '?' ? f.index : f.worktree);
    return m;
  }, [git]);

  const rows = useMemo(() => flattenTree(entries ?? [], open, dirs), [entries, open, dirs]);

  const onContext = (e: MouseEvent, entry: TreeEntry) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const copy = (text: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast('good', 'Chemin copié', text))
      .catch(() => toast('bad', 'Copie impossible'));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2.5 h-9 border-b border-line">
        <span className="text-[11px] uppercase tracking-[0.12em] text-faint flex-1 truncate" title={root?.workspaceRoot}>
          {root?.name ?? 'Explorateur'}
        </span>
        <IconButton size="sm" label="Actualiser l’arborescence" onClick={bumpTree}>
          <RefreshCw className="w-3.5 h-3.5" />
        </IconButton>
      </div>
      <div className="p-2 border-b border-line">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un fichier" aria-label="Rechercher un fichier" className="w-full h-7 pl-7 pr-2 rounded-md bg-sunk border border-line text-[12px] placeholder:text-faint focus:outline-none focus:border-brand/60" />
        </div>
      </div>
      <div ref={treeScroller} className="flex-1 overflow-y-auto py-1">
        {results ? (
          <ul>
            {results.length === 0 && <li className="px-3 py-2 text-[12px] text-faint">Aucun fichier.</li>}
            {results.map((p) => (
              <li key={p}>
                <button type="button" onClick={() => (void openFile(p), navigate('code', p))} className="w-full flex items-center gap-1.5 px-3 h-[26px] text-left text-[12px] text-muted hover:text-fg hover:bg-raised cursor-pointer font-mono">
                  <FileIcon name={p} />
                  <span className="truncate">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            {error && <p className="px-3 py-2 text-[12px] text-bad">{error}</p>}
            {!entries && !error && (
              <div className="px-3 py-2">
                <Spinner />
              </div>
            )}
            <div role="tree" aria-label="Fichiers du projet">
              <VirtualList
                count={rows.length}
                scrollRef={treeScroller}
                estimate={ROW_H}
                overscan={12}
                resetKey={root?.workspaceRoot}
                itemKey={(i) => {
                  const row = rows[i];
                  return row.kind === 'entry' ? row.entry.path : `note:${i}`;
                }}
                renderItem={(i) => {
                  const row = rows[i];
                  if (row.kind === 'note') {
                    return (
                      <div className={cx('h-[26px] flex items-center text-[11px]', row.tone === 'warn' ? 'text-warn' : 'text-faint')} style={{ paddingLeft: 12 + row.depth * 12 }}>
                        {row.text}
                      </div>
                    );
                  }
                  const { entry, depth } = row;
                  return entry.isDirectory ? (
                    <DirRow entry={entry} depth={depth} open={open.has(entry.path)} loading={dirs[entry.path]?.loading === true} onToggle={toggleDir} onContext={onContext} />
                  ) : (
                    <FileRow entry={entry} depth={depth} git={gitMap.get(entry.path)} active={active === entry.path} onContext={onContext} />
                  );
                }}
              />
            </div>
          </>
        )}
      </div>
      {recent.length > 0 && (
        <div className="border-t border-line max-h-[140px] overflow-y-auto py-1">
          <div className="px-3 py-1 text-[10.5px] uppercase tracking-[0.12em] text-faint">Récents</div>
          {recent.slice(0, 6).map((p) => (
            <button key={p} type="button" onClick={() => (void openFile(p), navigate('code', p))} className="w-full flex items-center gap-1.5 px-3 h-6 text-left text-[11.5px] text-muted hover:text-fg cursor-pointer font-mono">
              <span className="truncate">{p}</span>
            </button>
          ))}
        </div>
      )}
      {menu && (
        <div role="menu" className="fixed z-[var(--z-overlay)] w-56 rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] py-1" style={{ left: menu.x, top: menu.y }}>
          {!menu.entry.isDirectory && (
            <button type="button" role="menuitem" className="w-full text-left px-3 h-7 text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer" onClick={() => (void openFile(menu.entry.path), navigate('code', menu.entry.path))}>
              Ouvrir
            </button>
          )}
          <button type="button" role="menuitem" className="w-full flex items-center gap-2 text-left px-3 h-7 text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer" onClick={() => copy(menu.entry.path)}>
            <Copy className="w-3.5 h-3.5" /> Copier le chemin relatif
          </button>
          <button type="button" role="menuitem" className="w-full flex items-center gap-2 text-left px-3 h-7 text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer" onClick={() => copy(`${root?.workspaceRoot}\\${menu.entry.path.replace(/\//g, '\\')}`)}>
            <Copy className="w-3.5 h-3.5" /> Copier le chemin absolu
          </button>
          {!menu.entry.isDirectory && gitMap.has(menu.entry.path) && (
            <button type="button" role="menuitem" className="w-full text-left px-3 h-7 text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer" onClick={() => navigate('git', menu.entry.path)}>
              Voir les modifications Git
            </button>
          )}
        </div>
      )}
    </div>
  );
}
