import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { attachKillOnCloseJob } from './job-object.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

test('closing the Job Object kills the attached process and the grandchild it started afterwards', { skip: process.platform !== 'win32' }, async () => {
  // Arrange: a parent that starts a long-lived grandchild only when told to, after it joined the job.
  const parent = spawn(process.execPath, ['-e', `
    process.stdin.once('data', () => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(child.pid);
    });
    setInterval(() => {}, 1000);
  `], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const job = attachKillOnCloseJob(parent.pid);
  try {
    assert.equal(await job.attached, true);
    parent.stdin.write('go\n');
    const [line] = await once(parent.stdout, 'data') as [Buffer];
    const grandchild = Number(line.toString().trim());
    assert.ok(alive(grandchild));

    // Act
    job.close();

    // Assert
    assert.equal(await waitFor(() => !alive(parent.pid!) && !alive(grandchild), 10_000), true);
  } finally {
    job.close();
    parent.kill();
  }
});

test('a PID that cannot be attached resolves false instead of throwing', { skip: process.platform !== 'win32' }, async () => {
  // Arrange: a process that has already exited.
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(gone, 'exit');

  // Act
  const job = attachKillOnCloseJob(gone.pid);

  // Assert
  assert.equal(await job.attached, false);
  job.close();
});
