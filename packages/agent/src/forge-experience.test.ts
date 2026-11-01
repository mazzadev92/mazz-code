import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExperienceStore, defaultArm, experienceKey, DECAY } from './forge-experience.js';

// Deterministic LCG in [0,1).
const lcg = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exp-')), 'exp.json');
const KEY = experienceKey('m', 'c', 'c-function');

test('defaultArm reproduces forge portfolio', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => defaultArm(n)), [
    { strategy: 'stepwise', tempBucket: 0 }, { strategy: 'stepwise', tempBucket: 1 }, { strategy: 'whole', tempBucket: 2 },
    { strategy: 'stepwise', tempBucket: 3 }, { strategy: 'stepwise', tempBucket: 0 }, { strategy: 'whole', tempBucket: 1 },
  ]);
});

test('no data -> defaultArm for every slot', () => {
  const s = new ExperienceStore(tmpFile()).load();
  const rng = lcg(1);
  for (let n = 0; n < 24; n++) assert.deepEqual(s.choose(KEY, n, rng), defaultArm(n));
});

test('strong evidence -> arm chosen in most slots, exploration slot keeps default', () => {
  const s = new ExperienceStore(tmpFile());
  const good = { strategy: 'whole' as const, tempBucket: 1 };
  for (let i = 0; i < 40; i++) { s.record(KEY, good, true); s.record(KEY, defaultArm(i % 4 === 2 ? 1 : 0), false); }
  const rng = lcg(7);
  let hits = 0, nonExplore = 0;
  for (let n = 0; n < 40; n++) {
    const a = s.choose(KEY, n, rng);
    if (n % 4 === 0) { assert.deepEqual(a, defaultArm(n)); continue; }
    nonExplore++;
    if (a.strategy === good.strategy && a.tempBucket === good.tempBucket) hits++;
  }
  assert.ok(hits / nonExplore >= 0.7, `hits ${hits}/${nonExplore}`);
  // other keys unaffected
  assert.deepEqual(s.choose(experienceKey('m', 'python', 'python-test'), 2, rng), defaultArm(2));
});

test('persistence round trip', () => {
  const f = tmpFile();
  const s = new ExperienceStore(f);
  s.record(KEY, { strategy: 'stepwise', tempBucket: 3 }, true);
  s.record(KEY, { strategy: 'whole', tempBucket: 2 }, false);
  s.save();
  assert.ok(!fs.readdirSync(path.dirname(f)).some((x) => x.endsWith('.tmp')));
  const r = new ExperienceStore(f).load();
  assert.deepEqual(r.stats(KEY), s.stats(KEY));
  assert.equal(r.stats(KEY).length, 2);
});

test('corrupt or missing file -> empty store', () => {
  const f = tmpFile();
  assert.deepEqual(new ExperienceStore(f).load().keys(), []);
  fs.writeFileSync(f, '{not json');
  const s = new ExperienceStore(f).load();
  assert.deepEqual(s.keys(), []);
  assert.deepEqual(s.choose(KEY, 2, lcg(3)), defaultArm(2));
});

test('decay fades old evidence on that key only', () => {
  const s = new ExperienceStore(tmpFile());
  const a = { strategy: 'stepwise' as const, tempBucket: 0 };
  const b = { strategy: 'whole' as const, tempBucket: 2 };
  const other = experienceKey('m', 'python', 'python-function');
  s.record(KEY, a, true);
  s.record(other, a, true);
  s.record(KEY, b, false);
  s.record(KEY, b, false);
  const st = s.stats(KEY);
  const sa = st.find((x) => x.strategy === 'stepwise')!;
  const sb = st.find((x) => x.strategy === 'whole')!;
  assert.ok(Math.abs(sa.wins - DECAY * DECAY) < 1e-12);
  assert.ok(Math.abs(sb.losses - (DECAY + 1)) < 1e-12);
  assert.ok(Math.abs(sb.mean - 1 / (3 + DECAY)) < 1e-12);
  assert.equal(s.stats(other)[0]!.wins, 1);
});
