import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJson, writeJsonAtomic } from './storage.js';
import { SettingsStore } from './settings.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('atomic JSON revisions retain the previous complete document as a physical backup', async () => {
  const root = await tempDir('mazz-json-backup-');
  try {
    const file = path.join(root, 'state.json');
    const previous = { revision: 1, facts: ['début', 'milieu', 'fin'] };
    const current = { revision: 2, facts: ['persisté'] };
    await writeJsonAtomic(file, previous);
    await writeJsonAtomic(file, current);

    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), current);
    assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), previous);
    const newest = { revision: 3, facts: ['révision la plus récente'] };
    await writeJsonAtomic(file, newest);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), newest);
    assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), current);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('corrupt primary JSON is restored from the last valid backup without losing corrupt bytes', async () => {
  const root = await tempDir('mazz-json-recovery-');
  try {
    const file = path.join(root, 'state.json');
    const backupRevision = { revision: 6, value: 'état antérieur' };
    const latestRevision = { revision: 7, value: 'dernier état complet 𝐀' };
    await writeJsonAtomic(file, backupRevision);
    await writeJsonAtomic(file, latestRevision);
    const damagedBytes = '{"revision":7,"value":"écriture interrompue';
    await fs.writeFile(file, damagedBytes, 'utf8');

    assert.deepEqual(await readJson(file, { revision: 0 }), backupRevision);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), backupRevision);
    const damagedCopies = (await fs.readdir(root)).filter((name) => name.startsWith('state.json.') && name.endsWith('.corrupt'));
    assert.equal(damagedCopies.length, 1);
    assert.equal(await fs.readFile(path.join(root, damagedCopies[0]!), 'utf8'), damagedBytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('malformed persisted JSON without a known-good backup is reported instead of hidden as empty data', async () => {
  const root = await tempDir('mazz-json-no-backup-');
  try {
    const file = path.join(root, 'state.json');
    await fs.writeFile(file, '{invalid}', 'utf8');
    await assert.rejects(readJson(file, []), SyntaxError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a staged orphan from a terminated write cannot hide or replace the prior complete JSON revision', async () => {
  const root = await tempDir('mazz-json-crash-state-');
  try {
    const file = path.join(root, 'state.json');
    const complete = { revision: 4, body: 'complete durable revision' };
    await writeJsonAtomic(file, complete);
    // This is a real on-disk partial staging artifact, as left by process
    // termination before the atomic rename boundary.
    await fs.writeFile(`${file}.terminated-write.tmp`, '{"revision":5', 'utf8');
    assert.deepEqual(await readJson(file, null), complete);
    assert.equal(await fs.readFile(`${file}.terminated-write.tmp`, 'utf8'), '{"revision":5');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy v0 settings migrate to v1 with values retained and the original document backed up', async () => {
  const root = await tempDir('mazz-settings-migration-');
  try {
    const file = path.join(root, 'settings.json');
    const legacy = {
      appearance: { theme: 'blueprint', mode: 'dark', density: 'compact', uiScale: 115, motion: 'reduced', highContrast: true, codeFontSize: 16 },
      projects: { lastOpened: 'D:\\workspace', recent: [{ path: 'D:\\workspace', name: 'workspace', openedAt: 123 }] },
      customProviders: [{ id: 'local-openai', name: 'Local OpenAI API', baseUrl: 'http://127.0.0.1:8080/v1', locality: 'local', defaultModel: 'local-model' }],
      models: { library: ['D:\\Models\\local.gguf'], scanFolders: ['D:\\Models'] },
    };
    const legacyBytes = JSON.stringify(legacy, null, 2);
    await fs.writeFile(file, legacyBytes, 'utf8');

    const store = new SettingsStore(root);
    const loaded = await store.load();
    assert.equal(loaded.version, 1);
    assert.equal(loaded.appearance.theme, 'blueprint');
    assert.equal(loaded.appearance.uiScale, 115);
    assert.equal(loaded.projects.lastOpened, 'D:\\workspace');
    assert.deepEqual(loaded.projects.recent, legacy.projects.recent);
    assert.deepEqual(loaded.customProviders, legacy.customProviders);
    assert.deepEqual(loaded.models.library, legacy.models.library);
    assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), legacyBytes, 'migration must retain every original on-disk byte in the backup');

    const migratedBytes = await fs.readFile(file, 'utf8');
    const restarted = new SettingsStore(root);
    assert.deepEqual(await restarted.load(), loaded);
    assert.equal(await fs.readFile(file, 'utf8'), migratedBytes);
    assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), legacyBytes, 'a restart must not rewrite the legacy backup');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy settings with a muce section load, drop the key and keep its folder as runtimeDir', async () => {
  const root = await tempDir('mazz-settings-legacy-muce-');
  try {
    const file = path.join(root, 'settings.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, muce: { home: 'x' }, models: { llamaServerPath: '' } }), 'utf8');
    const loaded = await new SettingsStore(root).load();
    assert.ok(!('muce' in loaded));
    assert.equal(loaded.models.runtimeDir, 'x');
    await fs.writeFile(file, JSON.stringify({ version: 1, muce: { home: 'x' }, models: { llamaServerPath: 'llama-server.exe' } }), 'utf8');
    assert.equal((await new SettingsStore(root).load()).models.runtimeDir, '');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('settings from a future schema are refused without rewriting or discarding the source document', async () => {
  const root = await tempDir('mazz-settings-future-schema-');
  try {
    const file = path.join(root, 'settings.json');
    const future = { version: 999, appearance: { theme: 'future-theme', userData: 'keep intact' } };
    const source = JSON.stringify(future, null, 2);
    await fs.writeFile(file, source, 'utf8');
    await assert.rejects(new SettingsStore(root).load(), /plus récente que celle prise en charge/);
    assert.equal(await fs.readFile(file, 'utf8'), source);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
