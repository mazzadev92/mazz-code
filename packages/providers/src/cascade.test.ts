import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import {
  CascadeManager,
  classifyProviderError,
  DEFAULT_CASCADE_STEPS,
  extractRetryAfter,
  KNOWN_PROVIDER_QUOTAS,
} from './cascade.js';
import { ProviderRegistry } from './registry.js';
import { OpenAiCompatibleProvider } from './openai.js';

test('anonymous providers are registered with requiresApiKey false and zero secret requirement', () => {
  const registry = new ProviderRegistry();
  const ovh = registry.get('ovh-ai');
  const faucet = registry.get('llmfaucet');

  assert.ok(ovh, 'ovh-ai should be registered in ProviderRegistry');
  assert.equal(ovh.locality, 'remote');
  assert.equal(ovh.requiresApiKey, false, 'ovh-ai does not require an API key');
  assert.equal(ovh.hasApiKey?.(), false, 'ovh-ai has no configured secret');

  assert.ok(faucet, 'llmfaucet should be registered in ProviderRegistry');
  assert.equal(faucet.locality, 'remote');
  assert.equal(faucet.requiresApiKey, false, 'llmfaucet does not require user API key');

  const desc = registry.describe();
  const ovhDesc = desc.find((d) => d.id === 'ovh-ai');
  const faucetDesc = desc.find((d) => d.id === 'llmfaucet');

  assert.ok(ovhDesc);
  assert.equal(ovhDesc.requiresApiKey, false);
  assert.equal(ovhDesc.hasApiKey, false);

  assert.ok(faucetDesc);
  assert.equal(faucetDesc.requiresApiKey, false);
});

test('extractRetryAfter correctly parses numeric seconds and textual delays', () => {
  assert.equal(extractRetryAfter('31'), 31);
  assert.equal(extractRetryAfter(45), 45);
  assert.equal(extractRetryAfter('API rate limit exceeded. Retry-After: 28 seconds'), 28);
  assert.equal(extractRetryAfter('try again in 15s'), 15);
  assert.equal(extractRetryAfter('try again in 1m30s'), 90);
  assert.equal(extractRetryAfter('try again in 500ms'), 1);
});

test('classifyProviderError distinguishes recoverable from non-recoverable failures', () => {
  // Recoverable: 429 Rate Limit
  const err429 = classifyProviderError(new Error('HTTP 429 Too Many Requests. Retry-After: 35'));
  assert.equal(err429.recoverable, true);
  assert.equal(err429.statusCode, 429);
  assert.equal(err429.retryAfterSec, 35);

  // Recoverable: 503 Service Unavailable
  const err503 = classifyProviderError(new Error('HTTP 503 Service Unavailable'));
  assert.equal(err503.recoverable, true);
  assert.equal(err503.statusCode, 503);

  // Recoverable: 502 Bad Gateway
  const err502 = classifyProviderError(new Error('HTTP 502 Bad Gateway'));
  assert.equal(err502.recoverable, true);

  // Recoverable: 404 Model Not Found
  const err404 = classifyProviderError(new Error('HTTP 404 Not Found: model_not_found'));
  assert.equal(err404.recoverable, true);

  // Recoverable: Network DNS / Connect error
  const errDns = classifyProviderError(Object.assign(new Error('getaddrinfo ENOTFOUND api.llmfaucet.dev'), { code: 'ENOTFOUND' }));
  assert.equal(errDns.recoverable, true);

  // Non-recoverable: 400 Bad Request
  const err400 = classifyProviderError(new Error('HTTP 400 Bad Request: invalid schema definition'));
  assert.equal(err400.recoverable, false);

  // Non-recoverable: 413 Context Length Exceeded
  const err413 = classifyProviderError(new Error('HTTP 413 maximum context length exceeded'));
  assert.equal(err413.recoverable, false);

  // Non-recoverable: Local Strict Mode Violation
  const errLocalStrict = classifyProviderError(new Error('Violation du mode LOCAL STRICT : provider distant'));
  assert.equal(errLocalStrict.recoverable, false);
});

test('cascade falls back from 429 to next provider and honors Retry-After cooldown', async () => {
  let primaryHits = 0;
  let secondaryHits = 0;

  // Server 1 returns 429 with Retry-After: 12
  const server1 = http.createServer((req, res) => {
    primaryHits += 1;
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '12',
    });
    res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
  });
  await new Promise<void>((r) => server1.listen(0, '127.0.0.1', r));

  // Server 2 returns 200 with SSE stream
  const server2 = http.createServer((req, res) => {
    secondaryHits += 1;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    res.write('data: {"choices":[{"delta":{"content":"Réponse de secours"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));

  try {
    const port1 = (server1.address() as { port: number }).port;
    const port2 = (server2.address() as { port: number }).port;

    const registry = new ProviderRegistry();
    const p1 = registry.addCustom({ id: 'mock-primary-429', name: 'Primary 429', baseUrl: `http://127.0.0.1:${port1}/v1` });
    const p2 = registry.addCustom({ id: 'mock-secondary-ok', name: 'Secondary OK', baseUrl: `http://127.0.0.1:${port2}/v1` });

    const manager = new CascadeManager(registry);
    const candidates = [
      { providerId: p1.id, modelId: 'model-1', priority: 1, enabled: true },
      { providerId: p2.id, modelId: 'model-2', priority: 2, enabled: true },
    ];

    const events = [];
    for await (const ev of manager.executeWithCascade(candidates, [{ role: 'user', content: 'test' }], [], {
      modelId: 'default',
      taskId: 'test-cascade-429',
    })) {
      events.push(ev);
    }

    assert.equal(primaryHits, 1, 'Primary server must be called once');
    assert.equal(secondaryHits, 1, 'Secondary server must receive fallback');

    const tokenEv = events.find((e) => e.type === 'token');
    assert.ok(tokenEv && tokenEv.type === 'token');
    assert.equal(tokenEv.delta, 'Réponse de secours');

    const fallbackStatus = events.find((e) => e.type === 'status' && e.stage === 'cascade_fallback');
    assert.ok(fallbackStatus, 'Must emit a cascade_fallback status event');

    // Verify cooldown is set for p1 for 12 seconds
    const cdSec = manager.getCooldownRemainingSec(p1.id);
    assert.ok(cdSec > 0 && cdSec <= 12, `Cooldown must be set from Retry-After (got ${cdSec}s)`);
  } finally {
    server1.close();
    server2.close();
  }
});

test('cascade falls back on 5xx or network errors and halts on non-recoverable 400', async () => {
  let server503Hits = 0;
  let server400Hits = 0;

  // Server 503
  const server503 = http.createServer((req, res) => {
    server503Hits += 1;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream service unavailable' } }));
  });
  await new Promise<void>((r) => server503.listen(0, '127.0.0.1', r));

  // Server 400
  const server400 = http.createServer((req, res) => {
    server400Hits += 1;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid request payload' } }));
  });
  await new Promise<void>((r) => server400.listen(0, '127.0.0.1', r));

  try {
    const port503 = (server503.address() as { port: number }).port;
    const port400 = (server400.address() as { port: number }).port;

    const registry = new ProviderRegistry();
    const p503 = registry.addCustom({ id: 'mock-503', name: 'Mock 503', baseUrl: `http://127.0.0.1:${port503}/v1` });
    const p400 = registry.addCustom({ id: 'mock-400', name: 'Mock 400', baseUrl: `http://127.0.0.1:${port400}/v1` });

    const manager = new CascadeManager(registry);

    // Test 1: 503 falls back to 400; 400 is non-recoverable so it halts immediately
    const candidates = [
      { providerId: p503.id, modelId: 'model-503', priority: 1, enabled: true },
      { providerId: p400.id, modelId: 'model-400', priority: 2, enabled: true },
    ];

    const events = [];
    for await (const ev of manager.executeWithCascade(candidates, [{ role: 'user', content: 'test' }], [], {
      modelId: 'default',
      taskId: 'test-cascade-503-400',
    })) {
      events.push(ev);
    }

    assert.equal(server503Hits, 1);
    assert.equal(server400Hits, 1);

    const errorEv = events.find((e) => e.type === 'error');
    assert.ok(errorEv && errorEv.type === 'error');
    assert.equal(errorEv.code, 'HTTP_400');
  } finally {
    server503.close();
    server400.close();
  }
});

test('cascade terminates cleanly with CASCADE_EXHAUSTED when all candidates fail recoverable errors', async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    callCount += 1;
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'down' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  try {
    const port = (server.address() as { port: number }).port;
    const registry = new ProviderRegistry();
    const p1 = registry.addCustom({ id: 'cand-1', name: 'Candidate 1', baseUrl: `http://127.0.0.1:${port}/v1` });
    const p2 = registry.addCustom({ id: 'cand-2', name: 'Candidate 2', baseUrl: `http://127.0.0.1:${port}/v1` });

    const manager = new CascadeManager(registry);
    const candidates = [
      { providerId: p1.id, modelId: 'm1', priority: 1, enabled: true },
      { providerId: p2.id, modelId: 'm2', priority: 2, enabled: true },
    ];

    const events = [];
    for await (const ev of manager.executeWithCascade(candidates, [{ role: 'user', content: 'test' }], [], {
      modelId: 'm1',
      taskId: 'test-exhaustion',
    })) {
      events.push(ev);
    }

    assert.equal(callCount, 2, 'Must try each candidate once without looping');
    const exhausted = events.find((e) => e.type === 'error' && e.code === 'CASCADE_EXHAUSTED');
    assert.ok(exhausted, 'Must emit CASCADE_EXHAUSTED error when all providers fail');
  } finally {
    server.close();
  }
});
