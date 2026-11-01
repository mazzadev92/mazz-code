import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ToolExecutionContext } from '@mazz/shared';
import { ProjectCodeIndexStore, ProjectCodeIndexTool } from './project-code-index.js';

test('code.index scales to 500+ multi-language files, tracks hashes, resolves imports and computes impact', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-scale-'));
  const workspace = path.join(temp, 'workspace');
  const data = path.join(temp, 'data');
  const outside = path.join(temp, 'outside');

  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'pkg'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'native'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });

  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  });

  // 1. Generate 505 real source files across TypeScript, Python, and C/C++
  // 450 TypeScript files
  const tsPromises: Array<Promise<void>> = [];
  tsPromises.push(
    fs.writeFile(
      path.join(workspace, 'src', 'comp_000.ts'),
      'export function rootCalculate(x: number): number {\n  return x * 10;\n}\n\nexport class RootEngine {\n  start(): boolean { return true; }\n}\n',
      'utf8',
    ),
  );
  tsPromises.push(
    fs.writeFile(
      path.join(workspace, 'src', 'comp_001.ts'),
      "import { rootCalculate } from './comp_000.js';\nexport function helper_001(): number {\n  return rootCalculate(1);\n}\n",
      'utf8',
    ),
  );
  tsPromises.push(
    fs.writeFile(
      path.join(workspace, 'src', 'comp_002.ts'),
      "import { helper_001 } from './comp_001.js';\nexport function helper_002(): number {\n  return helper_001() + 1;\n}\n",
      'utf8',
    ),
  );

  for (let i = 3; i < 450; i++) {
    const padded = String(i).padStart(3, '0');
    tsPromises.push(
      fs.writeFile(
        path.join(workspace, 'src', `comp_${padded}.ts`),
        `import { rootCalculate } from './comp_000.js';\nexport function helper_${padded}(): number {\n  return rootCalculate(${i});\n}\n`,
        'utf8',
      ),
    );
  }
  await Promise.all(tsPromises);

  // 40 Python files
  const pyPromises: Array<Promise<void>> = [];
  pyPromises.push(
    fs.writeFile(
      path.join(workspace, 'pkg', 'mod_000.py'),
      'def base_py_func():\n    return 100\n\nclass PyBaseClass:\n    pass\n',
      'utf8',
    ),
  );
  for (let j = 1; j < 40; j++) {
    const padded = String(j).padStart(3, '0');
    pyPromises.push(
      fs.writeFile(
        path.join(workspace, 'pkg', `mod_${padded}.py`),
        `from .mod_000 import base_py_func\n\ndef py_worker_${padded}():\n    return base_py_func()\n`,
        'utf8',
      ),
    );
  }
  await Promise.all(pyPromises);

  // 15 C/C++ files
  const nativePromises: Array<Promise<void>> = [];
  nativePromises.push(
    fs.writeFile(
      path.join(workspace, 'native', 'core.h'),
      '#ifndef CORE_H\n#define CORE_H\nint core_native_function(int a);\n#endif\n',
      'utf8',
    ),
  );
  nativePromises.push(
    fs.writeFile(
      path.join(workspace, 'native', 'core.c'),
      '#include "core.h"\nint core_native_function(int a) {\n  return a * 2;\n}\n',
      'utf8',
    ),
  );
  for (let k = 1; k <= 13; k++) {
    const padded = String(k).padStart(3, '0');
    nativePromises.push(
      fs.writeFile(
        path.join(workspace, 'native', `unit_${padded}.cpp`),
        `#include "core.h"\nint unit_${padded}_exec() {\n  return core_native_function(${k});\n}\n`,
        'utf8',
      ),
    );
  }
  await Promise.all(nativePromises);

  // Total source files: 450 + 40 + 15 = 505 files

  // Outside workspace test file and symlink
  await fs.writeFile(path.join(outside, 'escaped.ts'), 'export function escapedFunc() {}\n', 'utf8');
  await fs.symlink(outside, path.join(workspace, 'linked_outside'), 'junction').catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPERM' && err.code !== 'EACCES' && err.code !== 'ENOTSUP') throw err;
  });

  // Oversized file to verify error tracking
  const oversizedPath = path.join(workspace, 'src', 'oversized_file.ts');
  await fs.writeFile(oversizedPath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));

  const store = await ProjectCodeIndexStore.open(workspace, data);
  const tool = new ProjectCodeIndexTool((root) => ProjectCodeIndexStore.open(root, data));
  const context: ToolExecutionContext = {
    taskId: 'scale-test',
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    permissionLevel: 'read_only',
    emitEvent: () => undefined,
  };

  // 2. Initial update with oversized file
  const firstUpdate = await tool.execute({ action: 'update' }, context);
  assert.equal(firstUpdate.success, false, 'partial failure reported when a file exceeds size limit');
  const summary1 = firstUpdate.output as { scanned: number; parsed: number; unchanged: number; removed: number; errors: number };
  assert.ok(summary1.scanned >= 505, `expected at least 505 scanned files, got ${summary1.scanned}`);
  assert.equal(summary1.errors, 1, 'expected exactly 1 error file');
  assert.equal(summary1.parsed, summary1.scanned - 1);

  // Check status report
  const statusRes = await tool.execute({ action: 'status' }, context);
  assert.equal(statusRes.success, false, 'status is false when error files exist');
  const statusOutput = statusRes.output as { indexedFiles: number; symbols: number; errorFiles: Array<{ path: string; error: string }> };
  assert.equal(statusOutput.errorFiles.length, 1);
  assert.equal(statusOutput.errorFiles[0]?.path, 'src/oversized_file.ts');
  assert.ok(statusOutput.symbols > 500, `expected >500 symbols extracted, got ${statusOutput.symbols}`);

  // 3. Remove oversized file and update
  await fs.rm(oversizedPath);
  const secondUpdate = await tool.execute({ action: 'update' }, context);
  assert.equal(secondUpdate.success, true);
  const summary2 = secondUpdate.output as { scanned: number; parsed: number; unchanged: number; removed: number; errors: number };
  assert.equal(summary2.scanned, 505);
  assert.equal(summary2.parsed, 0, 'all existing files should be unchanged');
  assert.equal(summary2.unchanged, 505);
  assert.equal(summary2.removed, 1, 'oversized file should be marked removed');
  assert.equal(summary2.errors, 0);

  // 4. Exact symbol search and line numbers
  const searchRoot = await tool.execute({ action: 'search', query: 'rootCalculate' }, context);
  assert.equal(searchRoot.success, true);
  const rootMatches = (searchRoot.output as { matches: Array<{ path: string; symbols: Array<{ name: string; line?: number }> }> }).matches;
  assert.ok(rootMatches.length > 0);
  assert.equal(rootMatches[0]?.path, 'src/comp_000.ts');
  const foundSymbol = rootMatches[0]?.symbols.find((s) => s.name === 'rootCalculate');
  assert.ok(foundSymbol);
  assert.equal(foundSymbol.line, 1, 'symbol should have exact 1-based line number');

  // Python symbol search
  const searchPy = await tool.execute({ action: 'search', query: 'base_py_func' }, context);
  assert.equal(searchPy.success, true);
  const pyMatches = (searchPy.output as { matches: Array<{ path: string }> }).matches;
  assert.ok(pyMatches.length > 0);
  assert.equal(pyMatches[0]?.path, 'pkg/mod_000.py');

  // C/C++ symbol search
  const searchC = await tool.execute({ action: 'search', query: 'core_native_function' }, context);
  assert.equal(searchC.success, true);
  const cMatches = (searchC.output as { matches: Array<{ path: string }> }).matches;
  assert.ok(cMatches.some((m) => m.path === 'native/core.c'));

  // 5. Impact analysis: direct and transitive dependencies
  // C header impact: core.h should impact core.c and unit_001.cpp .. unit_013.cpp
  const headerImpact = await tool.execute({ action: 'impact', path: 'native/core.h' }, context);
  assert.equal(headerImpact.success, true);
  const headerImpactOutput = headerImpact.output as { direct: string[]; transitive: string[] };
  assert.ok(headerImpactOutput.direct.includes('native/core.c'));
  assert.ok(headerImpactOutput.direct.includes('native/unit_001.cpp'));
  assert.ok(headerImpactOutput.direct.includes('native/unit_013.cpp'));
  assert.equal(headerImpactOutput.direct.length, 14);

  // TypeScript impact: comp_001 impacts comp_002 directly
  const comp1Impact = await tool.execute({ action: 'impact', path: 'src/comp_001.ts' }, context);
  assert.equal(comp1Impact.success, true);
  const comp1ImpactOutput = comp1Impact.output as { direct: string[]; transitive: string[] };
  assert.deepEqual(comp1ImpactOutput.direct, ['src/comp_002.ts']);

  // TypeScript impact: comp_000 impacts comp_001 directly, and comp_002 transitively
  const comp0Impact = await tool.execute({ action: 'impact', path: 'src/comp_000.ts' }, context);
  assert.equal(comp0Impact.success, true);
  const comp0ImpactOutput = comp0Impact.output as { direct: string[]; transitive: string[] };
  assert.ok(comp0ImpactOutput.direct.includes('src/comp_001.ts'));
  assert.ok(comp0ImpactOutput.direct.includes('src/comp_003.ts'));
  assert.ok(comp0ImpactOutput.transitive.includes('src/comp_002.ts'));

  // 6. Content change with preserved mtime (SHA-256 detection)
  const comp0Path = path.join(workspace, 'src', 'comp_000.ts');
  const statBefore = await fs.stat(comp0Path);
  await fs.writeFile(
    comp0Path,
    'export function rootCalculateV2(x: number): number {\n  return x * 20;\n}\n',
    'utf8',
  );
  await fs.utimes(comp0Path, statBefore.atime, statBefore.mtime);

  const hashDetectUpdate = await tool.execute({ action: 'update' }, context);
  assert.equal(hashDetectUpdate.success, true);
  const summaryHash = hashDetectUpdate.output as { parsed: number; unchanged: number };
  assert.equal(summaryHash.parsed, 1, 'file with altered content must be reparsed despite identical mtime');
  assert.equal(summaryHash.unchanged, 504);

  const searchV2 = await tool.execute({ action: 'search', query: 'rootCalculateV2' }, context);
  assert.equal(searchV2.success, true);
  const v2Matches = (searchV2.output as { matches: Array<{ path: string }> }).matches;
  assert.equal(v2Matches[0]?.path, 'src/comp_000.ts');

  // 7. File deletion and index cleanup
  await fs.rm(path.join(workspace, 'src', 'comp_002.ts'));
  const delUpdate = await tool.execute({ action: 'update' }, context);
  assert.equal(delUpdate.success, true);
  const summaryDel = delUpdate.output as { removed: number; unchanged: number };
  assert.equal(summaryDel.removed, 1);
  assert.equal(summaryDel.unchanged, 504);

  const comp1ImpactAfterDel = await tool.execute({ action: 'impact', path: 'src/comp_001.ts' }, context);
  assert.equal(comp1ImpactAfterDel.success, true);
  assert.deepEqual((comp1ImpactAfterDel.output as { direct: string[] }).direct, []);

  // 8. Disk persistence: open fresh store instance
  const storeFresh = await ProjectCodeIndexStore.open(workspace, data);
  const freshSnapshot = await storeFresh.snapshot();
  assert.equal(Object.keys(freshSnapshot.files).length, 504);
  assert.equal(freshSnapshot.files['src/comp_002.ts'], undefined);

  const searchFresh = await storeFresh.search('unit_007_exec');
  assert.equal(searchFresh.matches.length, 1);
  assert.equal(searchFresh.matches[0]?.path, 'native/unit_007.cpp');

  // 9. Path traversal rejection
  const invalidImpact = await tool.execute({ action: 'impact', path: '../outside/escaped.ts' }, context);
  assert.equal(invalidImpact.success, false);
  assert.match(invalidImpact.error ?? '', /rester dans le workspace/);
});
