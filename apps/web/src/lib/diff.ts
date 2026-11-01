// Line diff (LCS on lines, Myers-equivalent output for typical file sizes) and
// unified-patch parsing. Used to render agent `diff` events and git patches.

export type DiffLineKind = 'context' | 'add' | 'del' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

const MAX_CELLS = 4_000_000;

/** Computes a line diff between two texts. Falls back to whole replace when too large. */
export function diffLines(oldText: string | null, newText: string): DiffLine[] {
  const a = oldText === null || oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Trim common prefix/suffix to keep the table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: i + 1 });

  if (midA.length * midB.length > MAX_CELLS) {
    midA.forEach((t, i) => out.push({ kind: 'del', text: t, oldNo: start + i + 1 }));
    midB.forEach((t, i) => out.push({ kind: 'add', text: t, newNo: start + i + 1 }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'context', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
        out.push({ kind: 'add', text: midB[j], newNo: start + j + 1 });
        j++;
      } else {
        out.push({ kind: 'del', text: midA[i], oldNo: start + i + 1 });
        i++;
      }
    }
  }
  const shift = endB - endA;
  for (let i = endA; i < a.length; i++) out.push({ kind: 'context', text: a[i], oldNo: i + 1, newNo: i + 1 + shift });
  return out;
}

/** Keeps changed lines with `context` lines around them, inserting hunk separators. */
export function foldContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'add' || l.kind === 'del') {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'hunk', text: `${skipped} ligne(s) inchangée(s)` });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped && out.length) out.push({ kind: 'hunk', text: `${skipped} ligne(s) inchangée(s)` });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/** Change blocks of a line diff: each run of consecutive add/del lines, by index into `lines`. */
export function changeBlocks(lines: DiffLine[]): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  lines.forEach((l, i) => {
    if (l.kind !== 'add' && l.kind !== 'del') return;
    const last = blocks[blocks.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else blocks.push({ start: i, end: i + 1 });
  });
  return blocks;
}

/**
 * Rebuilds the new text keeping only the accepted change blocks: an accepted block contributes
 * its added lines, a rejected one its original (deleted) lines. Context lines are always kept.
 */
export function applyBlocks(lines: DiffLine[], accepted: ReadonlySet<number>): string {
  const blockOf = new Map<number, number>();
  changeBlocks(lines).forEach((b, k) => { for (let i = b.start; i < b.end; i++) blockOf.set(i, k); });
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (l.kind === 'context') out.push(l.text);
    else if (l.kind === 'add' && accepted.has(blockOf.get(i)!)) out.push(l.text);
    else if (l.kind === 'del' && !accepted.has(blockOf.get(i)!)) out.push(l.text);
  });
  return out.join('\n');
}

/** Parses a unified patch (git diff output) into numbered lines. */
export function parseUnifiedPatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
      }
      out.push({ kind: 'hunk', text: raw });
    } else if (raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('\\ No newline')) {
      out.push({ kind: 'meta', text: raw });
    } else if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith(' ')) {
      out.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}
