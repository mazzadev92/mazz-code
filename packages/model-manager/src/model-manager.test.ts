import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LlamaServerSupervisor, parseGgufHeader } from './index.js';
import { kvBytesPerToken, llamaKeyPath } from '@mazz/shared';

/** Minimal GGUF v3 writer for test fixtures. */
function buildGguf(kvs: Array<[string, 'str' | 'u32', string | number]>, tensors: Array<[string, number[]]>): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s, 'utf-8')]);
  parts.push(Buffer.from('GGUF', 'ascii'), u32(3), u64(tensors.length), u64(kvs.length));
  for (const [k, t, v] of kvs) {
    parts.push(str(k));
    if (t === 'str') parts.push(u32(8), str(String(v)));
    else parts.push(u32(4), u32(Number(v)));
  }
  for (const [name, dims] of tensors) {
    parts.push(str(name), u32(dims.length), ...dims.map(u64), u32(0), u64(0));
  }
  return Buffer.concat(parts);
}

test('GGUF parser: metadata, exact parameter count and KV estimate without loading weights', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-gguf-test-'));
  const file = path.join(tempDir, 'qwen2.5-coder-1.5b-q4_k_m.gguf');
  try {
    await fs.writeFile(
      file,
      buildGguf(
        [
          ['general.architecture', 'str', 'qwen2'],
          ['qwen2.context_length', 'u32', 32768],
          ['qwen2.block_count', 'u32', 28],
          ['qwen2.embedding_length', 'u32', 1536],
          ['qwen2.attention.head_count', 'u32', 12],
          ['qwen2.attention.head_count_kv', 'u32', 2],
        ],
        [
          ['token_embd.weight', [1536, 1000]],
          ['output_norm.weight', [1536]],
        ]
      )
    );

    const meta = await parseGgufHeader(file);
    assert.equal(meta.isValidGguf, true);
    assert.equal(meta.architecture, 'qwen2');
    assert.equal(meta.quantization, 'Q4_K_M (nom de fichier)');
    assert.equal(meta.contextLength, 32768);
    assert.equal(meta.tensorCount, 2);
    assert.equal(meta.parameterCount, 1536 * 1000 + 1536);
    // 28 layers x 2 kv heads x (128 + 128) dims x 2 bytes
    assert.equal(kvBytesPerToken(meta), 28 * 2 * 256 * 2);
    assert.ok(meta.estimatedRamMb > 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('GGUF parser: truncated and non-GGUF files are reported invalid', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-gguf-bad-'));
  try {
    const truncated = path.join(tempDir, 'cut.gguf');
    const full = buildGguf([['general.architecture', 'str', 'llama']], [['a', [4, 4]]]);
    await fs.writeFile(truncated, full.subarray(0, full.length - 6));
    const t = await parseGgufHeader(truncated);
    assert.equal(t.isValidGguf, false);
    assert.ok(t.error);

    const notGguf = path.join(tempDir, 'readme.gguf');
    await fs.writeFile(notGguf, 'hello world, not a model');
    const n = await parseGgufHeader(notGguf);
    assert.equal(n.isValidGguf, false);
    assert.equal(n.architecture, 'non-gguf');

    const missing = await parseGgufHeader(path.join(tempDir, 'absent.gguf'));
    assert.equal(missing.isValidGguf, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

const REAL_MODEL = process.env.MAZZ_TEST_GGUF || 'D:\\TESSERA\\Mgguf\\Qwen_Qwen3-0.6B-Q4_K_M.gguf';

test('GGUF parser: real model header (skipped when the file is absent)', { skip: !existsSync(REAL_MODEL) }, async () => {
  const before = process.memoryUsage().rss;
  const meta = await parseGgufHeader(REAL_MODEL);
  const grown = process.memoryUsage().rss - before;
  assert.equal(meta.isValidGguf, true, meta.error ?? '');
  assert.ok(meta.parameterCount && meta.parameterCount > 100_000_000);
  assert.ok(meta.vocabSize && meta.vocabSize > 1000);
  assert.ok(meta.blockCount && meta.blockCount > 0);
  // Header only: far below the 480 MB of weights.
  assert.ok(grown < 150 * 1024 * 1024, `RSS grew by ${grown} bytes`);
});

test('llama-server arguments: the API key is passed by file, never by value', () => {
  const args = LlamaServerSupervisor.buildArgs({ modelPath: 'm.gguf' });
  assert.equal(args[args.indexOf('--api-key-file') + 1], llamaKeyPath());
  assert.equal(args.some((a) => a.toLowerCase().includes('authorization') || a.startsWith('Bearer ')), false);
});

test('llama-server arguments: --mmproj only when a projector is chosen', () => {
  const withProj = LlamaServerSupervisor.buildArgs({ modelPath: 'm.gguf', mmprojPath: 'mmproj-m.gguf' });
  assert.equal(withProj[withProj.indexOf('--mmproj') + 1], 'mmproj-m.gguf');
  assert.ok(!LlamaServerSupervisor.buildArgs({ modelPath: 'm.gguf' }).includes('--mmproj'));
});

test('llama-server arguments: model-specific Jinja parameters are passed as JSON', () => {
  const budgeted = LlamaServerSupervisor.buildArgs({ modelPath: 'qwen.gguf', reasoning: 'on', reasoningBudget: 512 });
  assert.equal(budgeted[budgeted.indexOf('--reasoning-budget') + 1], '512');
  assert.equal(LlamaServerSupervisor.buildArgs({ modelPath: 'qwen.gguf', reasoning: 'off', reasoningBudget: 512 }).includes('--reasoning-budget'), false);
  const args = LlamaServerSupervisor.buildArgs({ modelPath: 'qwen.gguf', jinja: true, chatTemplateKwargs: { enable_thinking: false } });
  assert.equal(args[args.indexOf('--chat-template-kwargs') + 1], '{"enable_thinking":false}');
});

test('llama-server arguments: MUCE acceleration profile, draft model taking precedence', () => {
  const a = LlamaServerSupervisor.buildArgs({ modelPath: 'm.gguf', specType: 'ngram-mod', ngramMatch: 24, ngramMin: 4, ngramMax: 48, poll: 100, prio: 2, reasoning: 'off', kvCacheType: 'q8_0', flashAttn: 'on' });
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after('--spec-type'), 'ngram-mod');
  assert.equal(after('--spec-ngram-mod-n-min'), '4');
  assert.equal(after('--poll'), '100');
  assert.equal(after('--prio'), '2');
  assert.equal(after('--reasoning'), 'off');
  assert.equal(after('--cache-type-v'), 'q8_0');
  const withDraft = LlamaServerSupervisor.buildArgs({ modelPath: 'm.gguf', specType: 'ngram-mod', draftModelPath: 'd.gguf' });
  assert.ok(!withDraft.includes('--spec-type'));
  assert.ok(withDraft.includes('--model-draft'));
});
