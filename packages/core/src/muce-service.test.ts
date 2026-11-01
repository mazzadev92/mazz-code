import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { MuceServiceManager, shouldReportToolLatency } from './muce-service.js';

test('MUCE tool telemetry excludes orchestration and time spent waiting for a user', () => {
  for (const tool of ['user.ask', 'plan.update', 'tools.request', 'agent.delegate']) {
    assert.equal(shouldReportToolLatency(tool), false, tool);
  }
  assert.equal(shouldReportToolLatency('fs.read'), true);
  assert.equal(shouldReportToolLatency('compiler.gcc'), true);
});

test('MUCE tool latency feedback stays loopback-only and sends bounded measurements', async () => {
  const received: Array<{ tool_name: string; latency_ms: number }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool_name: string; latency_ms: number });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recorded: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const manager = new MuceServiceManager(`http://127.0.0.1:${address.port}`);
    assert.equal(await manager.recordToolLatency('fs.read', 12.345), true);
    assert.deepEqual(received, [{ tool_name: 'fs.read', latency_ms: 12.35 }]);
    assert.equal(await manager.recordToolLatency('invalid tool name', 3), false);
    assert.equal(await manager.recordToolLatency('fs.write', Number.NaN), false);
    assert.equal(await manager.recordToolLatency('fs.write', 0), false);
    assert.equal(received.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MUCE service manager rejects non-loopback telemetry destinations', () => {
  assert.throws(() => new MuceServiceManager('https://example.com'), /boucle locale/);
});
