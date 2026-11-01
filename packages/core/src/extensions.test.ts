import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExtensionStore } from './extensions.js';

test('Slash commands and custom agents in .mazz and .claude formats', async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-ext-data-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-ext-proj-'));
  try {
    await fs.mkdir(path.join(proj, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(path.join(proj, '.claude', 'commands', 'fix-issue.md'), '---\ndescription: Corrige un ticket\n---\nCorrige le ticket $ARGUMENTS puis lance les tests.', 'utf-8');
    await fs.mkdir(path.join(data, 'commands'), { recursive: true });
    await fs.writeFile(path.join(data, 'commands', 'resume.md'), 'Résume le projet.', 'utf-8');
    await fs.mkdir(path.join(proj, '.mazz', 'agents'), { recursive: true });
    await fs.writeFile(path.join(proj, '.mazz', 'agents', 'doc.md'), '---\nname: doc-writer\ndescription: Écrit la documentation\ntools: Read, Grep, Write\n---\nTu écris une documentation claire.', 'utf-8');
    const ext = new ExtensionStore(data);
    assert.deepEqual((await ext.commands(proj)).map((c) => c.name).sort(), ['fix-issue', 'resume']);
    assert.deepEqual(await ext.expand(proj, '/fix-issue 42'), { name: 'fix-issue', prompt: 'Corrige le ticket 42 puis lance les tests.' });
    assert.deepEqual(await ext.expand(proj, '/resume en 3 points'), { name: 'resume', prompt: 'Résume le projet.\n\nen 3 points' });
    assert.equal(await ext.expand(proj, '/inconnue'), undefined);
    const [agent] = await ext.agents(proj);
    assert.equal(agent.name, 'doc-writer');
    assert.deepEqual(agent.tools, ['fs.read', 'code.search', 'fs.write']);
    assert.match(agent.instructions, /documentation claire/);
  } finally {
    await fs.rm(data, { recursive: true, force: true });
    await fs.rm(proj, { recursive: true, force: true });
  }
});
