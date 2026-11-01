import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AgentEvent } from '@mazz/shared';
import type { IModelProvider } from '@mazz/providers';
import { calibrateModel, calibrationRuntimeMatches, isModelCalibrationProfile, type CalibrationRuntimeSnapshot } from './model-calibration.js';

const runtime: CalibrationRuntimeSnapshot = {
  binaryPath: 'C:\\runtime\\llama-server.exe', binarySizeBytes: 100, binaryModifiedAtMs: 1_700_000_000_000,
  contextSize: 4096, threads: 4, batchSize: 512, gpuLayers: 0, jinja: true, chatTemplateKwargs: { enable_thinking: false },
  reasoning: 'off', kvCacheType: 'f16', flashAttn: null, specType: 'ngram-mod', ngramMatch: 24, ngramMin: 4,
  ngramMax: 16, draftModelPath: null, draftMax: 3, poll: 100, prio: 2,
};

function fakeProvider(options?: { toolCall?: boolean; toolCallSequence?: boolean[]; grammar?: boolean; code?: boolean }): IModelProvider {
  let toolAttempt = 0;
  return {
    id: 'llama-local',
    type: 'llama_cpp',
    name: 'Fixture',
    baseUrl: 'http://127.0.0.1:8080/v1',
    async testConnection() { return { ok: true, message: 'ok', latencyMs: 0 }; },
    async listModels() { return []; },
    async *chatStream(): AsyncIterable<AgentEvent> {},
    async chatComplete() {
      const toolCall = options?.toolCallSequence?.[toolAttempt++] ?? options?.toolCall;
      return toolCall
        ? { content: '', toolCalls: [{ id: 'probe-1', name: 'calibration.echo', arguments: { value: 'MAZZ_CALIBRATION_42' } }] }
        : { content: 'Je réponds en texte.' };
    },
    async *completePrefix(_prompt, request) {
      const answer = request.grammar
        ? options?.grammar ? '42' : 'forty two'
        : options?.code ? 'left + right' : '0';
      yield { type: 'token', taskId: request.taskId, timestamp: Date.now(), delta: answer } satisfies AgentEvent;
    },
  } as IModelProvider;
}

test('model calibration scores tool JSON, grammar and code continuation', async () => {
  const result = await calibrateModel(fakeProvider({ toolCall: true, grammar: true, code: true }), 'fixture.gguf', 'C:\\models\\fixture.gguf', {
    sizeBytes: 1024,
    modifiedAtMs: 1_700_000_000_000,
  }, runtime);
  assert.deepEqual(result.score, { passed: 3, total: 3, percent: 100 });
  assert.equal(result.strategy, 'autonomous');
  assert.equal(result.checks.toolCalling.attempts, 3);
  assert.equal(result.checks.toolCalling.passedAttempts, 3);
  assert.ok(isModelCalibrationProfile(result));
  assert.deepEqual(result.runtime, runtime);
});

test('calibration runtime identity rejects changed or missing runtime snapshots', () => {
  assert.equal(calibrationRuntimeMatches(runtime, { ...runtime, chatTemplateKwargs: { enable_thinking: false } }), true);
  assert.equal(calibrationRuntimeMatches(runtime, { ...runtime, contextSize: 8192 }), false);
  assert.equal(calibrationRuntimeMatches(runtime, undefined), false);
  assert.equal(calibrationRuntimeMatches(undefined, runtime), false);
});

test('calibration profile validator rejects malformed runtime identity', async () => {
  const result = await calibrateModel(fakeProvider({ toolCall: true, grammar: true, code: true }), 'fixture.gguf', 'C:\\models\\fixture.gguf', {
    sizeBytes: 1024,
    modifiedAtMs: 1_700_000_000_000,
  }, runtime);
  assert.ok(!isModelCalibrationProfile({ ...result, runtime: { ...runtime, contextSize: 'large' } }));
});

test('model calibration tolerates one transient tool-call miss but records the observed response', async () => {
  const result = await calibrateModel(fakeProvider({ toolCallSequence: [false, true, true], grammar: true, code: false }), 'fixture.gguf', 'C:\\models\\fixture.gguf', {
    sizeBytes: 1024,
    modifiedAtMs: 1_700_000_000_000,
  });
  assert.equal(result.checks.toolCalling.status, 'passed');
  assert.equal(result.checks.toolCalling.attempts, 3);
  assert.equal(result.checks.toolCalling.passedAttempts, 2);
  assert.match(result.checks.toolCalling.outputPreview ?? '', /Je réponds en texte/u);
  assert.equal(result.checks.codeContinuation.outputPreview, '0');
  assert.ok(isModelCalibrationProfile(result));
});

test('model calibration recommends guided execution when probes do not pass', async () => {
  const result = await calibrateModel(fakeProvider({ toolCall: false, grammar: false, code: false }), 'fixture.gguf', 'C:\\models\\fixture.gguf', {
    sizeBytes: 1024,
    modifiedAtMs: 1_700_000_000_000,
  });
  assert.deepEqual(result.score, { passed: 0, total: 3, percent: 0 });
  assert.equal(result.strategy, 'guided');
  assert.ok(!isModelCalibrationProfile({ ...result, modelModifiedAtMs: -1 }));
});
