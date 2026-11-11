import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkspaceManager } from './workspace-manager.js';

test('WorkspaceManager utilise MAZZ_WORKSPACE_ROOT et crée le dossier', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-workspace-env-'));
  const root = path.join(parent, 'workspace');
  const previous = process.env.MAZZ_WORKSPACE_ROOT;
  process.env.MAZZ_WORKSPACE_ROOT = root;
  try {
    const manager = new WorkspaceManager();
    assert.equal(manager.getWorkspaceRoot(), path.resolve(root));
    assert.equal((await fs.stat(root)).isDirectory(), true);
  } finally {
    if (previous === undefined) delete process.env.MAZZ_WORKSPACE_ROOT;
    else process.env.MAZZ_WORKSPACE_ROOT = previous;
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('WorkspaceManager donne priorité au dossier explicite sur MAZZ_WORKSPACE_ROOT', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-workspace-explicit-'));
  const envRoot = path.join(parent, 'env');
  const explicit = path.join(parent, 'explicit');
  const previous = process.env.MAZZ_WORKSPACE_ROOT;
  process.env.MAZZ_WORKSPACE_ROOT = envRoot;
  try {
    const manager = new WorkspaceManager(explicit);
    assert.equal(manager.getWorkspaceRoot(), path.resolve(explicit));
    await assert.rejects(fs.stat(envRoot), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.MAZZ_WORKSPACE_ROOT;
    else process.env.MAZZ_WORKSPACE_ROOT = previous;
    await fs.rm(parent, { recursive: true, force: true });
  }
});
