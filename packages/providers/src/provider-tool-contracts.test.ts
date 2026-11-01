import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AgentEvent, ToolDefinition } from '@mazz/shared';
import {
  PROVIDER_TOOL_CALL_LIMITS,
  providerToolCallArgumentsIssue,
  providerToolCallIdIssue,
  providerToolCallLimitIssue,
  providerToolCallNameIssue,
} from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OpenAiCompatibleProvider, ProviderToolProtocolError, ToolCallAccumulator, readOpenAiSseEvents, isOpenAiSseDoneEvent } from './openai.js';

const tool: ToolDefinition = {
  name: 'fs.read',
  description: 'Read a workspace file',
  category: 'fs',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
  requiresPermission: false,
};

const nestedTool: ToolDefinition = {
  name: 'config.apply',
  description: 'Apply a structured configuration',
  category: 'analysis',
  parameters: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['safe', 'fast'] },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { command: { type: 'string' }, retries: { type: 'integer' } },
              required: ['command'],
            },
          },
        },
        required: ['mode', 'steps'],
      },
    },
    required: ['config'],
  },
  requiresPermission: true,
};

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\r\n\r\n`;
}

function stream(...values: unknown[]): Buffer {
  return Buffer.from(`${values.map(frame).join('')}data: [DONE]\r\n\r\n`, 'utf8');
}

function jsonlStream(...values: unknown[]): Buffer {
  return Buffer.from(`${values.map((value) => `${JSON.stringify(value)}\r\n`).join('')}`, 'utf8');
}

function anthropicFrame(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

function anthropicStream(...events: Array<[string, Record<string, unknown>]>): Buffer {
  return Buffer.from(events.map(([type, event]) => anthropicFrame(type, event)).join(''), 'utf8');
}

async function loopbackServer(response: (request: http.IncomingMessage, body: unknown, res: http.ServerResponse) => void): Promise<{ root: string; close: () => Promise<void> }> {
  const server = http.createServer((request, res) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      response(request, raw ? JSON.parse(raw) : undefined, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    root: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sendFragmented(res: http.ServerResponse, bytes: Buffer): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  // Deliberately split UTF-8 code points, SSE delimiters, JSON strings, and tool fragments.
  for (let index = 0; index < bytes.length; index += 1) res.write(bytes.subarray(index, index + 1));
  res.end();
}

function sendWhole(res: http.ServerResponse, bytes: Buffer): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  res.end(bytes);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function invalidToolStarts(events: AgentEvent[]): number {
  return events.filter((event) => event.type === 'tool_start').length;
}

test('SSE parser preserves events across byte-fragmented UTF-8 and terminal frames', async () => {
  const bytes = Buffer.from(`${frame({ choices: [{ delta: { content: 'été —Core—' } }] })}data: [DONE]\r\n\r\n`, 'utf8');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.subarray(index, index + 1));
      controller.close();
    },
  });
  const events: unknown[] = [];
  for await (const event of readOpenAiSseEvents(body)) events.push(event);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { choices: [{ delta: { content: 'été —Core—' } }] });
  assert.equal(isOpenAiSseDoneEvent(events[1]), true);
});

test('OpenAI-compatible JSONL parser preserves CRLF frames across byte fragments and emits EOF termination', async () => {
  const chunk = { choices: [{ delta: { content: 'été —Core—' } }] };
  const bytes = Buffer.from(`${JSON.stringify(chunk)}\r\n`, 'utf8');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 1) controller.enqueue(bytes.subarray(index, index + 1));
      controller.close();
    },
  });
  const events: unknown[] = [];
  for await (const event of readOpenAiSseEvents(body)) events.push(event);
  assert.deepEqual(events[0], chunk);
  assert.equal(isOpenAiSseDoneEvent(events[1]), true);
  assert.equal(events.length, 2);
});

test('OpenAI-compatible stream resolves fragmented authorized tool calls and sends only documented tool mode', async () => {
  let requestBody: any;
  const srv = await loopbackServer((_request, body, res) => {
    requestBody = body;
    sendFragmented(res, stream(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'fs__', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read', arguments: '"src/main.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ));
  });
  try {
    const provider = new OpenAiCompatibleProvider({ id: 'tool-contract-openai', name: 'loopback', baseUrl: `${srv.root}/v1`, locality: 'local' });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read source' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    const call = events.find((event) => event.type === 'tool_start');
    assert.deepEqual(call?.type === 'tool_start' ? { name: call.toolName, params: call.params } : undefined, { name: 'fs.read', params: { path: 'src/main.ts' } });
    assert.equal(requestBody.tool_choice, 'auto');
    assert.equal(requestBody.tools[0].function.name, 'fs__read');
    assert.equal(Object.hasOwn(requestBody, 'response_format'), false);
    assert.equal(Object.hasOwn(requestBody.tools[0].function, 'strict'), false);
    assert.equal(events.some((event) => event.type === 'error'), false);
  } finally {
    await srv.close();
  }
});

test('OpenAI, Gemini, and Anthropic stream adapters reject the same invalid tool-call ID before exposing a call', async () => {
  const longId = 'i'.repeat(PROVIDER_TOOL_CALL_LIMITS.idCharacters + 1);
  for (const kind of ['openai', 'gemini', 'anthropic'] as const) {
    const srv = await loopbackServer((_request, _body, res) => {
      if (kind === 'anthropic') {
        sendWhole(res, anthropicStream(
          ['message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1 } } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: longId, name: 'fs__read', input: { path: 'safe.txt' } } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }],
        ));
      } else {
        sendWhole(res, stream(
          { choices: [{ delta: { tool_calls: [{ index: 0, id: longId, type: 'function', function: { name: 'fs__read', arguments: '{"path":"safe.txt"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ));
      }
    });
    try {
      const provider = kind === 'openai'
        ? new OpenAiCompatibleProvider({ id: `long-tool-id-${kind}`, name: kind, baseUrl: `${srv.root}/v1`, locality: 'local' })
        : kind === 'gemini'
          ? new GeminiProvider({ id: `long-tool-id-${kind}`, apiKey: 'loopback-key', baseUrl: srv.root })
          : new AnthropicProvider({ id: `long-tool-id-${kind}`, apiKey: 'loopback-key', baseUrl: srv.root });
      const events = await collect(provider.chatStream([{ role: 'user', content: 'read safely' }], [tool], { modelId: 'fixture', taskId: 'identity-contract' }));
      assert.equal(invalidToolStarts(events), 0, `${kind} must not expose a malformed call`);
      const error = events.find((event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error');
      assert.equal(error?.code, 'INVALID_PROVIDER_RESPONSE', kind);
      assert.equal(error?.message, providerToolCallIdIssue(longId), `${kind} must share the same ID validation`);
    } finally {
      await srv.close();
    }
  }
});

test('tool-call accumulator orders multiple calls by provider index and rejects duplicate IDs', () => {
  const accumulator = new ToolCallAccumulator();
  accumulator.addFragments([
    { index: 1, id: 'second', type: 'function', function: { name: 'fs__read', arguments: '{"path":"second.txt"}' } },
    { index: 0, id: 'first', type: 'function', function: { name: 'fs__read', arguments: '{"path":"first.txt"}' } },
  ]);
  assert.deepEqual(accumulator.resolve([tool]).map(({ id, arguments: args }) => ({ id, args })), [
    { id: 'first', args: { path: 'first.txt' } },
    { id: 'second', args: { path: 'second.txt' } },
  ]);

  const duplicate = new ToolCallAccumulator();
  duplicate.addFragments([
    { index: 0, id: 'same', type: 'function', function: { name: 'fs__read', arguments: '{"path":"a.txt"}' } },
    { index: 1, id: 'same', type: 'function', function: { name: 'fs__read', arguments: '{"path":"b.txt"}' } },
  ]);
  assert.throws(() => duplicate.resolve([tool]), /Identifiant tool_call dupliqué/u);
});

test('provider tool-call bounds cover IDs, names, per-call arguments, total arguments, and call count', () => {
  assert.equal(providerToolCallIdIssue('id'), undefined);
  assert.equal(providerToolCallIdIssue('i'.repeat(PROVIDER_TOOL_CALL_LIMITS.idCharacters + 1)), `Identifiant tool_call trop long (maximum ${PROVIDER_TOOL_CALL_LIMITS.idCharacters} caractères).`);
  assert.equal(providerToolCallIdIssue('bad\nid'), 'Identifiant tool_call contenant un caractère de contrôle.');
  assert.equal(providerToolCallLimitIssue(PROVIDER_TOOL_CALL_LIMITS.calls - 1), undefined);
  assert.equal(providerToolCallLimitIssue(PROVIDER_TOOL_CALL_LIMITS.calls), `Trop d’appels d’outils dans une réponse (maximum ${PROVIDER_TOOL_CALL_LIMITS.calls}).`);
  assert.equal(providerToolCallNameIssue('fs__read'), undefined);
  assert.equal(providerToolCallNameIssue(' fs__read'), 'Nom d’outil vide ou invalide.');
  assert.equal(providerToolCallNameIssue('n'.repeat(PROVIDER_TOOL_CALL_LIMITS.nameCharacters + 1)), `Nom d’outil trop long (maximum ${PROVIDER_TOOL_CALL_LIMITS.nameCharacters} caractères).`);
  assert.equal(providerToolCallArgumentsIssue('x', PROVIDER_TOOL_CALL_LIMITS.argumentsPerCallCharacters, 0), `Arguments d’outil trop volumineux (maximum ${PROVIDER_TOOL_CALL_LIMITS.argumentsPerCallCharacters} caractères par appel).`);
  assert.equal(providerToolCallArgumentsIssue('x', 0, PROVIDER_TOOL_CALL_LIMITS.argumentsTotalCharacters), `Arguments d’outil au-delà de la limite cumulée (${PROVIDER_TOOL_CALL_LIMITS.argumentsTotalCharacters} caractères par réponse).`);
  const oversizedStream = new ToolCallAccumulator();
  assert.throws(() => oversizedStream.addFragments([
    { index: 0, id: 'large-args', type: 'function', function: { name: 'fs__read', arguments: 'x'.repeat(PROVIDER_TOOL_CALL_LIMITS.argumentsPerCallCharacters + 1) } },
  ]), /Arguments d’outil trop volumineux/u);
});

test('OpenAI-compatible JSONL stream validates nested arguments and closes on clean EOF', async () => {
  let requestBody: any;
  const srv = await loopbackServer((_request, body, res) => {
    requestBody = body;
    sendFragmented(res, jsonlStream(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'nested-jsonl-call', type: 'function', function: { name: 'config__', arguments: '{"config":{"mode":"safe","steps":[{"command":"build","retries":2},' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'apply', arguments: '{"command":"test"}]}}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ));
  });
  try {
    const provider = new OpenAiCompatibleProvider({ id: 'jsonl-nested', name: 'loopback', baseUrl: `${srv.root}/v1`, locality: 'local' });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'apply config' }], [nestedTool], { modelId: 'fixture', taskId: 'contract' }));
    const call = events.find((event) => event.type === 'tool_start');
    assert.deepEqual(call?.type === 'tool_start' ? { name: call.toolName, params: call.params } : undefined, {
      name: 'config.apply',
      params: { config: { mode: 'safe', steps: [{ command: 'build', retries: 2 }, { command: 'test' }] } },
    }, JSON.stringify(events));
    assert.equal(requestBody.tools[0].function.name, 'config__apply');
    assert.equal(events.some((event) => event.type === 'error'), false);
  } finally {
    await srv.close();
  }
});

test('OpenAI-compatible JSONL refuses invalid schemas, malformed arguments, and missing tool-call termination', async () => {
  let requestCount = 0;
  const invalidSchemaServer = await loopbackServer((_request, _body, res) => {
    requestCount += 1;
    sendFragmented(res, stream({ choices: [{ delta: { content: 'unexpected' } }] }));
  });
  try {
    const invalidTool = {
      ...nestedTool,
      parameters: { type: 'object', properties: { config: { type: 'object', properties: { mode: { type: 'unknown' } } } } },
    } as unknown as ToolDefinition;
    const providers = [
      new OpenAiCompatibleProvider({ id: 'invalid-schema-openai', name: 'loopback', baseUrl: `${invalidSchemaServer.root}/v1`, locality: 'local' }),
      new AnthropicProvider({ id: 'invalid-schema-anthropic', apiKey: 'loopback-key', baseUrl: invalidSchemaServer.root }),
      new GeminiProvider({ id: 'invalid-schema-gemini', apiKey: 'loopback-key', baseUrl: invalidSchemaServer.root }),
    ];
    for (const provider of providers) {
      const events = await collect(provider.chatStream([{ role: 'user', content: 'do not send' }], [invalidTool], { modelId: 'fixture', taskId: 'contract' }));
      assert.ok(events.some((event) => event.type === 'error' && event.code === 'INVALID_TOOL_DEFINITIONS' && event.fatal), provider.type);
    }
    assert.equal(requestCount, 0, 'invalid schemas must be rejected before prompt data is sent');
  } finally {
    await invalidSchemaServer.close();
  }

  const cases: Array<{ label: string; values: unknown[] }> = [
    {
      label: 'incomplete-json',
      values: [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial-json', type: 'function', function: { name: 'config__apply', arguments: '{"config":{"mode":"safe"' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
    },
    {
      label: 'missing-finish-reason',
      values: [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'no-finish', type: 'function', function: { name: 'config__apply', arguments: '{"config":{"mode":"safe","steps":[]}}' } }] } }] }],
    },
    {
      label: 'malformed-jsonl-line',
      values: [{ choices: [{ delta: { content: 'valid-prefix' } }] }, '{"choices":broken}'],
    },
  ];
  for (const { label, values } of cases) {
    const server = await loopbackServer((_request, _body, res) => sendFragmented(res, jsonlStream(...values)));
    try {
      const provider = new OpenAiCompatibleProvider({ id: `jsonl-${label}`, name: 'loopback', baseUrl: `${server.root}/v1`, locality: 'local' });
      const events = await collect(provider.chatStream([{ role: 'user', content: 'apply config' }], [nestedTool], { modelId: 'fixture', taskId: 'contract' }));
      assert.equal(invalidToolStarts(events), 0, label);
      assert.ok(events.some((event) => event.type === 'error' && event.fatal), label);
    } finally {
      await server.close();
    }
  }
});

test('OpenAI-compatible stream refuses arguments that violate the offered JSON schema before exposing tool_start', async () => {
  const srv = await loopbackServer((_request, _body, res) => sendFragmented(res, stream(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'bad-args', type: 'function', function: { name: 'fs__read', arguments: '{"path":42}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  )));
  try {
    const provider = new OpenAiCompatibleProvider({ id: 'tool-contract-invalid', name: 'loopback', baseUrl: `${srv.root}/v1`, locality: 'local' });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read source' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    assert.equal(invalidToolStarts(events), 0);
    const failure = events.find((event) => event.type === 'error');
    assert.ok(failure?.type === 'error' && failure.fatal);
    const usage = events.find((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
    assert.equal(usage?.telemetry?.stopReason, 'error');
  } finally {
    await srv.close();
  }
});

test('OpenAI-compatible stream rejects malformed event JSON instead of swallowing the frame', async () => {
  const srv = await loopbackServer((_request, _body, res) => {
    sendFragmented(res, Buffer.from('data: {"choices":broken}\r\n\r\ndata: [DONE]\r\n\r\n', 'utf8'));
  });
  try {
    const provider = new OpenAiCompatibleProvider({ id: 'tool-contract-malformed', name: 'loopback', baseUrl: `${srv.root}/v1`, locality: 'local' });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read source' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    assert.equal(invalidToolStarts(events), 0);
    assert.ok(events.some((event) => event.type === 'error' && event.fatal));
  } finally {
    await srv.close();
  }
});

test('OpenAI-compatible complete response validates tool-call arguments and finish reason', async () => {
  const srv = await loopbackServer((_request, _body, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'invalid-complete', type: 'function', function: { name: 'fs__read', arguments: '{"path":false}' } }] } }] }));
  });
  try {
    const provider = new OpenAiCompatibleProvider({ id: 'tool-contract-complete', name: 'loopback', baseUrl: `${srv.root}/v1`, locality: 'local' });
    await assert.rejects(provider.chatComplete([{ role: 'user', content: 'read source' }], [tool], { modelId: 'fixture', taskId: 'contract' }), /chaîne attendue/);
  } finally {
    await srv.close();
  }
});

test('Gemini OpenAI-compatible stream resolves offered aliases and rejects unoffered calls', async () => {
  let requestBody: any;
  const validServer = await loopbackServer((_request, body, res) => {
    requestBody = body;
    sendFragmented(res, stream(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'gemini-call', type: 'function', function: { name: 'fs_read', arguments: '{"path":"notes.md"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ));
  });
  try {
    const provider = new GeminiProvider({ id: 'gemini-tool-contract', apiKey: 'loopback-key', baseUrl: validServer.root });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read notes' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    const call = events.find((event) => event.type === 'tool_start');
    assert.deepEqual(call?.type === 'tool_start' ? { name: call.toolName, params: call.params } : undefined, { name: 'fs.read', params: { path: 'notes.md' } });
    assert.equal(requestBody.tool_choice, 'auto');
    assert.equal(requestBody.tools[0].function.name, 'fs__read');
    assert.deepEqual(requestBody.tools[0].function.parameters, tool.parameters);
    assert.equal(Object.hasOwn(requestBody, 'response_format'), false);
  } finally {
    await validServer.close();
  }

  const invalidServer = await loopbackServer((_request, _body, res) => sendFragmented(res, stream(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'unoffered', type: 'function', function: { name: 'terminal__run', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  )));
  try {
    const provider = new GeminiProvider({ id: 'gemini-tool-contract-invalid', apiKey: 'loopback-key', baseUrl: invalidServer.root });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read notes' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    assert.equal(invalidToolStarts(events), 0);
    assert.ok(events.some((event) => event.type === 'error' && event.fatal));
  } finally {
    await invalidServer.close();
  }
});

test('Gemini rejects nested schema violations before exposing tool_start', async () => {
  const srv = await loopbackServer((_request, _body, res) => sendFragmented(res, stream(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'gemini-nested-invalid', type: 'function', function: { name: 'config__apply', arguments: '{"config":{"mode":"unsafe","steps":[]}}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  )));
  try {
    const provider = new GeminiProvider({ id: 'gemini-nested-invalid', apiKey: 'loopback-key', baseUrl: srv.root });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'apply config' }], [nestedTool], { modelId: 'fixture', taskId: 'contract' }));
    assert.equal(invalidToolStarts(events), 0);
    assert.ok(events.some((event) => event.type === 'error' && event.fatal));
  } finally {
    await srv.close();
  }
});

test('Anthropic stream reassembles multiple tool blocks, resolves offered aliases, and validates the completed envelope', async () => {
  let requestBody: any;
  const srv = await loopbackServer((_request, body, res) => {
    requestBody = body;
    sendFragmented(res, anthropicStream(
      ['message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 11 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'anthropic-call-1', name: 'fs__read', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'anthropic-call-2', name: 'fs_read', input: { path: 'next.md' } } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"notes.md"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4 } }],
      ['message_stop', { type: 'message_stop' }],
    ));
  });
  try {
    const provider = new AnthropicProvider({ id: 'anthropic-tool-contract', apiKey: 'loopback-key', baseUrl: srv.root });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'read notes' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
    const calls = events.filter((event): event is Extract<AgentEvent, { type: 'tool_start' }> => event.type === 'tool_start');
    assert.deepEqual(calls.map(({ callId, toolName, params }) => ({ callId, toolName, params })), [
      { callId: 'anthropic-call-1', toolName: 'fs.read', params: { path: 'notes.md' } },
      { callId: 'anthropic-call-2', toolName: 'fs.read', params: { path: 'next.md' } },
    ]);
    assert.equal(requestBody.tools[0].name, 'fs__read');
    assert.deepEqual(requestBody.tools[0].input_schema, tool.parameters);
    assert.equal(events.some((event) => event.type === 'error'), false);
    const usage = events.find((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
    assert.equal(usage?.telemetry?.stopReason, 'tool_calls');
    assert.equal(usage?.promptTokens, 11);
    assert.equal(usage?.completionTokens, 4);
  } finally {
    await srv.close();
  }
});

test('Anthropic stream assembles fragmented nested arguments and sends the matching input schema', async () => {
  let requestBody: any;
  const encodedArguments = '{"config":{"mode":"safe","steps":[{"command":"build","retries":2}]}}';
  const srv = await loopbackServer((_request, body, res) => {
    requestBody = body;
    sendFragmented(res, anthropicStream(
      ['message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 2 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'anthropic-nested-call', name: 'config__apply', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: encodedArguments.slice(0, 27) } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: encodedArguments.slice(27) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }],
      ['message_stop', { type: 'message_stop' }],
    ));
  });
  try {
    const provider = new AnthropicProvider({ id: 'anthropic-nested', apiKey: 'loopback-key', baseUrl: srv.root });
    const events = await collect(provider.chatStream([{ role: 'user', content: 'apply config' }], [nestedTool], { modelId: 'fixture', taskId: 'contract' }));
    const call = events.find((event) => event.type === 'tool_start');
    assert.deepEqual(call?.type === 'tool_start' ? { name: call.toolName, params: call.params } : undefined, {
      name: 'config.apply',
      params: { config: { mode: 'safe', steps: [{ command: 'build', retries: 2 }] } },
    });
    assert.deepEqual(requestBody.tools[0].input_schema, nestedTool.parameters);
    assert.equal(events.some((event) => event.type === 'error'), false);
  } finally {
    await srv.close();
  }
});

test('Anthropic stream rejects malformed or schema-invalid tool arguments without exposing tool_start', async () => {
  for (const [caseName, partialJson] of [
    ['malformed-json', '{"path":'],
    ['invalid-schema', '{"path":42}'],
  ] as const) {
    const srv = await loopbackServer((_request, _body, res) => sendFragmented(res, anthropicStream(
      ['message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `anthropic-${caseName}`, name: 'fs__read', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    )));
    try {
      const provider = new AnthropicProvider({ id: `anthropic-${caseName}`, apiKey: 'loopback-key', baseUrl: srv.root });
      const events = await collect(provider.chatStream([{ role: 'user', content: 'read notes' }], [tool], { modelId: 'fixture', taskId: 'contract' }));
      assert.equal(invalidToolStarts(events), 0);
      assert.ok(events.some((event) => event.type === 'error' && event.fatal));
      const usage = events.find((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage');
      assert.equal(usage?.telemetry?.stopReason, 'error');
    } finally {
      await srv.close();
    }
  }
});

test('Anthropic chatComplete rejette un tool use non offert au lieu de rendre une réponse vide', async () => {
  const srv = await loopbackServer((_request, _body, res) => sendFragmented(res, anthropicStream(
    ['message_start', { type: 'message_start', message: { type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'unoffered-call', name: 'terminal__run', input: {} } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  )));
  try {
    const provider = new AnthropicProvider({ id: 'anthropic-unoffered', apiKey: 'loopback-key', baseUrl: srv.root });
    await assert.rejects(
      provider.chatComplete([{ role: 'user', content: 'run something' }], [tool], { modelId: 'fixture', taskId: 'contract' }),
      /n’appartient pas aux schémas autorisés/u,
    );
  } finally {
    await srv.close();
  }
});

test('tool-call accumulator in recover mode hands bad arguments to the agent loop instead of rejecting the response', () => {
  const accumulator = new ToolCallAccumulator();
  accumulator.addFragments([
    { index: 0, id: 'bad-json', type: 'function', function: { name: 'fs__read', arguments: '{"path": "a.txt",}' } },
    { index: 1, id: 'bad-type', type: 'function', function: { name: 'fs__read', arguments: '{"path": 42}' } },
    { index: 2, id: 'good', type: 'function', function: { name: 'fs__read', arguments: '{"path":"b.txt"}' } },
  ]);
  assert.throws(() => accumulator.resolve([tool]), ProviderToolProtocolError);
  assert.deepEqual(accumulator.resolve([tool], true).map(({ id, arguments: args }) => ({ id, args })), [
    { id: 'bad-json', args: { raw: '{"path": "a.txt",}' } },
    { id: 'bad-type', args: { path: 42 } },
    { id: 'good', args: { path: 'b.txt' } },
  ]);
});
