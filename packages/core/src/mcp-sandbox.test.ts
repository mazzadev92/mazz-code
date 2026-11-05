import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { confinedCwd, journalEntry, McpJournal, normalizeMcpPermission, scrubbedEnv } from './mcp-sandbox.js';
import { validateMcpConfig } from './mcp-manager.js';

test('scrubbedEnv drops secrets and keeps essentials and the explicit env map', () => {
  const base = { PATH: '/bin', SystemRoot: 'C:\\Windows', TEMP: '/tmp', MAZZ_GATEWAY_KEY: 'g', HF_TOKEN: 'h', MAZZ_HOME: '/x', OPENAI_API_KEY: 'o' };
  const env = scrubbedEnv({ MY_VAR: '1' }, { name: 'API', value: 's' }, base);
  assert.deepEqual(Object.keys(env).sort(), ['API', 'MY_VAR', 'PATH', 'SystemRoot', 'TEMP']);
  assert.equal(JSON.stringify(env).includes('"g"'), false);
  assert.equal(env.HF_TOKEN, undefined);
});

test('confinedCwd prefers the configured dir, falls back to the workspace and refuses missing dirs', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpcwd-'));
  assert.equal(confinedCwd(a, '/nope'), path.resolve(a));
  assert.equal(confinedCwd(undefined, a), path.resolve(a));
  assert.throws(() => confinedCwd(path.join(a, 'absent'), a), /introuvable/);
  assert.throws(() => confinedCwd(undefined, undefined), /Aucun dossier/);
});

test('journal keeps argument names only, never values', () => {
  const e = journalEntry('srv', 'tool', { query: 'hello', apiToken: 'SECRET-VALUE', password: 'p4ss' }, 12.4, true, new Date('2026-01-02T03:04:05Z'));
  assert.deepEqual(e.argKeys, ['query', 'apiToken', 'password']);
  assert.equal(e.at, '2026-01-02T03:04:05.000Z');
  const line = JSON.stringify(e);
  for (const v of ['hello', 'SECRET-VALUE', 'p4ss']) assert.equal(line.includes(v), false);
});

test('journal rotates past maxBytes and lists the newest entries first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjrn-'));
  const file = path.join(dir, 'j.jsonl');
  const j = new McpJournal(file, 300);
  for (let i = 0; i < 12; i++) j.append(journalEntry('s', `t${i}`, { a: 1 }, i, i % 2 === 0));
  assert.ok(fs.existsSync(`${file}.1`), 'rotated file exists');
  assert.ok(fs.statSync(file).size < 600);
  const last = j.last(50);
  assert.equal(last[0].tool, 't11');
  assert.ok(last.length >= 2 && last.length <= 12);
});

test('permission defaults to ask and is validated', () => {
  assert.equal(normalizeMcpPermission(undefined), 'ask');
  assert.equal(normalizeMcpPermission('bogus'), 'ask');
  assert.equal(normalizeMcpPermission('deny'), 'deny');
  assert.equal(validateMcpConfig({ id: 'a', transport: 'stdio', command: 'x' }).permission, 'ask');
  assert.equal(validateMcpConfig({ id: 'a', transport: 'stdio', command: 'x', permission: 'allow' }).permission, 'allow');
});
