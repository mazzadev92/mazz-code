// Lazy syntax highlighting for chat code blocks (highlight.js core, ~40 kB with
// the selected grammars, loaded on first use). Output is escaped by highlight.js.
import type { HLJSApi } from 'highlight.js';

let loading: Promise<HLJSApi> | null = null;

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  ps1: 'powershell',
  ps: 'powershell',
  pwsh: 'powershell',
  'c++': 'cpp',
  h: 'c',
  hpp: 'cpp',
  rs: 'rust',
  yml: 'yaml',
  html: 'xml',
  md: 'markdown',
};

export function loadHighlighter(): Promise<HLJSApi> {
  loading ??= (async () => {
    const [{ default: hljs }, ts, js, py, c, cpp, rust, json, bash, ps, xml, css, md, diff, yaml, java, go] = await Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/c'),
      import('highlight.js/lib/languages/cpp'),
      import('highlight.js/lib/languages/rust'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/powershell'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/lib/languages/diff'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/java'),
      import('highlight.js/lib/languages/go'),
    ]);
    const langs = { typescript: ts, javascript: js, python: py, c, cpp, rust, json, bash, powershell: ps, xml, css, markdown: md, diff, yaml, java, go };
    for (const [name, mod] of Object.entries(langs)) hljs.registerLanguage(name, mod.default);
    return hljs;
  })();
  return loading;
}

export function normalizeLang(lang: string): string {
  const l = lang.toLowerCase();
  return ALIASES[l] || l;
}
