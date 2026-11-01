// Fails when an emoji appears in interface source code or UI strings.
// Scans the code written for the Studio (apps/web/src, packages/*/src, apps/cli/src, scripts, docs of the UI).
// Technical Unicode (arrows, box drawing, accented letters, typographic quotes) is allowed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['apps/web/src', 'apps/web/index.html', 'apps/cli/src', 'packages', 'scripts', 'docs', 'UI_IMPLEMENTATION_STATUS.md'];
const EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.md', '.json', '.ps1']);
const SKIP = new Set(['node_modules', 'dist', '.git', 'legacy']);
// Extended_Pictographic covers emoji; variation selector 16 and keycap marks are emoji presentation.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/u;
// Characters that are Extended_Pictographic but used as plain typography in this codebase.
const ALLOWED = new Set(['\u00A9', '\u00AE', '\u2122']);

const hits = [];
function scan(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP.has(name)) scan(join(path, name));
    return;
  }
  if (!EXT.has(extname(path))) return;
  const lines = readFileSync(path, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    for (const ch of line) {
      if (EMOJI.test(ch) && !ALLOWED.has(ch)) {
        hits.push(`${path}:${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase()} ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  });
}
for (const r of ROOTS) scan(r);
if (hits.length) {
  console.error(`Emoji detecte(s) dans ${hits.length} ligne(s) :`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('Aucun emoji dans le code et les chaines d\'interface.');
