import { useMemo, useState } from 'react';
import { diffLines, diffStats, foldContext, parseUnifiedPatch, type DiffLine } from '../lib/diff';
import { Segmented, cx } from './ui';

const ROW: Record<DiffLine['kind'], string> = {
  context: '',
  add: 'bg-[var(--diff-add)] text-[var(--diff-add-fg)]',
  del: 'bg-[var(--diff-del)] text-[var(--diff-del-fg)]',
  hunk: 'text-faint bg-sunk italic',
  meta: 'text-faint',
};

const MAX_RENDERED = 3000;

function Unified({ lines }: { lines: DiffLine[] }) {
  const shown = lines.slice(0, MAX_RENDERED);
  return (
    <table className="w-full font-mono border-collapse" style={{ fontSize: 'var(--code-size)' }}>
      <tbody>
        {shown.map((l, i) => (
          <tr key={i} className={ROW[l.kind]}>
            <td className="w-10 pr-2 text-right text-faint select-none tabular align-top">{l.oldNo ?? ''}</td>
            <td className="w-10 pr-2 text-right text-faint select-none tabular align-top">{l.newNo ?? ''}</td>
            <td className="w-4 select-none text-center align-top">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ''}</td>
            <td className="whitespace-pre-wrap break-all pr-3">{l.text || ' '}</td>
          </tr>
        ))}
      </tbody>
      {lines.length > MAX_RENDERED && (
        <tfoot>
          <tr>
            <td colSpan={4} className="py-2 text-center text-faint text-[12px]">
              {lines.length - MAX_RENDERED} lignes supplémentaires non affichées
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}

/** Side by side: deletions on the left, additions on the right, aligned per change block. */
function Split({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => {
    const out: Array<{ l?: DiffLine; r?: DiffLine; hunk?: string }> = [];
    let dels: DiffLine[] = [];
    let adds: DiffLine[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ l: dels[i], r: adds[i] });
      dels = [];
      adds = [];
    };
    for (const l of lines.slice(0, MAX_RENDERED)) {
      if (l.kind === 'del') dels.push(l);
      else if (l.kind === 'add') adds.push(l);
      else {
        flush();
        if (l.kind === 'hunk' || l.kind === 'meta') out.push({ hunk: l.text });
        else out.push({ l, r: l });
      }
    }
    flush();
    return out;
  }, [lines]);
  return (
    <table className="w-full font-mono border-collapse table-fixed" style={{ fontSize: 'var(--code-size)' }}>
      <tbody>
        {rows.map((row, i) =>
          row.hunk !== undefined ? (
            <tr key={i} className={ROW.hunk}>
              <td colSpan={4} className="px-2">
                {row.hunk}
              </td>
            </tr>
          ) : (
            <tr key={i}>
              <td className="w-10 pr-2 text-right text-faint select-none tabular align-top">{row.l?.oldNo ?? ''}</td>
              <td className={cx('whitespace-pre-wrap break-all pr-2 align-top border-r border-line', row.l && row.l.kind === 'del' && ROW.del)}>{row.l?.text ?? ''}</td>
              <td className="w-10 pr-2 text-right text-faint select-none tabular align-top">{row.r?.newNo ?? ''}</td>
              <td className={cx('whitespace-pre-wrap break-all pr-2 align-top', row.r && row.r.kind === 'add' && ROW.add)}>{row.r?.text ?? ''}</td>
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

export function DiffView({ oldText, newText, patch, defaultMode = 'unified', maxHeight = 420 }: { oldText?: string | null; newText?: string; patch?: string; defaultMode?: 'unified' | 'split'; maxHeight?: number }) {
  const [mode, setMode] = useState<'unified' | 'split'>(defaultMode);
  const lines = useMemo(() => {
    if (patch !== undefined) return parseUnifiedPatch(patch);
    return foldContext(diffLines(oldText ?? null, newText ?? ''));
  }, [oldText, newText, patch]);
  const stats = diffStats(lines);
  if (lines.length === 0) return <p className="text-[12px] text-faint px-3 py-2">Aucune différence.</p>;
  return (
    <div className="rounded-[var(--radius-md)] border border-line bg-code overflow-hidden">
      <div className="flex items-center justify-between h-8 px-2 border-b border-line bg-sunk">
        <span className="text-[11.5px] tabular">
          <span className="text-good">+{stats.added}</span> <span className="text-bad">-{stats.removed}</span>
        </span>
        <Segmented
          size="xs"
          label="Mode d’affichage du diff"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'unified', label: 'Unifié' },
            { value: 'split', label: 'Côte à côte' },
          ]}
        />
      </div>
      <div className="overflow-auto" style={{ maxHeight }}>
        {mode === 'unified' ? <Unified lines={lines} /> : <Split lines={lines} />}
      </div>
    </div>
  );
}
