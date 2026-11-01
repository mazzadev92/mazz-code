// CodeMirror 6 editor (loaded with the Code view chunk only). Theme colors come
// from the CSS tokens so both Bioforge and Blueprint themes apply.
import { useEffect, useRef } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';

function languageFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'jsx':
      return javascript({ jsx: true });
    case 'py':
      return python();
    case 'c':
    case 'h':
    case 'cpp':
    case 'hpp':
    case 'cc':
      return cpp();
    case 'json':
      return json();
    case 'md':
      return markdown();
    case 'rs':
      return rust();
    case 'html':
    case 'htm':
      return html();
    case 'css':
      return css();
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--fg)', fontSize: 'var(--code-size)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--brand)' },
  '.cm-cursor': { borderLeftColor: 'var(--brand)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--faint)', borderRight: '1px solid var(--line)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--raised) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--fg)', borderTop: '1px solid var(--line)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font-sans)', fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--sunk)', border: '1px solid var(--line)', color: 'var(--muted)' },
});

// Syntax colors mapped to the theme tokens (same palette as chat code blocks).
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'color-mix(in srgb, var(--brand) 85%, var(--fg))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--good)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warn)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--info)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'color-mix(in srgb, var(--info) 70%, var(--fg))' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--leaf)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--fg)' },
  { tag: t.heading, color: 'var(--brand)', fontWeight: '600' },
  { tag: t.link, color: 'var(--info)', textDecoration: 'underline' },
  { tag: t.invalid, color: 'var(--bad)' },
]);

export function Editor({ path, value, onChange, onSave, tabSize, wordWrap, readOnly }: { path: string; value: string; onChange: (v: string) => void; onSave: () => void; tabSize: number; wordWrap: boolean; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  const wrapComp = useRef(new Compartment());

  // One EditorView per opened path; parent remounts with key=path.
  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        theme,
        syntaxHighlighting(highlight),
        languageFor(path),
        indentUnit.of(' '.repeat(tabSize)),
        EditorState.tabSize.of(tabSize),
        EditorState.readOnly.of(!!readOnly),
        wrapComp.current.of(wordWrap ? EditorView.lineWrapping : []),
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        EditorView.contentAttributes.of({ 'aria-label': `Éditeur : ${path}` }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current! });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tabSize, readOnly]);

  // External content changes (reload, revert) replace the document.
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: wrapComp.current.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
  }, [wordWrap]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
