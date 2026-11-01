import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCliGoal } from './knowledge-context.js';

test('CLI retrieval is bounded, cited and does not alter the original request', async () => {
  let stopped = false;
  const result = await enrichCliGoal('Diagnostique les includes C++', 'D:\\projet', {
    available: () => true,
    context: async (query, k, budget, options) => {
      assert.equal(query, 'Diagnostique les includes C++');
      assert.equal(k, 3); assert.equal(budget, 2800);
      assert.deepEqual(options?.allowedRoots, ['D:\\projet']);
      return { context: 'x'.repeat(6000), citations: [{ path: 'a.md' }], methods: [{ id: 'method' }] };
    },
    stop: () => { stopped = true; },
  });
  assert.equal(stopped, true); assert.ok(result.goal.startsWith('Diagnostique les includes C++'));
  assert.equal(result.goal.match(/x/g)?.length, 2800); assert.equal(result.citations.length, 1);
  assert.equal(result.directAnswer, undefined);
});

test('CLI bypasses generation only for a verified exact rational result', async () => {
  const manager = (status: string, tool: string) => ({
    available: () => true,
    context: async () => ({ context: '', verification: { status, payload: { tool, result: { data: { value: '29/36' } } } } }),
    stop: () => {},
  });
  assert.match((await enrichCliGoal('5/12 + 7/18', '.', manager('verified', 'rational_add'))).directAnswer!, /29\/36/);
  assert.equal((await enrichCliGoal('5/12 + 7/18', '.', manager('draft', 'rational_add'))).directAnswer, undefined);
  assert.equal((await enrichCliGoal('5/12 + 7/18', '.', manager('verified', 'mean'))).directAnswer, undefined);
});

test('unavailable retrieval remains nonfatal and owned resources are released', async () => {
  let stopped = false;
  const result = await enrichCliGoal('Question', '.', {
    available: () => true, context: async () => { throw new Error('timeout'); }, stop: () => { stopped = true; },
  });
  assert.equal(result.goal, 'Question'); assert.match(result.warning!, /timeout/); assert.equal(stopped, true);
});
