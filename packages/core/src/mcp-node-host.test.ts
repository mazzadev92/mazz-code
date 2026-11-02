import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { validateMcpConfig, WorkerMcpTransport } from './mcp-manager.js';

// Written next to the compiled tests so the fixture resolves @modelcontextprotocol/sdk like Studio does.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), `mcp-fixture-${process.pid}.mjs`);

const fixtureSource = (version: string) => `
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
const attempt = (run) => { try { run(); return 'executed'; } catch (err) { return err.name; } };
server.tool('try_exec', async () => ({ content: [{ type: 'text', text: attempt(() => spawn('cmd')) + ',' + attempt(() => execSync('echo x')) }] }));
server.tool('version', async () => ({ content: [{ type: 'text', text: '${version}' }] }));
console.error('fixture log line');
await server.connect(new StdioServerTransport());
`;

async function connect(stderr: string[]): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new WorkerMcpTransport(fixture, (text) => stderr.push(text)));
  return client;
}

const text = (result: unknown) => ((result as { content: Array<{ text: string }> }).content[0]!.text);

test('in-process MCP server: child_process blocked, stdio routed over MessagePort, fresh module on reload', async () => {
  // Arrange
  await fs.writeFile(fixture, fixtureSource('V1'), 'utf8');
  const stderr: string[] = [];
  try {
    // Act
    const first = await connect(stderr);
    const blocked = text(await first.callTool({ name: 'try_exec', arguments: {} }));
    const v1 = text(await first.callTool({ name: 'version', arguments: {} }));
    await first.close();
    await fs.writeFile(fixture, fixtureSource('V2'), 'utf8');
    const second = await connect(stderr);
    const v2 = text(await second.callTool({ name: 'version', arguments: {} }));
    await second.close();

    // Assert
    assert.equal(blocked, 'SelfExecBlockedError,SelfExecBlockedError');
    assert.deepEqual([v1, v2], ['V1', 'V2']);
    assert.ok(stderr.some((line) => line.includes('fixture log line')));
  } finally {
    await fs.rm(fixture, { force: true });
  }
});

test('in-process MCP server: a module that fails to load closes the connection with its error', async () => {
  // Arrange
  await fs.writeFile(fixture, 'throw new Error("boom at load");\n', 'utf8');
  const stderr: string[] = [];
  try {
    // Act / Assert
    await assert.rejects(connect(stderr));
    assert.ok(stderr.some((line) => line.includes('boom at load')));
  } finally {
    await fs.rm(fixture, { force: true });
  }
});

test('node transport config requires an absolute JavaScript entry point', () => {
  assert.throws(() => validateMcpConfig({ id: 'local', transport: 'node', entryPoint: 'server.mjs' }), /absolu/);
  assert.equal(validateMcpConfig({ id: 'local', transport: 'node', entryPoint: fixture }).entryPoint, fixture);
});
