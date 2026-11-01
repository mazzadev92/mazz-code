// Safe Markdown parser producing a small AST (rendered by components/Markdown.tsx
// as React elements: no innerHTML from model output). Supports headings, lists,
// fenced code, block quotes, GFM tables, rules, bold, italic, inline code, links,
// and inline/display math ($...$, $$...$$, \(...\), \[...\], \begin{...}).

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'math'; v: string; display?: boolean }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'code'; lang: string; v: string; closed: boolean }
  | { t: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { t: 'quote'; c: Block[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'center' | 'right' | undefined> }
  | { t: 'math'; v: string; display: true }
  | { t: 'hr' };

/** Only these URL schemes become links; anything else stays plain text. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^(https?:|mailto:)/i.test(h)) return h;
  return null;
}

const ESCAPABLE = /[\\`*_[\]()#+\-.!|$]/;

/** Currency amounts ($5, $5.00) must stay text; a lone number is not a formula. */
function isNumericAmount(value: string): boolean {
  return /^\d[\d.,\s]*$/.test(value.trim());
}

/**
 * Find the closing `$` of an inline formula. Escaped dollars are ignored, and
 * a closing dollar followed by a digit is treated as currency ("$5 and $10").
 */
export function findInlineMathClose(src: string, start: number): number {
  if (src[start + 1] === '$') return -1;
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === '$') {
      const content = src.slice(start + 1, i);
      const after = src[i + 1] ?? '';
      if (content.trim() && !isNumericAmount(content) && !/\d/.test(after)) return i;
    }
    i++;
  }
  return -1;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && src[i + 1] === '(') {
      const end = src.indexOf('\\)', i + 2);
      if (end !== -1 && src.slice(i + 2, end).trim()) {
        flush();
        out.push({ t: 'math', v: src.slice(i + 2, end).trim() });
        i = end + 2;
        continue;
      }
    }
    if (ch === '\\' && src[i + 1] === '[') {
      const end = src.indexOf('\\]', i + 2);
      if (end !== -1 && src.slice(i + 2, end).trim()) {
        flush();
        out.push({ t: 'math', v: src.slice(i + 2, end).trim(), display: true });
        i = end + 2;
        continue;
      }
    }
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1])) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const ticks = src.slice(i).match(/^`+/)![0];
      const end = src.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + ticks.length, end).replace(/^ (.*) $/, '$1') });
        i = end + ticks.length;
        continue;
      }
    }
    if (ch === '$') {
      if (src[i + 1] === '$') {
        const end = src.indexOf('$$', i + 2);
        if (end !== -1 && src.slice(i + 2, end).trim()) {
          flush();
          out.push({ t: 'math', v: src.slice(i + 2, end).trim(), display: true });
          i = end + 2;
          continue;
        }
      } else {
        const end = findInlineMathClose(src, i);
        if (end !== -1) {
          flush();
          out.push({ t: 'math', v: src.slice(i + 1, end).trim() });
          i = end + 1;
          continue;
        }
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && (i === 0 || /\W/.test(src[i - 1])))) {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[i + 1] !== ' ') {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = src.slice(i).match(/^\[([^\]]+)\]\(([^)\s]+)\)/);
      if (m) {
        const href = safeHref(m[2]);
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(m[1]) });
        else out.push({ t: 'text', v: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

interface DisplayMathStart {
  /** Text after the opening delimiter (or the whole line for \begin{...}). */
  body: string;
  close: string;
  /** LaTeX environments need their \end{...} kept in the TeX source. */
  keepClose?: boolean;
}

/** Detect block math delimiters: $$, \[, and \begin{environment}. */
export function displayMathStart(line: string): DisplayMathStart | null {
  const t = line.trim();
  if (t.startsWith('$$')) return { body: t.slice(2), close: '$$' };
  if (t.startsWith('\\[')) return { body: t.slice(2), close: '\\]' };
  const begin = t.match(/^\\begin\{([A-Za-z*]+)\}/);
  if (begin) return { body: t, close: `\\end{${begin[1]}}`, keepClose: true };
  return null;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      blocks.push({ t: 'code', lang: fence[2].toLowerCase(), v: body.join('\n'), closed });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const display = displayMathStart(line);
    if (display) {
      flushPara();
      const consumed: string[] = [line];
      const body: string[] = [];
      let trailing = '';
      let closed = false;
      const closeAt = display.body.indexOf(display.close);
      if (closeAt !== -1) {
        body.push(display.body.slice(0, closeAt));
        trailing = display.body.slice(closeAt + display.close.length).trim();
        closed = true;
        i++;
      } else {
        if (display.body.trim()) body.push(display.body);
        i++;
        while (i < lines.length) {
          consumed.push(lines[i]);
          const at = lines[i].indexOf(display.close);
          if (at !== -1) {
            body.push(lines[i].slice(0, at));
            trailing = lines[i].slice(at + display.close.length).trim();
            closed = true;
            i++;
            break;
          }
          body.push(lines[i]);
          i++;
        }
      }
      if (closed) {
        const inner = body.join('\n').trim();
        const tex = display.keepClose && inner ? `${inner}\n${display.close}` : inner;
        if (tex) blocks.push({ t: 'math', v: tex, display: true });
        if (trailing) blocks.push({ t: 'p', c: parseInline(trailing) });
      } else {
        // While streaming, an unterminated formula stays visible as plain text
        // instead of disappearing or being sent to KaTeX half-written.
        blocks.push({ t: 'p', c: parseInline(consumed.join('\n')) });
      }
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      blocks.push({ t: 'h', level: h[1].length, c: parseInline(h[2].replace(/\s+#+\s*$/, '')) });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara();
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ t: 'quote', c: parseMarkdown(q.join('\n')) });
      continue;
    }
    const li = line.match(/^\s*([-*+]|(\d+)[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = !!li[2];
      const start = ordered ? Number(li[2]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(m[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += '\n' + lines[i].trim();
          i++;
        } else break;
      }
      blocks.push({ t: 'list', ordered, start, items: items.map(parseInline) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ t: 'table', head: head.map(parseInline), rows, align });
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}
