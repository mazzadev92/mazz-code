import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gitBranches, gitCheckout, gitPull, gitPush } from './git-api.js';

test('Git: create branch, first push sets upstream, fast-forward pull, invalid names refused', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-git-'));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, windowsHide: true }).toString();
  try {
    const remote = path.join(tmp, 'remote.git');
    const work = path.join(tmp, 'work');
    g(tmp, 'init', '--bare', '-b', 'main', remote);
    g(tmp, 'clone', remote, work);
    g(work, 'config', 'user.email', 't@t');
    g(work, 'config', 'user.name', 't');
    await fs.writeFile(path.join(work, 'a.txt'), 'a', 'utf-8');
    g(work, 'add', '.');
    g(work, 'commit', '-m', 'init');
    g(work, 'push', '-u', 'origin', 'main');
    await assert.rejects(gitCheckout(work, '--force', true));
    await assert.rejects(gitCheckout(work, 'a..b', true));
    await gitCheckout(work, 'feature/x', true);
    assert.equal((await gitBranches(work)).current, 'feature/x');
    await fs.writeFile(path.join(work, 'b.txt'), 'b', 'utf-8');
    g(work, 'add', '.');
    g(work, 'commit', '-m', 'b');
    await gitPush(work);
    assert.match(g(remote, 'branch'), /feature\/x/);
    assert.match(g(work, 'rev-parse', '--abbrev-ref', '@{u}'), /origin\/feature\/x/);
    await gitPull(work);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
