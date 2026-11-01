import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as os from 'node:os';
import { detectShells, TerminalRunner, type ShellId, type TerminalChunk } from './terminal-runner.js';

function localShell(): ShellId {
  const available = detectShells().filter((shell) => shell.available);
  const preferred = process.platform === 'win32'
    ? available.find((shell) => shell.id === 'powershell') ?? available.find((shell) => shell.id === 'pwsh') ?? available.find((shell) => shell.id === 'cmd')
    : available[0];
  assert.ok(preferred, 'a real local shell must be available for this process test');
  return preferred.id;
}

function waitCommand(shell: ShellId): string {
  if (process.platform !== 'win32') return 'exec sleep 5';
  return shell === 'cmd' ? 'timeout /t 5 /nobreak > nul' : 'Start-Sleep -Seconds 5';
}

function visibleCommand(shell: ShellId): string {
  if (process.platform !== 'win32') return 'printf duplicate_must_not_start';
  return shell === 'cmd' ? 'echo duplicate_must_not_start' : "Write-Output 'duplicate_must_not_start'";
}

function runOptions(shell: ShellId, command: string) {
  return { command, shell, cwd: os.tmpdir(), timeoutMs: 10_000 };
}

test('duplicate runId is rejected without replacing or orphaning the active process handle', async () => {
  const runner = new TerminalRunner();
  const shell = localShell();
  const runId = 'duplicate-run-real-process';
  const originalEvents: TerminalChunk[] = [];
  const duplicateEvents: TerminalChunk[] = [];
  const original = runner.run(runId, runOptions(shell, waitCommand(shell)), (chunk) => originalEvents.push(chunk));

  try {
    assert.equal(runner.active().length, 1);
    assert.equal(runner.active()[0].runId, runId);
    const rejected = await runner.run(runId, runOptions(shell, visibleCommand(shell)), (chunk) => duplicateEvents.push(chunk));

    assert.deepEqual(duplicateEvents.map((chunk) => chunk.type), ['error', 'exit']);
    assert.match(duplicateEvents[0].data ?? '', /identifiant actif/);
    assert.equal(duplicateEvents[1].exitCode, null);
    assert.equal(rejected.exitCode, null);
    assert.equal(rejected.durationMs, 0);
    assert.equal(duplicateEvents.some((chunk) => chunk.type === 'stdout' && chunk.data?.includes('duplicate_must_not_start')), false);
    assert.equal(runner.active().length, 1, 'duplicate rejection must leave the original process registered');

    assert.equal(runner.cancel(runId), true, 'the original run remains cancellable by its id');
    const completed = await original;
    assert.ok(originalEvents.some((chunk) => chunk.type === 'exit' && chunk.cancelled === true));
    assert.ok(completed.durationMs >= 0);
    assert.deepEqual(runner.active(), []);
  } finally {
    if (runner.cancel(runId)) await original;
  }
});

test('runId is registered before the start callback can re-enter with the same id', async () => {
  const runner = new TerminalRunner();
  const shell = localShell();
  const runId = 'reentrant-duplicate-run';
  const originalEvents: TerminalChunk[] = [];
  const duplicateEvents: TerminalChunk[] = [];
  let duplicate: Promise<{ exitCode: number | null; durationMs: number }> | undefined;
  const original = runner.run(runId, runOptions(shell, waitCommand(shell)), (chunk) => {
    originalEvents.push(chunk);
    if (chunk.type === 'start') {
      duplicate = runner.run(runId, runOptions(shell, visibleCommand(shell)), (duplicateChunk) => duplicateEvents.push(duplicateChunk));
    }
  });

  try {
    assert.ok(duplicate, 'the start callback re-entered synchronously');
    const rejected = await duplicate;
    assert.equal(rejected.exitCode, null);
    assert.deepEqual(duplicateEvents.map((chunk) => chunk.type), ['error', 'exit']);
    assert.equal(runner.active().length, 1);
    assert.equal(runner.cancel(runId), true);
    await original;
    assert.ok(originalEvents.some((chunk) => chunk.type === 'exit' && chunk.cancelled === true));
    assert.deepEqual(runner.active(), []);
  } finally {
    if (runner.cancel(runId)) await original;
  }
});
