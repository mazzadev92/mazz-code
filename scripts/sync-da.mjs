// Copies the official MAZZ motion and colour tokens from the brand studio (D:\Mazz Laef\src\tokens)
// into the web app, so the Studio never re-types a curve or a colour by hand.
//   node scripts/sync-da.mjs [--src "D:\Mazz Laef\src\tokens"]
// Writes apps/web/src/styles/mazz-tokens.css and apps/web/src/motion/tokens.ts (both committed:
// the build does not depend on the brand folder being present).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--src');
const src = i >= 0 ? process.argv[i + 1] : 'D:\\Mazz Laef\\src\\tokens';

const read = (name) => readFileSync(path.join(src, name), 'utf8');

const easings = [...read('easings.ts').matchAll(/^\s*(mazz\w+):\s*'(cubic-bezier\([^)]+\))'/gm)].map((m) => [m[1], m[2]]);
const springs = [...read('springs.ts').matchAll(/^\s*([A-Z_]+):\s*\{\s*mass:\s*([\d.]+),\s*stiffness:\s*([\d.]+),\s*damping:\s*([\d.]+)/gm)].map((m) => [
  m[1],
  { mass: Number(m[2]), stiffness: Number(m[3]), damping: Number(m[4]) },
]);
const colors = [...read('colors.ts').matchAll(/^\s*([A-Z_]+):\s*'(#[0-9A-Fa-f]{6}|rgba\([^)]+\))'/gm)].map((m) => [m[1], m[2]]);

if (easings.length < 5 || springs.length < 3 || colors.length < 5) {
  throw new Error(`tokens incomplets (easings ${easings.length}, springs ${springs.length}, colors ${colors.length})`);
}

const kebab = (s) => s.replace(/^mazz/, '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

const css = [
  '/* Généré par scripts/sync-da.mjs depuis D:\\Mazz Laef\\src\\tokens. Ne pas modifier à la main. */',
  ':root {',
  ...easings.map(([k, v]) => `  --ease-${kebab(k)}: ${v};`),
  ...easings.map(([k]) => `  --ease-mazz-${kebab(k)}: var(--ease-${kebab(k)});`),
  ...colors.map(([k, v]) => `  --mazz-${k.toLowerCase().replace(/_/g, '-')}: ${v};`),
  '}',
  '',
].join('\n');

const ts = [
  '// Généré par scripts/sync-da.mjs depuis D:\\Mazz Laef\\src\\tokens. Ne pas modifier à la main.',
  `export const MAZZ_EASINGS = ${JSON.stringify(Object.fromEntries(easings), null, 2)} as const;`,
  '',
  `export const MAZZ_SPRINGS = ${JSON.stringify(Object.fromEntries(springs), null, 2)} as const;`,
  '',
  'export type MazzSpring = keyof typeof MAZZ_SPRINGS;',
  '',
].join('\n');

mkdirSync(path.join(root, 'apps/web/src/motion'), { recursive: true });
writeFileSync(path.join(root, 'apps/web/src/styles/mazz-tokens.css'), css);
writeFileSync(path.join(root, 'apps/web/src/motion/tokens.ts'), ts);
console.log(`easings ${easings.length}, springs ${springs.length}, colors ${colors.length}`);
