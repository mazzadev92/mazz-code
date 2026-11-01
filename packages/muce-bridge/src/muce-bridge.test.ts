import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MuceBridge } from './index.js';

test('MUCE Bridge Contract: handles unconfigured state with transparent fallback', async () => {
  const bridge = new MuceBridge('');
  const status = await bridge.inspect();
  assert.equal(status.isConfigured, false);
  assert.equal(status.isFallbackActive, true);
  assert.equal(status.isCliAvailable, false);
});

test('MUCE Bridge Contract: handles non-existent path without crashing', async () => {
  const bridge = new MuceBridge('C:\\non_existent_muce_path_xyz_123');
  const status = await bridge.inspect();
  assert.equal(status.isConfigured, true);
  assert.equal(status.isManifestValid, false);
  assert.equal(status.isFallbackActive, true);
  assert.ok(status.error?.includes('introuvable'));
});

test('MUCE Bridge Contract: handles invalid JSON manifest gracefully', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-muce-test-'));
  try {
    await fs.writeFile(path.join(tempDir, 'INTEGRATION_MANIFEST.json'), '{ invalid json ...');
    const bridge = new MuceBridge(tempDir);
    const status = await bridge.inspect();
    assert.equal(status.isManifestValid, false);
    assert.equal(status.isFallbackActive, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('MUCE Bridge Contract: valid manifest with verified CLI path', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-muce-test-'));
  try {
    // Create fake muce_cli.exe (script or empty file)
    await fs.writeFile(path.join(tempDir, 'muce_cli.exe'), 'binary content');
    const manifest = {
      manifestVersion: '1.0.0',
      name: 'MAZZ Universal Compute Engine',
      version: '0.9.0-alpha',
      cliPath: './muce_cli.exe',
      capabilities: {
        hardwareDetection: true,
        cpuOptimization: true,
      },
    };
    await fs.writeFile(
      path.join(tempDir, 'INTEGRATION_MANIFEST.json'),
      JSON.stringify(manifest, null, 2)
    );

    const bridge = new MuceBridge(tempDir);
    const status = await bridge.inspect();
    assert.equal(status.isManifestValid, true);
    assert.equal(status.isCliAvailable, true);
    assert.equal(status.isFallbackActive, false);
    assert.equal(status.manifest?.name, 'MAZZ Universal Compute Engine');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
