// Minimal MCP server (stdio) used by the core tests to exercise the real client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'mazz-test-server', version: '0.1.0' });
server.registerTool('add', { description: 'Additionne deux nombres', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));
server.registerTool('fail', { description: 'Renvoie toujours une erreur', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'échec volontaire' }],
  isError: true,
}));
server.registerTool('secret', { description: 'Renvoie la variable MAZZ_TEST_SECRET', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: process.env.MAZZ_TEST_SECRET ?? '(absente)' }],
}));
await server.connect(new StdioServerTransport());
