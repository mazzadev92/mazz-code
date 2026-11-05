import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ChatMessage } from '@mazz/shared';
import { resetLlamaKeyCacheForTests } from '@mazz/shared';
import { compactOldestToolExchanges } from './agent-loop.js';
import { resolveCompactionEndpoint } from './compaction.js';

function history(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'user', content: 'objectif' }];
  for (let i = 1; i <= 3; i++) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'fs.read', arguments: { path: `f${i}.txt` } }] });
    messages.push({ role: 'tool', content: `contenu de f${i}`, toolCallId: `c${i}` });
  }
  return messages;
}

async function withDraft(handler: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mazz-compaction-'));
  const previousKey = process.env.MAZZ_LLAMA_KEY_FILE;
  const previousUrl = process.env.MAZZ_COMPACTION_URL;
  process.env.MAZZ_LLAMA_KEY_FILE = path.join(dir, 'llama.key');
  delete process.env.MAZZ_COMPACTION_URL;
  resetLlamaKeyCacheForTests();
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousKey === undefined) delete process.env.MAZZ_LLAMA_KEY_FILE; else process.env.MAZZ_LLAMA_KEY_FILE = previousKey;
    if (previousUrl !== undefined) process.env.MAZZ_COMPACTION_URL = previousUrl;
    resetLlamaKeyCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('compaction: draft summary replaces the dropped exchanges (bearer key, temperature 0, 400 tokens) [fake server]', async () => {
  let request: { auth?: string; body?: any } = {};
  await withDraft((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      request = { auth: req.headers.authorization, body: JSON.parse(raw) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'f1 et f2 lus.' } }] }));
    });
  }, async (url) => {
    const messages = history();
    const dropped = await compactOldestToolExchanges(messages, 1, url);
    assert.equal(dropped, 2);
    assert.match(request.auth ?? '', /^Bearer .{16,}/);
    assert.equal(request.body.temperature, 0);
    assert.equal(request.body.max_tokens, 400);
    assert.match(request.body.messages[1].content, /f1\.txt/);
    const note = messages.find((m) => m.content.startsWith('[Contexte compacté'));
    assert.ok(note?.content.includes('Résumé de ces échanges : f1 et f2 lus.'));
    assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
  });
});

test('compaction: timeout and HTTP failure fall back to the mechanical drop', async () => {
  await withDraft(() => { /* never answers */ }, async (url) => {
    const messages = history();
    assert.equal(await compactOldestToolExchanges(messages, 1, url, 150), 2);
    const note = messages.find((m) => m.content.startsWith('[Contexte compacté'));
    assert.ok(note && !note.content.includes('Résumé'));
    assert.equal(messages.filter((m) => m.role === 'tool').length, 1);
  });
  await withDraft((_req, res) => { res.writeHead(500); res.end('boom'); }, async (url) => {
    const messages = history();
    assert.equal(await compactOldestToolExchanges(messages, 1, url), 2);
    assert.ok(!messages.some((m) => m.content.includes('Résumé')));
  });
});

test('compaction: no endpoint means no HTTP call, and MAZZ_COMPACTION_URL overrides the setting', async () => {
  let calls = 0;
  await withDraft((_req, res) => { calls++; res.writeHead(500); res.end(); }, async () => {
    const messages = history();
    assert.equal(await compactOldestToolExchanges(messages, 1, undefined), 2);
    assert.equal(await compactOldestToolExchanges(history(), 1, resolveCompactionEndpoint('')), 2);
    assert.equal(calls, 0);
    assert.equal(resolveCompactionEndpoint(' http://a:1/ '), 'http://a:1');
    process.env.MAZZ_COMPACTION_URL = 'http://b:2/';
    try { assert.equal(resolveCompactionEndpoint('http://a:1'), 'http://b:2'); } finally { delete process.env.MAZZ_COMPACTION_URL; }
    assert.equal(await compactOldestToolExchanges(history(), 5, 'http://127.0.0.1:1'), 0);
  });
});
