import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { SemanticIndex } from './semantic.js';

async function withWorkspace(run: (docs: string, store: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-semantic-lexical-'));
  const docs = path.join(root, 'docs');
  const store = path.join(root, 'index');
  await fs.mkdir(docs);
  try { await run(docs, store); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function put(docs: string, name: string, text: string): Promise<string> {
  const file = path.join(docs, name);
  await fs.writeFile(file, text, 'utf8');
  return file;
}

test('explicit lexical mode persists real passages, retrieves three and five source chains, and updates safely without embeddings', async () => {
  await withWorkspace(async (docs, store) => {
    const changedPath = await put(docs, 'doc_0041.md', 'Qadron has the OLD_FACT marker and 17 laboratories.\n');
    await put(docs, 'doc_0084.md', 'Every laboratory of Qadron has 6 rooms.\n');
    await put(docs, 'doc_0170.md', 'Every room of Qadron has 4 benches.\n');
    await put(docs, 'doc_0018.md', 'The first key is ORIGINE-91.\n');
    await put(docs, 'doc_0058.md', 'ORIGINE-91 points to BALISE-42.\n');
    await put(docs, 'doc_0112.md', 'BALISE-42 points to PLAN-73.\n');
    await put(docs, 'doc_0191.md', 'PLAN-73 points to ARCHIVE-64.\n');
    await put(docs, 'doc_0240.md', 'ARCHIVE-64 points to REPONSE-25.\n');

    const index = new SemanticIndex(store);
    await index.buildLexical([docs]);
    assert.deepEqual(index.status([docs]).retrievalMode, 'lexical');
    assert.equal(index.status([docs]).files, 8);

    const three = await index.search('Combien de bancs comporte Qadron ?', 8);
    assert.deepEqual(new Set(three.map((hit) => path.basename(hit.file))), new Set(['doc_0041.md', 'doc_0084.md', 'doc_0170.md']));
    assert.ok(three.every((hit) => hit.retrieval === 'lexical' && hit.line === 1));
    assert.ok(three.some((hit) => hit.text.includes('17 laboratories')));
    assert.ok(three.some((hit) => hit.text.includes('6 rooms')));
    assert.ok(three.some((hit) => hit.text.includes('4 benches')));

    // Start from one unique link token so the test proves identifier following
    // instead of succeeding because the initial top-k happens to contain all sources.
    const five = await index.search('ORIGINE-91', 8);
    const chain = new Map(five.map((hit) => [path.basename(hit.file), hit]));
    assert.deepEqual([...chain.keys()].sort(), ['doc_0018.md', 'doc_0058.md', 'doc_0112.md', 'doc_0191.md', 'doc_0240.md']);
    assert.equal(chain.get('doc_0240.md')?.matchedAnchor, 'ARCHIVE-64');
    assert.equal(chain.get('doc_0240.md')?.retrievalDepth, 3);
    assert.ok(five.every((hit) => hit.retrieval === 'lexical'));

    const meta = JSON.parse(await fs.readFile(path.join(store, 'meta.json'), 'utf8')) as {
      formatVersion: number; retrievalMode: string; dims: number; chunkFile: string; vectorFile?: string; vectorBytes: number; chunkSha256: string;
    };
    assert.equal(meta.formatVersion, 3);
    assert.equal(meta.retrievalMode, 'lexical');
    assert.equal(meta.dims, 0);
    assert.equal(meta.vectorBytes, 0);
    assert.equal(meta.vectorFile, undefined);
    assert.equal((await fs.readdir(store)).some((name) => name.startsWith('vectors.')), false);
    const chunkBytes = await fs.readFile(path.join(store, meta.chunkFile));
    assert.equal(createHash('sha256').update(chunkBytes).digest('hex'), meta.chunkSha256);

    const reopened = new SemanticIndex(store);
    await reopened.load();
    assert.equal(reopened.status([docs]).retrievalMode, 'lexical');
    assert.equal(path.basename((await reopened.search('REPONSE-25', 2))[0]!.file), 'doc_0240.md');

    const previous = await fs.stat(changedPath);
    await fs.writeFile(changedPath, 'Qadron has the NEW_FACT marker and 17 laboratories.\n', 'utf8');
    await fs.utimes(changedPath, previous.atime, previous.mtime);
    await fs.rm(path.join(docs, 'doc_0084.md'));
    await reopened.buildLexical([docs]);
    assert.equal((await reopened.search('OLD_FACT', 4)).length, 0);
    assert.equal(path.basename((await reopened.search('NEW_FACT', 2))[0]!.file), 'doc_0041.md');
    assert.equal((await reopened.search('laboratory Qadron rooms', 8)).some((hit) => path.basename(hit.file) === 'doc_0084.md'), false);
    assert.equal(reopened.status([docs]).files, 7);
  });
});

test('a lexical checkpoint is marked incomplete and resumes from persisted disk state', async () => {
  await withWorkspace(async (docs, store) => {
    for (let i = 0; i < 100; i++) await put(docs, `doc_${String(i).padStart(3, '0')}.md`, `RESUMABLE_LEXICAL_SOURCE_${i} is persisted.\n`);
    const first = new SemanticIndex(store);
    const building = first.buildLexical([docs]);
    for (let attempt = 0; attempt < 1000 && first.status([docs]).building; attempt++) {
      if ((first.status([docs]).progress?.done ?? 0) > 0) {
        first.stop();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await building;
    assert.match(first.status([docs]).error ?? '', /interrompu/i);
    assert.ok(first.status([docs]).files > 0 && first.status([docs]).files < 100);
    assert.ok((await first.search('persisted', 4)).length > 0);

    const resumed = new SemanticIndex(store);
    await resumed.load();
    assert.match(resumed.status([docs]).error ?? '', /interrompue|interrompu/i);
    await resumed.buildLexical([docs]);
    assert.equal(resumed.status([docs]).error, undefined);
    assert.equal(resumed.status([docs]).files, 100);
    assert.ok((await resumed.search('RESUMABLE_LEXICAL_SOURCE_99', 2)).length > 0);
  });
});

