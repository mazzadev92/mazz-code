import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { applyBlocks, changeBlocks, diffLines, type DiffLine } from '../../lib/diff';
import { cx } from '../../components/ui';

const ROW: Partial<Record<DiffLine['kind'], string>> = {
  add: 'bg-[var(--diff-add)] text-[var(--diff-add-fg)]',
  del: 'bg-[var(--diff-del)] text-[var(--diff-del-fg)]',
};
const CONTEXT = 2;

export type WriteReviewState =
  | { status: 'loading' }
  | { status: 'unavailable'; reason: string }
  | { status: 'ready'; lines: DiffLine[]; blocks: Array<{ start: number; end: number }> };

/** Current file content: null for a file that does not exist yet. */
async function readCurrent(path: string, sessionId?: string): Promise<{ content: string | null } | { reason: string }> {
  try {
    const r = await api.get<{ content?: string; binary: boolean; tooLarge: boolean }>(`/api/files/read?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ''}`);
    if (r.binary || r.tooLarge || r.content === undefined) return { reason: 'fichier binaire ou trop grand pour une revue par bloc' };
    return { content: r.content };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404 || /ENOENT|introuvable|no such file/i.test(String((e as Error).message))) return { content: null };
    return { reason: 'contenu actuel illisible' };
  }
}

/**
 * Hunk review of a proposed file write: one checkbox per change block. `onChange` receives the
 * text to write, or undefined when every block is kept (the proposal is then written unchanged).
 */
export function WriteReview({ path, proposed, sessionId, disabled, onChange }: {
  path: string;
  proposed: string;
  sessionId?: string;
  disabled?: boolean;
  onChange: (content: string | undefined) => void;
}) {
  const [state, setState] = useState<WriteReviewState>({ status: 'loading' });
  const [rejected, setRejected] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    let alive = true;
    void readCurrent(path, sessionId).then((r) => {
      if (!alive) return;
      if ('reason' in r) setState({ status: 'unavailable', reason: r.reason });
      else {
        const lines = diffLines(r.content, proposed);
        setState({ status: 'ready', lines, blocks: changeBlocks(lines) });
      }
    });
    return () => { alive = false; };
  }, [path, proposed, sessionId]);

  const ready = state.status === 'ready' ? state : null;
  const toggle = (k: number) => {
    if (!ready) return;
    const next = new Set(rejected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setRejected(next);
    const accepted = new Set(ready.blocks.map((_, i) => i).filter((i) => !next.has(i)));
    onChange(next.size ? applyBlocks(ready.lines, accepted) : undefined);
  };

  const view = useMemo(() => {
    if (!ready) return [];
    return ready.blocks.map((b, k) => ({
      k,
      before: ready.lines.slice(Math.max(0, b.start - CONTEXT), b.start).filter((l) => l.kind === 'context'),
      body: ready.lines.slice(b.start, b.end),
      after: ready.lines.slice(b.end, b.end + CONTEXT).filter((l) => l.kind === 'context'),
    }));
  }, [ready]);

  if (state.status === 'loading') return <p className="text-[12px] text-faint">Lecture du fichier actuel pour la revue…</p>;
  if (state.status === 'unavailable') return <p className="text-[12px] text-faint">Revue par bloc indisponible : {state.reason}.</p>;
  if (!view.length) return <p className="text-[12px] text-faint">Le contenu proposé est identique au fichier actuel.</p>;

  const row = (l: DiffLine, key: string, dim: boolean) => (
    <tr key={key} className={cx(ROW[l.kind], dim && 'opacity-40 line-through')}>
      <td className="w-9 pr-2 text-right text-faint select-none tabular align-top">{l.kind === 'del' ? l.oldNo : l.newNo}</td>
      <td className="w-4 select-none text-center align-top">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</td>
      <td className="whitespace-pre-wrap break-all pr-3">{l.text || ' '}</td>
    </tr>
  );
  return (
    <div className="space-y-2" aria-label={`Revue des modifications de ${path}`}>
      <div className="text-[11.5px] text-muted">
        {view.length} bloc{view.length > 1 ? 's' : ''} modifié{view.length > 1 ? 's' : ''} ; décochez un bloc pour garder le texte actuel à cet endroit.
        {rejected.size > 0 && <span className="text-warn"> {rejected.size} bloc{rejected.size > 1 ? 's' : ''} écarté{rejected.size > 1 ? 's' : ''}.</span>}
      </div>
      <div className="max-h-72 overflow-auto space-y-2">
        {view.map(({ k, before, body, after }) => {
          const kept = !rejected.has(k);
          const add = body.filter((l) => l.kind === 'add').length;
          const del = body.length - add;
          return (
            <div key={k} className={cx('rounded border bg-code overflow-hidden', kept ? 'border-line' : 'border-warn/40')}>
              <label className="flex items-center gap-2 px-2 h-7 bg-sunk border-b border-line text-[11.5px] cursor-pointer">
                <input type="checkbox" checked={kept} disabled={disabled} onChange={() => toggle(k)} aria-label={`Garder le bloc ${k + 1}`} />
                <span className="text-fg">Bloc {k + 1}</span>
                <span className="tabular"><span className="text-good">+{add}</span> <span className="text-bad">-{del}</span></span>
                {!kept && <span className="ml-auto text-warn">texte actuel conservé</span>}
              </label>
              <table className="w-full font-mono border-collapse" style={{ fontSize: 'var(--code-size)' }}>
                <tbody>
                  {before.map((l, i) => row(l, `b${i}`, false))}
                  {body.map((l, i) => row(l, `m${i}`, kept ? false : l.kind === 'add'))}
                  {after.map((l, i) => row(l, `a${i}`, false))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
    </div>
  );
}
