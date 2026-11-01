import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { contextUsage, estimateDecodeRate, ratesFromLlamaTimings, rollingRate, tokensPerSecond } from './telemetry.js';
import { estimateRam, kvBytesPerToken } from './estimates.js';

test('tokensPerSecond: plain ratio, undefined when not measurable', () => {
  assert.equal(tokensPerSecond(100, 2000), 50);
  assert.equal(tokensPerSecond(0, 1000), undefined);
  assert.equal(tokensPerSecond(10, 0), undefined);
  assert.equal(tokensPerSecond(undefined, 10), undefined);
});

test('llama.cpp timings: pp uses prompt counters, tg uses predicted counters (never mixed)', () => {
  // Real values returned by llama-server (Qwen3 0.6B Q4_K_M, i5-6500).
  const real = { prompt_n: 20, prompt_ms: 128.421, prompt_per_second: 155.7377687449872, predicted_n: 7, predicted_ms: 282.27, predicted_per_second: 21.25624402168137, cache_n: 0 };
  const r = ratesFromLlamaTimings(real);
  assert.ok(Math.abs((r.ppTokS ?? 0) - 155.7377) < 0.01);
  assert.ok(Math.abs((r.tgTokS ?? 0) - 21.256) < 0.01, 'runtime decode rate is authoritative');
  // Without per-second fields: count / duration fallback.
  const f = ratesFromLlamaTimings({ prompt_n: 20, prompt_ms: 128.421, predicted_n: 7, predicted_ms: 282.27 });
  assert.ok(Math.abs((f.tgTokS ?? 0) - 24.799) < 0.01);
  assert.equal(r.promptTokens, 20);
  assert.equal(r.completionTokens, 7);
  assert.equal(r.cachedTokens, 0);
});

test('client decode estimate excludes the first token (it closes the prefill)', () => {
  // 11 tokens: first at t=1000, last at t=2000 -> 10 tokens over 1 s.
  assert.equal(estimateDecodeRate(11, 1000, 2000), 10);
  assert.equal(estimateDecodeRate(1, 1000, 2000), undefined);
  assert.equal(estimateDecodeRate(10, undefined, 2000), undefined);
  // Groq-like burst: 30 tokens in 6 ms is not a measurable rate.
  assert.equal(estimateDecodeRate(30, 1000, 1006), undefined);
});

test('rolling rate over a window, stopped stream decays to undefined', () => {
  const ts = [0, 100, 200, 300, 400, 500];
  assert.equal(rollingRate(ts, 1000, 500), 10); // 5 intervals over 500 ms
  assert.equal(rollingRate(ts, 250, 500), 10); // 400,500 -> 1 interval in 100 ms
  assert.equal(rollingRate(ts, 1000, 5000), undefined); // generation stopped long ago
  assert.equal(rollingRate([], 1000, 0), undefined);
});

test('context usage percentage, unknown limit gives undefined', () => {
  assert.equal(contextUsage(1024, 4096), 25);
  assert.equal(contextUsage(9000, 4096), 100);
  assert.equal(contextUsage(10, undefined), undefined);
});

test('KV cache estimate for Qwen3-0.6B shape', () => {
  const meta = { blockCount: 28, headCount: 16, headCountKv: 8, keyLength: 128, valueLength: 128, embeddingLength: 1024 };
  assert.equal(kvBytesPerToken(meta), 28 * 8 * 256 * 2);
  const est = estimateRam({ ...meta, filePath: '', fileName: '', fileSizeBytes: 484220320, architecture: 'qwen3', quantization: 'Q4_K_M', estimatedRamMb: 0, isValidGguf: true }, 4096);
  assert.equal(est.kvCacheMb, 448);
  assert.equal(est.kvKnown, true);
  const unknown = estimateRam({ filePath: '', fileName: '', fileSizeBytes: 1048576, architecture: 'x', quantization: 'q', estimatedRamMb: 0, isValidGguf: true }, 4096);
  assert.equal(unknown.kvKnown, false);
});
