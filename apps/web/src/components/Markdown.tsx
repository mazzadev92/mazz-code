import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, Copy, FilePlus2, WrapText } from 'lucide-react';
import katex from 'katex';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { loadHighlighter, normalizeLang } from '../lib/highlight';
import { IconButton, cx } from './ui';

/**
 * KaTeX renders trusted math markup from model text. `trust: false` disables
 * \href, \htmlClass and \includegraphics, so the model cannot inject links or
 * raw HTML through a formula.
 */
function MathNode({ tex, display }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      return null;
    }
  }, [tex, display]);
  if (!html) return <code>{display ? `$$${tex}$$` : `$${tex}$`}</code>;
  return display
    ? <span className="math-display" role="math" aria-label={tex} dangerouslySetInnerHTML={{ __html: html }} />
    : <span className="math-inline" role="math" aria-label={tex} dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.v}</Fragment>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'strong':
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case 'em':
        return <em key={i}>{renderInline(n.c)}</em>;
      case 'link':
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" title={n.href}>
            {renderInline(n.c)}
          </a>
        );
      case 'math':
        return <MathNode key={i} tex={n.v} display={n.display} />;
      case 'br':
        return <br key={i} />;
    }
  });
}

export function CodeBlock({ code, lang, onSaveAs, streaming }: { code: string; lang: string; onSaveAs?: (code: string, lang: string) => void; streaming?: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const language = normalizeLang(lang);
  useEffect(() => {
    // No highlighting while tokens stream in: avoids re-highlighting on every chunk.
    if (streaming || code.length > 200_000) {
      setHtml(null);
      return;
    }
    let alive = true;
    loadHighlighter()
      .then((hljs) => {
        if (!alive) return;
        const out = language && hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }) : null;
        setHtml(out ? out.value : null);
      })
      .catch(() => setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, language, streaming]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group rounded-[var(--radius-md)] border border-line bg-code overflow-hidden not-prose">
      <div className="flex items-center justify-between h-7 pl-3 pr-1 border-b border-line bg-sunk">
        <span className="text-[11px] font-mono text-faint">{lang || 'texte'}</span>
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" label={wrap ? 'Désactiver le retour à la ligne' : 'Retour à la ligne'} active={wrap} onClick={() => setWrap((w) => !w)}>
            <WrapText className="w-3.5 h-3.5" />
          </IconButton>
          {onSaveAs && (
            <IconButton size="sm" label="Enregistrer dans un fichier du projet" onClick={() => onSaveAs(code, lang)}>
              <FilePlus2 className="w-3.5 h-3.5" />
            </IconButton>
          )}
          <IconButton size="sm" label={copied ? 'Copié' : 'Copier le code'} onClick={copy}>
            {copied ? <Check className="w-3.5 h-3.5 text-good" /> : <Copy className="w-3.5 h-3.5" />}
          </IconButton>
        </div>
      </div>
      <pre className={cx('px-3 py-2.5 overflow-x-auto font-mono leading-[1.55]', wrap && 'whitespace-pre-wrap break-words')} style={{ fontSize: 'var(--code-size)' }}>
        {/* highlight.js HTML-escapes the source and only adds <span class="hljs-..."> markup. */}
        {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

function renderBlocks(blocks: Block[], onSaveAs?: (code: string, lang: string) => void, streaming?: boolean): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'p':
        return <p key={i}>{renderInline(b.c)}</p>;
      case 'h': {
        const H = (`h${Math.min(3, b.level)}` as 'h1' | 'h2' | 'h3');
        return <H key={i}>{renderInline(b.c)}</H>;
      }
      case 'code':
        return <CodeBlock key={i} code={b.v} lang={b.lang} onSaveAs={onSaveAs} streaming={streaming && !b.closed} />;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>);
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'quote':
        return <blockquote key={i}>{renderBlocks(b.c, onSaveAs, streaming)}</blockquote>;
      case 'table':
        return (
          <table key={i}>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j} style={{ textAlign: b.align[j] }}>
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} style={{ textAlign: b.align[k] }}>
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'math':
        return <MathNode key={i} tex={b.v} display />;
      case 'hr':
        return <hr key={i} />;
    }
  });
}

/**
 * Splits streaming text after its last blank line outside a code fence: the prefix holds
 * finished blocks only, the tail is the block still being written.
 */
export function splitStable(text: string): [string, string] {
  let inFence = false;
  let mathClose: string | null = null;
  let cut = 0;
  let pos = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length + 1;
    const trimmed = line.trim();
    if (inFence) {
      if (/^\s*(```|~~~)/.test(line)) inFence = false;
    } else if (mathClose) {
      if (line.includes(mathClose)) mathClose = null;
    } else if (/^\s*(```|~~~)/.test(line)) {
      inFence = true;
    } else if (trimmed.startsWith('$$')) {
      if (trimmed.indexOf('$$', 2) === -1) mathClose = '$$';
    } else if (trimmed.startsWith('\\[')) {
      if (!trimmed.includes('\\]')) mathClose = '\\]';
    } else {
      const begin = trimmed.match(/^\\begin\{([A-Za-z*]+)\}/);
      if (begin) {
        const close = `\\end{${begin[1]}}`;
        if (!trimmed.includes(close)) mathClose = close;
      } else if (trimmed === '' && end <= text.length) {
        cut = end;
      }
    }
    pos = end;
  }
  return [text.slice(0, cut), text.slice(cut)];
}

// Finished blocks: parsed and rendered once, while only the tail follows the stream.
const StableBlocks = memo(function StableBlocks({ text, onSaveAs }: { text: string; onSaveAs?: (code: string, lang: string) => void }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <>{renderBlocks(blocks, onSaveAs, false)}</>;
});

export const Markdown = memo(function Markdown({ text, onSaveAs, streaming, className }: { text: string; onSaveAs?: (code: string, lang: string) => void; streaming?: boolean; className?: string }) {
  const [stable, tail] = useMemo(() => (streaming ? splitStable(text) : ['', text]), [text, streaming]);
  const blocks = useMemo(() => parseMarkdown(tail), [tail]);
  return (
    <div className={cx('md text-[13.5px] text-fg', className)}>
      {stable && <StableBlocks text={stable} onSaveAs={onSaveAs} />}
      {renderBlocks(blocks, onSaveAs, streaming)}
    </div>
  );
});
