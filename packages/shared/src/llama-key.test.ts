import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLlamaKey, llamaAuthHeaders, llamaKeyPath, resetLlamaKeyCacheForTests } from './llama-key.js';

test('shared llama key is created once and reused by every local client', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mazz-llama-key-'));
  const previous = process.env.MAZZ_LLAMA_KEY_FILE;
  process.env.MAZZ_LLAMA_KEY_FILE = path.join(dir, 'llama.key');
  resetLlamaKeyCacheForTests();
  try {
    const first = ensureLlamaKey();
    resetLlamaKeyCacheForTests();
    const second = ensureLlamaKey();
    assert.equal(first, second);
    assert.equal(fs.readFileSync(llamaKeyPath(), 'utf-8'), first);
    assert.equal(llamaAuthHeaders().Authorization, `Bearer ${first}`);
  } finally {
    if (previous === undefined) delete process.env.MAZZ_LLAMA_KEY_FILE;
    else process.env.MAZZ_LLAMA_KEY_FILE = previous;
    resetLlamaKeyCacheForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
