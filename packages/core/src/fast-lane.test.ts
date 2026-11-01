import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { MazzServer } from './server.js';
import { defaultProviderRegistry } from '@mazz/providers';

async function reservePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Échec de réservation d’un port de test.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function readSse(response: Response): Promise<any[]> {
  const text = await response.text();
  const events: any[] = [];
  for (const block of text.split('\n\n')) {
    if (block.includes('event: meta')) continue;
    const line = block.split('\n').find((entry) => entry.startsWith('data: '));
    if (!line || line === 'data: [DONE]') continue;
    events.push(JSON.parse(line.slice(6)));
  }
  return events;
}

test('/fast routes the exact calculation to Bib1 research and completes without any LLM call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-fast-lane-'));
  const dataDir = path.join(root, 'studio-data');
  await fs.mkdir(dataDir, { recursive: true });
  const port = await reservePort();
  const app = new MazzServer({ port, dataDir, webRoot: path.join(dataDir, 'no-web') });
  const knowledge = (app as any).knowledge;
  const calls: Array<{ query: string; options: any }> = [];
  knowledge.available = () => true;
  knowledge.context = async (query: string, _k: number, _budget: number, options: any) => {
    calls.push({ query, options });
    return {
      query,
      context: '',
      characters: 0,
      citations: [],
      knowledge: [{ id: 'mazz.pilot.fractions', path: 'fractions.md', title: 'Addition de fractions exactes', line: 26, body: 'Additionner a/b et c/d.', status: 'verified', absolute_path: 'D:\\Bib1\\fractions.md' }],
      methods: [],
      can_execute_directly: true,
      formatted_answer: 'Résultat vérifié (07.math_engine (rational_add)) : **29/36**',
      uie_result: { engine: '07.math_engine (rational_add)', verified: true, output: { value: '29/36' } },
      execution_path: 'fast_path',
      orchestration_mode: 'FAST',
      engine_status: 'ok',
      warnings: [],
    };
  };

  const provider = defaultProviderRegistry.get('deterministic-test') as any;
  const originalChatStream = provider.chatStream.bind(provider);
  let llmCalls = 0;
  provider.chatStream = async function* (...args: any[]) {
    llmCalls++;
    yield* originalChatStream(...args);
  };

  try {
    await app.start();
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: '/fast Calcule 5/12 + 7/18',
        mode: 'agent',
        selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' },
      }),
    });
    assert.equal(response.status, 200);
    const events = await readSse(response);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.query, 'Calcule 5/12 + 7/18');
    assert.equal(calls[0]!.options.research, true, '/fast must opt into Bib1 research');

    const fastStatus = events.find((event) => event.type === 'status' && event.stage === 'orchestrator');
    assert.ok(fastStatus, 'the deterministic fast lane must announce itself');
    assert.match(fastStatus.message, /voie rapide déterministe/i);
    assert.ok(events.some((event) => event.type === 'token' && String(event.delta).includes('29/36')));
    const complete = events.find((event) => event.type === 'complete');
    assert.ok(complete);
    assert.equal(complete.success, true);
    assert.match(String(complete.summary), /29\/36/);
    assert.equal(llmCalls, 0, 'the deterministic lane must not call the model');
  } finally {
    provider.chatStream = originalChatStream;
    await app.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a calculation without /fast keeps the ordinary retrieval path and does not trigger the fast lane', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-fast-lane-default-'));
  const dataDir = path.join(root, 'studio-data');
  await fs.mkdir(dataDir, { recursive: true });
  const port = await reservePort();
  const app = new MazzServer({ port, dataDir, webRoot: path.join(dataDir, 'no-web') });
  const knowledge = (app as any).knowledge;
  const calls: Array<{ query: string; options: any }> = [];
  knowledge.available = () => true;
  knowledge.context = async (query: string, _k: number, _budget: number, options: any) => {
    calls.push({ query, options });
    return {
      query, context: '', characters: 0, citations: [],
      knowledge: [{ id: 'mazz.pilot.fractions', path: 'fractions.md', title: 'Addition de fractions exactes', line: 26, body: 'Additionner a/b et c/d.', status: 'verified', absolute_path: 'D:\\Bib1\\fractions.md' }],
      methods: [], can_execute_directly: true,
      formatted_answer: 'Résultat vérifié (07.math_engine (rational_add)) : **29/36**',
      uie_result: { engine: '07.math_engine (rational_add)', verified: true, output: { value: '29/36' } },
      execution_path: 'fast_path', orchestration_mode: 'FAST', engine_status: 'ok', warnings: [],
    };
  };

  const provider = defaultProviderRegistry.get('deterministic-test') as any;
  const originalChatStream = provider.chatStream.bind(provider);
  let llmCalls = 0;
  provider.chatStream = async function* (...args: any[]) {
    llmCalls++;
    yield* originalChatStream(...args);
  };

  try {
    await app.start();
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goal: 'Calcule 5/12 + 7/18',
        mode: 'agent',
        selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' },
      }),
    });
    assert.equal(response.status, 200);
    const events = await readSse(response);

    assert.equal(calls.length, 0, 'autoContext is off, so ordinary retrieval is not called');
    assert.equal(events.some((event) => event.type === 'status' && /voie rapide déterministe/i.test(String(event.message))), false);
    assert.equal(llmCalls, 1, 'the model keeps handling ordinary requests');
  } finally {
    provider.chatStream = originalChatStream;
    await app.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
