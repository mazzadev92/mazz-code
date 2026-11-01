import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { detectShells, TerminalRunner, type ShellInfo } from './terminal-runner.js';

function cwdCommand(shell: ShellInfo): string {
  if (shell.id === 'cmd') return 'cd';
  if (process.platform === 'win32') return '[Console]::Out.Write((Get-Location).Path)';
  return 'pwd';
}

test('terminal cwd containing shell metacharacters is passed as process data, not evaluated as command text', async (t) => {
  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-terminal-security-'));
  const workspace = path.join(isolatedRoot, 'workspace & echo MAZZ_PATH_INJECTION');
  await fs.mkdir(workspace);
  t.after(async () => fs.rm(isolatedRoot, { recursive: true, force: true }));

  const shells = detectShells().filter((shell) => shell.available);
  assert.ok(shells.length > 0, 'a real local shell is required for this process test');
  for (const shell of shells) {
    const runner = new TerminalRunner();
    const chunks: Array<{ type: string; data?: string }> = [];
    const result = await runner.run(
      `cwd-metachar-${shell.id}`,
      { command: cwdCommand(shell), shell: shell.id, cwd: workspace, timeoutMs: 10_000 },
      (chunk) => chunks.push(chunk),
    );
    const output = chunks.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.data ?? '').join('').trim();
    assert.equal(result.exitCode, 0, `${shell.label} must start in the exact isolated cwd`);
    assert.equal(output, workspace, `${shell.label} must not parse the cwd's ampersand as shell syntax`);
  }
});
