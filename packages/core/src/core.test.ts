import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MazzServer } from './index.js';
import { mergeSettings, DEFAULT_SETTINGS } from './settings.js';
import { maskSecret } from './secrets.js';
import { appendCompacted } from './sessions.js';
import type { AgentEvent, ExecutionMode, ToolExecutionContext } from '@mazz/shared';
import { defaultToolRegistry, ProjectCodeIndexStore, ProjectCodeIndexTool, ToolRegistry } from '@mazz/tools';
import { McpManager, type McpFetch } from './mcp-manager.js';
import { defaultProviderRegistry } from '@mazz/providers';
import { defaultModelScanner } from '@mazz/model-manager';

async function withServer(port: number, fn: (base: string, dataDir: string, ws: string) => Promise<void>, mcpFetch?: McpFetch): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-core-data-'));
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-core-ws-'));
  const server = new MazzServer({ port, host: '127.0.0.1', dataDir, webRoot: path.join(dataDir, 'no-web'), mcpFetch });
  await server.start();
  try {
    await fn(`http://127.0.0.1:${port}`, dataDir, ws);
  } finally {
    await server.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(ws, { recursive: true, force: true });
  }
}

async function findAvailableLoopbackPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    throw new Error('Impossible de réserver un port loopback éphémère pour le test Core.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function readSse(res: Response): Promise<{ events: any[]; meta: any }> {
  const text = await res.text();
  const events: any[] = [];
  let meta: any;
  for (const block of text.split('\n\n')) {
    const isMeta = block.includes('event: meta');
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line || line === 'data: [DONE]') continue;
    const parsed = JSON.parse(line.slice(6));
    if (isMeta) meta = parsed;
    else events.push(parsed);
  }
  return { events, meta };
}

test('Mazz Core Server: HTTP & SSE API verification', async () => {
  await withServer(3339, async (base) => {
    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as any;
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.product, 'MAZZ ÆNGENIUM — Agent Studio');
    assert.ok(healthJson.workspace.toolchains.length > 0);

    const toolsJson = (await (await fetch(`${base}/api/tools`)).json()) as any;
    assert.ok(toolsJson.tools.length >= 7);

    const muceJson = (await (await fetch(`${base}/api/muce/status`)).json()) as any;
    assert.equal(muceJson.isFallbackActive, true);
  });
});

test('model calibration is refused until a generative llama-server model is loaded', async () => {
  await withServer(3341, async (base) => {
    const response = await fetch(`${base}/api/models/calibrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = await response.json() as { error?: string };
    assert.match(body.error ?? '', /Chargez un modèle génératif/u);
  });
});

test('Core security: foreign origins and hosts are refused, no wildcard CORS', async () => {
  await withServer(3340, async (base) => {
    const evil = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);

    const own = await fetch(`${base}/api/health`, { headers: { Origin: 'http://127.0.0.1:3340' } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3340');

    const run = await fetch(`${base}/api/terminal/run`, {
      method: 'POST',
      headers: { Origin: 'http://attacker.local', 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo pwned' }),
    });
    assert.equal(run.status, 403);
  });
});

test('Core security: terminal refuses a sibling path with the workspace prefix', async () => {
  await withServer(3351, async (base, _dataDir, workspace) => {
    const sibling = `${workspace}-private`;
    await fs.mkdir(sibling, { recursive: true });
    try {
      const opened = await fetch(`${base}/api/workspace/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: workspace }),
      });
      assert.equal(opened.status, 200);
      const response = await fetch(`${base}/api/terminal/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo must-not-run', cwd: sibling, shell: 'cmd' }),
      });
      assert.equal(response.status, 403);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});

test('Core settings: validation, persistence and reset', async () => {
  await withServer(3341, async (base, dataDir) => {
    const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: { threads: 999 } }) });
    assert.equal(bad.status, 422);

    const ok = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appearance: { theme: 'blueprint' }, models: { threads: 3 } }) });
    assert.equal(ok.status, 200);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf-8'));
    assert.equal(saved.appearance.theme, 'blueprint');
    assert.equal(saved.models.threads, 3);

    const reset = (await (await fetch(`${base}/api/settings/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: 'appearance' }) })).json()) as any;
    assert.equal(reset.settings.appearance.theme, 'bioforge');
    assert.equal(reset.settings.models.threads, 3);
  });
});

test('Provider discovery and diagnostics stay inside local_strict even when a custom endpoint is mislabeled local', async () => {
  const port = 3362;
  const realFetch = globalThis.fetch;
  const originalScan = defaultModelScanner.scanDefaultLocations;
  const nonLoopbackAttempts: string[] = [];
  const interceptedLocalProbes: string[] = [];
  const customIds = ['strict-egress-remote', 'strict-egress-mislabeled'];

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (url.hostname === '127.0.0.1' && url.port === String(port)) return realFetch(input, init);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) interceptedLocalProbes.push(url.href);
    else nonLoopbackAttempts.push(url.href);
    throw new Error('Provider discovery test network guard intercepted this request.');
  }) as typeof fetch;
  // Keep this integration test independent of the user's local model folders.
  defaultModelScanner.scanDefaultLocations = async () => [];

  try {
    await withServer(port, async (base) => {
      const request = (url: string, method: string, body?: unknown) => fetch(`${base}${url}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const mode = await request('/api/settings', 'PUT', { ai: { executionMode: 'local_strict' } });
      assert.equal(mode.status, 200);

      const definitions = [
        { id: customIds[0], locality: 'remote', baseUrl: 'https://provider-egress.invalid/v1' },
        // A locality label cannot override the physical locality of the URL.
        { id: customIds[1], locality: 'local', baseUrl: 'https://mislabeled-egress.invalid/v1' },
      ];
      for (const provider of definitions) {
        const added = await request('/api/providers', 'POST', {
          ...provider, name: provider.id, defaultModel: 'probe-model',
        });
        assert.equal(added.status, 200, await added.text());
        const keyed = await request(`/api/providers/${provider.id}/key`, 'PUT', { key: 'test-only-not-a-real-credential' });
        assert.equal(keyed.status, 200, await keyed.text());
      }

      const catalogResponse = await request('/api/models/catalog', 'GET');
      assert.equal(catalogResponse.status, 200);
      const catalog = (await catalogResponse.json()) as any;
      assert.equal(catalog.executionMode, 'local_strict');
      for (const id of customIds) {
        const entry = catalog.catalog.find((item: any) => item.provider.id === id);
        assert.ok(entry, `catalog entry missing for ${id}`);
        assert.deepEqual(entry.models, []);
        assert.match(entry.reason, /local strict/i);

        const models = await request(`/api/providers/${id}/models`, 'GET');
        assert.equal(models.status, 403);
        const diagnostic = await request('/api/providers/test', 'POST', { providerId: id });
        assert.equal(diagnostic.status, 403);
      }

      const allModelsResponse = await request('/api/models', 'GET');
      assert.equal(allModelsResponse.status, 200);
      const allModels = (await allModelsResponse.json()) as any;
      assert.ok(!allModels.models.some((model: any) => customIds.includes(model.providerId)));
      assert.deepEqual(allModels.localGgufFiles, []);
      assert.deepEqual(nonLoopbackAttempts, [], 'no remote provider endpoint may receive a discovery or diagnostic request');

      // Remove the temporary provider definitions and their temporary vault entries.
      for (const id of customIds) {
        const removed = await request(`/api/providers/${id}`, 'DELETE');
        assert.equal(removed.status, 200, await removed.text());
      }
    });
  } finally {
    globalThis.fetch = realFetch;
    defaultModelScanner.scanDefaultLocations = originalScan;
    for (const id of customIds) {
      // Keep the process-wide registry clean even when an assertion aborts the test.
      defaultProviderRegistry.removeCustom(id);
    }
    assert.deepEqual(nonLoopbackAttempts, [], 'the global fetch guard must show zero external attempts');
    // Local service probes were intercepted before the HTTP stack could reach a running user service.
    assert.ok(interceptedLocalProbes.every((url) => new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost' || new URL(url).hostname === '[::1]'));
  }
});

test('fs.delete always waits for an explicit one-time approval, including bypass and allow policies', async () => {
  await withServer(3363, async (base, _dataDir, workspace) => {
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const putSettings = (body: unknown) => fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const eventsUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, wanted: string): Promise<any[]> => {
      const events: any[] = [];
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = block.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6);
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);
          events.push(event);
          if (event.type === wanted) return events;
          if (event.type === 'complete') throw new Error(`Expected ${wanted}; agent completed first.`);
          continue;
        }
        const next = await reader.read();
        if (next.done) throw new Error(`SSE closed before ${wanted}.`);
        buffer += decoder.decode(next.value, { stream: true });
      }
    };
    const startDelete = async (sessionId: string, relativePath: string) => {
      const { defaultProviderRegistry } = await import('@mazz/providers');
      const det = defaultProviderRegistry.get('deterministic-test') as any;
      det.setScript([
        { toolCall: { id: `delete-${relativePath}`, name: 'fs.delete', arguments: { path: relativePath } } },
        { message: 'Terminé.' },
      ]);
      const response = await post('/api/agent/run', {
        sessionId, goal: `Supprime ${relativePath}`, mode: 'agent',
        selection: { providerId: 'deterministic-test', modelId: 'deterministic-test' },
      });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      return { det, reader: response.body!.getReader() };
    };

    await post('/api/workspace/open', { path: workspace });
    const targetBypass = path.join(workspace, 'bypass-delete-target.txt');
    await fs.writeFile(targetBypass, 'must remain until a person confirms', 'utf-8');
    assert.equal((await putSettings({ permissions: { delete: 'allow' } })).status, 200);
    const bypassSession = ((await (await post('/api/sessions', { title: 'Delete bypass', projectRoot: workspace })).json()) as any).session.id as string;
    const bypassMode = await fetch(`${base}/api/sessions/${bypassSession}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'bypass' }),
    });
    assert.equal(bypassMode.status, 200);

    let run = await startDelete(bypassSession, 'bypass-delete-target.txt');
    try {
      const pending = (await eventsUntil(run.reader, 'approval_request')).find((event) => event.type === 'approval_request');
      assert.ok(pending);
      assert.equal(pending.category, 'delete');
      assert.equal(pending.params.path, 'bypass-delete-target.txt');
      assert.equal(await fs.readFile(targetBypass, 'utf-8'), 'must remain until a person confirms');
      const refused = await post('/api/agent/approve', { approvalId: pending.callId, approved: false, scope: 'always' });
      assert.equal(refused.status, 200);
      await eventsUntil(run.reader, 'complete');
      assert.equal(await fs.readFile(targetBypass, 'utf-8'), 'must remain until a person confirms');
    } finally {
      run.det.setScript([]);
      await run.reader.cancel().catch(() => undefined);
    }

    const targetOnce = path.join(workspace, 'once-delete-target.txt');
    await fs.writeFile(targetOnce, 'only this approved file may be removed', 'utf-8');
    assert.equal((await putSettings({ permissions: { delete: 'ask' } })).status, 200);
    const defaultSession = ((await (await post('/api/sessions', { title: 'Delete confirmation', projectRoot: workspace })).json()) as any).session.id as string;
    run = await startDelete(defaultSession, 'once-delete-target.txt');
    try {
      const pending = (await eventsUntil(run.reader, 'approval_request')).find((event) => event.type === 'approval_request');
      assert.ok(pending);
      assert.equal(await fs.readFile(targetOnce, 'utf-8'), 'only this approved file may be removed');
      const approved = await post('/api/agent/approve', { approvalId: pending.callId, approved: true, scope: 'always' });
      assert.equal(approved.status, 200);
      const completed = await eventsUntil(run.reader, 'complete');
      assert.ok(completed.some((event) => event.type === 'tool_result' && event.toolName === 'fs.delete' && event.success === true));
      await assert.rejects(fs.stat(targetOnce), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
      const settings = (await (await fetch(`${base}/api/settings`)).json()) as any;
      assert.equal(settings.settings.permissions.delete, 'ask', 'an API request for scope=always must be normalized to a one-time delete approval');
    } finally {
      run.det.setScript([]);
      await run.reader.cancel().catch(() => undefined);
    }
  });
});

test('Core agent: fs.patch validates, waits for the UI approval endpoint, writes, and rereads exact file bytes', async () => {
  await withServer(await findAvailableLoopbackPort(), async (base, _dataDir, workspace) => {
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const putSettings = (body: unknown) => fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const eventsUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, wanted: string): Promise<any[]> => {
      const events: any[] = [];
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = block.split(/\r?\n/u).find((line) => line.startsWith('data: '))?.slice(6);
          if (!data || data === '[DONE]') continue;
          const event = JSON.parse(data);
          events.push(event);
          if (event.type === wanted || event.type === 'complete') return events;
          continue;
        }
        const next = await reader.read();
        if (next.done) throw new Error(`SSE closed before ${wanted}.`);
        buffer += decoder.decode(next.value, { stream: true });
      }
    };

    await post('/api/workspace/open', { path: workspace });
    assert.equal((await putSettings({ permissions: { write: 'ask' }, agent: { approvalTimeoutSec: 10, toolSelection: 'all' } })).status, 200);
    const target = path.join(workspace, 'patch-target.txt');
    const original = Buffer.from('header\r\nVALUE=old\r\nfooter\r\n', 'utf8');
    const expected = Buffer.from('header\r\nVALUE=new\r\nfooter\r\n', 'utf8');
    await fs.writeFile(target, original);
    const sessionId = ((await (await post('/api/sessions', { title: 'Patch end to end', projectRoot: workspace })).json()) as any).session.id as string;
    const deterministic = defaultProviderRegistry.get('deterministic-test') as any;
    deterministic.setScript([
      { toolCall: { id: 'plan-patch', name: 'plan.update', arguments: {
        objective: 'Appliquer et relire un remplacement exact dans patch-target.txt.',
        constraints: ['Rester dans le workspace.', 'Préserver les octets non concernés.'],
        acceptanceCriteria: ['patch-target.txt contient exactement le nouveau marqueur et conserve les fins de ligne.'],
        items: [
          { id: 'patch', content: 'Applique fs.patch à patch-target.txt.', dependencies: [], status: 'in_progress' },
          { id: 'verify', content: 'Relis patch-target.txt avec fs.read.', dependencies: ['patch'], status: 'pending' },
        ],
      } } },
      { toolCall: { id: 'read-before-patch', name: 'fs.read', arguments: { path: 'patch-target.txt' } } },
      { toolCall: { id: 'patch-target', name: 'fs.patch', arguments: { path: 'patch-target.txt', edits: [{ search: 'VALUE=old', replace: 'VALUE=new' }] } } },
      { toolCall: { id: 'read-patched-target', name: 'fs.read', arguments: { path: 'patch-target.txt' } } },
      { message: 'Le patch a été appliqué puis relu.' },
    ]);

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await post('/api/agent/run', {
        sessionId,
        goal: 'Remplace exactement VALUE=old par VALUE=new dans patch-target.txt, puis relis le fichier.',
        mode: 'agent',
        selection: { providerId: 'deterministic-test', modelId: 'deterministic-test' },
      });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      reader = response.body!.getReader();

      const pendingEvents = await eventsUntil(reader, 'approval_request');
      const approval = pendingEvents.find((event) => event.type === 'approval_request');
      assert.ok(approval, JSON.stringify(pendingEvents));
      assert.equal(approval.toolName, 'fs.patch');
      assert.equal(approval.category, 'write');
      assert.deepEqual(approval.params, { path: 'patch-target.txt', edits: [{ search: 'VALUE=old', replace: 'VALUE=new' }] });
      assert.deepEqual(await fs.readFile(target), original, 'the physical file must remain unchanged until the UI decision arrives');
      assert.equal(pendingEvents.some((event) => event.type === 'tool_result' && event.toolName === 'fs.patch'), false,
        'the model may propose the call, but the tool cannot return a result before approval');

      const approved = await post('/api/agent/approve', { approvalId: approval.callId, approved: true, scope: 'once' });
      assert.equal(approved.status, 200, await approved.text());
      const completedEvents = await eventsUntil(reader, 'complete');
      const patchResult = completedEvents.find((event) => event.type === 'tool_result' && event.toolName === 'fs.patch');
      const rereadResult = completedEvents.filter((event) => event.type === 'tool_result' && event.toolName === 'fs.read').at(-1);
      assert.equal(patchResult?.success, true, JSON.stringify(patchResult));
      assert.equal(rereadResult?.success, true, JSON.stringify(rereadResult));
      assert.equal(rereadResult.output.content, expected.toString('utf8'));
      assert.equal(completedEvents.at(-1)?.success, true, JSON.stringify([
        ...completedEvents.filter((event) => event.type === 'plan' || event.type === 'tool_result' && event.toolName === 'plan.update'),
        ...completedEvents.slice(-4),
      ]));
      assert.deepEqual(await fs.readFile(target), expected, 'the physical bytes must match the exact reread result');
      const settings = (await (await fetch(`${base}/api/settings`)).json()) as any;
      assert.equal(settings.settings.permissions.write, 'ask', 'a one-time UI approval must not change the persistent permission policy');
    } finally {
      deterministic.setScript([]);
      await reader?.cancel().catch(() => undefined);
    }
  });
});

test('Core agent: session persistence, deterministic run, checkpoint and rollback through the API', async () => {
  await withServer(3342, async (base, _dataDir, ws) => {
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: { write: 'allow' } }) });
    await fetch(`${base}/api/workspace/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ws }) });

    const created = (await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Test', projectRoot: ws }) })).json()) as any;
    const sessionId = created.session.id;

    const res = await fetch(`${base}/api/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, goal: 'Réponds simplement', mode: 'ask', selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' } }),
    });
    assert.equal(res.status, 200);
    const { events, meta } = await readSse(res);
    assert.equal(meta.sessionId, sessionId);
    assert.ok(events.some((e) => e.type === 'complete'));
    const usage = events.find((e) => e.type === 'usage');
    assert.equal(usage.telemetry.speedSource, 'synthetic');
    assert.equal(usage.tokensPerSecond, undefined);

    const detail = (await (await fetch(`${base}/api/sessions/${sessionId}`)).json()) as any;
    assert.equal(detail.session.turns.length, 1);
    assert.equal(detail.session.turns[0].status, 'completed');

    // Manual edit creates a checkpoint; rollback restores the previous content.
    await fs.writeFile(path.join(ws, 'a.txt'), 'avant', 'utf-8');
    const w = (await (await fetch(`${base}/api/files/write`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: 'a.txt', content: 'après' }) })).json()) as any;
    assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf-8'), 'après');
    const rb = await fetch(`${base}/api/checkpoints/${w.checkpointId}/rollback`, { method: 'POST' });
    assert.equal(rb.status, 200);
    assert.equal(await fs.readFile(path.join(ws, 'a.txt'), 'utf-8'), 'avant');

    const escape = await fetch(`${base}/api/files/read?path=${encodeURIComponent('../../etc/passwd')}`);
    assert.equal(escape.status, 403);
  });
});

test('Core terminal: real command streamed with exit code; policy deny blocks it', async () => {
  await withServer(3343, async (base, _d, ws) => {
    await fetch(`${base}/api/workspace/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ws }) });
    const res = await fetch(`${base}/api/terminal/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo mazz-ok', shell: 'cmd' }) });
    const { events } = await readSse(res);
    assert.ok(events.some((e) => e.type === 'stdout' && e.data.includes('mazz-ok')));
    const exit = events.find((e) => e.type === 'exit');
    assert.equal(exit.exitCode, 0);

    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: { terminal: 'deny' } }) });
    const denied = await fetch(`${base}/api/terminal/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'echo x' }) });
    assert.equal(denied.status, 403);
  });
});

test('Core providers: key never returned, only a masked hint', async () => {
  await withServer(3344, async (base) => {
    const secret = 'gsk_test_1234567890abcdefWXYZ';
    const put = await fetch(`${base}/api/providers/groq-api/key`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: secret }) });
    const body = await put.text();
    assert.equal(put.status, 200, body);
    assert.ok(!body.includes('1234567890'));
    const list = await (await fetch(`${base}/api/providers`)).text();
    assert.ok(!list.includes('1234567890'));
    assert.ok(JSON.parse(list).providers.find((p: any) => p.id === 'groq-api').hasApiKey);
    const del = await fetch(`${base}/api/providers/groq-api/key`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  });
});

test('Settings merge rejects unknown enum values and keeps defaults', () => {
  const { settings, errors } = mergeSettings(structuredClone(DEFAULT_SETTINGS), { appearance: { theme: 'neon' }, unknown: 1 });
  assert.equal(errors.length, 1);
  assert.equal(settings.appearance.theme, 'bioforge');
});

test('Secret masking keeps only the family prefix and last 4 characters', () => {
  assert.equal(maskSecret('sk-ant-api03-abcdefghijklmnop'), 'sk-ant-••••mnop');
  assert.equal(maskSecret('short'), '••••');
});

test('Session event compaction merges consecutive token deltas', () => {
  const events: AgentEvent[] = [];
  appendCompacted(events, { type: 'token', taskId: 't', timestamp: 1, delta: 'Bon' });
  appendCompacted(events, { type: 'token', taskId: 't', timestamp: 2, delta: 'jour' });
  appendCompacted(events, { type: 'status', taskId: 't', timestamp: 3, stage: 's', message: 'm' });
  appendCompacted(events, { type: 'token', taskId: 't', timestamp: 4, delta: '!' });
  assert.equal(events.length, 3);
  assert.equal((events[0] as any).delta, 'Bonjour');
});

test('KV session cache: saves the previous owner, restores existing caches, prunes by size [mock supervisor]', async () => {
  const { KvSessionCache } = await import('./kv-cache.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-kv-'));
  const calls: string[] = [];
  const fake = {
    async slotAction(action: string, filename?: string) {
      calls.push(`${action}:${filename}`);
      if (action === 'save' && filename) await fs.writeFile(path.join(dir, filename), Buffer.alloc(600));
      return { ok: true, data: { n_saved: 10, n_restored: 10 }, ms: 1 };
    },
  };
  try {
    const kv = new KvSessionCache(dir, fake as never, 1000);
    assert.equal((await kv.prepare('a')).skipped, 'aucun modèle chargé');
    kv.reset('D:/m/model.gguf', 4096);
    const fa = kv.fileFor('s_a')!;
    assert.match(fa, /^[0-9a-f]{12}__s_a\.bin$/);
    await kv.prepare('s_a'); // no cache yet: nothing restored
    await kv.prepare('s_b'); // saves a
    const r = await kv.prepare('s_a'); // saves b, restores a
    assert.equal(r.saved?.sessionId, 's_b');
    assert.equal(r.restored?.tokens, 10);
    assert.deepEqual(calls, [`save:${fa}`, `save:${kv.fileFor('s_b')}`, `restore:${fa}`]);
    // Budget 1000 bytes, two 600-byte files: the oldest that is not the owner's is removed.
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.bin'));
    assert.deepEqual(files, [fa]);
    // Another model never reuses these files.
    kv.reset('D:/m/other.gguf', 4096);
    assert.notEqual(kv.fileFor('s_a'), fa);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MCP: real stdio server started on demand, tools registered with permissions, agent call, stop', async () => {
  const fixture = path.resolve('fixtures/mcp-test-server.mjs');
  await withServer(3346, async (base, _d, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/workspace/open', { path: ws });
    const bad = await post('/api/mcp/servers', { id: 'Bad Id', transport: 'stdio', command: 'node' });
    assert.equal(bad.status, 400);
    assert.equal((await post('/api/mcp/servers', { id: 'demo', name: 'Démo', transport: 'stdio', command: process.execPath, args: [fixture] })).status, 200);

    const start = await post('/api/mcp/servers/demo/start', {});
    const st = (await start.json()) as any;
    assert.equal(start.status, 200, JSON.stringify(st));
    assert.deepEqual(st.tools.map((t: any) => t.registeredAs).sort(), ['mcp.demo.add', 'mcp.demo.fail', 'mcp.demo.secret']);

    const tools = (await (await fetch(`${base}/api/tools`)).json()) as any;
    const add = tools.tools.find((t: any) => t.name === 'mcp.demo.add');
    assert.equal(add.permissionCategory, 'mcp');

    // Manual calls carry the effective mode; local stdio remains usable in strict mode.
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: { executionMode: 'local_strict' } }) });
    const call = (await (await post('/api/mcp/servers/demo/call', { tool: 'add', arguments: { a: 2, b: 40 } })).json()) as any;
    assert.equal(call.success, true);
    assert.equal(call.output.text, '42');
    const fail = (await (await post('/api/mcp/servers/demo/call', { tool: 'fail', arguments: {} })).json()) as any;
    assert.equal(fail.success, false);

    // Agent run (scripted engine) calling the MCP tool; the "mcp" permission is enforced.
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: { mcp: 'deny' } }) });
    const { DeterministicTestProvider } = await import('@mazz/providers/testing');
    const det = (await import('@mazz/providers')).defaultProviderRegistry.get('deterministic-test') as InstanceType<typeof DeterministicTestProvider>;
    det.setScript([{ toolCall: { id: 'm1', name: 'mcp.demo.add', arguments: { a: 1, b: 1 } } }, { message: 'ok' }]);
    const res = await post('/api/agent/run', { goal: 'additionne', mode: 'agent', selection: { providerId: 'deterministic-test', modelId: 'm' } });
    const { events } = await readSse(res);
    const tr = events.find((e) => e.type === 'tool_result' && e.toolName === 'mcp.demo.add');
    assert.equal(tr.success, false);
    assert.match(tr.error, /refusée/);
    assert.ok(events.some((e) => e.type === 'approval_result' && e.decidedBy === 'policy'));
    det.setScript([]);

    assert.equal((await post('/api/mcp/servers/demo/stop', {})).status, 200);
    const after = (await (await fetch(`${base}/api/tools`)).json()) as any;
    assert.ok(!after.tools.some((t: any) => t.name.startsWith('mcp.')));
  });
});

test('MCP HTTP local_strict: blocks outbound starts and tool calls even for a previously running server', async () => {
  const registry = new ToolRegistry();
  let executionMode: ExecutionMode = 'cloud';
  const methods: string[] = [];
  const fetchFixture = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method !== 'POST') return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number | string; method?: string; params?: any };
    methods.push(message.method ?? '');
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'isolated-fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Fixture tool', inputSchema: { type: 'object', properties: {} } }] }
        : message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'fixture result' }] }
          : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const configs = [{
    id: 'remote', name: 'Remote fixture', transport: 'http' as const,
    url: 'https://mcp.example.invalid/mcp', enabled: true, autoStart: false,
  }];
  const manager = new McpManager(registry, () => configs, () => undefined, () => executionMode, fetchFixture);
  const started = await manager.start('remote');
  assert.equal(started.state, 'running');
  const tool = registry.get('mcp.remote.ping');
  assert.ok(tool);

  const context: ToolExecutionContext = {
    taskId: 'mcp-locality-test', workspaceRoot: os.tmpdir(), signal: AbortSignal.timeout(5000),
    executionMode: 'cloud', permissionLevel: 'trusted_workspace', emitEvent: () => undefined,
  };
  const beforePolicyChange = await tool.execute({}, context);
  assert.equal(beforePolicyChange.success, true);
  assert.equal(methods.filter((method) => method === 'tools/call').length, 1);

  executionMode = 'local_strict';
  const callsBeforeBlockedStart = methods.length;
  const blockedStart = await manager.start('remote');
  assert.equal(blockedStart.state, 'error');
  assert.match(blockedStart.error ?? '', /local strict/i);
  assert.equal(methods.length, callsBeforeBlockedStart, 'strict-mode start must not emit an HTTP request');

  const blockedCall = await tool.execute({}, { ...context, executionMode: 'local_strict' });
  assert.equal(blockedCall.success, false);
  assert.match(blockedCall.error ?? '', /local strict/i);
  assert.equal(methods.filter((method) => method === 'tools/call').length, 1, 'the pre-started HTTP client must emit no tool call after strict mode is enabled');
  await manager.stopAll();

  const freshRegistry = new ToolRegistry();
  const freshManager = new McpManager(freshRegistry, () => configs, () => undefined, () => 'local_strict', fetchFixture);
  const strictStart = await freshManager.start('remote');
  assert.equal(strictStart.state, 'error');
  assert.equal(methods.length, callsBeforeBlockedStart, 'a new strict-mode manager must reject before opening the HTTP transport');

  const loopbackRegistry = new ToolRegistry();
  const loopbackManager = new McpManager(loopbackRegistry, () => [{
    id: 'loopback', name: 'Loopback fixture', transport: 'http', url: 'http://127.0.0.1:43123/mcp', enabled: true, autoStart: false,
  }], () => undefined, () => executionMode, fetchFixture);
  const loopbackStarted = await loopbackManager.start('loopback', 'cloud');
  assert.equal(loopbackStarted.state, 'running', 'local loopback HTTP MCP remains available in strict mode');
  const loopbackTool = loopbackRegistry.get('mcp.loopback.ping');
  assert.ok(loopbackTool);
  const loopbackCall = await loopbackTool.execute({}, { ...context, executionMode: 'local_strict' });
  assert.equal(loopbackCall.success, true);
  await loopbackManager.stopAll();
});

test('MCP manual start route: local_strict refuses a non-loopback HTTP server before network egress', async () => {
  const realFetch = globalThis.fetch;
  const outbound: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      outbound.push(url.href);
      throw new Error('External network is disabled in this test.');
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    await withServer(3352, async (base) => {
      const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      await fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai: { executionMode: 'local_strict' } }),
      });
      const configured = await post('/api/mcp/servers', {
        id: 'remote', name: 'Remote', transport: 'http', url: 'https://mcp.example.invalid/mcp', enabled: true,
      });
      assert.equal(configured.status, 200);
      const started = await post('/api/mcp/servers/remote/start', {});
      assert.equal(started.status, 502);
      const listed = (await (await fetch(`${base}/api/mcp/servers`)).json()) as any;
      assert.equal(listed.servers.find((item: any) => item.id === 'remote').status.state, 'error');
      assert.deepEqual(outbound, [], 'manual start must reject before issuing any non-loopback request');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('MCP settings transition: switching cloud to local_strict closes and unregisters an active HTTP server', async () => {
  const methods: string[] = [];
  const signals: AbortSignal[] = [];
  const mcpFetch: McpFetch = async (url, init) => {
    assert.equal(new URL(url).hostname, 'mcp.example.invalid');
    if (init?.signal) signals.push(init.signal as AbortSignal);
    const method = init?.method ?? 'GET';
    if (method !== 'POST') return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number | string; method?: string; params?: any };
    methods.push(request.method ?? '');
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'settings-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'ping', description: 'Fixture tool', inputSchema: { type: 'object', properties: {} } }] }
        : request.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'fixture result' }] }
          : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await withServer(3353, async (base) => {
    const post = (url: string, body: unknown) => fetch(base + url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const updateMode = (executionMode: ExecutionMode) => fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ai: { executionMode } }),
    });
    assert.equal((await updateMode('cloud')).status, 200);
    const saved = await post('/api/mcp/servers', {
      id: 'remote', name: 'Remote fixture', transport: 'http', url: 'https://mcp.example.invalid/mcp', enabled: true,
    });
    assert.equal(saved.status, 200);
    assert.equal((await post('/api/mcp/servers/remote/start', {})).status, 200);

    const before = (await (await fetch(`${base}/api/tools`)).json()) as any;
    assert.ok(before.tools.some((tool: any) => tool.name === 'mcp.remote.ping'));
    const firstCall = await post('/api/mcp/servers/remote/call', { tool: 'ping', arguments: {} });
    assert.equal(firstCall.status, 200);
    assert.equal(((await firstCall.json()) as any).success, true);
    assert.equal(methods.filter((method) => method === 'tools/call').length, 1);
    assert.ok(signals.length > 0);
    assert.ok(signals.some((signal) => !signal.aborted));

    assert.equal((await updateMode('local_strict')).status, 200);
    assert.ok(signals.every((signal) => signal.aborted), 'the settings response must follow transport abort');
    const after = (await (await fetch(`${base}/api/tools`)).json()) as any;
    assert.ok(!after.tools.some((tool: any) => tool.name === 'mcp.remote.ping'), 'stopping remote MCP must unregister its tools');
    const laterCall = await post('/api/mcp/servers/remote/call', { tool: 'ping', arguments: {} });
    assert.equal(laterCall.status, 404);
    assert.equal(methods.filter((method) => method === 'tools/call').length, 1, 'no MCP tool-call request may occur after strict mode takes effect');
  }, mcpFetch);
});

test('Connectors: MCP secret kept in the vault, passed to the server, never returned', async () => {
  const fixture = path.resolve('fixtures/mcp-test-server.mjs');
  await withServer(3347, async (base, dataDir, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/workspace/open', { path: ws });
    const saved = (await (await post('/api/mcp/servers', { id: 'sec', transport: 'stdio', command: process.execPath, args: [fixture], secretName: 'MAZZ_TEST_SECRET', secret: 'ghp_abcdefghijklmnop1234' })).json()) as any;
    const entry = saved.servers.find((x: any) => x.id === 'sec');
    assert.ok(entry.secretHint && !entry.secretHint.includes('abcdefghijklmnop'));
    assert.ok(!JSON.stringify(saved).includes('ghp_abcdefghijklmnop1234'));
    assert.ok(!(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf-8')).includes('abcdefghijklmnop'));
    assert.equal((await post('/api/mcp/servers/sec/start', {})).status, 200);
    const call = (await (await post('/api/mcp/servers/sec/call', { tool: 'secret', arguments: {} })).json()) as any;
    assert.equal(call.output.text, 'ghp_abcdefghijklmnop1234');
    await post('/api/mcp/servers/sec/stop', {});
  });
});

test('Skills: SKILL.md created, listed, loaded by /name and by the skills.load tool', async () => {
  await withServer(3348, async (base, _d, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skills: { includeClaude: false } }) });
    await post('/api/workspace/open', { path: ws });
    await fs.mkdir(path.join(ws, '.mazz', 'skills', 'projet-regles'), { recursive: true });
    await fs.writeFile(path.join(ws, '.mazz', 'skills', 'projet-regles', 'SKILL.md'), '---\nname: projet-regles\ndescription: "Règles de nommage du projet"\n---\n\nPréfixer les fonctions par mz_.', 'utf-8');
    assert.equal((await post('/api/skills', { name: 'Bad Name', description: 'x', body: 'y' })).status, 400);
    assert.equal((await post('/api/skills', { name: 'revue-c', description: 'Revue de sécurité du code C', body: 'Vérifier les débordements de tampon.' })).status, 200);
    const list = (await (await fetch(`${base}/api/skills?rescan=1`)).json()) as any;
    assert.deepEqual(list.skills.map((s: any) => s.name).sort(), ['projet-regles', 'revue-c']);
    const one = (await (await fetch(`${base}/api/skills/revue-c`)).json()) as any;
    assert.match(one.body, /débordements/);

    const { defaultProviderRegistry } = await import('@mazz/providers');
    const det = defaultProviderRegistry.get('deterministic-test') as any;
    det.setScript([{ toolCall: { id: 'k1', name: 'skills.load', arguments: { name: 'projet-regles' } } }, { message: 'ok' }]);
    const created = (await (await post('/api/sessions', { title: 'S', projectRoot: ws })).json()) as any;
    const { events } = await readSse(await post('/api/agent/run', { sessionId: created.session.id, goal: '/revue-c vérifie main.c', mode: 'agent', selection: { providerId: 'deterministic-test', modelId: 'm' } }));
    const tr = events.find((e) => e.type === 'tool_result' && e.toolName === 'skills.load');
    assert.equal(tr.success, true, JSON.stringify(tr));
    assert.match(JSON.stringify(tr.output), /mz_/);
    det.setScript([]);
    assert.equal((await fetch(`${base}/api/skills/revue-c`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/skills/projet-regles`, { method: 'DELETE' })).status, 400);
  });
});

test('Attachments and PC access: upload, run with attachment, project-only refusal, session bypass, protected folder', async () => {
  await withServer(3349, async (base, dataDir, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-core-out-'));
    try {
      await fs.writeFile(path.join(outside, 'note.txt'), 'hors projet', 'utf-8');
      await post('/api/workspace/open', { path: ws });
      const up = (await (await fetch(`${base}/api/attachments?name=${encodeURIComponent('main.py')}`, { method: 'POST', body: 'print("salut")' })).json()) as any;
      assert.equal(up.attachment.kind, 'code');
      const created = (await (await post('/api/sessions', { title: 'A', projectRoot: ws })).json()) as any;
      const sid = created.session.id;
      const { defaultProviderRegistry } = await import('@mazz/providers');
      const det = defaultProviderRegistry.get('deterministic-test') as any;
      const run = async (goal: string, script: unknown[]) => {
        det.setScript(script);
        const r = await readSse(await post('/api/agent/run', { sessionId: sid, goal, mode: 'agent', attachments: goal === 'pj' ? [up.attachment.id] : undefined, selection: { providerId: 'deterministic-test', modelId: 'm' } }));
        det.setScript([]);
        return r.events;
      };
      await run('pj', [{ message: 'ok' }]);
      const detail = (await (await fetch(`${base}/api/sessions/${sid}`)).json()) as any;
      assert.equal(detail.session.turns[0].attachments[0].name, 'main.py');

      const readOutside = [{ toolCall: { id: 'r1', name: 'fs.read', arguments: { path: path.join(outside, 'note.txt') } } }, { message: 'fin' }];
      const put = (b: unknown) => fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
      await put({ access: { mode: 'project' } });
      let ev = await run('lis', readOutside);
      assert.equal(ev.find((e) => e.type === 'tool_result').success, false);

      await put({ access: { mode: 'ask' } });
      await fetch(`${base}/api/sessions/${sid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionMode: 'bypass' }) });
      ev = await run('lis', readOutside);
      const ok = ev.find((e) => e.type === 'tool_result');
      assert.equal(ok.success, true, JSON.stringify(ok));

      ev = await run('vault', [{ toolCall: { id: 'v1', name: 'fs.list', arguments: { path: dataDir } } }, { message: 'fin' }]);
      const blocked = ev.find((e) => e.type === 'tool_result');
      assert.equal(blocked.success, false);
      assert.match(blocked.error, /protégé/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test('Project code index is reachable from the Studio API and indexes the active workspace on disk', async () => {
  const port = await findAvailableLoopbackPort();
  const indexData = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-code-index-api-data-'));
  const previousIndexTool = defaultToolRegistry.get('code.index');
  assert.ok(previousIndexTool, 'default tool registry includes the production code.index tool');
  defaultToolRegistry.register(new ProjectCodeIndexTool((root) => ProjectCodeIndexStore.open(root, indexData)));
  try {
    await withServer(port, async (base, _dataDir, workspace) => {
      const post = (body: unknown) => fetch(`${base}/api/code/index`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const opened = await fetch(`${base}/api/workspace/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: workspace }),
      });
      assert.equal(opened.status, 200, await opened.clone().text());
      await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
      await fs.writeFile(path.join(workspace, 'src', 'core.ts'), 'export function indexedSentinel(): number { return 7; }\n', 'utf8');
      await fs.writeFile(path.join(workspace, 'src', 'service.ts'), "import { indexedSentinel } from './core.js';\nexport function callSentinel() { return indexedSentinel(); }\n", 'utf8');
      await fs.writeFile(path.join(workspace, 'src', 'consumer.ts'), "import { callSentinel } from './service.js';\nexport function consumeSentinel() { return callSentinel(); }\n", 'utf8');

      const statusResponse = await post({ action: 'status' });
      assert.equal(statusResponse.status, 200, await statusResponse.clone().text());
      const before = await statusResponse.json() as any;
      assert.equal(before.success, true, before.error);
      assert.equal(before.output.workspace, workspace.toLowerCase());
      assert.equal(before.output.indexedFiles, 0);
      assert.ok(before.output.indexPath.startsWith(indexData));

      const updateResponse = await post({ action: 'update' });
      assert.equal(updateResponse.status, 200, await updateResponse.clone().text());
      const update = await updateResponse.json() as any;
      assert.equal(update.success, true, update.error);
      assert.deepEqual({ scanned: update.output.scanned, parsed: update.output.parsed, errors: update.output.errors }, { scanned: 3, parsed: 3, errors: 0 });
      const persisted = JSON.parse(await fs.readFile(update.output.indexPath ?? before.output.indexPath, 'utf8')) as any;
      assert.equal(persisted.workspace, workspace.toLowerCase());
      assert.equal(persisted.files['src/core.ts'].symbols[0].name, 'indexedSentinel');
      assert.equal(persisted.files['src/service.ts'].imports[0].target, 'src/core.ts');

      const searchResponse = await post({ action: 'search', query: 'consumeSentinel' });
      const search = await searchResponse.json() as any;
      assert.equal(search.success, true, search.error);
      assert.equal(search.output.matches[0].path, 'src/consumer.ts');
      assert.match(search.output.matches[0].sha256, /^[a-f0-9]{64}$/u);

      const impactResponse = await post({ action: 'impact', path: 'src/core.ts' });
      const impact = await impactResponse.json() as any;
      assert.equal(impact.success, true, impact.error);
      assert.deepEqual(impact.output.direct, ['src/service.ts']);
      assert.deepEqual(impact.output.transitive, ['src/consumer.ts']);

      const invalid = await post({ action: 'impact', path: '../outside.ts' });
      const rejected = await invalid.json() as any;
      assert.equal(invalid.status, 200);
      assert.equal(rejected.success, false);
      assert.match(rejected.error, /rester dans le workspace/);

      await fs.rm(path.join(workspace, 'src', 'service.ts'));
      const afterDeleteResponse = await post({ action: 'update' });
      const afterDelete = await afterDeleteResponse.json() as any;
      assert.equal(afterDelete.success, true, afterDelete.error);
      assert.equal(afterDelete.output.removed, 1);
      const finalStatus = await (await post({ action: 'status' })).json() as any;
      assert.equal(finalStatus.output.indexedFiles, 2);
      assert.equal(finalStatus.output.symbols, 2);
    });
  } finally {
    defaultToolRegistry.register(previousIndexTool);
    await fs.rm(indexData, { recursive: true, force: true });
  }
});

test('Long prompt attachment: server validates its identity and passes a bounded-read requirement to the agent', async () => {
  await withServer(3352, async (base, _dataDir, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/workspace/open', { path: ws });
    const settings = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: { attachmentBudgetChars: 1000 }, permissions: { write: 'allow' } }),
    });
    assert.equal(settings.status, 200);

    const requirements = [
      '- The agent must preserve the exact START_SENTINEL_MAZZ_PROMPT token.',
      '- The agent must preserve the exact MIDDLE_SENTINEL_MAZZ_PROMPT token.',
      '- The agent must preserve the exact END_SENTINEL_MAZZ_PROMPT token.',
    ];
    const requirementWordCount = requirements.reduce((total, line) => total + line.trim().split(/\s+/u).length, 0);
    const paddingWordCount = 50_000 - requirementWordCount;
    const beforePaddingWords = Math.floor(paddingWordCount / 2);
    const afterPaddingWords = paddingWordCount - beforePaddingWords;
    const fullText = [
      requirements[0],
      Array.from({ length: beforePaddingWords }, () => 'padding').join(' '),
      requirements[1],
      Array.from({ length: afterPaddingWords }, () => 'padding').join(' '),
      requirements[2],
    ].join('\n\n');
    assert.equal(fullText.trim().split(/\s+/u).length, 50_000);
    const uploaded = (await (await fetch(`${base}/api/attachments?name=long-prompt.txt`, { method: 'POST', body: fullText })).json()) as any;
    const attachmentId = uploaded.attachment.id as string;
    assert.equal(uploaded.attachment.chars, fullText.length);
    assert.equal(uploaded.attachment.textSha256, createHash('sha256').update(fullText, 'utf8').digest('hex'));
    const sessionId = ((await (await post('/api/sessions', { title: 'Long prompt', projectRoot: ws })).json()) as any).session.id as string;

    const compilationResponse = await post('/api/prompt-ledger/compile', { attachmentId, sessionId });
    assert.equal(compilationResponse.status, 200, await compilationResponse.clone().text());
    const compilation = await compilationResponse.json() as any;
    assert.equal(compilation.source.attachmentId, attachmentId);
    assert.equal(compilation.source.sourceTextSha256, uploaded.attachment.textSha256);
    assert.equal(compilation.source.sourceUtf16Length, fullText.length);
    assert.ok(compilation.analysis.candidateCount >= 1);
    assert.equal(compilation.analysis.llmUsed, false);
    assert.equal(compilation.analysis.extractionCompleteness, 'not_semantically_exhaustive');

    const candidatePage = await (await fetch(`${base}/api/prompt-ledger?sessionId=${encodeURIComponent(sessionId)}&sourceId=${encodeURIComponent(compilation.source.sourceId)}&limit=20`)).json() as any;
    assert.equal(candidatePage.total, compilation.analysis.candidateCount);
    assert.ok(candidatePage.items.some((item: any) => item.text.includes('END_SENTINEL_MAZZ_PROMPT')));
    assert.ok(candidatePage.items.every((item: any) => item.status === 'Candidate'));

    const requirement = candidatePage.items.find((item: any) => item.text.includes('END_SENTINEL_MAZZ_PROMPT'));
    assert.ok(requirement);
    const requirementUrl = `${base}/api/prompt-ledger/requirements/${encodeURIComponent(requirement.id)}`;
    const readRequirement = await fetch(`${requirementUrl}?sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(readRequirement.status, 200);
    assert.equal(((await readRequirement.json()) as any).requirement.version, 1);
    const otherWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-prompt-other-ws-'));
    try {
      const otherSessionId = ((await (await post('/api/sessions', { title: 'Other workspace', projectRoot: otherWorkspace })).json()) as any).session.id as string;
      const hidden = await fetch(`${requirementUrl}?sessionId=${encodeURIComponent(otherSessionId)}`);
      assert.equal(hidden.status, 404);
      const crossWorkspaceMutation = await fetch(requirementUrl, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: otherSessionId, status: 'Extracted', expectedVersion: 1 }),
      });
      assert.equal(crossWorkspaceMutation.status, 404);
    } finally {
      await fs.rm(otherWorkspace, { recursive: true, force: true });
    }

    const outsideEvidence = path.join(path.dirname(ws), `${path.basename(ws)}-outside-evidence.txt`);
    await fs.writeFile(outsideEvidence, 'outside workspace evidence');
    const rejectOutside = await fetch(requirementUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status: 'Extracted', expectedVersion: 1, evidence: [{ kind: 'implementation', path: outsideEvidence, description: 'must be refused' }] }),
    });
    assert.equal(rejectOutside.status, 403);
    await fs.rm(outsideEvidence, { force: true });

    const extracted = await fetch(requirementUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status: 'Extracted', expectedVersion: 1, actor: 'integration-test' }),
    });
    assert.equal(extracted.status, 200, await extracted.clone().text());
    const extractedRecord = await extracted.json() as any;
    assert.equal(extractedRecord.requirement.status, 'Extracted');
    assert.equal(extractedRecord.requirement.version, 2);
    assert.equal(extractedRecord.history.at(-1).toStatus, 'Extracted');

    const implementationEvidence = path.join(ws, 'prompt-implementation.txt');
    await fs.writeFile(implementationEvidence, 'Observed implementation artifact for the scoped prompt requirement.');
    const confirmed = await fetch(requirementUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status: 'Confirmed', expectedVersion: 2, evidence: [{ kind: 'implementation', path: implementationEvidence, description: 'Physical workspace artifact' }] }),
    });
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const confirmedRecord = await confirmed.json() as any;
    assert.equal(confirmedRecord.requirement.status, 'Confirmed');
    assert.equal(confirmedRecord.requirement.evidence.length, 1);
    assert.match(confirmedRecord.requirement.evidence[0].sha256, /^[a-f0-9]{64}$/u);

    const stale = await fetch(requirementUrl, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, status: 'Planned', expectedVersion: 2 }),
    });
    assert.equal(stale.status, 409);

    const mismatched = await post('/api/agent/run', {
      sessionId, goal: 'Applique ce prompt', mode: 'agent', attachments: [], requiredPromptAttachmentId: attachmentId,
      selection: { providerId: 'deterministic-test', modelId: 'm' },
    });
    assert.equal(mismatched.status, 400);
    assert.match(await mismatched.text(), /pièce jointe du prompt/i);

    const { defaultProviderRegistry } = await import('@mazz/providers');
    const det = defaultProviderRegistry.get('deterministic-test') as any;
    const inlineCharacters = 1000;
    const pageSize = 20_000;
    const promptPageCalls = Array.from(
      { length: Math.ceil((fullText.length - inlineCharacters) / pageSize) },
      (_, index) => ({
        toolCall: {
          id: `read-page-${index}`,
          name: 'attachments.read',
          arguments: { id: attachmentId, offset: inlineCharacters + index * pageSize, length: pageSize },
        },
      }),
    );
    const lastPromptPageCallId = promptPageCalls.at(-1)!.toolCall.id;
    const planAfterRead = {
      objective: 'Appliquer le prompt après lecture complète.',
      constraints: ['Rester dans le workspace.'],
      acceptanceCriteria: ['result.txt contient END_SENTINEL_MAZZ_PROMPT lu dans le prompt.'],
      items: [{ id: 'write-result', content: 'Écris result.txt avec fs.write.', dependencies: [], status: 'in_progress' }],
    };
    det.setScript([
      { toolCall: { id: 'premature-plan', name: 'plan.update', arguments: planAfterRead } },
      ...promptPageCalls,
      { toolCall: { id: 'read-requirement-page', name: 'prompt.requirements.read', arguments: { sourceId: compilation.source.sourceId, offset: 0, limit: 20 } } },
      { toolCall: { id: 'plan-after-read', name: 'plan.update', arguments: planAfterRead } },
      { toolCall: { id: 'write-after-read', name: 'fs.write', arguments: { path: 'result.txt', content: 'END_SENTINEL_MAZZ_PROMPT' } } },
      { message: 'Prompt lu intégralement et résultat vérifié.' },
    ]);
    const { events } = await readSse(await post('/api/agent/run', {
      sessionId, goal: 'Applique ce prompt', mode: 'agent', attachments: [attachmentId], requiredPromptAttachmentId: attachmentId,
      selection: { providerId: 'deterministic-test', modelId: 'm' },
    }));
    det.setScript([]);

    const planResult = events.find((event) => event.type === 'tool_result' && event.callId === 'premature-plan');
    assert.equal(planResult?.success, false, JSON.stringify(events));
    assert.match(planResult?.error ?? '', /pièces jointes|lis d’abord|lecture/i);
    const readResult = events.find((event) => event.type === 'tool_result' && event.callId === lastPromptPageCallId);
    assert.equal(readResult?.success, true, JSON.stringify(events));
    assert.equal(readResult.output.total, fullText.length);
    assert.equal(readResult.output.done, true);
    assert.match(readResult.output.text, /END_SENTINEL_MAZZ_PROMPT/);
    const pageResults = events.filter((event) => event.type === 'tool_result' && event.toolName === 'attachments.read' && event.success)
      .map((event) => event.output).sort((left, right) => left.offset - right.offset);
    assert.equal(pageResults.length, promptPageCalls.length);
    let nextOffset = inlineCharacters;
    for (const page of pageResults) {
      assert.equal(page.offset, nextOffset);
      assert.equal(page.length, page.text.length);
      assert.equal(page.textSha256, uploaded.attachment.textSha256);
      nextOffset += page.length;
    }
    assert.equal(nextOffset, fullText.length);
    const reconstructedPrompt = fullText.slice(0, inlineCharacters) + pageResults.map((page) => page.text).join('');
    assert.equal(reconstructedPrompt, fullText);
    assert.equal(createHash('sha256').update(reconstructedPrompt, 'utf8').digest('hex'), uploaded.attachment.textSha256);
    const requirementResult = events.find((event) => event.type === 'tool_result' && event.callId === 'read-requirement-page');
    assert.equal(requirementResult?.success, true, JSON.stringify(requirementResult));
    assert.equal(requirementResult.output.total, compilation.analysis.candidateCount);
    assert.ok(requirementResult.output.items.some((item: any) => item.text.includes('END_SENTINEL_MAZZ_PROMPT')));
    const acceptedPlan = events.find((event) => event.type === 'tool_result' && event.callId === 'plan-after-read');
    assert.equal(acceptedPlan?.success, true, JSON.stringify(events));
    const writeResult = events.find((event) => event.type === 'tool_result' && event.callId === 'write-after-read');
    assert.equal(writeResult?.success, true, JSON.stringify(events));
    assert.equal(await fs.readFile(path.join(ws, 'result.txt'), 'utf8'), 'END_SENTINEL_MAZZ_PROMPT');
    assert.ok(events.some((event) => event.type === 'complete' && event.success));
  });
});

test('Vision: image attachment withheld from a model without vision, with the reason shown', async () => {
  await withServer(3350, async (base, _d, ws) => {
    const post = (u: string, b: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    await post('/api/workspace/open', { path: ws });
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const up = (await (await fetch(`${base}/api/attachments?name=capture.png`, { method: 'POST', body: png })).json()) as any;
    assert.equal(up.attachment.kind, 'image');
    const { events } = await readSse(await post('/api/agent/run', { goal: 'décris', mode: 'ask', attachments: [up.attachment.id], selection: { providerId: 'deterministic-test', modelId: 'm' } }));
    const st = events.find((e) => e.type === 'status' && e.stage === 'vision');
    assert.match(st.message, /non transmises/);
  });
});

test('Compaction: older turns replaced by a summary, recent ones kept in history', async () => {
  await withServer(3351, async (base, _d, ws) => {
    const post = (u: string, b?: unknown) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) });
    await post('/api/workspace/open', { path: ws });
    const { defaultProviderRegistry } = await import('@mazz/providers');
    const det = defaultProviderRegistry.get('deterministic-test') as any;
    const sid = ((await (await post('/api/sessions', { title: 'C', projectRoot: ws })).json()) as any).session.id;
    for (let i = 0; i < 4; i++) {
      det.setScript([{ message: `réponse ${i}` }]);
      await readSse(await post('/api/agent/run', { sessionId: sid, goal: `demande ${i}`, mode: 'ask', selection: { providerId: 'deterministic-test', modelId: 'm' } }));
    }
    det.setScript([{ message: 'Résumé : demandes 0 et 1 traitées.' }]);
    const r = await post(`/api/sessions/${sid}/compact`);
    assert.equal(r.status, 200);
    const s = ((await r.json()) as any).session;
    assert.equal(s.summarizedTurns, 2);
    assert.match(s.summary, /demandes 0 et 1/);
    det.setScript([]);
    assert.equal((await post(`/api/sessions/${sid}/compact`)).status, 400);
  });
});
