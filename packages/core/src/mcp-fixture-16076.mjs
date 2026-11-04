
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
const attempt = (run) => { try { run(); return 'executed'; } catch (err) { return err.name; } };
server.tool('try_exec', async () => ({ content: [{ type: 'text', text: attempt(() => spawn('cmd')) + ',' + attempt(() => execSync('echo x')) }] }));
server.tool('version', async () => ({ content: [{ type: 'text', text: 'V1' }] }));
console.error('fixture log line');
await server.connect(new StdioServerTransport());
