import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SessionStore } from './sessions.js';
import { DebouncedWriter } from './storage.js';
import { MazzServer } from './index.js';

async function unusedLoopbackPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('Impossible de réserver un port de test.');
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('session data is byte-backed and complete after a new store loads the same data directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-restart-'));
  try {
    const store = new SessionStore(dataDir);
    await store.load();
    const session = store.create({
      title: 'Décision — UTF-8 𝐀', projectRoot: dataDir, providerId: 'llama-local', modelId: 'local/model.gguf', mode: 'agent',
    });
    store.update(session.id, {
      title: 'Décision finale — UTF-8 𝐀', pinned: true, providerId: 'llama-local', modelId: 'local/second-model.gguf',
      extraRoots: [path.join(dataDir, 'external docs')], permissionMode: 'acceptEdits',
    });
    const attachment = {
      id: 'att_01', name: 'source é𝐀.md', sizeBytes: 123, kind: 'text', chars: 77,
      sourceSha256: 'a'.repeat(64), textSha256: 'b'.repeat(64), extractionStatus: 'complete', offsetUnit: 'utf16-code-unit',
    };
    const turn = store.beginTurn(session.id, {
      id: 'turn_01', taskId: 'task_01', prompt: 'Objectif : préserver 4,2 et l’UTF-16 𝐀', mode: 'agent',
      providerId: 'llama-local', modelId: 'local/second-model.gguf', startedAt: 1_797_000_000_000, attachments: [attachment],
    });
    store.recordEvent(session.id, turn.id, { type: 'status', taskId: turn.taskId, timestamp: 1, stage: 'plan', message: 'Décision confirmée.' });
    store.recordEvent(session.id, turn.id, { type: 'token', taskId: turn.taskId, timestamp: 2, delta: 'Résultat ' });
    store.recordEvent(session.id, turn.id, { type: 'token', taskId: turn.taskId, timestamp: 3, delta: 'exact : 4,2 𝐀' });
    store.recordEvent(session.id, turn.id, { type: 'complete', taskId: turn.taskId, timestamp: 4, success: true, summary: 'Résultat exact : 4,2 𝐀', durationMs: 987 });
    store.endTurn(session.id, turn.id, 'completed', 'Résultat exact : 4,2 𝐀');
    await store.flush(session.id);

    const expected = structuredClone(store.get(session.id));
    assert.ok(expected);
    const file = path.join(dataDir, 'sessions', `${session.id}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), expected);

    // A fresh store instance has no in-memory state from the writer above.
    const restarted = new SessionStore(dataDir);
    await restarted.load();
    assert.deepEqual(restarted.get(session.id), expected);
    assert.deepEqual(restarted.history(session.id), [
      { role: 'user', content: 'Objectif : préserver 4,2 et l’UTF-16 𝐀' },
      { role: 'assistant', content: 'Résultat exact : 4,2 𝐀' },
    ]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('loading after an interrupted run recovers and durably records its interrupted state', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-interrupted-'));
  try {
    const firstProcess = new SessionStore(dataDir);
    await firstProcess.load();
    const session = firstProcess.create({ title: 'Reprise', projectRoot: dataDir, providerId: 'llama-local', modelId: 'model.gguf', mode: 'agent' });
    const turn = firstProcess.beginTurn(session.id, {
      id: 'turn_interrupted', taskId: 'task_interrupted', prompt: 'Conserver le dernier objectif confirmé', mode: 'agent',
      providerId: 'llama-local', modelId: 'model.gguf', startedAt: Date.now(),
    });
    firstProcess.recordEvent(session.id, turn.id, {
      type: 'status', taskId: turn.taskId, timestamp: Date.now(), stage: 'tool', message: 'État avant interruption',
    });
    await firstProcess.flush(session.id);

    // Loading from the same on-disk directory models a new application process.
    const restartedProcess = new SessionStore(dataDir);
    await restartedProcess.load();
    const recovered = restartedProcess.get(session.id);
    assert.equal(recovered?.status, 'interrupted');
    assert.equal(recovered?.turns[0]?.status, 'interrupted');
    assert.equal(recovered?.turns[0]?.prompt, 'Conserver le dernier objectif confirmé');
    assert.equal(recovered?.turns[0]?.events[0]?.type, 'status');

    // Recovery is flushed before load() resolves, so a second restart is stable.
    const recoveredOnDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', `${session.id}.json`), 'utf8'));
    assert.equal(recoveredOnDisk.status, 'interrupted');
    assert.equal(recoveredOnDisk.turns[0].status, 'interrupted');
    const thirdProcess = new SessionStore(dataDir);
    await thirdProcess.load();
    assert.equal(thirdProcess.get(session.id)?.turns[0]?.status, 'interrupted');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('a forcibly terminated child process leaves a recoverable running session on disk', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-hard-crash-'));
  const sessionsModuleUrl = new URL('./sessions.js', import.meta.url).href;
  const childSource = `
    import { SessionStore } from ${JSON.stringify(sessionsModuleUrl)};
    const dataDir = process.env.MAZZ_PERSISTENCE_CHILD_DIR;
    if (!dataDir) throw new Error('Missing isolated test data directory');
    const store = new SessionStore(dataDir);
    await store.load();
    const session = store.create({ title: 'Reprise après arrêt forcé', projectRoot: dataDir, providerId: 'llama-local', modelId: 'local.gguf', mode: 'agent' });
    const turn = store.beginTurn(session.id, {
      id: 'turn_hard_crash', taskId: 'task_hard_crash', prompt: 'Préserver exactement le dernier objectif confirmé 𝐀', mode: 'agent',
      providerId: 'llama-local', modelId: 'local.gguf', startedAt: Date.now(),
    });
    store.recordEvent(session.id, turn.id, {
      type: 'status', taskId: turn.taskId, timestamp: Date.now(), stage: 'tool', message: 'Checkpoint physique avant terminaison forcée',
    });
    await store.flush(session.id);
    process.stdout.write('READY:' + session.id + '\\n');
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    env: { ...process.env, MAZZ_PERSISTENCE_CHILD_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const readyId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Child process did not persist its checkpoint. stderr: ${stderr}`)), 15_000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(new Error(`Child process exited before its durable checkpoint (code=${code}, signal=${signal}). stderr: ${stderr}`));
      });
      lines.once('line', (line) => {
        clearTimeout(timeout);
        if (!line.startsWith('READY:s_')) reject(new Error(`Unexpected child checkpoint: ${line}. stderr: ${stderr}`));
        else resolve(line.slice('READY:'.length));
      });
    });

    const sessionFile = path.join(dataDir, 'sessions', `${readyId}.json`);
    const bytesBeforeTermination = await fs.readFile(sessionFile, 'utf8');
    const persistedBeforeTermination = JSON.parse(bytesBeforeTermination) as {
      id: string; status: string; turns: Array<{ id: string; status: string; prompt: string; events: Array<{ message?: string }> }>;
    };
    assert.equal(persistedBeforeTermination.id, readyId);
    assert.equal(persistedBeforeTermination.status, 'running');
    assert.equal(persistedBeforeTermination.turns[0]?.status, 'running');
    assert.equal(persistedBeforeTermination.turns[0]?.prompt, 'Préserver exactement le dernier objectif confirmé 𝐀');
    assert.equal(persistedBeforeTermination.turns[0]?.events[0]?.message, 'Checkpoint physique avant terminaison forcée');

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(child.kill('SIGKILL'), true, 'the still-running child must accept forced termination');
    let exitTimeout: NodeJS.Timeout | undefined;
    const timedExit = new Promise<never>((_, reject) => {
      exitTimeout = setTimeout(() => reject(new Error('Terminated child did not exit')), 10_000);
    });
    const exit = await Promise.race([exited, timedExit]).finally(() => clearTimeout(exitTimeout));
    assert.ok(exit.signal !== null || exit.code !== 0, 'child must not report a clean application shutdown');

    // Recovery uses only the bytes written by the separate, now-dead process.
    assert.equal(await fs.readFile(sessionFile, 'utf8'), bytesBeforeTermination);
    const restarted = new SessionStore(dataDir);
    await restarted.load();
    const recovered = restarted.get(readyId);
    assert.equal(recovered?.status, 'interrupted');
    assert.equal(recovered?.turns[0]?.status, 'interrupted');
    assert.equal(recovered?.turns[0]?.prompt, 'Préserver exactement le dernier objectif confirmé 𝐀');
    assert.equal(recovered?.turns[0]?.events[0]?.type, 'status');
    assert.equal((recovered?.turns[0]?.events[0] as { message?: string } | undefined)?.message, 'Checkpoint physique avant terminaison forcée');

    const recoveredBytes = await fs.readFile(sessionFile, 'utf8');
    const recoveredOnDisk = JSON.parse(recoveredBytes) as typeof persistedBeforeTermination;
    assert.equal(recoveredOnDisk.status, 'interrupted');
    assert.equal(recoveredOnDisk.turns[0]?.status, 'interrupted');
    assert.equal(recoveredOnDisk.turns[0]?.prompt, persistedBeforeTermination.turns[0]?.prompt);
    const nextRestart = new SessionStore(dataDir);
    await nextRestart.load();
    assert.deepEqual(nextRestart.get(readyId), recovered);
    assert.equal(await fs.readFile(sessionFile, 'utf8'), recoveredBytes, 'a second restart must keep the recovered bytes stable');
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('session metadata survives a real core HTTP server stop and restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-http-restart-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-http-project-'));
  const port = await unusedLoopbackPort();
  const base = `http://127.0.0.1:${port}`;
  let server: MazzServer | undefined;
  try {
    server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
    await server.start();
    const createdResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Décision persistante', projectRoot, providerId: 'llama-local', modelId: 'first.gguf', mode: 'agent' }),
    });
    assert.equal(createdResponse.status, 200);
    const { session: created } = await createdResponse.json() as { session: { id: string } };
    const updatedResponse = await fetch(`${base}/api/sessions/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Décision validée après redémarrage', pinned: true, modelId: 'second.gguf', permissionMode: 'acceptEdits' }),
    });
    assert.equal(updatedResponse.status, 200);
    await server.stop();
    server = undefined;

    server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web') });
    await server.start();
    const listed = await (await fetch(`${base}/api/sessions`)).json() as { sessions: Array<{ id: string; title: string; pinned: boolean }> };
    assert.ok(listed.sessions.some((session) => session.id === created.id && session.title === 'Décision validée après redémarrage' && session.pinned));
    const detail = await (await fetch(`${base}/api/sessions/${created.id}`)).json() as { session: { projectRoot: string; providerId: string; modelId: string; permissionMode?: string } };
    assert.equal(detail.session.projectRoot, projectRoot);
    assert.equal(detail.session.providerId, 'llama-local');
    assert.equal(detail.session.modelId, 'second.gguf');
    assert.equal(detail.session.permissionMode, 'acceptEdits');
  } finally {
    await server?.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('writer drains a later revision queued while the previous atomic write is in flight', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-writer-revisions-'));
  try {
    const file = path.join(dataDir, 'session.json');
    const writer = new DebouncedWriter(file, 60_000);
    writer.schedule({ revision: 1, body: 'A'.repeat(256_000) });
    const firstFlush = writer.flush();
    writer.schedule({ revision: 2, body: 'final confirmed revision' });
    const secondFlush = writer.flush();
    await Promise.all([firstFlush, secondFlush]);

    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 2, body: 'final confirmed revision' });
    assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), { revision: 1, body: 'A'.repeat(256_000) });
    assert.deepEqual((await fs.readdir(dataDir)).sort(), ['session.json', 'session.json.bak']);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('finished turns go to an append-only JSONL log that restores them when the JSON snapshot is stale', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-session-jsonl-'));
  try {
    // Arrange: a legacy JSON-only session snapshot, saved before any turn finished.
    const store = new SessionStore(dataDir);
    await store.load();
    const session = store.create({ projectRoot: dataDir, providerId: 'llama-local', modelId: 'm', mode: 'agent' });
    await store.flush();
    const jsonPath = path.join(dataDir, 'sessions', `${session.id}.json`);
    const staleSnapshot = await fs.readFile(jsonPath, 'utf8');
    for (const id of ['turn_a', 'turn_b']) {
      store.beginTurn(session.id, { id, taskId: `task_${id}`, prompt: id, mode: 'agent', providerId: 'llama-local', modelId: 'm', startedAt: 1 });
      store.endTurn(session.id, id, 'completed', `answer ${id}`);
    }
    await store.flush();
    const logPath = path.join(dataDir, 'sessions', `${session.id}.jsonl`);
    // Simulate a crash: the snapshot predates both turns and the last append was torn.
    await fs.writeFile(jsonPath, staleSnapshot, 'utf8');
    await fs.appendFile(logPath, '{"id":"turn_c","ev', 'utf8');

    // Act
    const reloaded = new SessionStore(dataDir);
    await reloaded.load();

    // Assert
    const lines = (await fs.readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.deepEqual(reloaded.get(session.id)?.turns.map((t) => [t.id, t.status, t.finalText]),
      [['turn_a', 'completed', 'answer turn_a'], ['turn_b', 'completed', 'answer turn_b']]);
    await reloaded.remove(session.id);
    await assert.rejects(fs.access(logPath));
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});