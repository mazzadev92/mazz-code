import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { MazzServer } from './index.js';

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test('GET /api/files/model3d serves only confined, existing .glb files', async () => {
  // Arrange
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-model3d-'));
  const server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
  await server.start();
  try {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}/api/files/model3d?path=${encodeURIComponent(p)}`);

    // Act
    const [notGlb, escaped, missing] = await Promise.all([get('model.obj'), get('../../outside.glb'), get('absent-model-3d-test.glb')]);

    // Assert
    assert.equal(notGlb.status, 400);
    assert.equal(escaped.status, 403);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
