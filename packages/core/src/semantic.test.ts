import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkText, SemanticIndex, type EmbedFn } from './semantic.js';

/** Bag-of-words embedding: deterministic stand-in for the real model in unit tests. */
const VOCAB = ['cache', 'kv', 'gpu', 'vulkan', 'pizza', 'recette', 'tomate', 'compilation', 'cmake'];
const fakeEmbed: EmbedFn = async (texts) => texts.map((t) => VOCAB.map((w) => (t.toLowerCase().split(/\W+/).filter((x) => x === w).length)));

test('chunkText: overlapping chunks with correct line numbers', () => {
  const text = Array.from({ length: 200 }, (_, i) => `ligne ${i + 1} ${'x'.repeat(30)}`).join('\n');
  const chunks = chunkText(text);
  assert.ok(chunks.length > 3);
  assert.equal(chunks[0].line, 1);
  for (const c of chunks) assert.ok(c.text.startsWith(`ligne ${c.line} `), `${c.line}: ${c.text.slice(0, 20)}`);
});

test('Semantic index: build, search by meaning, incremental rebuild keeps unchanged files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-sem-'));
  const docs = path.join(dir, 'docs');
  try {
    await fs.mkdir(path.join(docs, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(docs, 'gpu.md'), '# GPU\nLe backend vulkan accélère le gpu et le cache kv.', 'utf-8');
    await fs.writeFile(path.join(docs, 'cuisine.md'), '# Pizza\nRecette de pizza à la tomate, recette simple.', 'utf-8');
    await fs.writeFile(path.join(docs, 'node_modules', 'x.md'), 'pizza pizza pizza vulkan', 'utf-8');
    let calls = 0;
    const counting: EmbedFn = async (t, k) => ((calls += k === 'document' ? t.length : 0), fakeEmbed(t, k));
    const idx = new SemanticIndex(path.join(dir, 'index'));
    await idx.build([docs], 'fake', counting);
    assert.equal(idx.status([docs]).files, 2);
    const hits = await idx.search('vulkan gpu', 2, fakeEmbed);
    assert.equal(path.basename(hits[0].file), 'gpu.md');
    const before = calls;
    await fs.writeFile(path.join(docs, 'build.md'), 'Compilation avec cmake.', 'utf-8');
    await idx.build([docs], 'fake', counting);
    assert.equal(calls - before, 1);
    const reloaded = new SemanticIndex(path.join(dir, 'index'));
    await reloaded.load();
    assert.equal(path.basename((await reloaded.search('cmake compilation', 1, fakeEmbed))[0].file), 'build.md');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Semantic index: reindexes same-size same-mtime edits and persists refreshed chunks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-sem-hash-'));
  const docs = path.join(dir, 'docs');
  const stablePath = path.join(docs, 'stable.md');
  const editedPath = path.join(docs, 'edited.md');
  const fixedTime = new Date('2022-03-04T05:06:07.000Z');
  try {
    await fs.mkdir(docs, { recursive: true });
    await fs.writeFile(stablePath, 'stablemarker evidence remains untouched in this document.', 'utf-8');
    await fs.writeFile(editedPath, 'oldmarker evidence for one stable document.', 'utf-8');
    await fs.utimes(stablePath, fixedTime, fixedTime);
    await fs.utimes(editedPath, fixedTime, fixedTime);

    let documentEmbeddings = 0;
    const counting: EmbedFn = async (texts, kind) => {
      if (kind === 'document') documentEmbeddings += texts.length;
      return fakeEmbed(texts, kind);
    };
    const indexPath = path.join(dir, 'index');
    const index = new SemanticIndex(indexPath);
    await index.build([docs], 'test-embedder', counting);
    const initialEmbeddingCount = documentEmbeddings;
    assert.equal(initialEmbeddingCount, 2);

    const before = await fs.stat(editedPath);
    const replacement = 'newmarker evidence for one stable document.';
    assert.equal(replacement.length, Buffer.byteLength('oldmarker evidence for one stable document.'));
    await fs.writeFile(editedPath, replacement, 'utf-8');
    await fs.utimes(editedPath, before.atime, before.mtime);
    const after = await fs.stat(editedPath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    await index.build([docs], 'test-embedder', counting);
    // Only the edited file is embedded; the unchanged file reuses its vector.
    assert.equal(documentEmbeddings - initialEmbeddingCount, 1);

    const persistedMeta = JSON.parse(await fs.readFile(path.join(indexPath, 'meta.json'), 'utf-8'));
    assert.match(persistedMeta.files[editedPath].contentHash, /^[a-f0-9]{64}$/);
    const reloaded = new SemanticIndex(indexPath);
    await reloaded.load();
    const updatedHits = await reloaded.search('newmarker', 3, fakeEmbed);
    assert.ok(updatedHits.some((hit) => hit.file === editedPath && hit.text.includes('newmarker')));
    assert.deepEqual(await reloaded.search('oldmarker', 3, fakeEmbed), []);
    assert.ok((await reloaded.search('stablemarker', 3, fakeEmbed)).some((hit) => hit.file === stablePath));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
