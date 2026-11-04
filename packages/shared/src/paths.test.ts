import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { mazzHome, mazzPath } from './paths.js';

function withHome(value: string | undefined, fn: () => void): void {
  const previous = process.env.MAZZ_HOME;
  if (value === undefined) delete process.env.MAZZ_HOME; else process.env.MAZZ_HOME = value;
  try { fn(); } finally { if (previous === undefined) delete process.env.MAZZ_HOME; else process.env.MAZZ_HOME = previous; }
}

test('mazzHome defaults to ~/.mazz', () => {
  withHome(undefined, () => assert.equal(mazzHome(), path.join(os.homedir(), '.mazz')));
  withHome('  ', () => assert.equal(mazzHome(), path.join(os.homedir(), '.mazz')));
});

test('MAZZ_HOME overrides and relative values become absolute', () => {
  const abs = path.join(os.tmpdir(), 'mazz-home-x');
  withHome(abs, () => assert.equal(mazzPath('studio', 'a'), path.join(abs, 'studio', 'a')));
  withHome('rel-home', () => assert.equal(mazzHome(), path.resolve('rel-home')));
});
