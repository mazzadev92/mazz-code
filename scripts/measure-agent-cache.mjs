// Real measurement of the prompt-cost optimisations on a llama.cpp model.
// Starts an isolated Studio server (temporary data), then measures the first model
// call of agent tasks: tool profile full vs compact, session switch, and resume
// after a llama-server restart (per-session KV cache on disk).
//
//   node scripts/measure-agent-cache.mjs [model.gguf] [llama-server.exe]
// Output: docs/agent-cache-measurements.json

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.argv[2] || 'D:/TESSERA/Mgguf/Qwen_Qwen3-0.6B-Q4_K_M.gguf';
const BIN = process.argv[3] || 'D:/MAZZ GPU ACX/dist/MUCE-v0.1.0/runtimes/llama-avx2/llama-server.exe';
const PORT = 3361;
const BASE = `http://127.0.0.1:${PORT}`;

delete process.env.NoDefaultCurrentDirectoryInExePath;
const { MazzServer } = await import(new URL('../packages/core/dist/index.js', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'mazz-measure-'));
const ws = mkdtempSync(join(tmpdir(), 'mazz-measure-ws-'));
const server = new MazzServer({ port: PORT, dataDir, webRoot: join(root, 'apps/web/dist') });
await server.start();

const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${u} ${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t);
};

async function task(sessionId, goal) {
  const res = await fetch(`${BASE}/api/agent/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, goal, mode: 'ask', selection: { providerId: 'llama-local', modelId: 'local', maxOutputTokens: 48 } }) });
  const text = await res.text();
  const events = text.split('\n\n').map((b) => b.split('\n').find((l) => l.startsWith('data: {'))).filter(Boolean).map((l) => JSON.parse(l.slice(6)));
  const usage = events.filter((e) => e.type === 'usage').map((e) => e.telemetry);
  const kv = events.find((e) => e.type === 'status' && e.stage === 'kv-cache')?.message;
  const first = usage[0] ?? {};
  return { newPromptTokens: first.promptTokens, cachedTokens: first.cachedTokens ?? 0, prefillMs: first.promptMs ? Math.round(first.promptMs) : undefined, ttftMs: first.ttftMs, kv };
}

const results = { model: MODEL, date: new Date().toISOString(), steps: [] };
const log = (label, r) => {
  results.steps.push({ label, ...r });
  console.log(label.padEnd(58), JSON.stringify(r));
};

try {
  await call('POST', '/api/workspace/open', { path: ws });
  await call('PUT', '/api/settings', { models: { llamaServerPath: BIN, port: 8098, contextSize: 4096, kvPersist: true, parallel: 1, cacheRamMb: 512 } });
  const start = () => call('POST', '/api/models/server/start', { modelPath: MODEL });
  await start();

  // Long-ish shared history to make the session cache matter.
  const history = 'Contexte : le projet est un analyseur de journaux en C avec un module de parsing, un module de statistiques et des tests. '.repeat(30);
  const c = (await call('POST', '/api/sessions', { title: 'C', projectRoot: ws })).session.id;
  const a = (await call('POST', '/api/sessions', { title: 'A', projectRoot: ws })).session.id;
  const b = (await call('POST', '/api/sessions', { title: 'B', projectRoot: ws })).session.id;

  await call('PUT', '/api/settings', { agent: { toolProfile: 'full' } });
  log('1. Session C, schéma complet (froid)', await task(c, `${history}
Quel module tester en premier ? /no_think`));
  await call('PUT', '/api/settings', { agent: { toolProfile: 'compact' } });
  log('2. Session A, schéma compact, même demande', await task(a, `${history}
Quel module tester en premier ? /no_think`));
  log('3. Session B, compact (préfixe stable partagé)', await task(b, 'Explique la commande gcc -Wall. /no_think'));
  log('4. Session B, 2e message (même session)', await task(b, 'Et -O2 ? /no_think'));
  log('5. Retour session A (cache KV restauré)', await task(a, 'Résume la réponse précédente. /no_think'));
  await call('POST', '/api/models/server/stop', {});
  await start();
  log('6. Après redémarrage de llama-server, session A', await task(a, 'Et ensuite ? /no_think'));
  await call('PUT', '/api/settings', { models: { kvPersist: false } });
  await call('POST', '/api/models/server/stop', {});
  await start();
  log('7. Même chose sans cache KV disque (référence)', await task(a, 'Et après ? /no_think'));
  await call('POST', '/api/models/server/stop', {});
} finally {
  await server.stop();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
}
writeFileSync(join(root, 'docs', 'agent-cache-measurements.json'), JSON.stringify(results, null, 2));
console.log('Rapport : docs/agent-cache-measurements.json');
