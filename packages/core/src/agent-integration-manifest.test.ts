import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ToolRegistry } from '@mazz/tools';
import { MazzServer } from './index.js';

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const manifestPath = path.join(projectRoot, 'AGENT_INTEGRATION_MANIFEST.json');
const serverSourcePath = path.join(projectRoot, 'packages/core/src/server.ts');

type Manifest = {
  api: { endpoints: Array<{ path: string; method: string }> };
  tools: string[];
  toolDiscovery: {
    path: string;
    method: string;
    responsePath: string;
    registryTools: string[];
    alwaysRegistered: string[];
    conditionallyRegistered: string[];
    dynamicNamePatterns: Array<{ pattern: string }>;
  };
};

function endpointKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

function routesFromSource(source: string): Set<string> {
  const routes = new Set<string>();
  const routePattern = /\br\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g;
  for (const match of source.matchAll(routePattern)) routes.add(endpointKey(match[1], match[3]));
  return routes;
}

async function freePort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('integration manifest matches the tool registry, live discovery API, and mounted MCP routes', async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
  const routeSource = await fs.readFile(serverSourcePath, 'utf8');
  const mountedRoutes = routesFromSource(routeSource);
  const declaredRoutes = new Set(manifest.api.endpoints.map((route) => endpointKey(route.method, route.path)));
  for (const route of declaredRoutes) assert.ok(mountedRoutes.has(route), `Manifest declares an unmounted API route: ${route}`);

  const mountedMcpRoutes = new Set([...mountedRoutes].filter((route) => route.split(' ').at(1)?.startsWith('/api/mcp/servers')));
  const declaredMcpRoutes = new Set([...declaredRoutes].filter((route) => route.split(' ').at(1)?.startsWith('/api/mcp/servers')));
  assert.deepEqual([...declaredMcpRoutes].sort(), [...mountedMcpRoutes].sort(), 'MCP API routes in the manifest must equal the routes registered by the server');

  const registryNames = new ToolRegistry().list().map((tool) => tool.name).sort();
  assert.deepEqual([...manifest.toolDiscovery.registryTools].sort(), registryNames, 'Manifest package registry tools must match @mazz/tools');

  const knownNames = new Set([...manifest.toolDiscovery.alwaysRegistered, ...manifest.toolDiscovery.conditionallyRegistered]);
  assert.deepEqual([...manifest.tools].sort(), [...knownNames].sort(), 'The manifest catalog must be the union of always and conditional runtime tools');
  assert.deepEqual([manifest.toolDiscovery.method, manifest.toolDiscovery.path, manifest.toolDiscovery.responsePath], ['GET', '/api/tools', 'tools[].name']);

  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-manifest-data-'));
  const server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
  await server.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const toolsResponse = await fetch(`${base}${manifest.toolDiscovery.path}`);
    assert.equal(toolsResponse.status, 200);
    const toolsPayload = await toolsResponse.json() as { tools: Array<{ name: string }> };
    const liveNames = toolsPayload.tools.map((tool) => tool.name).sort();
    const conditional = new Set(manifest.toolDiscovery.conditionallyRegistered);
    const expectedLiveNames = [...knownNames].filter((name) => !conditional.has(name) || liveNames.includes(name)).sort();
    const dynamicNames = liveNames.filter((name) => name.startsWith('mcp.'));
    assert.deepEqual(liveNames.filter((name) => !name.startsWith('mcp.')).sort(), expectedLiveNames,
      'GET /api/tools contains undeclared tools or omits a mandatory registered tool');
    for (const name of dynamicNames) assert.match(name, /^mcp\.[^.]+\..+$/, 'MCP tool name must follow the runtime namespace contract');

    const mcpResponse = await fetch(`${base}/api/mcp/servers`);
    assert.equal(mcpResponse.status, 200);
    assert.ok(Array.isArray((await mcpResponse.json() as { servers: unknown[] }).servers));
    const skillsResponse = await fetch(`${base}/api/skills`);
    assert.equal(skillsResponse.status, 200);
    assert.ok(Array.isArray((await skillsResponse.json() as { skills: unknown[] }).skills));
  } finally {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
