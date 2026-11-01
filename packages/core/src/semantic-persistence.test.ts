import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexSearchTool, SemanticIndex, type EmbedFn } from './semantic.js';
import type { ToolExecutionContext } from '@mazz/shared';

// These tests exercise the real on-disk index and lexical fallback. The zero
// vectors deliberately keep these deterministic storage/retrieval checks
// independent of a running embedding GGUF; they are not model-quality evidence.
const zeroVectors: EmbedFn = async (texts) => texts.map(() => [0, 0]);

async function withWorkspace(run: (root: string, docs: string, store: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-semantic-persist-'));
  const docs = path.join(root, 'docs');
  const store = path.join(root, 'index');
  await fs.mkdir(docs);
  try { await run(root, docs, store); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function put(docs: string, name: string, text: string): Promise<string> {
  const file = path.join(docs, name);
  await fs.writeFile(file, text, 'utf8');
  return file;
}

test('virtual context retrieval returns all three source documents for a composed fact', async () => {
  await withWorkspace(async (_root, docs, store) => {
    await put(docs, 'doc_0041.md', 'La planète fictive Qadron possède exactement 17 laboratoires.');
    await put(docs, 'doc_0084.md', 'Chaque laboratoire de Qadron comporte exactement 6 salles.');
    await put(docs, 'doc_0170.md', 'Chaque salle de Qadron comporte exactement 4 bancs.');
    const index = new SemanticIndex(store);
    await index.build([docs], 'isolated-lexical-test', zeroVectors);

    const hits = await index.search('Combien de bancs comporte Qadron ?', 8, zeroVectors);
    const sources = new Set(hits.map((hit) => path.basename(hit.file)));
    assert.equal(sources.has('doc_0041.md'), true);
    assert.equal(sources.has('doc_0084.md'), true);
    assert.equal(sources.has('doc_0170.md'), true);
    assert.equal(hits.length, 3);
    for (const hit of hits) assert.ok(hit.line >= 1 && hit.text.length > 20);
  });
});

test('virtual context follows an explicit five-document identifier chain with source provenance', async () => {
  await withWorkspace(async (_root, docs, store) => {
    await put(docs, 'doc_0018.md', 'La clé de l’étape 1 est ORIGINE-91.');
    await put(docs, 'doc_0058.md', 'ORIGINE-91 pointe vers BALISE-42.');
    await put(docs, 'doc_0112.md', 'BALISE-42 pointe vers PLAN-73.');
    await put(docs, 'doc_0191.md', 'PLAN-73 pointe vers ARCHIVE-64.');
    await put(docs, 'doc_0240.md', 'ARCHIVE-64 pointe vers REPONSE-25.');
    const index = new SemanticIndex(store);
    await index.build([docs], 'isolated-lexical-test', zeroVectors);

    const hits = await index.search('Quelle réponse finale est reliée à ORIGINE-91 ?', 8, zeroVectors);
    const bySource = new Map(hits.map((hit) => [path.basename(hit.file), hit]));
    assert.deepEqual([...bySource.keys()].sort(), [
      'doc_0018.md', 'doc_0058.md', 'doc_0112.md', 'doc_0191.md', 'doc_0240.md',
    ]);
    assert.equal(bySource.get('doc_0018.md')?.retrievalDepth, 0);
    assert.equal(bySource.get('doc_0058.md')?.retrievalDepth, 0);
    assert.equal(bySource.get('doc_0112.md')?.matchedAnchor, 'BALISE-42');
    assert.equal(bySource.get('doc_0191.md')?.matchedAnchor, 'PLAN-73');
    assert.equal(bySource.get('doc_0240.md')?.matchedAnchor, 'ARCHIVE-64');
    for (const hit of hits) assert.ok(hit.file && hit.line === 1 && hit.text.length > 20);

    const tool = new IndexSearchTool((query, k) => index.search(query, k, zeroVectors));
    const execution = await tool.execute({ query: 'Quelle réponse finale est reliée à ORIGINE-91 ?', k: 8 }, {} as ToolExecutionContext);
    assert.equal(execution.success, true);
    const toolResults = (execution.output as { results: Array<{ path: string; retrievalDepth: number; matchedAnchor?: string }> }).results;
    assert.equal(toolResults.some((hit) => path.basename(hit.path) === 'doc_0240.md' && hit.retrievalDepth === 3 && hit.matchedAnchor === 'ARCHIVE-64'), true);
  });
});

test('generation metadata commits atomically, reloads, updates one file, deletes another, and re-embeds on model change', async () => {
  await withWorkspace(async (_root, docs, store) => {
    const a = await put(docs, 'a.md', 'OLD_MAZZ_SENTINEL identifies the first indexed document.');
    const b = await put(docs, 'b.md', 'DELETE_MAZZ_SENTINEL identifies the second indexed document.');
    await put(docs, 'c.md', 'KEEP_MAZZ_SENTINEL identifies an unchanged indexed document.');
    const index = new SemanticIndex(store);
    await index.build([docs], 'embedder-one', zeroVectors);
    const firstMeta = JSON.parse(await fs.readFile(path.join(store, 'meta.json'), 'utf8')) as { generation: string; chunkFile: string; vectorFile: string; chunkSha256: string; vectorSha256: string };
    assert.match(firstMeta.generation, /^[a-f0-9]{32}$/);
    assert.equal(firstMeta.chunkSha256.length, 64);
    assert.equal(firstMeta.vectorSha256.length, 64);
    await fs.access(path.join(store, firstMeta.chunkFile));
    await fs.access(path.join(store, firstMeta.vectorFile));

    const reopened = new SemanticIndex(store);
    await reopened.load();
    assert.equal(reopened.status([docs]).chunks, 3);
    assert.equal(path.basename((await reopened.search('KEEP_MAZZ_SENTINEL', 2, zeroVectors))[0].file), 'c.md');

    await fs.writeFile(a, 'NEW_MAZZ_SENTINEL replaces the old source passage.');
    await fs.rm(b);
    let updatedPassages = 0;
    const countUpdates: EmbedFn = async (texts, kind) => {
      if (kind === 'document') updatedPassages += texts.length;
      return zeroVectors(texts, kind);
    };
    await reopened.build([docs], 'embedder-one', countUpdates);
    assert.equal(updatedPassages, 1);
    assert.equal((await reopened.search('OLD_MAZZ_SENTINEL', 3, zeroVectors)).length, 0);
    assert.equal((await reopened.search('DELETE_MAZZ_SENTINEL', 3, zeroVectors)).length, 0);
    assert.equal(path.basename((await reopened.search('NEW_MAZZ_SENTINEL', 2, zeroVectors))[0].file), 'a.md');
    assert.equal(path.basename((await reopened.search('KEEP_MAZZ_SENTINEL', 2, zeroVectors))[0].file), 'c.md');

    let modelPassages = 0;
    const countModelChange: EmbedFn = async (texts, kind) => {
      if (kind === 'document') modelPassages += texts.length;
      return zeroVectors(texts, kind);
    };
    await reopened.build([docs], 'embedder-two', countModelChange);
    assert.equal(modelPassages, 2);
    const afterChange = new SemanticIndex(store);
    await afterChange.load();
    assert.equal(afterChange.status([docs]).model, 'embedder-two');
    assert.equal(afterChange.status([docs]).files, 2);
    await assert.rejects(fs.access(path.join(store, firstMeta.chunkFile)));
  });
});

test('stopping an incremental build preserves unprocessed indexed sources and commits the changed prefix', async () => {
  await withWorkspace(async (_root, docs, store) => {
    const a = await put(docs, 'a.md', 'OLD_PREFIX_MARKER belongs to the first source.');
    await put(docs, 'b.md', 'SUFFIX_B_MARKER belongs to the second source.');
    await put(docs, 'c.md', 'SUFFIX_C_MARKER belongs to the third source.');
    const index = new SemanticIndex(store);
    await index.build([docs], 'same-model', zeroVectors);

    await fs.writeFile(a, 'NEW_PREFIX_MARKER replaces the first source.');
    const stopOnFirstReembed: EmbedFn = async (texts, kind) => {
      if (kind === 'document') index.stop();
      return zeroVectors(texts, kind);
    };
    await index.build([docs], 'same-model', stopOnFirstReembed);

    assert.match(index.status([docs]).error ?? '', /interrompue/);
    assert.equal((await index.search('OLD_PREFIX_MARKER', 4, zeroVectors)).length, 0);
    assert.equal(path.basename((await index.search('NEW_PREFIX_MARKER', 4, zeroVectors))[0].file), 'a.md');
    assert.equal(path.basename((await index.search('SUFFIX_B_MARKER', 4, zeroVectors))[0].file), 'b.md');
    assert.equal(path.basename((await index.search('SUFFIX_C_MARKER', 4, zeroVectors))[0].file), 'c.md');
    const afterRestart = new SemanticIndex(store);
    await afterRestart.load();
    assert.equal(afterRestart.status([docs]).files, 3);
    assert.match(afterRestart.status([docs]).error ?? '', /point de reprise/);
    assert.equal(path.basename((await afterRestart.search('SUFFIX_C_MARKER', 4, zeroVectors))[0].file), 'c.md');
  });
});

test('a stopped first index build persists its completed prefix so a later build resumes the remaining files', async () => {
  await withWorkspace(async (_root, docs, store) => {
    await put(docs, 'a.md', 'FIRST_BUILD_MARKER is the completed source.');
    await put(docs, 'b.md', 'RESUMED_BUILD_MARKER is the later source.');
    const first = new SemanticIndex(store);
    const stopAfterFirstDocument: EmbedFn = async (texts, kind) => {
      if (kind === 'document') first.stop();
      return zeroVectors(texts, kind);
    };
    await first.build([docs], 'same-model', stopAfterFirstDocument);
    assert.equal(first.status([docs]).files, 1);
    assert.match(first.status([docs]).error ?? '', /point de reprise/);
    assert.equal(path.basename((await first.search('FIRST_BUILD_MARKER', 2, zeroVectors))[0].file), 'a.md');

    const resumed = new SemanticIndex(store);
    await resumed.load();
    assert.match(resumed.status([docs]).error ?? '', /point de reprise/);
    let embedded = 0;
    const countResume: EmbedFn = async (texts, kind) => {
      if (kind === 'document') embedded += texts.length;
      return zeroVectors(texts, kind);
    };
    await resumed.build([docs], 'same-model', countResume);
    assert.equal(embedded, 1);
    assert.equal(resumed.status([docs]).files, 2);
    assert.equal(resumed.status([docs]).error, undefined);
    assert.equal(path.basename((await resumed.search('RESUMED_BUILD_MARKER', 2, zeroVectors))[0].file), 'b.md');
  });
});

test('corrupt persisted vectors are reported instead of silently appearing as an empty index', async () => {
  await withWorkspace(async (_root, docs, store) => {
    await put(docs, 'source.md', 'PERSISTED_MAZZ_FACT is stored in this document.');
    const index = new SemanticIndex(store);
    await index.build([docs], 'embedder-one', zeroVectors);
    const meta = JSON.parse(await fs.readFile(path.join(store, 'meta.json'), 'utf8')) as { vectorFile: string };
    const vectorPath = path.join(store, meta.vectorFile);
    const vectors = await fs.readFile(vectorPath);
    vectors[0] = vectors[0]! ^ 0xff;
    await fs.writeFile(vectorPath, vectors);

    const reopened = new SemanticIndex(store);
    await reopened.load();
    assert.match(reopened.status([docs]).error ?? '', /empreinte|taille|illisible/i);
    await assert.rejects(reopened.search('PERSISTED_MAZZ_FACT', 3, zeroVectors), /Index sémantique illisible/);
    assert.ok((await fs.stat(vectorPath)).size > 0, 'load diagnoses corruption without deleting the persisted evidence');
  });
});

test('existing three-file indexes load and migrate to a committed generation without re-embedding unchanged sources', async () => {
  await withWorkspace(async (_root, docs, store) => {
    const file = await put(docs, 'legacy.md', 'LEGACY_MAZZ_MARKER remains searchable after index migration.');
    const source = await fs.stat(file);
    const content = await fs.readFile(file);
    const { createHash } = await import('node:crypto');
    const vectors = new Float32Array([1, 0]);
    await fs.mkdir(store);
    await fs.writeFile(path.join(store, 'chunks.jsonl'), `${JSON.stringify({ file, line: 1, text: content.toString('utf8') })}\n`);
    await fs.writeFile(path.join(store, 'vectors.f32'), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
    await fs.writeFile(path.join(store, 'meta.json'), JSON.stringify({
      model: 'legacy-model', dims: 2, folders: [docs], builtAt: source.mtimeMs,
      files: { [file]: { size: source.size, mtime: source.mtimeMs, contentHash: createHash('sha256').update(content).digest('hex'), first: 0, count: 1 } },
    }));

    const index = new SemanticIndex(store);
    await index.load();
    assert.equal(index.status([docs]).error, undefined);
    assert.equal(path.basename((await index.search('LEGACY_MAZZ_MARKER', 1, zeroVectors))[0].file), 'legacy.md');

    let reembedded = 0;
    const counting: EmbedFn = async (texts, kind) => {
      if (kind === 'document') reembedded += texts.length;
      return zeroVectors(texts, kind);
    };
    await index.build([docs], 'legacy-model', counting);
    assert.equal(reembedded, 0);
    const migrated = JSON.parse(await fs.readFile(path.join(store, 'meta.json'), 'utf8')) as { formatVersion?: number; generation?: string };
    assert.equal(migrated.formatVersion, 2);
    assert.match(migrated.generation ?? '', /^[a-f0-9]{32}$/);
    const afterRestart = new SemanticIndex(store);
    await afterRestart.load();
    assert.equal(path.basename((await afterRestart.search('LEGACY_MAZZ_MARKER', 1, zeroVectors))[0].file), 'legacy.md');
  });
});
