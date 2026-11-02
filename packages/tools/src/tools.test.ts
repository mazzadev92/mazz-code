import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import { syntaxGate } from './syntax-gate.js';
import {
  rankByReferences,
  FsWriteTool,
  FsReadTool,
  FsListTool,
  TerminalRunTool,
  boundedTerminalTimeout,
  TERMINAL_CAPTURE_BYTES_PER_STREAM,
  TERMINAL_MAX_TIMEOUT_MS,
  CompilerGccTool,
  detectToolchains,
  runBoundedCompilerProcess,
  CheckpointManager,
  childEnv,
  coerceToolArgs,
  validateToolArgs,
} from './index.js';
import type { AgentEvent, ToolExecutionContext } from '@mazz/shared';

test('GCC process runner bounds captured output', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-compiler-output-'));
  try {
    const result = await runBoundedCompilerProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000))"],
      tempDir,
      5_000,
      1_024,
    );
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.length, 1_024);
    assert.equal(result.stdoutTruncated, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('GCC process runner kills a timed-out process tree', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-compiler-timeout-'));
  try {
    const result = await runBoundedCompilerProcess(
      process.execPath,
      ['-e', "process.stdout.write('x'.repeat(20000)); setTimeout(() => {}, 5000)"],
      tempDir,
      100,
      1_024,
    );
    assert.equal(result.timedOut, true);
    assert.equal(result.stdout.length, 1_024);
    assert.equal(result.stdoutTruncated, true);
    assert.ok(result.durationMs < 5_000, `Timed-out child remained alive for ${result.durationMs} ms`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('End-to-End Tools: C file write -> GCC compile -> Run EXE -> Verify -> Rollback', async () => {
  // 1. Create a isolated temp workspace directory
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-test-workspace-'));
  const events: AgentEvent[] = [];

  const context: ToolExecutionContext = {
    taskId: 'test-task-1',
    workspaceRoot: tempDir,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: (ev) => events.push(ev),
  };

  try {
    // 2. Checkpoint before creation
    const checkpointMgr = new CheckpointManager();
    const chk = await checkpointMgr.createCheckpoint(
      tempDir,
      'chk-initial',
      'Initial state before C file creation',
      ['main.c', 'hello.exe']
    );
    assert.equal(chk.files['main.c'], null); // did not exist

    // 3. Write C code
    const cSource = `#include <stdio.h>

int main() {
    printf("MAZZ AENGENIUM ENGINE VERIFIED\\n");
    return 0;
}
`;
    const writeTool = new FsWriteTool();
    const writeRes = await writeTool.execute({ path: 'main.c', content: cSource }, context);
    assert.equal(writeRes.success, true);

    // 4. Read back and verify
    const readTool = new FsReadTool();
    const readRes = await readTool.execute({ path: 'main.c' }, context);
    assert.equal(readRes.success, true);
    assert.ok((readRes.output as any).content.includes('MAZZ AENGENIUM ENGINE VERIFIED'));

    // 5. Detect toolchains
    const toolchains = detectToolchains();
    const gccToolchain = toolchains.find((t) => t.name === 'gcc' && t.isAvailable);
    assert.ok(gccToolchain, 'GCC must be available on the test machine');

    // 6. Compile C code to hello.exe
    const compileTool = new CompilerGccTool();
    const compileRes = await compileTool.execute(
      { sourceFiles: ['main.c'], outputExe: 'hello.exe' },
      context
    );
    assert.equal(compileRes.success, true, `GCC failed: ${compileRes.error}`);
    assert.ok((compileRes.output as any).outputSizeBytes > 0);

    // 7. Run the compiled executable via TerminalRunTool
    const terminalTool = new TerminalRunTool();
    const runRes = await terminalTool.execute({ command: '.\\hello.exe' }, context);
    assert.equal(runRes.success, true, `Execution failed: ${runRes.error}`);
    assert.ok((runRes.output as any).stdout.includes('MAZZ AENGENIUM ENGINE VERIFIED'));

    // 8. Test Rollback
    const rollbackRes = await checkpointMgr.rollback(tempDir, 'chk-initial');
    assert.equal(rollbackRes.success, true);

    // Verify main.c was deleted by rollback
    let mainExists = true;
    try {
      await fs.stat(path.join(tempDir, 'main.c'));
    } catch {
      mainExists = false;
    }
    assert.equal(mainExists, false, 'main.c should be deleted by rollback');

  } finally {
    // Cleanup temp dir
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test('GCC construit une DLL chargeable depuis Python ctypes', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-gcc-ctypes-'));
  const context: ToolExecutionContext = {
    taskId: 'gcc-ctypes',
    workspaceRoot,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: () => undefined,
  };
  try {
    await fs.writeFile(path.join(workspaceRoot, 'fixture.c'), [
      '#include <stdint.h>',
      '#ifdef _WIN32',
      '__declspec(dllexport)',
      '#endif',
      'uint32_t mazz_add(uint32_t left, uint32_t right) { return left + right; }',
    ].join('\n'), 'utf8');

    const compiled = await new CompilerGccTool().execute({
      sourceFiles: ['fixture.c'], outputExe: 'bin/fixture.dll', kind: 'shared_library',
    }, context);
    assert.equal(compiled.success, true, `GCC failed: ${compiled.error}`);
    assert.equal((compiled.output as { binaryKind?: string }).binaryKind, 'shared_library');
    assert.ok((compiled.output as { outputSizeBytes?: number }).outputSizeBytes! > 0);

    const loaded = await new TerminalRunTool().execute({
      command: `python -c "import ctypes; print(ctypes.CDLL(r'bin/fixture.dll').mazz_add(40, 2))"`,
    }, context);
    assert.equal(loaded.success, true, `ctypes failed: ${loaded.error}`);
    assert.match((loaded.output as { stdout?: string }).stdout ?? '', /42/u);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('fs.read resolves a redundant workspace-name prefix to the real workspace file', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-read-root-'));
  const sentinel = `FS_READ_${randomUUID()}`;
  await fs.writeFile(path.join(workspaceRoot, 'brief.txt'), `SENTINEL=${sentinel}\n`, 'utf8');
  const context: ToolExecutionContext = {
    taskId: 'fs-read-root-prefix',
    workspaceRoot,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: () => undefined,
  };

  try {
    const result = await new FsReadTool().execute({ path: `${path.basename(workspaceRoot)}/brief.txt` }, context);
    assert.equal(result.success, true, result.error ?? 'fs.read failed');
    assert.deepEqual(result.output, {
      path: 'brief.txt',
      content: `SENTINEL=${sentinel}\n`,
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      totalBytes: Buffer.byteLength(`SENTINEL=${sentinel}\n`, 'utf8'),
    });
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('fs.read returns a line range with offset/limit and says where the rest starts', async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-read-range-'));
  const body = Array.from({ length: 100 }, (_, i) => `ligne ${i + 1}`).join('\n');
  await fs.writeFile(path.join(workspaceRoot, 'long.txt'), body, 'utf8');
  const context: ToolExecutionContext = {
    taskId: 'fs-read-range',
    workspaceRoot,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: () => undefined,
  };
  try {
    const result = await new FsReadTool().execute({ path: 'long.txt', offset: 51, limit: 40 }, context);
    const out = result.output as { content: string; startLine: number; endLine: number; totalLines: number; note: string };
    assert.equal(out.startLine, 51);
    assert.equal(out.endLine, 90);
    assert.equal(out.totalLines, 100);
    assert.equal(out.content.split('\n')[0], 'ligne 51');
    assert.equal(out.content.split('\n').length, 40);
    assert.match(out.note, /offset=91/);
    // A one-line limit is widened so a small model still sees the code around it.
    const tiny = await new FsReadTool().execute({ path: 'long.txt', offset: 10, limit: 1 }, context);
    assert.equal((tiny.output as { endLine: number }).endLine, 49);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test('Tool calls: strict argument validation with corrective messages', async () => {
  const { validateToolArgs, normalizeToolPaths, defaultToolRegistry } = await import('./index.js');
  const write = defaultToolRegistry.get('fs.write')!.definition.parameters;
  assert.deepEqual(validateToolArgs(write, { path: 'a.c', content: 'x' }), []);
  const missing = validateToolArgs(write, { path: 'a.c' });
  assert.match(missing[0], /"content" est requis/);
  assert.match(validateToolArgs(write, { path: 3, content: 'x' })[0], /chaîne/);
  assert.match(validateToolArgs(write, { path: 'a', content: 'x', mode: 'w' })[0], /Paramètre inconnu "mode"/);
  assert.match(validateToolArgs(write, { raw: '{bad' })[0], /JSON invalide/);
  const term = defaultToolRegistry.get('terminal.run')!.definition.parameters;
  assert.match(validateToolArgs(term, { command: 'dir', shell: 'bash' })[0], /"powershell" ou "cmd"/);

  const root = os.tmpdir();
  const fixed = normalizeToolPaths({ path: path.join(root, 'sub', 'x.c'), sourceFiles: [path.join(root, 'y.c'), 'z.c'] }, root);
  assert.equal(fixed.path, 'sub/x.c');
  assert.deepEqual(fixed.sourceFiles, ['y.c', 'z.c']);
  const outside = normalizeToolPaths({ path: 'C:\Windows\win.ini' }, root);
  assert.equal(outside.path, 'C:\Windows\win.ini');

  // An invalid call is refused before any approval prompt or side effect.
  let asked = false;
  const r = await defaultToolRegistry.executeTool('fs.write', { path: 'a.c' }, { taskId: 't', workspaceRoot: root, signal: new AbortController().signal, permissionLevel: 'ask_on_write', emitEvent: () => undefined, requestApproval: async () => ((asked = true), true) });
  assert.equal(r.success, false);
  assert.equal(asked, false);
});

test('fs.patch validates nested edits before path access and requires an approval handler', async () => {
  const { defaultToolRegistry, validateToolArgs } = await import('./index.js');
  const patchSchema = defaultToolRegistry.get('fs.patch')!.definition.parameters;
  assert.deepEqual(validateToolArgs(patchSchema, { path: 'src/a.ts', edits: [{ search: 'before', replace: 'after' }] }), []);
  assert.match(validateToolArgs(patchSchema, { path: 'src/a.ts', edits: [{ search: 'before' }] }).join(' '), /edits\[0\]\.replace.*requis/);
  assert.match(validateToolArgs(patchSchema, { path: 'src/a.ts', edits: [{ search: 'before', replace: 4 }] }).join(' '), /edits\[0\]\.replace.*chaîne/);
  assert.match(validateToolArgs(patchSchema, { path: 'src/a.ts', edits: [{ search: 'before', replace: 'after', typo: true }] }).join(' '), /Paramètre inconnu.*typo/);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-patch-validation-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-patch-outside-'));
  const file = path.join(outside, 'secret.txt');
  await fs.writeFile(file, 'DO_NOT_CHANGE\n', 'utf8');
  let pathAsked = false;
  let approvalAsked = false;
  try {
    const invalid = await defaultToolRegistry.executeTool('fs.patch', {
      path: file,
      edits: [{ search: 'DO_NOT_CHANGE', replace: 'CHANGED', extra: 'bad' }],
    }, {
      taskId: 'invalid-patch-before-access', workspaceRoot: workspace,
      signal: new AbortController().signal, permissionLevel: 'ask_on_write',
      emitEvent: () => undefined,
      requestPathAccess: async () => ((pathAsked = true), true),
      requestApproval: async () => ((approvalAsked = true), true),
    });
    assert.equal(invalid.success, false);
    assert.match(invalid.error ?? '', /typo|extra|Paramètre inconnu/);
    assert.equal(pathAsked, false);
    assert.equal(approvalAsked, false);
    assert.equal(await fs.readFile(file, 'utf8'), 'DO_NOT_CHANGE\n');

    await fs.writeFile(path.join(workspace, 'target.txt'), 'OLD\n', 'utf8');
    const noApprovalHandler = await defaultToolRegistry.executeTool('fs.patch', {
      path: 'target.txt', edits: [{ search: 'OLD', replace: 'NEW' }],
    }, {
      taskId: 'patch-without-ui-approval-handler', workspaceRoot: workspace,
      signal: new AbortController().signal, permissionLevel: 'ask_on_write', emitEvent: () => undefined,
    });
    assert.equal(noApprovalHandler.success, false);
    assert.match(noApprovalHandler.error ?? '', /aucun gestionnaire d’autorisation/);
    assert.equal(await fs.readFile(path.join(workspace, 'target.txt'), 'utf8'), 'OLD\n');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('fs.patch fallback preserves unrelated bytes and verifies the physical file after approval', async () => {
  const { defaultToolRegistry } = await import('./index.js');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-patch-preserve-'));
  const original = 'const first = 1;   \r\nconst target = 2;\t\r\nconst last = 3;  \r\n';
  const expected = 'const first = 1;   \r\nconst target = 20;\t\r\nconst last = 3;  \r\n';
  const file = path.join(workspace, 'target.ts');
  const events: AgentEvent[] = [];
  let approvalRequests = 0;
  const context: ToolExecutionContext = {
    taskId: 'fs-patch-normalized-preserves-bytes',
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    permissionLevel: 'ask_on_write',
    emitEvent: (event) => events.push(event),
    requestApproval: async () => (approvalRequests++, true),
  };

  try {
    await fs.writeFile(file, original, 'utf8');
    await new FsReadTool().execute({ path: 'target.ts' }, context);
    const patched = await defaultToolRegistry.executeTool('fs.patch', {
      path: 'target.ts',
      edits: [{ search: 'const target = 2;', replace: 'const target = 20;' }],
    }, context);
    assert.equal(patched.success, true, patched.error ?? 'fs.patch failed');
    assert.ok(approvalRequests > 0, 'the real write must pass through approval');
    assert.equal(await fs.readFile(file, 'utf8'), expected, 'unrelated trailing spaces and CRLF must remain byte-for-byte intact');

    const reread = await new FsReadTool().execute({ path: 'target.ts' }, context);
    assert.equal(reread.success, true, reread.error ?? 'fs.read failed');
    assert.equal((reread.output as { content: string }).content, expected);
    const diffs = events.filter((event) => event.type === 'diff');
    assert.equal(diffs.length, 1);
    assert.equal((diffs[0] as any).oldContent, original);
    assert.equal((diffs[0] as any).newContent, expected);

    const ambiguousOriginal = 'let repeated = 1;  \r\nlet repeated = 1;\t\r\n';
    await fs.writeFile(file, ambiguousOriginal, 'utf8');
    await new FsReadTool().execute({ path: 'target.ts' }, context);
    const ambiguous = await defaultToolRegistry.executeTool('fs.patch', {
      path: 'target.ts',
      edits: [{ search: 'let repeated = 1;\n', replace: 'let repeated = 2;\n' }],
    }, context);
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.error ?? '', /trouvé 2 fois après normalisation/);
    assert.equal(await fs.readFile(file, 'utf8'), ambiguousOriginal, 'ambiguous normalized matches must not alter the file');
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('syntaxGate_brokenPythonWrite_isRefused_butBrokenFileStaysEditable', async () => {
  // Arrange
  const file = path.join(os.tmpdir(), `gate-${randomUUID()}.py`);
  // Act
  const refused = await syntaxGate(file, 'def f(:\n    return 1\n', 'def f():\n    return 1\n');
  const fixOfBroken = await syntaxGate(file, 'def f(:\n', 'x = (\n');
  const valid = await syntaxGate(file, 'def f():\n    return 2\n', 'def f():\n    return 1\n');
  const notChecked = await syntaxGate(file.replace(/\.py$/, '.txt'), '((((', null);
  // Assert
  assert.match(refused ?? '', /Écriture refusée.*ligne 1/);
  assert.equal(fixOfBroken, undefined, 'an already broken file can still be rewritten');
  assert.equal(valid, undefined);
  assert.equal(notChecked, undefined);
  assert.match((await syntaxGate('x.json', '{"a": }', null)) ?? '', /JSON invalide/);
});

test('Code tools: ripgrep search, ast-grep outline and map, block patch', async () => {
  const { defaultToolRegistry, applyEdits } = await import('./index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-'));
  const ctx = { taskId: 't', workspaceRoot: dir, signal: new AbortController().signal, permissionLevel: 'trusted_workspace' as const, emitEvent: () => undefined };
  try {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.mkdir(path.join(dir, 'node_modules'));
    await fs.writeFile(path.join(dir, 'src', 'calc.c'), 'struct Acc { int v; };\nint add(int a, int b) {\n  return a + b; /* TODO */\n}\nstatic void reset(struct Acc *a) { a->v = 0; }\n');
    await fs.writeFile(path.join(dir, 'src', 'tool.py'), 'class Parser:\n    def run(self):\n        return 1\n\ndef main():\n    pass\n');
    await fs.writeFile(path.join(dir, 'src', 'app.ts'), 'export function start(port: number) {}\nexport const stop = () => 0;\nclass Server { listen() {} }\n');
    await fs.writeFile(path.join(dir, 'node_modules', 'x.c'), 'int TODO_hidden;');

    const search = await defaultToolRegistry.executeTool('code.search', { query: 'TODO' }, ctx);
    assert.equal(search.success, true, search.error ?? '');
    const s = search.output as { matches: string[]; engine: string };
    assert.equal(s.matches.length, 1, JSON.stringify(s));
    assert.match(s.matches[0], /^src\/calc\.c:3:/);

    const outline = await defaultToolRegistry.executeTool('code.outline', { path: 'src/calc.c' }, ctx);
    const names = (outline.output as { symbols: Array<{ name: string; line: number }> }).symbols.map((x) => `${x.name}@${x.line}`);
    assert.deepEqual(names, ['Acc@1', 'add@2', 'reset@5']);
    const py = await defaultToolRegistry.executeTool('code.outline', { path: 'src/tool.py' }, ctx);
    assert.deepEqual((py.output as any).symbols.map((x: any) => (x.parent ? `${x.parent}.${x.name}` : x.name)), ['Parser', 'Parser.run', 'main']);
    const ts = await defaultToolRegistry.executeTool('code.outline', { path: 'src/app.ts' }, ctx);
    assert.deepEqual((ts.output as any).symbols.map((x: any) => x.name), ['start', 'stop', 'Server', 'listen']);

    const map = await defaultToolRegistry.executeTool('code.map', { focus: 'parser python' }, ctx);
    const m = map.output as { text: string; files: number };
    assert.equal(m.files, 3);
    assert.ok(m.text.startsWith('src/tool.py'), m.text);

    // Without a focus, the file whose symbols the others use comes first (reference graph + PageRank).
    const ids = (src: string) => new Map([...src.matchAll(/[A-Za-z_]\w{2,}/g)].map((x) => [x[0], 1]));
    const ranked = rankByReferences([
      { rel: 'b.c', score: 0, names: ['use_b'], idents: ids('void use_b(void) { core_fn(); }') },
      { rel: 'a.c', score: 0, names: ['core_fn'], idents: ids('int core_fn(void) { return 1; }') },
      { rel: 'c.c', score: 0, names: ['use_c'], idents: ids('void use_c(void) { core_fn(); core_fn(); }') },
    ]);
    assert.equal([...ranked].sort((x, y) => y[1] - x[1])[0][0], 'a.c');

    await defaultToolRegistry.executeTool('fs.read', { path: 'src/calc.c' }, ctx);
    const patched = await defaultToolRegistry.executeTool('fs.patch', { path: 'src/calc.c', edits: [{ search: 'return a + b;', replace: 'return a + b + 0;' }] }, ctx);
    assert.equal(patched.success, true, patched.error ?? '');
    assert.match(await fs.readFile(path.join(dir, 'src', 'calc.c'), 'utf-8'), /a \+ b \+ 0;/);
    const missing = await defaultToolRegistry.executeTool('fs.patch', { path: 'src/calc.c', edits: [{ search: 'int add(int a, int b) {\n  return 42;', replace: 'x' }] }, ctx);
    assert.match(missing.error!, /introuvable.*La première ligne/s);
    assert.throws(() => applyEdits('a\na\n', [{ search: 'a', replace: 'b' }]), /trouvé 2 fois/);
    assert.equal(applyEdits('x  \r\ny\r\n', [{ search: 'x\ny', replace: 'z' }]).content, 'z\r\n');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('Path access: outside folder asked once then allowed for the run; protected folders always refused', async () => {
  const { ToolRegistry, FsReadTool: Read } = await import('./index.js');
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-acc-ws-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-acc-out-'));
  const secret = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-acc-secret-'));
  try {
    await fs.writeFile(path.join(outside, 'a.txt'), 'dehors', 'utf-8');
    await fs.writeFile(path.join(outside, 'b.txt'), 'encore', 'utf-8');
    await fs.writeFile(path.join(secret, 'key'), 'x', 'utf-8');
    const reg = new ToolRegistry();
    reg.register(new Read());
    const asked: string[] = [];
    let answer = false;
    const ctx: ToolExecutionContext = {
      taskId: 't',
      workspaceRoot: ws,
      signal: new AbortController().signal,
      permissionLevel: 'trusted_workspace',
      emitEvent: () => undefined,
      allowedRoots: [],
      deniedRoots: [secret],
      requestPathAccess: async (p) => (asked.push(p), answer),
    };
    const refused = await reg.executeTool('fs.read', { path: path.join(outside, 'a.txt') }, ctx);
    assert.equal(refused.success, false);
    assert.equal(asked.length, 1);
    answer = true;
    const ok = await reg.executeTool('fs.read', { path: path.join(outside, 'a.txt') }, ctx);
    assert.ok(ok.success, String(ok.error));
    // Same folder: already granted for the run, no second request.
    const again = await reg.executeTool('fs.read', { path: path.join(outside, 'b.txt') }, ctx);
    assert.equal(again.success, true);
    assert.equal(asked.length, 2);
    const blocked = await reg.executeTool('fs.read', { path: path.join(secret, 'key') }, { ...ctx, allowedRoots: [path.parse(secret).root] });
    assert.equal(blocked.success, false);
    assert.match(blocked.error ?? '', /protégé/);
    assert.equal(asked.length, 2);
  } finally {
    for (const d of [ws, outside, secret]) await fs.rm(d, { recursive: true, force: true });
  }
});

test('fs.search_text stays inside its workspace and skips files beyond its read budget', async () => {
  const { FsSearchTextTool, FS_SEARCH_MAX_FILE_BYTES } = await import('./index.js');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-search-bounds-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-search-outside-'));
  const link = path.join(workspace, 'outside-link');
  const context: ToolExecutionContext = {
    taskId: 'fs-search-resource-bound',
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: () => undefined,
  };
  try {
    await fs.writeFile(path.join(workspace, 'small.txt'), 'SAFE_HIT\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'oversized.txt'), Buffer.concat([
      Buffer.alloc(FS_SEARCH_MAX_FILE_BYTES, 0x78),
      Buffer.from('HIT', 'utf8'),
    ]));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'HIT\n', 'utf8');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await new FsSearchTextTool().execute({ query: 'HIT', maxResults: 100000 }, context);
    assert.equal(result.success, true, result.error ?? 'fs.search_text failed');
    const output = result.output as {
      matches: Array<{ file: string }>;
      truncated: boolean;
      limitReasons: string[];
      scannedFiles: number;
      skippedLargeFiles: number;
    };
    assert.deepEqual(output.matches.map((match) => match.file), ['small.txt']);
    assert.equal(output.truncated, true);
    assert.ok(output.limitReasons.includes('file_size_limit'));
    assert.equal(output.scannedFiles, 1);
    assert.equal(output.skippedLargeFiles, 1);

    const emptyQuery = await new FsSearchTextTool().execute({ query: '   ' }, context);
    assert.equal(emptyQuery.success, false);
    assert.match(emptyQuery.error ?? '', /vide/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('Background jobs: start, incremental read, stop with the process tree', async () => {
  const { TerminalStartTool, TerminalReadTool, TerminalStopTool, backgroundJobs } = await import('./index.js');
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-jobs-'));
  const ctx: ToolExecutionContext = { taskId: 't', workspaceRoot: ws, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  let childPid: number | undefined;
  let jobPid: number | undefined;
  let jobId: string | undefined;
  try {
    const childPidPath = path.join(ws, 'child-pid.txt').replace(/'/g, "''");
    const childCommand = `Set-Content -LiteralPath '${childPidPath}' -Value $PID; Start-Sleep -Seconds 30`;
    const encodedChildCommand = Buffer.from(childCommand, 'utf16le').toString('base64');
    const command = `Write-Output debut; Start-Process powershell.exe -ArgumentList '-NoProfile','-EncodedCommand','${encodedChildCommand}' -NoNewWindow -Wait; Write-Output fin`;
    const started = await new TerminalStartTool().execute({ command, shell: 'powershell' }, ctx);
    assert.ok(started.success, String(started.error));
    const out = started.output as { id: string; running: boolean; output: string; next: number };
    jobId = out.id;
    assert.equal(out.running, true);
    assert.match(out.output, /debut/);
    jobPid = backgroundJobs.get(out.id)?.proc?.pid;
    const childPidFile = path.join(ws, 'child-pid.txt');
    const childPidDeadline = Date.now() + 10000;
    let childPidText: string | undefined;
    while (Date.now() < childPidDeadline) {
      try {
        childPidText = await fs.readFile(childPidFile, 'utf8');
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (!backgroundJobs.get(out.id)?.proc) {
          throw new Error(`Background child did not record its PID before the shell exited; output: ${backgroundJobs.read(out.id).text}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(childPidText, `background child did not record its real process id within 10 seconds; output: ${backgroundJobs.read(out.id).text}`);
    childPid = Number(childPidText);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, 'background child did not record its real process id');
    const again = (await new TerminalReadTool().execute({ id: out.id, since: out.next }, ctx)).output as { output: string };
    assert.ok(!again.output.includes('debut'));
    const stopped = await new TerminalStopTool().execute({ id: out.id }, ctx);
    assert.equal(stopped.success, true, stopped.error ?? 'terminal.stop failed');
    assert.equal(backgroundJobs.get(out.id)?.proc, undefined);
    assert.ok(!backgroundJobs.read(out.id).text.includes('fin'));
    let childAlive = true;
    try { process.kill(childPid, 0); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') childAlive = false;
      else throw err;
    }
    assert.equal(childAlive, false, `terminal.stop left child process ${childPid} running`);
    await fs.rm(ws, { recursive: true });
    await assert.rejects(fs.access(ws), { code: 'ENOENT' });
  } finally {
    if (jobId) {
      try { await backgroundJobs.stopAndWait(jobId, 5000); } catch { /* Continue with the test-owned PID fallback below. */ }
    }
    const ownedPids = [...new Set([childPid, jobPid].filter((pid): pid is number => Number.isSafeInteger(pid) && (pid ?? 0) > 0))];
    for (const pid of ownedPids) {
      try { process.kill(pid, 'SIGKILL'); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
    const cleanupDeadline = Date.now() + 5000;
    while (ownedPids.some((pid) => {
      try { process.kill(pid, 0); return true; } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
        throw err;
      }
    })) {
      if (Date.now() >= cleanupDeadline) throw new Error(`Test cleanup could not stop its own process ids: ${ownedPids.join(', ')}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('terminal.run enforces hard time and UTF-8 output bounds while draining real process output', async () => {
  assert.equal(boundedTerminalTimeout(1), 1);
  assert.equal(boundedTerminalTimeout(0), 30000);
  assert.equal(boundedTerminalTimeout(Number.POSITIVE_INFINITY), 30000);
  assert.equal(boundedTerminalTimeout(TERMINAL_MAX_TIMEOUT_MS * 100), TERMINAL_MAX_TIMEOUT_MS);

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-terminal-bounded-'));
  const context: ToolExecutionContext = {
    taskId: 'terminal-output-bound',
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    permissionLevel: 'trusted_workspace',
    emitEvent: () => undefined,
  };
  try {
    const result = await new TerminalRunTool().execute({
      command: "[Console]::Out.Write(('é' * 300000) -join '')",
      timeoutMs: 10 * 60 * 1000,
      shell: 'powershell',
    }, context);
    assert.equal(result.success, true, result.error ?? 'PowerShell output command failed');
    const output = result.output as {
      stdout: string;
      stderr: string;
      stdoutBytesObserved: number;
      stderrBytesObserved: number;
      stdoutBytesCaptured: number;
      stderrBytesCaptured: number;
      outputTruncated: boolean;
    };
    assert.equal(output.stdoutBytesCaptured, TERMINAL_CAPTURE_BYTES_PER_STREAM);
    assert.equal(Buffer.byteLength(output.stdout, 'utf8'), TERMINAL_CAPTURE_BYTES_PER_STREAM);
    assert.ok(output.stdoutBytesObserved > output.stdoutBytesCaptured);
    assert.equal(output.stderrBytesCaptured, 0);
    assert.equal(output.outputTruncated, true);
    assert.ok(!output.stdout.includes('\uFFFD'), 'the output cap must not split a UTF-8 code point');
    assert.ok(output.stdout.endsWith('é'));

    const lateWrite = path.join(workspace, 'descendant-survived-timeout.txt');
    const childPidFile = path.join(workspace, 'descendant.pid');
    const childScript = `[IO.File]::WriteAllText('${childPidFile.replace(/'/g, "''")}', [string]$PID); Start-Sleep -Seconds 5; [IO.File]::WriteAllText('${lateWrite.replace(/'/g, "''")}', 'SURVIVED')`;
    const encodedChildScript = Buffer.from(childScript, 'utf16le').toString('base64');
    let childPid: number | undefined;
    try {
      const timedOut = await new TerminalRunTool().execute({
        command: `$child = Start-Process powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand','${encodedChildScript}') -NoNewWindow -PassThru; Write-Output ('CHILD_PID=' + $child.Id); Wait-Process -Id $child.Id`,
        timeoutMs: 1500,
        shell: 'powershell',
      }, context);
      assert.equal(timedOut.success, false);
      assert.equal((timedOut.output as { timeout: boolean }).timeout, true);
      const pidMatch = (timedOut.output as { stdout?: string }).stdout?.match(/CHILD_PID=(\d+)/u);
      assert.ok(pidMatch, 'the timed command must report the descendant PID before timeout');
      childPid = Number(pidMatch[1]);
      assert.throws(() => process.kill(childPid!, 0), 'timeout must terminate the command descendant tree');
      await new Promise((resolve) => setTimeout(resolve, 5500));
      await assert.rejects(fs.lstat(lateWrite), { code: 'ENOENT' }, 'a killed descendant must not write after the timeout');
    } finally {
      // Prevent a broken tree-kill implementation from leaking this fixture
      // when the assertion intentionally detects a surviving child.
      if (childPid) {
        try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('ToolRegistry pairs tool_start and tool_result by callId, including a refused approval', async () => {
  const { ToolRegistry } = await import('./index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-callid-'));
  try {
    const reg = new ToolRegistry();
    const run = async (permissionLevel: ToolExecutionContext['permissionLevel'], approve: boolean, file: string) => {
      const events: AgentEvent[] = [];
      const r = await reg.executeTool('fs.write', { path: file, content: 'x' }, {
        taskId: 't', workspaceRoot: dir, signal: new AbortController().signal, permissionLevel,
        emitEvent: (e) => events.push(e), requestApproval: async () => approve,
      });
      const start = events.find((e) => e.type === 'tool_start');
      const result = events.find((e) => e.type === 'tool_result');
      assert.ok(start?.type === 'tool_start' && result?.type === 'tool_result', JSON.stringify(events));
      assert.ok(start.callId, 'callId is set');
      assert.equal(result.callId, start.callId);
      return { r, result };
    };
    const ok = await run('trusted_workspace', true, 'a.txt');
    assert.equal(ok.r.success, true);
    assert.equal(ok.result.type === 'tool_result' && ok.result.success, true);
    const refused = await run('ask_on_write', false, 'b.txt');
    assert.equal(refused.r.success, false);
    assert.equal(refused.result.type === 'tool_result' && refused.result.success, false);
    await assert.rejects(fs.access(path.join(dir, 'b.txt')), 'a refused write writes nothing');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('coerceToolArgs repairs lossless type slips and leaves ambiguous values to validation', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      limit: { type: 'integer' as const },
      ratio: { type: 'number' as const },
      force: { type: 'boolean' as const },
      name: { type: 'string' as const },
      files: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  assert.deepEqual(coerceToolArgs(schema, { limit: '100', ratio: '0.5', force: 'true', name: 7, files: 'a.py' }), {
    limit: 100, ratio: 0.5, force: true, name: '7', files: ['a.py'],
  });
  assert.deepEqual(coerceToolArgs(schema, { limit: 'cent' }), { limit: 'cent' });
  assert.deepEqual(validateToolArgs(schema, coerceToolArgs(schema, { limit: '12' })), []);
});

test('childEnv drops secret-looking variables but keeps the toolchain', () => {
  const env = childEnv({ PATH: 'C:/bin', HF_TOKEN: 'x', GROQ_API_KEY: 'y', PYTHONPATH: 'p', MY_SECRET: 'z', PWD: '/w' });
  assert.deepEqual(env, { PATH: 'C:/bin', PYTHONPATH: 'p', PWD: '/w' });
});

test('workspaceTools_globDiffLogAndTestRun_workOnARealRepository', async () => {
  // Arrange: a small git repository with one committed file, one change and a pytest suite.
  const { FsGlobTool, GitDiffTool, GitLogTool, TestRunTool, detectTestRunner } = await import('./workspace-tools.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-wstools-'));
  const { spawnSync } = await import('node:child_process');
  const sh = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const context: ToolExecutionContext = { taskId: 'ws', workspaceRoot: root, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  try {
    await fs.mkdir(path.join(root, 'tests'));
    await fs.writeFile(path.join(root, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    await fs.writeFile(path.join(root, 'tests', 'test_calc.py'), 'import sys, os\nsys.path.insert(0, os.getcwd())\nfrom calc import add\n\ndef test_add():\n    assert add(2, 2) == 4\n');
    sh('init', '-q'); sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'); sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await fs.writeFile(path.join(root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
    // Act
    const glob = await new FsGlobTool().execute({ pattern: '**/*.py' }, context);
    const diff = await new GitDiffTool().execute({}, context);
    const log = await new GitLogTool().execute({ limit: 5 }, context);
    const tests = await new TestRunTool().execute({}, context);
    // Assert
    assert.deepEqual([...(glob.output as { files: string[] }).files].sort(), ['calc.py', 'tests/test_calc.py']);
    assert.match((diff.output as { diff: string }).diff, /-    return a \+ b\n\+    return a - b/);
    assert.equal((log.output as { commits: Array<{ message: string }> }).commits[0].message, 'init');
    assert.equal(detectTestRunner(root)?.id, 'pytest');
    assert.equal(tests.success, false, 'the broken add() must fail its test');
    assert.ok((tests.output as { failures: string[] }).failures.length > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('editGuard_unreadOrStaleFile_isRefused_newFileAndReadFileAreWrittenAtomically', async () => {
  // Arrange
  const { defaultToolRegistry } = await import('./index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-guard-'));
  const ctx = { taskId: `guard-${randomUUID()}`, workspaceRoot: dir, signal: new AbortController().signal, permissionLevel: 'trusted_workspace' as const, emitEvent: () => undefined };
  const file = path.join(dir, 'bom.txt');
  try {
    await fs.writeFile(file, '\uFEFFalpha\n', 'utf8');
    // Act
    const unreadPatch = await defaultToolRegistry.executeTool('fs.patch', { path: 'bom.txt', edits: [{ search: 'alpha', replace: 'beta' }] }, ctx);
    const unreadWrite = await defaultToolRegistry.executeTool('fs.write', { path: 'bom.txt', content: 'gamma\n' }, ctx);
    await defaultToolRegistry.executeTool('fs.read', { path: 'bom.txt' }, ctx);
    const written = await defaultToolRegistry.executeTool('fs.write', { path: 'bom.txt', content: 'gamma\n' }, ctx);
    const patchAfterOwnWrite = await defaultToolRegistry.executeTool('fs.patch', { path: 'bom.txt', edits: [{ search: 'gamma', replace: 'delta' }] }, ctx);
    const afterPatch = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'changed outside, longer\n', 'utf8');
    const stale = await defaultToolRegistry.executeTool('fs.patch', { path: 'bom.txt', edits: [{ search: 'changed', replace: 'x' }] }, ctx);
    const created = await defaultToolRegistry.executeTool('fs.write', { path: 'new/created.txt', content: 'fresh\n' }, ctx);
    // Assert
    assert.equal(unreadPatch.success, false);
    assert.match(unreadPatch.error ?? '', /File has not been read yet/);
    assert.match(unreadWrite.error ?? '', /File has not been read yet/);
    assert.equal(written.success, true, written.error ?? '');
    assert.equal(patchAfterOwnWrite.success, true, patchAfterOwnWrite.error ?? '');
    assert.equal(afterPatch, '\uFEFFdelta\n', 'the BOM of the original file survives fs.write and fs.patch');
    assert.equal(stale.success, false);
    assert.match(stale.error ?? '', /modifié sur le disque depuis ta dernière lecture/);
    assert.equal(created.success, true, created.error ?? '');
    assert.equal(await fs.readFile(path.join(dir, 'new', 'created.txt'), 'utf8'), 'fresh\n');
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.mazztmp')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('editGuard_writeAtomic_keepsBom_andLeavesNoTempFileOnFailure', async () => {
  // Arrange
  const { writeAtomic } = await import('./edit-guard.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-atomic-'));
  const file = path.join(dir, 'a.txt');
  try {
    const planted = path.join(dir, 'a.txt.mazztmp');
    await fs.writeFile(planted, 'planted', 'utf8');
    // Act
    const kept = await writeAtomic(file, 'new\n', '\uFEFFold\n');
    const plantedAfter = await fs.readFile(planted, 'utf8');
    await fs.rm(planted);
    const failure = await writeAtomic(path.join(dir, 'missing-dir', 'b.txt'), 'x', null).then(() => null, (error: Error) => error);
    // Assert
    assert.equal(plantedAfter, 'planted', 'a file planted at a predictable temp path is never written through');
    assert.equal(kept, '\uFEFFnew\n');
    assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFnew\n');
    assert.ok(failure instanceof Error);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['a.txt']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('defaultDeny_shellDeletionsKillsAndSecretFiles_areRefusedWhateverThePermissionLevel', async () => {
  // Arrange
  const { defaultToolRegistry, commandVerbs } = await import('./index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-deny-'));
  const ctx = { taskId: `deny-${randomUUID()}`, workspaceRoot: dir, signal: new AbortController().signal, permissionLevel: 'trusted_workspace' as const, emitEvent: () => undefined };
  try {
    await fs.writeFile(path.join(dir, '.env'), 'TOKEN=secret', 'utf8');
    await fs.writeFile(path.join(dir, '.env.example'), 'TOKEN=', 'utf8');
    // Act
    const rm = await defaultToolRegistry.executeTool('terminal.run', { command: 'echo ok && rm -rf src' }, ctx);
    const wrapped = await defaultToolRegistry.executeTool('terminal.run', { command: 'cmd /c del /q build\*' }, ctx);
    const kill = await defaultToolRegistry.executeTool('terminal.run', { command: 'taskkill /F /IM node.exe' }, ctx);
    const env = await defaultToolRegistry.executeTool('fs.read', { path: '.env' }, ctx);
    const key = await defaultToolRegistry.executeTool('fs.write', { path: 'certs/server.key', content: 'x' }, ctx);
    const example = await defaultToolRegistry.executeTool('fs.read', { path: '.env.example' }, ctx);
    // Assert
    for (const refused of [rm, wrapped, kill]) assert.match(refused.error ?? '', /Commande refusée par défaut/);
    assert.match(env.error ?? '', /contient des secrets/);
    assert.match(key.error ?? '', /contient des secrets/);
    assert.equal(example.success, true, example.error ?? '');
    assert.ok(['git', 'findstr', 'remove-item'].every((v) => commandVerbs('git status | findstr M; powershell -NoProfile Remove-Item x').includes(v)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('applyEdits_replayedInsertionOrReplacement_isNoOp_withoutDuplication', async () => {
  // Arrange
  const { applyEdits } = await import('./index.js');
  const source = 'import a from "a";\nconst x = 1;\n';
  const insertion = [{ search: 'import a from "a";\n', replace: 'import a from "a";\nimport b from "b";\n' }];
  const replacement = [{ search: 'const x = 1;', replace: 'const x = 2; // updated' }];
  // Act
  const once = applyEdits(source, [...insertion, ...replacement]);
  const twice = applyEdits(once.content, [...insertion, ...replacement]);
  // Assert
  assert.equal(once.applied, 2);
  assert.equal(twice.content, once.content);
  assert.equal(twice.alreadyApplied, 2);
  assert.equal(twice.content.split('import b from "b";').length - 1, 1);
  assert.throws(() => applyEdits(source, [{ search: 'absent', replace: 'x' }]), /introuvable/);
});

test('defaultDeny_wrapperFlagsSubshellsAndWindowsNameTricks_areStillRefused', async () => {
  // Arrange
  const { defaultDenyReason, isSecretFile } = await import('./index.js');
  const commands = [
    'powershell -ExecutionPolicy Bypass Remove-Item -Recurse src',
    'echo $(rm -rf src)',
    'ls | xargs rm',
    'git clean -fdx',
    'find . -name "*.ts" -delete',
    'kill -9 1234',
    'type .env',
  ];
  // Act
  const refused = commands.map((command) => defaultDenyReason('terminal.run', { command }));
  // Assert
  refused.forEach((reason, i) => assert.ok(reason, `not refused: ${commands[i]}`));
  assert.equal(defaultDenyReason('terminal.run', { command: 'npm run build && git status' }), undefined);
  assert.equal(isSecretFile('.env. '), true);
  assert.equal(isSecretFile('server.KEY:stream'), true);
  assert.equal(isSecretFile('.env.example'), false);
});

test('secretFiles_searchGlobAndIndex_neverReturnTheirContent', async () => {
  // Arrange: the same marker sits in a source file and in every kind of secret file.
  const { FsSearchTextTool, CodeSearchTool, FsGlobTool, ProjectCodeIndexTool, ProjectCodeIndexStore } = await import('./index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-secret-search-'));
  const workspace = path.join(root, 'ws');
  const marker = 'SECRET_MARKER_7Q2Z';
  const context: ToolExecutionContext = { taskId: 'secret', workspaceRoot: workspace, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  try {
    await fs.mkdir(path.join(workspace, 'conf'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'app.ts'), `export const name = "${marker}";\n`);
    for (const secret of ['.env', '.env.local', 'conf/server.key', 'conf/cert.pem']) await fs.writeFile(path.join(workspace, secret), `TOKEN=${marker}-leak\n`);
    await fs.writeFile(path.join(workspace, '.env.example'), `TOKEN=${marker}-example\n`);
    // Act
    const text = await new FsSearchTextTool().execute({ query: marker }, context);
    const code = await new CodeSearchTool().execute({ query: marker }, context);
    const glob = await new FsGlobTool().execute({ pattern: '**/*' }, context);
    const index = await new ProjectCodeIndexTool((ws) => ProjectCodeIndexStore.open(ws, path.join(root, 'index'))).execute({ action: 'search', query: marker }, context);
    // Assert
    for (const result of [text, code, glob, index]) {
      assert.equal(result.success, true, result.error ?? "échec");
      assert.doesNotMatch(JSON.stringify(result.output), /-leak/);
    }
    assert.match(JSON.stringify(text.output), /app\.ts/);
    assert.match(JSON.stringify(code.output), /app\.ts/);
    assert.doesNotMatch(JSON.stringify(code.output), /server\.key|cert\.pem/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('secretFiles_symlinkWithInnocentName_neverLeaksThroughSearchOrIndex', async (t) => {
  // Arrange: notes.txt and alias.ts are file links to .env (file links may need privileges on Windows).
  const { fallbackSearch, CodeSearchTool, FsSearchTextTool, ProjectCodeIndexTool, ProjectCodeIndexStore } = await import('./index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-secret-link-'));
  const workspace = path.join(root, 'ws');
  const context: ToolExecutionContext = { taskId: 'link', workspaceRoot: workspace, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  try {
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, '.env'), 'TOKEN=LINKED_SECRET_4K8P\n');
    await fs.writeFile(path.join(workspace, 'app.ts'), 'export const marker = "LINKED_SECRET_4K8P";\n');
    try {
      await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'notes.txt'), 'file');
      await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'alias.ts'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('file symlinks need privileges here'); return; }
      throw error;
    }
    // Act
    const fallback = await fallbackSearch(workspace, '.', 'LINKED_SECRET_4K8P', false, 50);
    const code = await new CodeSearchTool().execute({ query: 'LINKED_SECRET_4K8P' }, context);
    const text = await new FsSearchTextTool().execute({ query: 'LINKED_SECRET_4K8P' }, context);
    const index = await new ProjectCodeIndexTool((ws) => ProjectCodeIndexStore.open(ws, path.join(root, 'index'))).execute({ action: 'search', query: 'LINKED_SECRET_4K8P' }, context);
    // Assert: only the source file matches, never the link to .env.
    assert.deepEqual(fallback, ['app.ts:1:export const marker = "LINKED_SECRET_4K8P";']);
    for (const result of [code, text, index]) {
      assert.equal(result.success, true, result.error ?? 'échec');
      assert.doesNotMatch(JSON.stringify(result.output), /TOKEN=|notes\.txt|alias\.ts/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('toolHooks_preExit2BlocksWithStderr_postExit2ReportsAndTimeoutBlocks', async () => {
  // Arrange: a hook that records its stdin and refuses fs.write; a post hook that complains; a hook that hangs.
  const { ToolRegistry } = await import('./index.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-hooks-'));
  const node = `"${process.execPath}"`;
  try {
    await fs.writeFile(path.join(dir, 'pre.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      "let s = ''; process.stdin.on('data', (c) => { s += c; }).on('end', () => {",
      "  const p = JSON.parse(s); writeFileSync(process.argv[2], JSON.stringify({ ...p, hookCwd: process.cwd(), noCwdExe: process.env.NoDefaultCurrentDirectoryInExePath ?? null }));",
      "  if (p.tool_name === 'fs.write') { process.stderr.write('écriture interdite par la politique'); process.exit(2); }",
      "});",
    ].join('\n'));
    await fs.writeFile(path.join(dir, 'post.mjs'), "process.stdin.resume().on('end', () => { process.stderr.write('sortie non conforme'); process.exit(2); });");
    await fs.writeFile(path.join(dir, 'hang.mjs'), 'setTimeout(() => undefined, 60000);');
    await fs.writeFile(path.join(dir, 'a.txt'), 'bonjour');
    const reg = new ToolRegistry();
    const context = (hooks: ToolExecutionContext['hooks']): ToolExecutionContext => ({ taskId: 'hk', workspaceRoot: dir, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined, hooks });
    const seen = path.join(dir, 'seen.json');
    const script = (name: string) => `"${path.join(dir, name)}"`;
    const pre = { preToolUse: [`${node} ${script('pre.mjs')} "${seen}"`] };
    // Act
    const write = await reg.executeTool('fs.write', { path: 'b.txt', content: 'x' }, context(pre));
    const read = await reg.executeTool('fs.read', { path: 'a.txt' }, context(pre));
    const payload = JSON.parse(await fs.readFile(seen, 'utf8'));
    const post = await reg.executeTool('fs.read', { path: 'a.txt' }, context({ postToolUse: [`${node} ${script('post.mjs')}`] }));
    const hang = await reg.executeTool('fs.read', { path: 'a.txt' }, context({ preToolUse: [`${node} ${script('hang.mjs')}`], timeoutMs: 300 }));
    // Assert
    assert.equal(write.success, false);
    assert.match(write.error ?? '', /PreToolUse : écriture interdite par la politique/);
    await assert.rejects(fs.access(path.join(dir, 'b.txt')), 'a blocked write writes nothing');
    assert.equal(read.success, true, read.error ?? 'échec');
    assert.equal(payload.hook_event_name, 'PreToolUse');
    assert.equal(payload.tool_name, 'fs.read');
    assert.match(String(payload.tool_input.path), /a\.txt$/);
    assert.equal(payload.workspace_root, dir, 'the project root travels in the payload');
    assert.notEqual(path.resolve(payload.hookCwd).toLowerCase(), path.resolve(dir).toLowerCase(), 'a hook never starts in the untrusted workspace');
    if (process.platform === 'win32') assert.equal(payload.noCwdExe, '1');
    assert.equal(post.success, false);
    assert.match(post.error ?? '', /PostToolUse : sortie non conforme/);
    assert.ok(post.output, 'the tool output is kept after a PostToolUse report');
    assert.equal(hang.success, false);
    assert.match(hang.error ?? '', /sans réponse après 300 ms/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('codeSearch_subdirectoryWithSecrets_returnsNoSecretLine', async () => {
  // Arrange
  const { CodeSearchTool } = await import('./index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-secret-subdir-'));
  const context: ToolExecutionContext = { taskId: 'sub', workspaceRoot: root, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  try {
    await fs.mkdir(path.join(root, 'config'));
    for (const name of ['.env', '.env.prod', 'api.key', 'tls.pem']) await fs.writeFile(path.join(root, 'config', name), 'SUBDIR_MARKER_3J9=leak\n');
    await fs.writeFile(path.join(root, 'config', 'settings.ts'), 'const k = "SUBDIR_MARKER_3J9";\n');
    // Act
    const result = await new CodeSearchTool().execute({ query: 'SUBDIR_MARKER_3J9', path: 'config' }, context);
    // Assert
    assert.equal(result.success, true, result.error ?? 'échec');
    const matches = (result.output as { matches: string[] }).matches;
    assert.deepEqual(matches.map((m) => m.split(':')[0]), ['config/settings.ts']);
    assert.doesNotMatch(JSON.stringify(matches), /leak/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('resolveSafePath_windowsPathOver260_getsLongPathPrefixAndStaysUsable', async () => {
  // Arrange: a project path well beyond MAX_PATH.
  const { resolveSafePath, withLongPathPrefix, FsWriteTool, FsReadTool } = await import('./index.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-longpath-'));
  const deep = path.join(...Array.from({ length: 12 }, (_, i) => `segment_${i}_${'x'.repeat(20)}`), 'fichier.txt');
  const context: ToolExecutionContext = { taskId: 'long', workspaceRoot: root, signal: new AbortController().signal, permissionLevel: 'trusted_workspace', emitEvent: () => undefined };
  try {
    // Act
    const resolved = resolveSafePath(root, deep);
    const written = await new FsWriteTool().execute({ path: deep, content: 'profond' }, context);
    const read = await new FsReadTool().execute({ path: deep }, context);
    // Assert
    assert.ok(path.join(root, deep).length > 260);
    if (process.platform === 'win32') assert.ok(resolved.startsWith('\\\\?\\'), resolved);
    assert.equal(withLongPathPrefix('C:\\court.txt', 'win32'), 'C:\\court.txt');
    assert.equal(withLongPathPrefix(`C:\\${'a'.repeat(300)}`, 'win32'), `\\\\?\\C:\\${'a'.repeat(300)}`);
    assert.equal(withLongPathPrefix(`/${'a'.repeat(300)}`, 'linux'), `/${'a'.repeat(300)}`);
    assert.equal(written.success, true, written.error ?? 'échec');
    assert.equal(read.success, true, read.error ?? 'échec');
    assert.match(JSON.stringify(read.output), /profond/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
