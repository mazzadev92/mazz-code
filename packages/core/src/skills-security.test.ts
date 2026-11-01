import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { SkillStore } from './skills.js';

test('skill references reject lexical traversal and physical symlink escapes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-skill-path-security-'));
  const studio = path.join(root, 'skills');
  const outside = path.join(root, 'outside');
  const skill = path.join(studio, 'review-code');
  await fs.mkdir(skill, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));

  await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: review-code\ndescription: Review source\n---\n\nRead-only review instructions.\n', 'utf8');
  await fs.writeFile(path.join(skill, 'reference.md'), 'In-skill reference.\n', 'utf8');
  await fs.writeFile(path.join(outside, 'private.txt'), 'MUST_NOT_LEAK_FROM_SKILL_ROOT', 'utf8');
  await fs.symlink(outside, path.join(skill, 'external'), process.platform === 'win32' ? 'junction' : 'dir');

  const store = new SkillStore(studio, () => ({ folders: [], includeClaude: false }));
  await store.scan();
  assert.equal(await store.readFile('review-code', 'reference.md'), 'In-skill reference.\n');
  await assert.rejects(store.readFile('review-code', '../../outside/private.txt'), /Chemin hors du dossier du skill/u);
  await assert.rejects(store.readFile('review-code', 'external/private.txt'), /résout hors du dossier du skill/u);
  assert.equal((await store.load('review-code')).body, 'Read-only review instructions.');
});
