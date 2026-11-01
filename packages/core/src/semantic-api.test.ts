import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { MazzServer } from './server.js';

async function reservePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Échec de réservation d’un port de test.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('isolated HTTP path explicitly builds and queries a persistent lexical index without an embedding model', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-semantic-api-'));
  const dataDir = path.join(root, 'studio-data');
  const docs = path.join(root, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(docs, 'source.md'), 'The API_LEXICAL_SENTINEL proves this result came from the selected local file.\n', 'utf8');
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ version: 1, semantic: { folders: [docs], embeddingModel: '' } }), 'utf8');

  const port = await reservePort();
  const app = new MazzServer({ port, dataDir });
  const base = `http://127.0.0.1:${port}`;
  try {
    await app.start();
    const invalid = await fetch(`${base}/api/semantic/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'automatic-fallback' }),
    });
    assert.equal(invalid.status, 400, 'unknown modes must not silently select lexical indexing');

    const implicit = await fetch(`${base}/api/semantic/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(implicit.status, 400, 'the default remains hybrid and requires a configured embedding model');

    const started = await fetch(`${base}/api/semantic/build`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'lexical' }),
    });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { started: true, retrievalMode: 'lexical' });

    let status: { building: boolean; retrievalMode?: string; files: number; chunks: number; error?: string };
    const deadline = Date.now() + 10_000;
    do {
      const response = await fetch(`${base}/api/semantic`);
      assert.equal(response.status, 200);
      status = await response.json() as typeof status;
      if (status.building) await new Promise((resolve) => setTimeout(resolve, 20));
    } while (status.building && Date.now() < deadline);
    assert.equal(status.building, false);
    assert.equal(status.retrievalMode, 'lexical');
    assert.equal(status.files, 1);
    assert.equal(status.chunks, 1);
    assert.equal(status.error, undefined);

    const searchResponse = await fetch(`${base}/api/semantic/search`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'API_LEXICAL_SENTINEL', k: 3 }),
    });
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json() as { retrievalMode: string; results: Array<{ file: string; line: number; text: string; retrieval: string }> };
    assert.equal(search.retrievalMode, 'lexical');
    assert.equal(search.results.length, 1);
    assert.equal(path.basename(search.results[0]!.file), 'source.md');
    assert.equal(search.results[0]!.line, 1);
    assert.equal(search.results[0]!.retrieval, 'lexical');
    assert.match(search.results[0]!.text, /API_LEXICAL_SENTINEL/);
    assert.equal((await fs.readdir(path.join(dataDir, 'semantic'))).some((name) => name.startsWith('vectors.')), false);
  } finally {
    await app.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
