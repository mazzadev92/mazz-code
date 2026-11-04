import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { appendReplay, PTY_RESET_SEQUENCE, ReplayBuffer, PTY_SHELLS, PtyManager, type IPty, type PtyModule } from './pty-manager.js';

const closedJobs: number[] = [];
const noJob = (pid: number) => ({ attached: Promise.resolve(false), close: () => { closedJobs.push(pid); } });

function fakePty() {
  const spawned: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  const killed: number[] = [];
  let emitData: (d: string) => void = () => undefined;
  let emitExit: (e: { exitCode: number }) => void = () => undefined;
  const mod: PtyModule = {
    spawn(file, args, opts) {
      spawned.push({ file, args, opts });
      const pty: IPty = {
        pid: 4242,
        onData: (cb) => { emitData = cb; return { dispose: () => undefined }; },
        onExit: (cb) => { emitExit = cb; return { dispose: () => undefined }; },
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      };
      return pty;
    },
  };
  return { mod, spawned, killed, data: (d: string) => emitData(d), exit: (code: number) => emitExit({ exitCode: code }) };
}

test('ptyManager_spawn_usesConptyAndUtf8InitPerShell', () => {
  // Arrange
  const fake = fakePty();
  const manager = new PtyManager(() => fake.mod, (p) => fake.killed.push(p.pid), noJob);
  // Act
  manager.create('cmd', '.', 80, 24);
  manager.create('powershell', '.', 80, 24);
  // Assert
  assert.equal(fake.spawned[0].opts.useConpty, true);
  assert.deepEqual(fake.spawned[0].args, ['/K', 'chcp 65001 >nul']);
  assert.equal(fake.spawned[1].opts.useConpty, true);
  assert.match(fake.spawned[1].args.join(' '), /\[Console\]::OutputEncoding/);
  assert.match(PTY_SHELLS.pwsh.args.join(' '), /chcp 65001/);
});

test('ptyManager_exitOrClose_reemitsCursorResetAndKillsProcessTree', () => {
  // Arrange
  const fake = fakePty();
  const manager = new PtyManager(() => fake.mod, (p) => fake.killed.push(p.pid), noJob);
  closedJobs.length = 0;
  const crashed = manager.create('cmd', '.', 80, 24);
  const seen: string[] = [];
  crashed.listeners.add((c) => seen.push(c.type === 'data' ? c.data : `exit:${c.exitCode}`));
  // Act
  fake.data('\x1b[?25l');
  fake.exit(3);
  const open = manager.create('cmd', '.', 80, 24);
  const closing: string[] = [];
  open.listeners.add((c) => { if (c.type === 'data') closing.push(c.data); });
  manager.close(open.id);
  // Assert
  assert.deepEqual(seen, ['\x1b[?25l', PTY_RESET_SEQUENCE, 'exit:3']);
  assert.ok(crashed.replay.endsWith(PTY_RESET_SEQUENCE), 'a reloaded page also gets the reset');
  assert.deepEqual(closing, [PTY_RESET_SEQUENCE]);
  assert.deepEqual(fake.killed, [4242], 'close kills the tree of the running terminal only');
  assert.deepEqual(closedJobs, [4242, 4242], 'the Job Object closes on exit and on close');
});

test('appendReplay_overLineOrSizeLimit_evictsOldestFirst', () => {
  // Arrange
  const lines = Array.from({ length: 12 }, (_, i) => `l${i}\n`).join('');
  // Act
  const byLines = appendReplay('', lines, 10, 1_000);
  const bySize = appendReplay('abcdef', 'ghij', 100, 4);
  // Assert
  assert.equal(byLines, Array.from({ length: 10 }, (_, i) => `l${i + 2}\n`).join(''));
  assert.equal(bySize, 'ghij');
});

test('replayBuffer_hundredsOfThousandsOfChunks_staysUnderLimitsAndAppendsInLinearTime', () => {
  // Arrange
  const buffer = new ReplayBuffer(100, 10_000);
  const started = performance.now();
  // Act
  for (let i = 0; i < 300_000; i++) buffer.append(`ligne ${i}\n`);
  const elapsed = performance.now() - started;
  const text = buffer.text();
  // Assert: bounded by both limits, newest output kept, and no per-chunk rescan of the whole buffer
  assert.ok(text.split('\n').length - 1 <= 100);
  assert.ok(text.length <= 10_000);
  assert.ok(text.endsWith('ligne 299999\n'));
  assert.ok(elapsed < 2_000, `trop lent : ${elapsed.toFixed(0)} ms`);
});

test('replayBuffer_oneOversizedChunk_isTrimmedFromTheFront', () => {
  // Arrange
  const buffer = new ReplayBuffer(5, 50);
  // Act
  buffer.append('x'.repeat(200) + '\nfin\n');
  // Assert
  assert.ok(buffer.text().length <= 50 && buffer.text().endsWith('fin\n'));
});
