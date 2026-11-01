import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { ModelSelection } from '@mazz/shared';
import { ProviderRegistry } from './registry.js';
import { OpenAiCompatibleProvider } from './openai.js';

function selection(providerId: string, executionMode: 'local_strict' | 'cloud' = 'cloud'): ModelSelection {
  return {
    providerId,
    modelId: 'requested-model-do-not-rewrite',
    executionMode,
    allowedWorkspaceRoots: ['C:/workspace'],
  };
}

test('provider resolution returns the exact requested provider and rejects unknown IDs without fallback', () => {
  const registry = new ProviderRegistry();
  const selected = registry.get('deepseek-api');
  assert.ok(selected);
  assert.equal(registry.resolveProviderForSelection(selection('deepseek-api')), selected);
  assert.throws(
    () => registry.resolveProviderForSelection(selection('missing-provider')),
    /Provider inconnu/,
  );
});

test('local_strict rejects a selected remote provider instead of substituting a local provider', () => {
  const registry = new ProviderRegistry();
  const local = registry.get('llama-local');
  assert.ok(local);
  assert.throws(
    () => registry.resolveProviderForSelection(selection('deepseek-api', 'local_strict')),
    /LOCAL STRICT.*distant/s,
  );
  assert.equal(registry.get('llama-local'), local);
});

test('local_strict rejects a loopback endpoint explicitly classified as remote', () => {
  const registry = new ProviderRegistry();
  const provider = registry.addCustom({
    id: 'loopback-cloud-proxy',
    name: 'Loopback cloud proxy',
    baseUrl: 'http://127.0.0.1:45678/v1',
    locality: 'remote',
  });

  assert.throws(
    () => registry.resolveProviderForSelection(selection(provider.id, 'local_strict')),
    /LOCAL STRICT.*distant/s,
  );
  assert.equal(registry.get(provider.id), provider, 'rejection must not replace the selected provider');
});

test('a failing selected local provider surfaces its error without retrying or changing the model', async () => {
  let requestCount = 0;
  let requestPath: string | undefined;
  let requestModel: unknown;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    requestPath = req.url;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requestModel = JSON.parse(body).model;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'local runtime unavailable' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const port = (server.address() as { port: number }).port;
    const registry = new ProviderRegistry();
    const selected = registry.addCustom({
      id: 'offline-local-runtime',
      name: 'Offline local runtime fixture',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      locality: 'local',
    });
    assert.equal(registry.resolveProviderForSelection(selection(selected.id, 'local_strict')), selected);

    const events = [];
    for await (const event of selected.chatStream(
      [{ role: 'user', content: 'private local prompt' }],
      [],
      { modelId: 'the-selected-model', taskId: 'local-strict-failure' },
    )) events.push(event);

    const failure = events.find((event) => event.type === 'error');
    assert.ok(failure && failure.type === 'error');
    assert.equal(failure.code, 'HTTP_503');
    assert.equal(failure.fatal, true);
    assert.equal(requestCount, 1, 'the selected local endpoint receives one request and is not retried');
    assert.equal(requestPath, '/v1/chat/completions');
    assert.equal(requestModel, 'the-selected-model', 'the registry/provider must preserve the selected model');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('registering an existing provider ID cannot silently replace its provider or model endpoint', () => {
  const registry = new ProviderRegistry();
  const original = registry.get('llama-local');
  assert.ok(original);
  const replacement = new OpenAiCompatibleProvider({
    id: 'llama-local',
    type: 'llama_cpp',
    name: 'unrequested replacement',
    baseUrl: 'http://127.0.0.1:65534/v1',
    locality: 'local',
    defaultModel: 'different-model',
  });

  assert.throws(() => registry.register(replacement), /déjà enregistré.*ne peut pas le remplacer implicitement/i);
  assert.equal(registry.get('llama-local'), original);
  assert.equal(registry.resolveProviderForSelection(selection('llama-local', 'local_strict')), original);
});

test('same-ID custom provider changes remain explicit configuration updates', () => {
  const registry = new ProviderRegistry();
  const first = registry.addCustom({
    id: 'custom-fixture',
    name: 'Custom fixture',
    baseUrl: 'http://127.0.0.1:65533/v1',
    defaultModel: 'model-a',
  });
  const updated = registry.addCustom({
    id: 'custom-fixture',
    name: 'Custom fixture updated',
    baseUrl: 'http://127.0.0.1:65532/v1',
    defaultModel: 'model-b',
  });

  assert.notEqual(updated, first);
  assert.equal(registry.get('custom-fixture'), updated);
  assert.equal(updated.baseUrl, 'http://127.0.0.1:65532/v1');
});
