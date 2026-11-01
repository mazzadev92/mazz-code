import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { defaultProviderRegistry, type ChatOptions } from '@mazz/providers';
import type { ChatMessage, ToolDefinition } from '@mazz/shared';
import { AttachmentStore, type AttachmentUrlRequest } from './attachments.js';
import { MazzServer } from './index.js';

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function postJson(base: string, route: string, value: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

test('URL attachment uses the pinned transport, persists provenance, and reaches the actual agent prompt', async () => {
  const html = '<!doctype html><html><head><title>Règles du projet</title></head><body><main><h1>Règles du projet</h1><p>URL_SENTINEL_EUROPE_2026</p></main></body></html>';
  const htmlBytes = Buffer.from(html, 'utf-8');
  let fixturePort = 0;
  const fixtureRequests: string[] = [];
  const fixture = createServer((req, res) => {
    fixtureRequests.push(req.url ?? '/');
    if (req.url === '/redirect-public') {
      res.writeHead(302, { Location: `http://93.184.216.34:${fixturePort}/doc` });
      res.end();
      return;
    }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { Location: `http://127.0.0.1:${fixturePort}/private` });
      res.end();
      return;
    }
    if (req.url === '/binary') {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '4' });
      res.end('%PDF');
      return;
    }
    if (req.url === '/oversized') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(5 * 1024 * 1024 + 1) });
      res.end('x');
      return;
    }
    if (req.url === '/doc') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(htmlBytes.length) });
      res.end(htmlBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  fixturePort = await listen(fixture);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-url-attachment-data-'));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-url-attachment-ws-'));
  const appPortServer = createServer();
  const appPort = await listen(appPortServer);
  await close(appPortServer);

  const fetchCalls: Array<{ url: string; address: string; timeoutMs: number }> = [];
  // This test-only transport seam maps the validated public URL to a local HTTP
  // fixture. Production continues to use requestPinnedAddress from web-tools.ts.
  const attachmentUrlRequest: AttachmentUrlRequest = async (url, address, init, timeoutMs) => {
    fetchCalls.push({ url: url.toString(), address, timeoutMs: timeoutMs ?? 0 });
    const fixtureUrl = new URL(`${url.pathname}${url.search}`, `http://127.0.0.1:${fixturePort}`);
    return fetch(fixtureUrl, { ...init, redirect: 'manual' });
  };
  const app = new MazzServer({
    port: appPort,
    host: '127.0.0.1',
    dataDir,
    webRoot: path.join(dataDir, 'no-web'),
    attachmentUrlRequest,
  });
  const provider = defaultProviderRegistry.get('deterministic-test');
  assert.ok(provider, 'the deterministic provider must be available inside node:test only');
  const originalChatStream = provider.chatStream.bind(provider);
  const observedMessages: ChatMessage[] = [];

  try {
    await app.start();
    const base = `http://127.0.0.1:${appPort}`;

    const strictMode = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/doc` });
    assert.equal(strictMode.status, 403);
    assert.equal(fetchCalls.length, 0, 'local strict must block before any network transport');

    const settings = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai: { executionMode: 'hybrid_opt_in' } }),
    });
    assert.equal(settings.status, 200);

    const deniedPolicy = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { web: 'deny' } }),
    });
    assert.equal(deniedPolicy.status, 200);
    const deniedByPolicy = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/doc` });
    assert.equal(deniedByPolicy.status, 403);
    assert.equal(fetchCalls.length, 0, 'an explicit web deny policy must block before transport');

    const allowPolicy = await fetch(`${base}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissions: { web: 'allow' } }),
    });
    assert.equal(allowPolicy.status, 200);

    const unsupportedScheme = await postJson(base, '/api/attachments/url', { url: 'file:///etc/passwd' });
    assert.equal(unsupportedScheme.status, 400);
    const credentials = await postJson(base, '/api/attachments/url', { url: 'https://user:password@example.org/doc' });
    assert.equal(credentials.status, 400);

    const privateTarget = await postJson(base, '/api/attachments/url', { url: `http://127.0.0.1:${fixturePort}/doc` });
    assert.equal(privateTarget.status, 403);
    assert.equal(fetchCalls.length, 0, 'private destinations must be refused before the injected transport');

    const privateRedirect = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/redirect-private` });
    assert.equal(privateRedirect.status, 403, await privateRedirect.text());
    assert.equal(fetchCalls.length, 1, 'the public first hop may be read, but the private redirect must not be fetched');
    assert.ok(!fixtureRequests.includes('/private'));

    const binary = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/binary` });
    assert.equal(binary.status, 415);
    const oversized = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/oversized` });
    assert.equal(oversized.status, 413);

    const imported = await postJson(base, '/api/attachments/url', { url: `http://93.184.216.34:${fixturePort}/redirect-public` });
    assert.equal(imported.status, 200);
    const { attachment } = await imported.json() as { attachment: {
      id: string; name: string; sizeBytes: number; mime: string; chars: number;
      sourceSha256: string; textSha256?: string; extractionStatus: string;
      sourceUrl: string; finalUrl: string; fetchedAt: number;
    } };
    assert.match(attachment.id, /^att_[a-z0-9]+$/);
    assert.equal(attachment.mime, 'text/html');
    assert.equal(attachment.sizeBytes, htmlBytes.length);
    assert.equal(attachment.sourceSha256, sha256(htmlBytes));
    assert.ok(attachment.textSha256);
    assert.equal(attachment.extractionStatus, 'complete');
    assert.equal(attachment.sourceUrl, `http://93.184.216.34:${fixturePort}/redirect-public`);
    assert.equal(attachment.finalUrl, `http://93.184.216.34:${fixturePort}/doc`);
    assert.ok(attachment.fetchedAt > 0);
    assert.deepEqual(fetchCalls.slice(-2).map((call) => call.url), [
      `http://93.184.216.34:${fixturePort}/redirect-public`,
      `http://93.184.216.34:${fixturePort}/doc`,
    ]);
    assert.ok(fetchCalls.every((call) => call.address === '93.184.216.34' && call.timeoutMs === 15000));

    const metaResponse = await fetch(`${base}/api/attachments/${attachment.id}`);
    assert.equal(metaResponse.status, 200);
    assert.equal((await metaResponse.json() as any).attachment.sourceUrl, attachment.sourceUrl);
    const textResponse = await fetch(`${base}/api/attachments/${attachment.id}/text`);
    const persistedText = await textResponse.json() as { text: string; textSha256: string };
    assert.equal(persistedText.textSha256, attachment.textSha256);
    assert.ok(persistedText.text.includes('URL_SENTINEL_EUROPE_2026'));
    assert.ok(persistedText.text.includes(attachment.sourceUrl));
    const rawResponse = await fetch(`${base}/api/attachments/${attachment.id}/raw`);
    assert.deepEqual(Buffer.from(await rawResponse.arrayBuffer()), htmlBytes);

    // The Composer's remove action must wait for this real route to delete the
    // stored attachment. Verify both the API acknowledgement and bytes on disk.
    const disposableBytes = Buffer.from('ATTACHMENT_DELETE_SENTINEL_2026', 'utf8');
    const uploaded = await fetch(`${base}/api/attachments?name=${encodeURIComponent('to-delete.txt')}`, {
      method: 'POST', body: disposableBytes,
    });
    assert.equal(uploaded.status, 200);
    const disposable = (await uploaded.json() as { attachment: { id: string; sourceSha256: string } }).attachment;
    assert.equal(disposable.sourceSha256, sha256(disposableBytes));
    const storedOriginal = path.join(dataDir, 'attachments', disposable.id, 'original');
    assert.deepEqual(await fs.readFile(storedOriginal), disposableBytes);
    const deleted = await fetch(`${base}/api/attachments/${disposable.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true });
    await assert.rejects(fs.access(storedOriginal), { code: 'ENOENT' });
    assert.equal((await fetch(`${base}/api/attachments/${disposable.id}`)).status, 404);

    const restartedStore = new AttachmentStore(path.join(dataDir, 'attachments'));
    const restartedMeta = await restartedStore.meta(attachment.id);
    assert.equal(restartedMeta.sourceSha256, attachment.sourceSha256);
    assert.equal(await restartedStore.text(attachment.id), persistedText.text);
    const rendered = await restartedStore.renderForPrompt([attachment.id], 30000);
    assert.ok(rendered.text.includes(attachment.sourceUrl));
    assert.ok(rendered.text.includes(attachment.finalUrl));
    assert.ok(rendered.text.includes('URL_SENTINEL_EUROPE_2026'));

    // Capture the actual provider input while delegating to the real test-only
    // deterministic provider, proving the server's agent path includes the page.
    provider.chatStream = async function* (messages: ChatMessage[], tools: ToolDefinition[], options: ChatOptions) {
      observedMessages.push(...messages.map((message) => ({ ...message })));
      yield* originalChatStream(messages, tools, options);
    };
    const opened = await postJson(base, '/api/workspace/open', { path: workspace });
    assert.equal(opened.status, 200);
    const created = await postJson(base, '/api/sessions', { title: 'URL attachment', projectRoot: workspace });
    assert.equal(created.status, 200);
    const { session } = await created.json() as { session: { id: string } };
    const run = await postJson(base, '/api/agent/run', {
      sessionId: session.id,
      goal: 'Résume la page jointe et cite sa provenance.',
      mode: 'ask',
      attachments: [attachment.id],
      selection: { providerId: 'deterministic-test', modelId: 'mazz-deterministic-v1' },
    });
    assert.equal(run.status, 200);
    const events = await run.text();
    assert.match(events, /"type":"complete"/);
    const agentInput = observedMessages.map((message) => message.content).join('\n');
    assert.ok(agentInput.includes('URL_SENTINEL_EUROPE_2026'));
    assert.ok(agentInput.includes(attachment.sourceUrl));
    assert.ok(agentInput.includes(attachment.finalUrl));
  } finally {
    provider.chatStream = originalChatStream;
    await app.stop();
    await close(fixture);
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
