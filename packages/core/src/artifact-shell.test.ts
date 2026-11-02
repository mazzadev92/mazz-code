import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MazzServer } from './server.js';
import { ARTIFACT_SHELL_PATH } from './artifact-shell.js';

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', () => resolve()); });
  const address = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('Port loopback introuvable.');
  return address.port;
}

test('artifactShell_route_hasOwnSandboxedCspAllowingInlineScriptsOnly', async () => {
  // Arrange
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-artifact-shell-'));
  const port = await freePort();
  const server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
  await server.start();
  try {
    // Act
    const res = await fetch(`http://127.0.0.1:${port}${ARTIFACT_SHELL_PATH}`);
    const body = await res.text();
    // Assert
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.equal(res.status, 200);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'unsafe-inline'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /sandbox allow-scripts(;|$)/);
    assert.doesNotMatch(csp, /allow-same-origin|script-src[^;]*'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(body, /mazz-artifact-ready/);
  } finally {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
