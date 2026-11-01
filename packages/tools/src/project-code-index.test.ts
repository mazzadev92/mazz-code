import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ToolExecutionContext } from '@mazz/shared';
import { defaultToolRegistry } from './registry.js';
import { ProjectCodeIndexStore, ProjectCodeIndexTool } from './project-code-index.js';

test('code.index parses real workspace files, updates by content hash, persists and computes reverse impact', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-index-'));
  const workspace = path.join(temp, 'workspace');
  const data = path.join(temp, 'app-data');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));

  const corePath = path.join(workspace, 'src', 'core.ts');
  const servicePath = path.join(workspace, 'src', 'service.ts');
  const consumerPath = path.join(workspace, 'src', 'consumer.ts');
  const oversizedPath = path.join(workspace, 'src', 'oversized.ts');
  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
  await fs.mkdir(path.join(workspace, 'ignored'));
  await fs.writeFile(path.join(workspace, 'ignored', 'hidden.ts'), 'export function hiddenSymbol() {}\n');
  await fs.writeFile(path.join(outside, 'outside.ts'), 'export function escapedSymbol() {}\n');
  await fs.writeFile(corePath, 'export function computeModel(input: string): string { return input.trim(); }\n', 'utf8');
  await fs.writeFile(servicePath, "import { computeModel } from './core.js';\nexport class TaskService { runTask() { return computeModel(' task '); } }\n", 'utf8');
  await fs.writeFile(consumerPath, "import { TaskService } from './service.js';\nexport function executeTask() { return new TaskService().runTask(); }\n", 'utf8');
  await fs.writeFile(oversizedPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
  await fs.symlink(outside, path.join(workspace, 'linked'), 'junction').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error;
  });

  assert.equal(defaultToolRegistry.has('code.index'), true, 'the default registry exposes the actual code.index tool');
  const store = await ProjectCodeIndexStore.open(workspace, data);
  const tool = new ProjectCodeIndexTool((root) => ProjectCodeIndexStore.open(root, data));
  const context: ToolExecutionContext = {
    taskId: 'test-code-index', workspaceRoot: workspace, signal: new AbortController().signal,
    permissionLevel: 'read_only', emitEvent: () => undefined,
  };
  const update = await tool.execute({ action: 'update' }, context);
  assert.equal(update.success, false, 'an update with a file-size error is reported as partial failure');
  assert.match(update.error ?? '', /fichier\(s\) en erreur/);
  const summary = update.output as { scanned: number; parsed: number; unchanged: number; removed: number; errors: number; updatedAt: string };
  assert.deepEqual({ scanned: summary.scanned, parsed: summary.parsed, unchanged: summary.unchanged, removed: summary.removed, errors: summary.errors }, { scanned: 4, parsed: 3, unchanged: 0, removed: 0, errors: 1 });
  assert.ok(Number.isFinite(Date.parse(summary.updatedAt)));

  const errored = await store.snapshot();
  assert.deepEqual(Object.keys(errored.files).sort(), ['src/consumer.ts', 'src/core.ts', 'src/oversized.ts', 'src/service.ts']);
  assert.equal(errored.files['src/oversized.ts'].status, 'error');
  assert.match(errored.files['src/oversized.ts'].error ?? '', /limite de/);
  assert.ok(Number.isFinite(Date.parse(errored.files['src/oversized.ts'].checkedAt)));
  const status = await tool.execute({ action: 'status' }, context);
  assert.equal(status.success, false, 'status exposes that at least one file is in error');
  assert.equal((status.output as { errorFiles: Array<{ path: string; error: string }> }).errorFiles[0]?.path, 'src/oversized.ts');

  await fs.rm(oversizedPath);
  const recovered = await tool.execute({ action: 'update' }, context);
  assert.equal(recovered.success, true, recovered.error ?? 'index update failed');
  const first = await store.snapshot();
  assert.deepEqual(Object.keys(first.files).sort(), ['src/consumer.ts', 'src/core.ts', 'src/service.ts']);
  assert.ok(first.files['src/core.ts'].symbols.some((symbol) => symbol.name === 'computeModel'));
  assert.ok(first.files['src/service.ts'].symbols.some((symbol) => symbol.name === 'TaskService'));
  assert.equal(first.files['src/service.ts'].imports[0]?.target, 'src/core.ts');
  assert.equal(first.files['src/consumer.ts'].imports[0]?.target, 'src/service.ts');

  const impact = await tool.execute({ action: 'impact', path: 'src/core.ts' }, context);
  assert.equal(impact.success, true, impact.error ?? 'impact query failed');
  assert.deepEqual((impact.output as { direct: string[]; transitive: string[] }).direct, ['src/service.ts']);
  assert.deepEqual((impact.output as { direct: string[]; transitive: string[] }).transitive, ['src/consumer.ts']);
  const search = await tool.execute({ action: 'search', query: 'executeTask' }, context);
  assert.equal(search.success, true, search.error ?? 'symbol search failed');
  assert.equal((search.output as { matches: Array<{ path: string }> }).matches[0]?.path, 'src/consumer.ts');

  let malformedQueryFactoryCalls = 0;
  const malformedQueryTool = new ProjectCodeIndexTool(async (root) => {
    malformedQueryFactoryCalls++;
    return ProjectCodeIndexStore.open(root, data);
  });
  const malformedSearch = await malformedQueryTool.execute({ action: 'search', query: '   ' }, context);
  assert.equal(malformedSearch.success, false);
  assert.equal(malformedQueryFactoryCalls, 0, 'a malformed search is rejected before opening or scanning an index');
  const invalidPathData = path.join(temp, 'invalid-impact-data');
  const invalidImpactTool = new ProjectCodeIndexTool((root) => ProjectCodeIndexStore.open(root, invalidPathData));
  const invalidImpact = await invalidImpactTool.execute({ action: 'impact', path: '../outside/outside.ts' }, context);
  assert.equal(invalidImpact.success, false);
  assert.match(invalidImpact.error ?? '', /rester dans le workspace/);
  await assert.rejects(fs.access(invalidPathData), { code: 'ENOENT' }, 'an invalid impact path is rejected before any index file is created');

  const old = await fs.stat(corePath);
  const oldDigest = first.files['src/core.ts'].sha256;
  await fs.writeFile(corePath, 'export function computePlan(input: string): string { return input.trim(); }\n', 'utf8');
  await fs.utimes(corePath, old.atime, old.mtime);
  const second = await ProjectCodeIndexStore.open(workspace, data);
  const changed = await second.update();
  assert.equal(changed.parsed, 1, 'the unchanged mtime does not hide changed file content');
  assert.equal(changed.unchanged, 2, 'unchanged source files are hashed but not reparsed');
  assert.equal(changed.errors, 0, 'the removed oversized file no longer contributes an error');
  assert.notEqual((await second.snapshot()).files['src/core.ts'].sha256, oldDigest);
  assert.ok((await second.snapshot()).files['src/core.ts'].symbols.some((symbol) => symbol.name === 'computePlan'));

  await fs.rm(servicePath);
  const afterDelete = await second.update();
  assert.equal(afterDelete.removed, 1);
  const final = await second.snapshot();
  assert.equal(final.files['src/service.ts'], undefined);
  assert.equal(final.files['src/consumer.ts'].imports[0]?.target, undefined, 'an import with a deleted target remains external/unresolved');
  assert.equal((await second.search('TaskService')).matches.length, 0);
});
