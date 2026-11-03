import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aiRouterSelectionAllowed, isAiRouterModelId } from './ai-router-policy.js';

describe('MAZZ Control router selection policy', () => {
  it('blocks explicit remote router models in local strict while preserving local gateway models', () => {
    assert.equal(isAiRouterModelId('auto'), true);
    assert.equal(isAiRouterModelId('router/frontier'), true);
    assert.equal(aiRouterSelectionAllowed('local_strict', 'mazz-cloud', 'auto'), false);
    assert.equal(aiRouterSelectionAllowed('local_strict', 'mazz-cloud', 'router/fast'), false);
    assert.equal(aiRouterSelectionAllowed('local_strict', 'mazz-cloud', 'local-model.gguf'), true);
    assert.equal(aiRouterSelectionAllowed('hybrid_opt_in', 'mazz-cloud', 'auto'), true);
  });
});
