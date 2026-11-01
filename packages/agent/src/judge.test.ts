import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent } from '@mazz/shared';
import type { IModelProvider } from '@mazz/providers';
import { comparePair, tournament, VERDICT_GRAMMAR } from './judge.js';

/** Judge stand-in: `pick` sees the two options as shown and returns "1", "2" or "=". */
function judgeProvider(pick: (first: string, second: string) => string): IModelProvider & { grammars: string[] } {
  const grammars: string[] = [];
  return {
    id: 'judge', type: 'llama_cpp', name: 'judge', baseUrl: 'http://127.0.0.1:1/v1', locality: 'local', grammars,
    async testConnection() { return { ok: true, message: '', latencyMs: 0 }; },
    async listModels() { return []; },
    async *chatStream() { /* unused */ },
    async chatComplete() { return { content: '' }; },
    async *completePrefix(prompt: string, options: { taskId: string; grammar?: string }) {
      grammars.push(options.grammar ?? '');
      const first = /Option 1:\n([\s\S]*?)\n\nOption 2:/.exec(prompt)![1];
      const second = /Option 2:\n([\s\S]*?)\n\nWhich option/.exec(prompt)![1];
      yield { type: 'token', taskId: options.taskId, timestamp: Date.now(), delta: pick(first, second) } as AgentEvent;
    },
  };
}

const base = { modelId: 'qwen3-test.gguf', taskId: 't', criterion: 'states the exact return value' };
const quality = (s: string) => Number(/q(\d)/.exec(s)![1]);

test('a judge that always picks the first option cannot make a winner: the order is swapped', async () => {
  const provider = judgeProvider(() => '1');
  const pair = await comparePair({ ...base, provider, repeats: 4 }, ['q1 left', 'q2 right'], 0, 1);
  assert.equal(pair.winsA, pair.winsB, 'position bias cancels out');
  assert.ok(provider.grammars.every((g) => g === VERDICT_GRAMMAR), 'every verdict is grammar-constrained');
});

test('round robin ranks candidates by pairwise wins', async () => {
  const provider = judgeProvider((a, b) => (quality(a) > quality(b) ? '1' : quality(a) < quality(b) ? '2' : '='));
  const r = await tournament({ ...base, provider, repeats: 3 }, ['q2 average', 'q5 best', 'q1 worst']);
  assert.deepEqual(r.ranking, [1, 0, 2]);
  assert.equal(r.pairs.length, 3);
  assert.equal(r.calls, 9);
});

test('many candidates go through a single-elimination bracket (linear number of pairs)', async () => {
  const provider = judgeProvider((a, b) => (quality(a) >= quality(b) ? '1' : '2'));
  const cands = ['q3', 'q1', 'q7', 'q2', 'q5', 'q4', 'q6', 'q0'];
  const r = await tournament({ ...base, provider, repeats: 1, roundRobinMax: 4 }, cands);
  assert.equal(r.ranking[0], 2, 'q7 wins the bracket');
  assert.equal(r.pairs.length, cands.length - 1);
});
