import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AgentEvent, UsageEvent } from '@mazz/shared';
import { AnthropicProvider, GeminiProvider, OpenAiCompatibleProvider, assertUniqueWireToolNames, compactResolvedToolRejections, fromWireToolName, likelyVisionModel, resolveToolName, retryDelayMs, validateCompletionChunk, sanitizeProviderDiagnostic, toOpenAiMessage, toWireToolName, TelemetryRecorder } from './index.js';

/** Mock OpenAI-compatible server (labelled mock: real-model runs are covered by the E2E report). */
function mockServer(chunks: string[], delayMs = 5): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const c of chunks) {
        if (res.destroyed) return;
        res.write(`data: ${c}\n\n`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const delta = (content: string) => JSON.stringify({ choices: [{ delta: { content } }] });

test('resolved rejected text calls are compacted only after a later successful tool result', () => {
  const original = [
    { role: 'user' as const, content: 'Patch the file.' },
    { role: 'assistant' as const, content: '{"tool":"user.ask","arguments":{}}' },
    { role: 'user' as const, content: '<tool_call_rejected>Call fs.patch instead.</tool_call_rejected>' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'patch', name: 'fs.patch', arguments: {} }] },
    { role: 'tool' as const, toolCallId: 'patch', name: 'fs.patch', content: JSON.stringify({ path: 'a.txt', written: true }) },
  ];
  assert.deepEqual(compactResolvedToolRejections(original).map((message) => message.role), ['user', 'assistant', 'tool']);
  assert.deepEqual(compactResolvedToolRejections(original.slice(0, 3)), original.slice(0, 3));
  const failed = [...original.slice(0, 3), { role: 'tool' as const, content: JSON.stringify({ error: 'denied' }) }];
  assert.deepEqual(compactResolvedToolRejections(failed), failed);
});

test('wire tool names round-trip (dots are not allowed by remote APIs)', () => {
  assert.equal(toWireToolName('fs.write'), 'fs__write');
  assert.equal(fromWireToolName('fs__write'), 'fs.write');
  assert.match(toWireToolName('compiler.gcc'), /^[a-zA-Z0-9_-]+$/);
});

test('tool-name resolution is bounded by the current offered schemas', () => {
  const tools = [
    { name: 'fs.read', description: '', category: 'fs' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false },
    { name: 'code.search', description: '', category: 'analysis' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false },
  ];
  assert.equal(resolveToolName('fs.read', tools), 'fs.read');
  assert.equal(resolveToolName('fs__read', tools), 'fs.read');
  assert.equal(resolveToolName('fs_read', tools), 'fs.read');
  assert.equal(resolveToolName('code_search', tools), 'code.search');
  assert.equal(resolveToolName('terminal__run', tools), undefined);
  const multiSeparator = { name: 'mcp.agent.tools.index', description: '', category: 'mcp' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false };
  assert.equal(resolveToolName('mcp_agent_tools_index', [multiSeparator]), multiSeparator.name);
  const ambiguousAlias = [
    { name: 'one.two.three', description: '', category: 'mcp' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false },
    { name: 'one.two_three', description: '', category: 'mcp' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false },
  ];
  assert.equal(resolveToolName('one_two_three', ambiguousAlias), undefined, 'ambiguous separator folding must fail closed');
  assert.throws(() => assertUniqueWireToolNames([
    ...tools,
    { name: 'fs__read', description: '', category: 'fs' as const, parameters: { type: 'object' as const, properties: {} }, requiresPermission: false },
  ]), /ambigus/);
  assert.doesNotThrow(() => assertUniqueWireToolNames(tools));
});

test('OpenAI-compatible requests send structured tool schemas with tool_choice auto [mock server]', async () => {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fs__read', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAiCompatibleProvider({ id: 'provider-test', name: 'provider-test', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
    const tool = { name: 'fs.read', description: 'Read a file', category: 'fs' as const, parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] }, requiresPermission: false };
    const events: AgentEvent[] = [];
    for await (const event of provider.chatStream([{ role: 'user', content: 'read' }], [tool], { modelId: 'model', taskId: 't' })) events.push(event);
    const requiredEvents: AgentEvent[] = [];
    for await (const event of provider.chatStream([{ role: 'user', content: 'read now' }], [tool], { modelId: 'model', taskId: 't-required', toolChoice: 'required' })) requiredEvents.push(event);
    assert.deepEqual(requests.map((request) => request.tool_choice), ['auto', 'required']);
    assert.equal(requests[0].tools[0].function.name, 'fs__read');
    assert.deepEqual(requests[0].tools[0].function.parameters, tool.parameters);
    assert.ok(events.some((event) => event.type === 'tool_start' && event.toolName === 'fs.read'));
    assert.ok(requiredEvents.some((event) => event.type === 'tool_start' && event.toolName === 'fs.read'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('llama.cpp accepts a complete schema-valid native tool call terminated with stop or length [mock server]', async () => {
  let finishReason = 'stop';
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model_path: 'local-test.gguf', default_generation_settings: { n_ctx: 1024 } }));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (req.url === '/apply-template') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ prompt: 'mock rendered prompt' }));
          return;
        }
        if (req.url === '/tokenize') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ tokens: [1, 2, 3] }));
          return;
        }
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${finishReason}`, type: 'function', function: { name: 'fs__list', arguments: '{"path":"."}' } }] }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`);
          return;
        }
        res.writeHead(404); res.end();
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAiCompatibleProvider({ id: 'llama-stop', type: 'llama_cpp', name: 'local llama', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
    const tool = { name: 'fs.list', description: 'List files', category: 'fs' as const, parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] }, requiresPermission: false };
    for (const reason of ['stop', 'length']) {
      finishReason = reason;
      const events: AgentEvent[] = [];
      for await (const event of provider.chatStream([{ role: 'user', content: 'list' }], [tool], { modelId: 'local-test.gguf', taskId: `llama-${reason}`, toolChoice: 'required' })) events.push(event);
      assert.ok(events.some((event) => event.type === 'tool_start' && event.toolName === 'fs.list' && event.callId === `call-${reason}`));
      const usage = events.find((event): event is UsageEvent => event.type === 'usage');
      assert.equal(usage?.telemetry?.stopReason, 'tool_calls');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('llama.cpp completes raw code prefixes through /completion stop=true without requiring an OpenAI [DONE] sentinel [mock server]', async () => {
  let completionRequest: any;
  let terminalStop = true;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model_path: 'local-test.gguf', default_generation_settings: { n_ctx: 2048 } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const value = JSON.parse(body);
      if (req.url === '/tokenize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tokens: [1, 2, 3, 4] }));
        return;
      }
      if (req.url === '/completion') {
        completionRequest = value;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end([
          `data: ${JSON.stringify({ content: 'return left + right;', stop: false })}\n\n`,
          `data: ${JSON.stringify({ content: '', stop: terminalStop, stop_type: terminalStop ? 'word' : 'none', timings: { prompt_n: 4, predicted_n: 5, prompt_ms: 8, predicted_ms: 20, prompt_per_second: 500, predicted_per_second: 250 } })}\n\n`,
        ].join(''));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAiCompatibleProvider({ id: 'llama-prefix', type: 'llama_cpp', name: 'local llama', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
    const events: AgentEvent[] = [];
    for await (const event of provider.completePrefix!('#include <stdio.h>\nint add(int left, int right) {\n', {
      modelId: 'local-test.gguf', taskId: 'prefix-test', maxTokens: 64, temperature: 0.1, topP: 0.8, topK: 20,
      presencePenalty: 0, stop: ['\n}\n', '<|im_end|>'],
      grammar: 'root ::= "left + right" | "right + left"',
    })) events.push(event);
    assert.equal(completionRequest.prompt, '#include <stdio.h>\nint add(int left, int right) {\n');
    assert.equal(completionRequest.n_predict, 64);
    assert.deepEqual(completionRequest.stop, ['\n}\n', '<|im_end|>']);
    assert.equal(completionRequest.grammar, 'root ::= "left + right" | "right + left"');
    assert.equal(completionRequest.top_p, 0.8);
    assert.equal(completionRequest.top_k, 20);
    assert.equal(completionRequest.presence_penalty, 0);
    assert.equal(completionRequest.stream, true);
    assert.equal(completionRequest.tools, undefined, 'la complétion brute ne reçoit aucun schéma d’outil');
    assert.equal(events.filter((event) => event.type === 'token').map((event) => event.type === 'token' ? event.delta : '').join(''), 'return left + right;');
    assert.ok(events.some((event) => event.type === 'status' && event.stage === 'context-budget' && event.contextBudget?.promptTokens === 4));
    assert.ok(events.some((event) => event.type === 'status' && event.contextSnapshot?.responseFormat === 'raw-prefix'));
    assert.ok(events.some((event) => event.type === 'usage' && event.telemetry?.backend === 'llama_cpp'));

    terminalStop = false;
    const interrupted: AgentEvent[] = [];
    for await (const event of provider.completePrefix!('int add(int a, int b) {\n', { modelId: 'local-test.gguf', taskId: 'prefix-interrupted', maxTokens: 16 })) interrupted.push(event);
    assert.ok(interrupted.some((event) => event.type === 'error' && event.code === 'INVALID_PREFIX_RESPONSE'), 'EOF without stop=true or [DONE] must remain an error');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('OpenAI-compatible non-streaming completion refuses redirects before prompt data reaches another origin', async () => {
  let redirectedRequests = 0;
  const destination = http.createServer((req, res) => {
    redirectedRequests += 1;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'unexpected' } }] }));
  });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const destinationPort = (destination.address() as { port: number }).port;
  const redirector = http.createServer((_req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${destinationPort}/capture` });
    res.end();
  });
  await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectPort = (redirector.address() as { port: number }).port;
  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'local-redirect-guard', name: 'Local redirect fixture',
      baseUrl: `http://127.0.0.1:${redirectPort}/v1`, locality: 'local',
    });
    await assert.rejects(provider.chatComplete(
      [{ role: 'user', content: 'PRIVATE_PROMPT_REDIRECT_SENTINEL' }],
      [],
      { modelId: 'local-model', taskId: 'local-redirect-guard' },
    ));
    assert.equal(redirectedRequests, 0, 'the 307 target must not receive the private prompt');
  } finally {
    await Promise.all([redirector, destination].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
  }
});

test('llama.cpp reduces only the output reserve when the measured prompt leaves a smaller native budget [mock server]', async () => {
  let completionRequest: any;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/props') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model_path: 'local-test.gguf', default_generation_settings: { n_ctx: 1024 } }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const value = body ? JSON.parse(body) : {};
      if (req.url === '/apply-template') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt: 'actual rendered prompt' }));
      }
      else if (req.url === '/tokenize') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tokens: Array.from({ length: 900 }, (_, index) => index) }));
      }
      else if (req.url === '/v1/chat/completions') {
        completionRequest = value;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAiCompatibleProvider({ id: 'llama-budget', type: 'llama_cpp', name: 'local llama', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
    const events: AgentEvent[] = [];
    const forcedTool = { name: 'fs.list', description: 'List directory entries', category: 'fs' as const, parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] }, requiresPermission: false };
    for await (const event of provider.chatStream([{ role: 'user', content: 'prompt' }], [forcedTool], {
      modelId: 'local-test.gguf', taskId: 'budget', maxTokens: 256, toolChoice: 'required',
      topP: 0.8, topK: 20, presencePenalty: 1.5,
    })) events.push(event);
    const budget = events.find((event) => event.type === 'status' && event.stage === 'context-budget');
    assert.ok(budget?.type === 'status' && budget.contextBudget);
    assert.equal(budget.contextBudget.promptTokens, 900);
    assert.equal(budget.contextBudget.requestedOutputTokens, 256);
    assert.equal(budget.contextBudget.reservedOutputTokens, 108);
    assert.equal(budget.contextBudget.outputBudgetAdjusted, true);
    assert.equal(completionRequest.max_tokens, 108);
    assert.equal(completionRequest.tool_choice, 'required');
    assert.equal(completionRequest.tools[0].function.name, 'fs__list');
    assert.deepEqual(completionRequest.tools[0].function.parameters, forcedTool.parameters);
    assert.equal(completionRequest.response_format, undefined, 'native tool schema avoids leaking the JSON envelope into file content');
    assert.equal(completionRequest.cache_prompt, false, 'forced calls bypass llama.cpp prefix reuse');
    assert.equal(completionRequest.top_p, 0.8);
    assert.equal(completionRequest.top_k, 20);
    assert.equal(completionRequest.presence_penalty, 1.5);
    const snapshot = events.find((event) => event.type === 'status' && event.stage === 'context-snapshot');
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.toolChoice : undefined, 'required');
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.responseFormat : undefined, undefined);
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.cachePrompt : undefined, false);
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.topP : undefined, 0.8);
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.topK : undefined, 20);
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.presencePenalty : undefined, 1.5);
    assert.equal(snapshot?.type === 'status' ? snapshot.contextSnapshot?.tools.length : undefined, 1);
    const systemPrompt = snapshot?.type === 'status' ? snapshot.contextSnapshot?.messages[0]?.content : undefined;
    assert.equal(typeof systemPrompt, 'string');
    assert.doesNotMatch(systemPrompt as string, /required_tool_call/);
    assert.ok(events.some((event) => event.type === 'token' && event.delta === 'ok'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('llama.cpp timings take priority and keep pp and tg separate [mock server]', async () => {
  const srv = await mockServer([
    delta('Bon'),
    delta('jour'),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 7 }, timings: { prompt_n: 20, prompt_ms: 128.4, prompt_per_second: 155.7, predicted_n: 7, predicted_ms: 282.3, predicted_per_second: 21.26 } }),
  ]);
  try {
    // This historical transport fixture is not a llama.cpp tokenizer service.
    const p = new OpenAiCompatibleProvider({ id: 'llama-local', type: 'openai_compatible', name: 'mock', baseUrl: srv.url, locality: 'local' });
    const events: AgentEvent[] = [];
    for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't' })) events.push(ev);
    const usage = events.find((e): e is UsageEvent => e.type === 'usage')!;
    assert.equal(usage.telemetry?.speedSource, 'runtime_timings');
    assert.equal(usage.telemetry?.ppTokS, 155.7);
    assert.equal(usage.telemetry?.tgTokS, 21.26);
    assert.equal(usage.tokensPerSecond, 21.26);
    assert.equal(usage.promptTokens, 20);
    assert.ok((usage.telemetry?.ttftMs ?? -1) >= 0);
  } finally {
    await srv.close();
  }
});

test('without counters the rate is labelled as a chunk estimate, never as tokens [mock server]', async () => {
  const srv = await mockServer([delta('a'), delta('b'), delta('c')], 150);
  try {
    const p = new OpenAiCompatibleProvider({ id: 'x', name: 'mock', baseUrl: srv.url, locality: 'local' });
    const events: AgentEvent[] = [];
    for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't' })) events.push(ev);
    const t = (events.find((e) => e.type === 'usage') as UsageEvent).telemetry!;
    assert.equal(t.tokenSource, 'unavailable');
    assert.equal(t.speedSource, 'client_estimate');
    assert.equal(t.streamedChunks, 3);
    assert.equal(t.ppTokS, undefined);
  } finally {
    await srv.close();
  }
});

test('abort mid-stream yields a partial record instead of throwing [mock server]', async () => {
  const srv = await mockServer(Array.from({ length: 40 }, (_, i) => delta(`t${i} `)), 25);
  try {
    const p = new OpenAiCompatibleProvider({ id: 'x', name: 'mock', baseUrl: srv.url, locality: 'local' });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const events: AgentEvent[] = [];
    for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't', signal: ctrl.signal })) events.push(ev);
    const t = (events.find((e) => e.type === 'usage') as UsageEvent).telemetry!;
    assert.equal(t.stopReason, 'aborted');
    assert.equal(t.partial, true);
    assert.ok(events.filter((e) => e.type === 'token').length < 40);
  } finally {
    await srv.close();
  }
});

test('unreachable provider reports an error event, not a crash', async () => {
  const p = new OpenAiCompatibleProvider({ id: 'x', name: 'mock', baseUrl: 'http://127.0.0.1:9/v1', locality: 'local' });
  const events: AgentEvent[] = [];
  for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't' })) events.push(ev);
  const failure = events.find(e => e.type === 'error');
  assert.ok(failure);
  assert.equal((failure as { code: string }).code, 'PROVIDER_UNREACHABLE');
});

test('provider_rateLimit_waitsAndRetries_thenStreams [loopback HTTP]', async () => {
  // Arrange: the first call is rate limited with Groq's wording, the second streams a reply.
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached on tokens per minute (TPM). Please try again in 0.05s.' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const p = new OpenAiCompatibleProvider({ id: 'rl', name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'remote' });
  const events: AgentEvent[] = [];
  try {
    // Act
    for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't' })) events.push(ev);
    // Assert
    assert.equal(calls, 2);
    assert.ok(events.some((e) => e.type === 'status' && (e as { stage?: string }).stage === 'rate-limit'));
    assert.equal(events.filter((e) => e.type === 'token').map((e) => (e as { delta: string }).delta).join(''), 'ok');
    assert.equal(events.some((e) => e.type === 'error'), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('provider_inStreamError_reportsProviderMessage', () => {
  assert.throws(() => validateCompletionChunk({ error: { code: 'tool_use_failed', message: 'Failed to call a function.' } }), /Erreur du fournisseur dans le flux : tool_use_failed : Failed to call a function\./);
  assert.throws(() => validateCompletionChunk({ id: 'x' }), /choices doit être un tableau/);
});

test('provider_retryDelay_readsHeaderMessageOrBackoff', () => {
  assert.equal(retryDelayMs('3', '', 1), 3250);
  assert.equal(retryDelayMs(null, 'Please try again in 1.605s. Need more', 1), 1855);
  assert.equal(retryDelayMs(null, 'try again in 340ms', 1), 590);
  assert.equal(retryDelayMs(null, 'try again in 1m2.5s', 1), 62750);
  assert.equal(retryDelayMs(null, 'busy', 3), 8250);
  assert.equal(retryDelayMs('600', '', 1), 65000, 'capped');
});

test('synthetic engine records carry no speed', () => {
  const r = new TelemetryRecorder({ providerId: 'deterministic-test', modelId: 'm', locality: 'local', backend: 'deterministic', synthetic: true });
  r.onOutputChunk();
  const ev = r.toUsageEvent('t', 'complete');
  assert.equal(ev.tokensPerSecond, undefined);
  assert.equal(ev.telemetry?.speedSource, 'synthetic');
});

test('incoherent runtime timings are rejected, not displayed [mock server]', async () => {
  const srv = await mockServer([
    delta('a'),
    delta('b'),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 1513, completion_tokens: 2 }, timings: { prompt_n: 1513, prompt_ms: 40621731, prompt_per_second: 0.03, predicted_n: 2, predicted_ms: 90, predicted_per_second: 22 } }),
  ]);
  try {
    const p = new OpenAiCompatibleProvider({ id: 'llama-local', type: 'openai_compatible', name: 'mock', baseUrl: srv.url, locality: 'local' });
    const events: AgentEvent[] = [];
    for await (const ev of p.chatStream([{ role: 'user', content: 'x' }], [], { modelId: 'm', taskId: 't' })) events.push(ev);
    const t = (events.find((e) => e.type === 'usage') as UsageEvent).telemetry!;
    assert.notEqual(t.speedSource, 'runtime_timings');
    assert.equal(t.ppTokS, undefined);
    assert.equal(t.promptTokens, 1513);
    assert.ok(t.notes.some((n) => /incohérents/.test(n)));
  } finally {
    await srv.close();
  }
});

test('vision: images travel as OpenAI image_url parts; families recognised by name', () => {
  const m = toOpenAiMessage({ role: 'user', content: 'décris', images: [{ mime: 'image/png', dataBase64: 'AAAA' }] });
  assert.deepEqual(m.content, [
    { type: 'text', text: 'décris' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
  assert.equal(toOpenAiMessage({ role: 'user', content: 'texte' }).content, 'texte');
  for (const id of ['gpt-4o-mini', 'claude-sonnet-4-5', 'gemini-2.5-flash', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen2.5-vl-72b-instruct', 'pixtral-12b']) assert.ok(likelyVisionModel(id), id);
  for (const id of ['llama-3.1-8b-instant', 'deepseek-chat', 'openai/gpt-oss-20b', 'qwen3-32b']) assert.ok(!likelyVisionModel(id), id);
});

test('vision: request body sent to an OpenAI-compatible server carries the image [mock server]', async () => {
  let body = '';
  const server = http.createServer((req, res) => {
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'un chat' } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (server.address() as { port: number }).port;
    const p = new OpenAiCompatibleProvider({ id: 'llama-local', type: 'llama_cpp', name: 'mock', baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local' });
    for await (const _ev of p.chatStream([{ role: 'user', content: 'quoi ?', images: [{ mime: 'image/jpeg', dataBase64: '/9j/AA==' }] }], [], { modelId: 'm', taskId: 't' })) void _ev;
    const sent = JSON.parse(body);
    assert.equal(sent.messages[0].content[1].image_url.url, 'data:image/jpeg;base64,/9j/AA==');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('provider failures redact echoed API keys and URL user-info in events, diagnostics, and thrown errors [loopback HTTP]', async () => {
  const secrets = {
    openai: 'sk-test-openai-echo-secret-123456',
    anthropic: 'sk-ant-test-anthropic-echo-secret-123456',
    gemini: 'AIza-test-gemini-echo-secret-1234567890',
  };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const secret = pathname.startsWith('/v1beta/') ? secrets.gemini
      : req.headers['anthropic-version'] ? secrets.anthropic
      : secrets.openai;
    const customHeaderSecret = req.headers['x-debug-token'];
    res.statusCode = 401;
    res.statusMessage = `credential=${secret}`;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: `server echoed ${secret}`,
      api_key: secret,
      authorization: `Bearer ${secret}`,
      debug_url: `https://user:${secret}@provider.invalid/error?token=${secret}`,
      custom_header_secret: customHeaderSecret,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const rootUrl = `http://127.0.0.1:${port}`;

  const assertRedacted = (serialized: string, secret: string) => {
    assert.equal(serialized.includes(secret), false, `provider output leaked ${secret}`);
    assert.match(serialized, /\[REDACTED\]/);
  };
  const readErrorEvent = async (provider: OpenAiCompatibleProvider | AnthropicProvider | GeminiProvider, modelId: string) => {
    const events: AgentEvent[] = [];
    for await (const event of provider.chatStream([{ role: 'user', content: 'test provider error' }], [], { modelId, taskId: 'secret-redaction' })) events.push(event);
    const failure = events.find((event) => event.type === 'error');
    assert.ok(failure?.type === 'error');
    return JSON.stringify(failure);
  };

  try {
    const openai = new OpenAiCompatibleProvider({
      id: 'redaction-openai', name: 'OpenAI-compatible fixture', baseUrl: `${rootUrl}/v1`,
      apiKey: secrets.openai, locality: 'local', extraHeaders: { 'x-debug-token': 'header-secret-fixture' },
    });
    const openAiConnection = await openai.testConnection();
    assertRedacted(JSON.stringify(openAiConnection), secrets.openai);
    assert.match(openAiConnection.message, /HTTP 401/);
    const openAiEvent = await readErrorEvent(openai, 'test-model');
    assertRedacted(openAiEvent, secrets.openai);
    assertRedacted(openAiEvent, 'header-secret-fixture');
    await assert.rejects(
      openai.chatComplete([{ role: 'user', content: 'test provider error' }], [], { modelId: 'test-model', taskId: 'secret-redaction' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assertRedacted(message, secrets.openai);
        return true;
      },
    );

    // Fetch rejects URL user-info before connecting; the provider's emitted diagnostic
    // still includes its configured URL and must not expose either credential field.
    const userInfoUser = 'url-user-secret-fixture';
    const userInfoPassword = 'url-password-secret-fixture';
    const userInfoProvider = new OpenAiCompatibleProvider({
      id: 'redaction-url-userinfo', name: 'URL user-info fixture',
      baseUrl: `http://${userInfoUser}:${userInfoPassword}@127.0.0.1:${port}/v1`, locality: 'local',
    });
    const userInfoMessage = await readErrorEvent(userInfoProvider, 'test-model');
    assert.equal(userInfoMessage.includes(userInfoUser), false);
    assert.equal(userInfoMessage.includes(userInfoPassword), false);
    assert.match(userInfoMessage, /\[REDACTED\]@127\.0\.0\.1/);

    const anthropic = new AnthropicProvider({ id: 'redaction-anthropic', apiKey: secrets.anthropic, baseUrl: rootUrl });
    const anthropicConnection = await anthropic.testConnection();
    assertRedacted(JSON.stringify(anthropicConnection), secrets.anthropic);
    assert.match(anthropicConnection.message, /HTTP 401/);
    assertRedacted(await readErrorEvent(anthropic, 'claude-test-model'), secrets.anthropic);

    const gemini = new GeminiProvider({ id: 'redaction-gemini', apiKey: secrets.gemini, baseUrl: rootUrl });
    const geminiConnection = await gemini.testConnection();
    assertRedacted(JSON.stringify(geminiConnection), secrets.gemini);
    assert.match(geminiConnection.message, /HTTP 401/);
    assertRedacted(await readErrorEvent(gemini, 'gemini-test-model'), secrets.gemini);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('configured credentials are redacted from bare provider echoes and in-flight errors after key rotation [loopback HTTP]', async () => {
  let signalRequestSeen!: () => void;
  const requestSeen = new Promise<void>((resolve) => { signalRequestSeen = resolve; });
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let receivedAuthorization = '';
  const server = http.createServer(async (req, res) => {
    receivedAuthorization = String(req.headers.authorization || '');
    signalRequestSeen();
    await responseGate;
    const keySent = receivedAuthorization.replace(/^Bearer\s+/i, '');
    res.writeHead(401, { 'Content-Type': 'application/json' });
    // The echoed credential is deliberately bare: this verifies known-key
    // redaction, rather than relying on a label such as api_key or token=.
    res.end(JSON.stringify({ error: `provider rejected credential ${keySent}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const provider = new OpenAiCompatibleProvider({
      id: 'configured-key-redaction', name: 'Configured key fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`, locality: 'local',
    });
    provider.configure({ apiKey: 'Xy7' });

    const eventsPromise = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of provider.chatStream(
        [{ role: 'user', content: 'exercise configured key diagnostic redaction' }],
        [],
        { modelId: 'fixture-model', taskId: 'configured-key-redaction' },
      )) events.push(event);
      return events;
    })();

    await requestSeen;
    assert.equal(receivedAuthorization, 'Bearer Xy7', 'configure() key must be used on the actual provider request');
    provider.configure({ apiKey: 'rotated-secret-456' });
    releaseResponse();

    const events = await eventsPromise;
    const failure = events.find((event) => event.type === 'error');
    assert.ok(failure?.type === 'error');
    assert.equal(failure.message.includes('Xy7'), false, 'short configured key must not survive an unlabelled echo');
    assert.match(failure.message, /\[REDACTED\]/);
  } finally {
    releaseResponse();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('provider diagnostic redaction stays fail-safe for malformed UTF-16 credentials', () => {
  const malformedCredential = '\uD800';
  const safe = sanitizeProviderDiagnostic(`provider echoed ${malformedCredential}`, [malformedCredential]);
  assert.equal(safe.includes(malformedCredential), false);
  assert.match(safe, /\[REDACTED\]/);
});
