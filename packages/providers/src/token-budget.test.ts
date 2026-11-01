import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateToolTokens,
  estimateRequestTokens,
  planTokenBudget,
  TokenScheduler,
} from './token-budget.js';
import type { ChatMessage, ToolDefinition } from '@mazz/shared';

test('estimateTokens calcule une approximation cohérente', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('hello world'), 4);
  const code = 'function calculateTotal(items: Item[]): number { return items.reduce((a, b) => a + b.price, 0); }';
  const est = estimateTokens(code);
  assert.ok(est > 15 && est < 40);
});

test('estimateRequestTokens agrège les messages et les outils', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Tu es un assistant de test.' },
    { role: 'user', content: 'Peux-tu inspecter ce projet ?' },
  ];
  const tool: ToolDefinition = {
    name: 'fs.read',
    description: 'Lit un fichier texte.',
    category: 'fs',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    requiresPermission: false,
  };
  const tokens = estimateRequestTokens(messages, [tool]);
  assert.ok(tokens > 25);
});

test('planTokenBudget ajuste max_tokens proactivement pour Groq TPM 8000', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'A'.repeat(18000) }, // ~5000 tokens
  ];
  const plan = planTokenBudget('groq-api', 'openai/gpt-oss-120b', messages, [], 4096);
  assert.equal(plan.tpmLimit, 8000);
  assert.ok(plan.promptTokens > 4500);
  assert.ok(plan.isClamped);
  assert.ok(plan.allocatedMaxTokens < 3000);
  assert.ok(plan.suggestCompactTools);
});

test('TokenScheduler respecte le délai de backoff et la fenêtre de 60s', async () => {
  const scheduler = new TokenScheduler();
  scheduler.recordBackoff('groq-api', 50);
  assert.ok(scheduler.getBackoffRemaining('groq-api') > 0);

  const t0 = Date.now();
  const res = await scheduler.acquire('groq-api', 100);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 40);
  assert.ok(res.waitMs > 0);
  res.release();

  scheduler.recordUsage('groq-api', 100);
  const usage = scheduler.getCurrentWindowUsage('groq-api');
  assert.equal(usage.requests, 1);
  assert.equal(usage.tokens, 100);
});
