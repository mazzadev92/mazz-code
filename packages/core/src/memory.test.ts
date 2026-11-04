import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryReadTool, MemorySaveTool, MemorySearchTool, MemoryStore } from './memory.js';

test('Agent memory: save, index, search, read, update, delete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-mem-'));
  try {
    const m = new MemoryStore(dir);
    await assert.rejects(m.save('Bad Name', 'x', 'user', 'y'));
    await m.save('style-code', 'Préférences de style', 'feedback', 'Indentation 2 espaces, pas de point-virgule.');
    await m.save('llama-runtime', 'Runtime llama local', 'reference', 'D:/llama/build/llama-avx2');
    assert.match(await m.index(), /\[global\/feedback; v1; sha256:[a-f0-9]{12}\] style-code : Préférences de style/);
    const hits = await m.search('quel runtime llama');
    assert.equal(hits[0].name, 'llama-runtime');
    assert.match((await m.read('style-code')).content, /2 espaces/);
    await m.save('style-code', 'Préférences de style', 'feedback', 'Indentation 4 espaces.');
    assert.match((await m.read('style-code')).content, /4 espaces/);
    await m.remove('style-code');
    assert.deepEqual((await m.list()).map((e) => e.name), ['llama-runtime']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('memory keeps global and project domains isolated and traces exact content revisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-mem-scope-'));
  const projectA = path.join(dir, 'project-a');
  const projectB = path.join(dir, 'project-b');
  await fs.mkdir(projectA);
  await fs.mkdir(projectB);
  try {
    const global = new MemoryStore(path.join(dir, 'memory'));
    const scopedA = global.forProject(projectA);
    const scopedB = global.forProject(projectB);
    const longContent = `Début sentinelle mémoire\n${'donnée durable '.repeat(2500)}\nFin sentinelle mémoire`;

    await global.save('language-choice', 'Préférence commune', 'user', 'Répondre en français.');
    await scopedA.save('release-decision', 'Décision liée au projet', 'project', longContent, { origin: 'agent', taskId: 'task_123' });
    await scopedA.save('repair-procedure', 'Procédure de validation', 'procedural', 'Lancer les tests ciblés puis relire le fichier modifié.');

    const projectEntry = await scopedA.read('release-decision');
    assert.equal(projectEntry.content, longContent);
    assert.equal(projectEntry.entry.scope, 'project');
    assert.equal(projectEntry.entry.version, 1);
    assert.equal(projectEntry.entry.integrity, 'verified');
    assert.equal(projectEntry.entry.origin, 'agent');
    assert.equal(projectEntry.entry.sourceTaskId, 'task_123');
    assert.equal(projectEntry.entry.contentSha256.length, 64);
    assert.equal((await scopedB.list()).length, 0);
    assert.deepEqual((await global.list()).map((entry) => entry.name), ['language-choice']);
    assert.match(await global.indexForProject(projectA), /\[project\/project; v1; sha256:/);
    assert.match(await global.indexForProject(projectA), /\[project\/procedural;/);
    assert.match(await global.indexForProject(projectA), /\[global\/user;/);
    assert.equal((await global.searchForProject('sentinelle mémoire', projectA))[0]?.name, 'release-decision');

    await scopedA.save('release-decision', 'Décision mise à jour', 'project', 'Deuxième révision.');
    const revised = await scopedA.read('release-decision');
    assert.equal(revised.entry.version, 2);
    assert.equal(revised.content, 'Deuxième révision.');
    assert.match(await fs.readFile(path.join(scopedA.directory, '.history', 'release-decision', 'v1.md'), 'utf8'), /Fin sentinelle mémoire/);

    await fs.appendFile(path.join(scopedA.directory, 'release-decision.md'), '\nédition directe');
    const tampered = await scopedA.read('release-decision');
    assert.equal(tampered.entry.integrity, 'modified');
    assert.equal((await scopedA.search('édition directe')).length, 0);
    assert.doesNotMatch(await global.indexForProject(projectA), /release-decision/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('memory.save obeys the durable-memory opt-out and routes project domains by workspace', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-mem-tool-'));
  const project = path.join(dir, 'workspace');
  await fs.mkdir(project);
  try {
    const store = new MemoryStore(path.join(dir, 'memory'));
    let enabled = false;
    const tool = new MemorySaveTool(store, () => enabled);
    const searchTool = new MemorySearchTool(store, () => enabled);
    const readTool = new MemoryReadTool(store, () => enabled);
    const context = {
      taskId: 'task_memory_test',
      workspaceRoot: project,
      signal: new AbortController().signal,
      permissionLevel: 'ask_on_write' as const,
      emitEvent: () => undefined,
    };
    const refused = await tool.execute({ name: 'no-write', description: '', type: 'user', content: 'must not persist' }, context);
    assert.equal(refused.success, false);
    assert.equal((await searchTool.execute({ query: 'memory' }, context)).success, false);
    assert.equal((await readTool.execute({ name: 'no-write' }, context)).success, false);
    assert.deepEqual(await store.list(), []);

    enabled = true;
    const userFact = await tool.execute({ name: 'language', description: 'Préférence', type: 'user', content: 'Français' }, context);
    const projectFact = await tool.execute({ name: 'build-rule', description: 'Commande réelle', type: 'procedural', content: 'npm test' }, context);
    assert.equal(userFact.success, true);
    assert.equal(projectFact.success, true);
    assert.equal((await store.read('language')).entry.scope, 'global');
    assert.equal((await store.forProject(project).read('build-rule')).entry.scope, 'project');
    const invalid = await tool.execute({ name: 'bad-type', description: '', type: 'invented', content: 'not accepted' }, context);
    assert.equal(invalid.success, false);
    assert.deepEqual((await store.list()).map((entry) => entry.name), ['language']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
