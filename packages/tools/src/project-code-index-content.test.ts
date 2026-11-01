import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ToolExecutionContext } from '@mazz/shared';
import { ProjectCodeIndexStore, ProjectCodeIndexTool } from './project-code-index.js';

test('code.index searches real source contents at 505-file scale and returns hash-verified excerpts', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-content-'));
  const workspace = path.join(temp, 'workspace');
  const data = path.join(temp, 'index-data');
  const outside = path.join(temp, 'outside');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'ignored'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));

  await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored/\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'ignored', 'ignored.ts'), 'const hidden = "IGNORED_CONTENT_9A4F";\n', 'utf8');
  await fs.writeFile(path.join(outside, 'outside.ts'), 'const outside = "OUTSIDE_CONTENT_1B7C";\n', 'utf8');

  const sources = Array.from({ length: 505 }, (_, index) => {
    const padded = String(index).padStart(3, '0');
    const extra = index === 0
      ? '\nconst startSentinel = "START_CONTENT_5D2E";'
      : index === 252
        ? '\nconst crossDocument = "CROSS_DOCUMENT_7C1B";'
        : index === 504
          ? '\nconst endSentinel = "END_CONTENT_8A3F";'
          : '';
    return fs.writeFile(
      path.join(workspace, 'src', `file_${padded}.ts`),
      `export function item_${padded}(): string { return "source-${padded}"; }${extra}\n`,
      'utf8',
    );
  });
  await Promise.all(sources);
  await fs.symlink(outside, path.join(workspace, 'outside-link'), 'junction').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPERM' && error.code !== 'EACCES' && error.code !== 'ENOTSUP') throw error;
  });

  const tool = new ProjectCodeIndexTool((root) => ProjectCodeIndexStore.open(root, data));
  const context: ToolExecutionContext = {
    taskId: 'content-index-test',
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    permissionLevel: 'read_only',
    emitEvent: () => undefined,
  };

  const searchStart = await tool.execute({ action: 'search', query: 'START_CONTENT_5D2E' }, context);
  assert.equal(searchStart.success, true, searchStart.error ?? 'literal search failed');
  const startOutput = searchStart.output as {
    contentMatches: Array<{ path: string; line: number; column: number; excerpt: string; sha256: string; bytes: number }>;
    matches: Array<{ path: string }>;
    update: { scanned: number; parsed: number; errors: number };
  };
  assert.equal(startOutput.update.scanned, 505, 'the update traverses 505 actual source files');
  assert.equal(startOutput.update.parsed, 505);
  assert.equal(startOutput.update.errors, 0);
  assert.deepEqual(startOutput.contentMatches.map((match) => match.path), ['src/file_000.ts']);
  const firstMatch = startOutput.contentMatches[0]!;
  assert.equal(firstMatch.line, 2);
  assert.equal(firstMatch.column, 24);
  assert.match(firstMatch.excerpt, /START_CONTENT_5D2E/);
  assert.match(firstMatch.sha256, /^[a-f0-9]{64}$/);
  assert.ok(firstMatch.bytes > 0);

  const middle = await tool.execute({ action: 'search', query: 'CROSS_DOCUMENT_7C1B' }, context);
  assert.equal(middle.success, true, middle.error ?? 'middle literal search failed');
  const middleMatches = (middle.output as { contentMatches: Array<{ path: string; line: number; sha256: string }> }).contentMatches;
  assert.equal(middleMatches.length, 1);
  assert.equal(middleMatches[0]?.path, 'src/file_252.ts');
  assert.equal(middleMatches[0]?.line, 2);
  const middleDisk = await fs.readFile(path.join(workspace, middleMatches[0]!.path));
  assert.equal((await import('node:crypto')).createHash('sha256').update(middleDisk).digest('hex'), middleMatches[0]?.sha256);

  const end = await tool.execute({ action: 'search', query: 'END_CONTENT_8A3F' }, context);
  assert.equal(end.success, true, end.error ?? 'end literal search failed');
  const endMatches = (end.output as { contentMatches: Array<{ path: string; line: number; excerpt: string }> }).contentMatches;
  assert.equal(endMatches[0]?.path, 'src/file_504.ts');
  assert.equal(endMatches[0]?.line, 2);
  assert.match(endMatches[0]?.excerpt ?? '', /END_CONTENT_8A3F/);

  const ignored = await tool.execute({ action: 'search', query: 'IGNORED_CONTENT_9A4F' }, context);
  assert.equal(ignored.success, true, ignored.error ?? 'ignored-path check failed');
  assert.deepEqual((ignored.output as { contentMatches: unknown[] }).contentMatches, [], '.gitignore paths are absent from the current index and literal search');
  const outsideResult = await tool.execute({ action: 'search', query: 'OUTSIDE_CONTENT_1B7C' }, context);
  assert.equal(outsideResult.success, true, outsideResult.error ?? 'workspace-boundary check failed');
  assert.deepEqual((outsideResult.output as { contentMatches: unknown[] }).contentMatches, [], 'symlink targets outside the workspace are not searched');

  const changedPath = path.join(workspace, 'src', 'file_252.ts');
  const originalStat = await fs.stat(changedPath);
  await fs.writeFile(changedPath, 'export function item_252(): string { return "UPDATED_CONTENT_44AF"; }\n', 'utf8');
  await fs.utimes(changedPath, originalStat.atime, originalStat.mtime);
  const changed = await tool.execute({ action: 'search', query: 'UPDATED_CONTENT_44AF' }, context);
  assert.equal(changed.success, true, changed.error ?? 'modified source search failed');
  const changedMatches = (changed.output as { contentMatches: Array<{ path: string; sha256: string }> }).contentMatches;
  assert.equal(changedMatches[0]?.path, 'src/file_252.ts');
  const changedIndex = await (await ProjectCodeIndexStore.open(workspace, data)).snapshot();
  assert.equal(changedMatches[0]?.sha256, changedIndex.files['src/file_252.ts']?.sha256);
  const oldValue = await tool.execute({ action: 'search', query: 'CROSS_DOCUMENT_7C1B' }, context);
  assert.equal(oldValue.success, true, oldValue.error ?? 'removed content search failed');
  assert.deepEqual((oldValue.output as { contentMatches: unknown[] }).contentMatches, [], 'changed content is not served from a stale persisted body');

  await fs.rm(path.join(workspace, 'src', 'file_504.ts'));
  const deleted = await tool.execute({ action: 'search', query: 'END_CONTENT_8A3F' }, context);
  assert.equal(deleted.success, true, deleted.error ?? 'deleted content search failed');
  const deletedOutput = deleted.output as { contentMatches: unknown[]; update: { removed: number } };
  assert.deepEqual(deletedOutput.contentMatches, []);
  assert.equal(deletedOutput.update.removed, 1, 'deleted files are removed before content search');

  const persisted = await (await ProjectCodeIndexStore.open(workspace, data)).snapshot();
  assert.equal(Object.keys(persisted.files).length, 504);
  const serializedIndex = await fs.readFile((await ProjectCodeIndexStore.open(workspace, data)).indexPath, 'utf8');
  assert.equal(serializedIndex.includes('return "source-000"'), false, 'the full source line is not copied into persisted symbol metadata');
  assert.equal(serializedIndex.includes('CROSS_DOCUMENT_7C1B'), false, 'the removed source body is not persisted into the metadata index');
  assert.equal(serializedIndex.includes('START_CONTENT_5D2E'), false, 'literal source bodies are read at search time rather than copied into JSON');
});
