import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AgentEvent } from '@mazz/shared';
import { defaultToolRegistry } from '@mazz/tools';
import { OpenAiCompatibleProvider, buildToolCallSchema, parseConstrainedReply, shouldConstrainToolCalls, toWireToolName } from '@mazz/providers';

const local = { local: true, llamaCpp: true };

test('schema covers every real registry tool plus the final answer', () => {
  const tools = defaultToolRegistry.list();
  assert.ok(tools.length > 10);
  const schema = buildToolCallSchema(tools) as { oneOf: Array<{ properties: Record<string, any> }> };
  assert.equal(schema.oneOf.length, tools.length + 1);
  tools.forEach((tool, i) => {
    assert.equal(schema.oneOf[i].properties.name.const, toWireToolName(tool.name));
    assert.equal(schema.oneOf[i].properties.arguments.type, 'object');
  });
  assert.deepEqual(Object.keys(schema.oneOf[tools.length].properties), ['answer']);
  assert.doesNotThrow(() => JSON.stringify(schema));
});

test('parseConstrainedReply maps wire names back, reads answers, rejects the rest', () => {
  const tools = defaultToolRegistry.list();
  const read = tools.find((t) => t.name === 'fs.read')!;
  const reply = parseConstrainedReply(JSON.stringify({ name: toWireToolName(read.name), arguments: { path: 'a.txt' } }), tools);
  assert.deepEqual(reply, { call: { name: 'fs.read', arguments: { path: 'a.txt' } } });
  assert.deepEqual(parseConstrainedReply('{"answer":"fait"}', tools), { answer: 'fait' });
  assert.equal(parseConstrainedReply('{"name":"inconnu","arguments":{}}', tools), undefined);
  assert.equal(parseConstrainedReply('{"name":"fs__read","arg', tools), undefined);
});

test('auto threshold: on under 8B (metadata then name), off from 8B, unknown, remote or non-llama', () => {
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'Mazz-Technos-Base-4B.Q4_K_M' }), true);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'x', meta: { parameterCount: 600_000_000 } }), true);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'x', meta: { sizeLabel: '0.6B' } }), true);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'x', meta: { sizeLabel: '7B' } }), true);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'qwen-8b' }), false);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'qwen-14b' }), false);
  assert.equal(shouldConstrainToolCalls('auto', { ...local, modelId: 'mystery' }), false);
  assert.equal(shouldConstrainToolCalls('auto', { local: false, llamaCpp: true, modelId: 'm-4b' }), false);
  assert.equal(shouldConstrainToolCalls('auto', { local: true, llamaCpp: false, modelId: 'm-4b' }), false);
  assert.equal(shouldConstrainToolCalls('on', { ...local, modelId: 'qwen-32b' }), true);
  assert.equal(shouldConstrainToolCalls('on', { local: false, llamaCpp: true, modelId: 'm' }), false);
  assert.equal(shouldConstrainToolCalls('off', { ...local, modelId: 'm-4b' }), false);
  assert.equal(shouldConstrainToolCalls(undefined, { ...local, modelId: 'm-4b' }), true);
});

async function withLlama(handler: (body: any) => { status?: number; content: string }, run: (provider: OpenAiCompatibleProvider, bodies: any[]) => Promise<void>): Promise<void> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (value: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.url === '/props') return json({ model_path: 'm.gguf', default_generation_settings: { n_ctx: 8192 } });
      if (req.url === '/apply-template') return json({ prompt: 'p' });
      if (req.url === '/tokenize') return json({ tokens: [1, 2, 3] });
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(raw);
        bodies.push(body);
        const out = handler(body);
        if (out.status) { res.writeHead(out.status); res.end('{"error":"grammar"}'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: out.content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await run(new OpenAiCompatibleProvider({ id: 'llama-c', type: 'llama_cpp', name: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' }), bodies);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

async function collect(provider: OpenAiCompatibleProvider, constrain: boolean | undefined): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const tools = defaultToolRegistry.list().filter((t) => t.name === 'fs.read' || t.name === 'fs.list');
  for await (const e of provider.chatStream([{ role: 'user', content: 'lis a.txt' }], tools, { modelId: 'm', taskId: 't', constrainToolCalls: constrain })) events.push(e);
  return events;
}

test('request carries json_schema + tool_choice none only when constrained, and the call becomes tool_start [mock llama]', async () => {
  await withLlama(() => ({ content: '{"name":"fs__read","arguments":{"path":"a.txt"}}' }), async (provider, bodies) => {
    const events = await collect(provider, true);
    assert.equal(bodies[0].response_format.type, 'json_schema');
    assert.equal(bodies[0].tool_choice, 'none');
    assert.equal(bodies[0].response_format.json_schema.schema.oneOf.length, 3);
    assert.ok(events.some((e) => e.type === 'tool_start' && e.toolName === 'fs.read' && (e.params as any).path === 'a.txt'));
    assert.ok(!events.some((e) => e.type === 'token'));
    await collect(provider, false);
    assert.equal(bodies[1].response_format, undefined);
    assert.equal(bodies[1].tool_choice, 'auto');
  });
});

test('constrained final answer is emitted as text; HTTP 400 falls back unconstrained [mock llama]', async () => {
  await withLlama(() => ({ content: '{"answer":"Bonjour"}' }), async (provider) => {
    const events = await collect(provider, true);
    assert.equal(events.filter((e) => e.type === 'token').map((e: any) => e.delta).join(''), 'Bonjour');
  });
  await withLlama((body) => (body.response_format ? { status: 400, content: '' } : { content: 'texte libre' }), async (provider, bodies) => {
    const events = await collect(provider, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].response_format, undefined);
    assert.equal(events.filter((e) => e.type === 'token').map((e: any) => e.delta).join(''), 'texte libre');
    assert.ok(events.some((e) => e.type === 'status' && e.stage === 'constrained-decoding'));
  });
});
