// Rebuilds the files accepted during a recorded Forge run (events JSON) into a folder, for diagnosis.
// Usage: node scripts/forge-replay.mjs <events.json> <out dir> [extra unit id=candidate number ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadBlueprints } from '../packages/agent/dist/index.js';

const [eventsFile, outDir, ...picks] = process.argv.slice(2);
const events = JSON.parse(readFileSync(eventsFile, 'utf8'));
const id = events.find((e) => e.type === 'forge' && e.phase === 'blueprint').blueprintId;
const bp = loadBlueprints([process.env.MAZZ_BLUEPRINTS || 'D:\\Mazz Code\\Bib1\\_BLUEPRINTS']).find((b) => b.id === id);
const code = new Map(events.filter((e) => e.type === 'forge' && e.phase === 'unit_done').map((e) => [e.unitId, e.code]));
for (const pick of picks) {
  const [unit, n] = pick.split('=');
  code.set(unit, events.find((e) => e.type === 'forge' && e.phase === 'candidate' && e.unitId === unit && e.candidate === Number(n)).code);
}
for (const f of bp.files) {
  const parts = bp.units.filter((u) => u.file === f.path && code.has(u.id)).map((u) => `${code.get(u.id)}${u.after ?? ''}`);
  const target = path.join(outDir, f.path);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${f.prologue}${parts.length ? `\n${parts.join('\n\n')}` : ''}${f.epilogue ?? ''}`);
}
mkdirSync(path.join(outDir, 'build'), { recursive: true });
console.log(`${code.size} unités reconstruites dans ${outDir}`);
