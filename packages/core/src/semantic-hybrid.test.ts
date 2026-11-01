import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SemanticIndex, type EmbedFn } from './semantic.js';

// Deliberately misleading vectors: exact matches must survive a bad semantic rank.
const misleading: EmbedFn = async (texts, kind) => texts.map((text) =>
  kind === 'query' || text.includes('UNRELATED') ? [1, 0] : [0, 1]);

async function fixture(run: (index: SemanticIndex, root: string, docs: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-hybrid-'));
  const docs = path.join(root, 'docs');
  try {
    await fs.mkdir(docs);
    await fs.writeFile(path.join(docs, 'a-noise.md'), 'UNRELATED recipes and gardening without programming guidance.');
    await fs.writeFile(path.join(docs, 'b-python.md'), 'Use pathlib.Path.resolve to obtain an absolute filesystem path safely.');
    await fs.writeFile(path.join(docs, 'c-errors.md'), 'ECONNREFUSED means that the network connection was refused by the destination.');
    const index = new SemanticIndex(path.join(root, 'index'));
    await index.build([docs], 'test-vectors', misleading);
    await run(index, root, docs);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('hybrid retrieval recovers dotted identifiers despite misleading embeddings', async () => {
  await fixture(async (index) => {
    const hits = await index.search('pathlib.Path.resolve', 1, misleading);
    assert.equal(path.basename(hits[0].file), 'b-python.md');
    assert.equal(hits[0].retrieval, 'hybrid');
    assert.equal(hits[0].semanticScore, 0);
    assert.ok(hits[0].lexicalScore! > 0);
  });
});

test('hybrid retrieval recovers exact error codes', async () => {
  await fixture(async (index) => {
    assert.equal(path.basename((await index.search('ECONNREFUSED', 1, misleading))[0].file), 'c-errors.md');
  });
});

test('lexical index reloads from existing persistence without embedding documents again', async () => {
  await fixture(async (_index, root) => {
    const reloaded = new SemanticIndex(path.join(root, 'index'));
    await reloaded.load();
    const fail: EmbedFn = async () => { throw new Error('embedding service offline'); };
    const hits = await reloaded.search('ECONNREFUSED', 1, fail);
    assert.equal(path.basename(hits[0].file), 'c-errors.md');
    assert.equal(hits[0].retrieval, 'lexical');
    assert.equal(hits[0].embeddingWarning, 'embedding service offline');
    await assert.rejects(reloaded.search('absentuniqueword', 1, fail), /offline/);
  });
});

test('incremental rebuild removes deleted lexical terms and indexes changed files only', async () => {
  await fixture(async (index, _root, docs) => {
    await fs.rm(path.join(docs, 'c-errors.md'));
    await fs.writeFile(path.join(docs, 'new.md'), 'ERR_MAZZ_NEW identifies this newly added fixture failure.');
    let embedded = 0;
    const counted: EmbedFn = async (texts, kind) => {
      if (kind === 'document') embedded += texts.length;
      return misleading(texts, kind);
    };
    await index.build([docs], 'test-vectors', counted);
    assert.equal(embedded, 1);
    const zeros: EmbedFn = async (texts) => texts.map(() => [0, 0]);
    assert.equal((await index.search('ECONNREFUSED', 3, zeros)).length, 0);
    assert.equal(path.basename((await index.search('ERR_MAZZ_NEW', 1, zeros))[0].file), 'new.md');
  });
});

test('empty query returns no unrelated results and invalid k is bounded', async () => {
  await fixture(async (index) => {
    assert.deepEqual(await index.search('   ', 1, misleading), []);
    assert.equal((await index.search('ECONNREFUSED', -1, misleading)).length, 1);
  });
});
