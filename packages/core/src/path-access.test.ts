import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isPhysicallyInside, isPhysicallyInsideAny } from './path-access.js';

test('filesystem access uses path boundaries and canonical filesystem targets', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-path-boundary-'));
  const workspace = path.join(parent, 'workspace');
  const sibling = path.join(parent, 'workspace-private');
  const child = path.join(workspace, 'src');
  const outside = path.join(parent, 'outside');
  await Promise.all([fs.mkdir(child, { recursive: true }), fs.mkdir(outside)]);
  try {
    assert.equal(isPhysicallyInside(workspace, workspace), true);
    assert.equal(isPhysicallyInside(workspace, child), true);
    assert.equal(isPhysicallyInside(workspace, sibling), false);
    assert.equal(isPhysicallyInsideAny(sibling, [workspace]), false);

    const escapeLink = path.join(workspace, 'external');
    await fs.symlink(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(isPhysicallyInside(workspace, path.join(escapeLink, 'secret.txt')), false);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
