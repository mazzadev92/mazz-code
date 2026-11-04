// End-to-end Forge run through the real Studio server (isolated data dir): settings, Model Hub
// start of a GGUF with 4 llama.cpp slots, session, POST /api/agent/run mode=forge, SSE events.
// Usage: node scripts/forge-e2e-server.mjs <out dir> [gguf] [--keep]   (--keep leaves the server up for the UI)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MazzServer } from '../packages/core/dist/index.js';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const [outDir, modelPath = 'D:\\TESSERA\\Mgguf\\Qwen_Qwen3-0.6B-Q4_K_M.gguf'] = args.filter((a) => a !== '--keep');
const port = Number(process.env.MAZZ_FORGE_PORT || 3341);
const modelPort = Number(process.env.MAZZ_FORGE_MODEL_PORT || 8093);
const base = `http://127.0.0.1:${port}`;
const workspace = path.resolve(outDir, 'workspace');
mkdirSync(workspace, { recursive: true });

async function request(method, route, body, timeoutMs = 60_000) {
  const r = await fetch(`${base}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const server = new MazzServer({ port, host: '127.0.0.1', dataDir: path.resolve(outDir, 'server-data') });
await server.start();
await request('POST', '/api/workspace/open', { path: workspace });
await request('PUT', '/api/settings', {
  ai: { executionMode: 'local_strict', defaultProviderId: 'llama-local', defaultModelId: path.basename(modelPath) },
  agent: { defaultMode: 'forge', maxConcurrentTasks: 1, autoCompact: false, memory: false, projectInstructions: false },
  access: { mode: 'project', extraRoots: [] },
  permissions: { write: 'allow', delete: 'deny', terminal: 'allow', git: 'deny', network: 'deny', web: 'deny', mcp: 'deny' },
  knowledge: { home: 'D:\\Mazz Code\\Bib1', port: 8095, autoContext: false },
  models: { port: modelPort, contextSize: 16384, threads: 4, parallel: 4, gpuLayers: 0 },
});
const started = Date.now();
await request('POST', '/api/models/server/start', {
  modelPath, binaryPath: process.env.MAZZ_LLAMA_SERVER || 'llama-server',
  // q8_0 KV (flash attention on) halves the cache: 16384 tokens for 4 slots in about 1.6 GB.
  port: modelPort, contextSize: 16384, threads: 4, gpuLayers: 0, jinja: true, kvCacheType: 'q8_0',
}, 240_000);
const blueprints = await request('GET', '/api/forge/blueprints');
console.log(`modèle prêt en ${Date.now() - started} ms ; blueprints : ${blueprints.blueprints.map((b) => b.id).join(', ')}`);
const { session } = await request('POST', '/api/sessions', { projectRoot: workspace, providerId: 'llama-local', modelId: path.basename(modelPath), mode: 'forge', title: 'Forge CRC-32 Python+C' });

if (keep && process.env.MAZZ_FORGE_UI_ONLY) {
  console.log(`Serveur prêt pour l’interface : ${base} (session ${session.id})`);
} else {
  const goal = 'Crée un projet Python+C complet et compact de calcul CRC-32/ISO-HDLC sur des fichiers : cœur C, wrapper ctypes, CLI, tests et README.';
  const response = await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, goal, mode: 'forge', selection: { providerId: 'llama-local', modelId: path.basename(modelPath), executionMode: 'local_strict' } }),
    signal: AbortSignal.timeout(40 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`run -> ${response.status} ${await response.text()}`);
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (!ev.type) continue;
      events.push(ev);
      const t = ((Date.now() - started) / 1000).toFixed(0).padStart(5);
      if (ev.type === 'forge' && ['unit_done', 'verify', 'summary'].includes(ev.phase)) console.log(`${t}s [${ev.phase}] ${ev.unitId ?? ''} ${ev.detail ?? ''}`);
      if (ev.type === 'approval_request') console.log(`${t}s approbation demandée : ${ev.toolName}`);
      if (ev.type === 'error') console.log(`${t}s erreur ${ev.code} : ${ev.message}`);
      if (ev.type === 'complete') console.log(`${t}s complete success=${ev.success} : ${ev.summary}`);
    }
    if (events.some((e) => e.type === 'complete')) break;
  }
  writeFileSync(path.resolve(outDir, 'server-events.json'), JSON.stringify(events, null, 1));
}
if (!keep) {
  await request('POST', '/api/models/server/stop', {}).catch(() => undefined);
  await server.stop?.();
  process.exit(0);
}
