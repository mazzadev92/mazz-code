// Realistic agent bench: fix a bug, add a function with its tests, understand an unknown project.
// Each task starts from a fresh copy of its fixture and is scored by a hidden check (tests the agent
// never saw, or exact facts in the answer). The same tasks run through the real Studio server with any
// provider (local GGUF, DeepSeek, Gemini, OpenAI, Anthropic...) or through Claude Code (`claude -p`).
//
// Studio, local model:  node scripts/agent-bench/run.mjs <out> --runner studio --provider llama-local --model D:\TESSERA\Mgguf\Qwen_Qwen3-4B-Q4_K_M.gguf
// Studio, API:          node scripts/agent-bench/run.mjs <out> --runner studio --provider deepseek-api --model deepseek-chat --key-env DEEPSEEK_API_KEY
//                       (or --key-file <file holding only the key>; --list-models 1 prints the provider's models and exits)
//                       (google-gemini + gemini-2.5-pro, openai-api, anthropic-claude ... same way)
// Claude Code:          node scripts/agent-bench/run.mjs <out> --runner claude
// Options: --tasks bugfix-textstats,feature-median,understand-shop  --profile auto|small|large  --timeout-min 20
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outDir = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'agent-bench-out');
const runner = opt('runner', 'studio');
const providerId = opt('provider', 'llama-local');
const modelArg = opt('model', '');
const keyEnv = opt('key-env', '');
// --key-file: a file holding only the API key (kept out of the command line and of any log).
const keyFile = opt('key-file', '');
const profile = opt('profile', 'auto');
// --reasoning on|auto|off: thinking of hybrid local models (Qwen3), off by default in the Studio for speed.
const reasoning = opt('reasoning', '');
// --reasoning-budget N: thinking tokens per reply (Studio default 512).
const reasoningBudget = opt('reasoning-budget', '');
// --ctx N: context of the local model (smaller when the Studio's memory guard refuses 16384).
const ctx = Number(opt('ctx', '16384'));
const timeoutMs = Number(opt('timeout-min', '20')) * 60_000;
mkdirSync(outDir, { recursive: true });

const TASKS = {
  'bugfix-textstats': {
    mode: 'agent',
    prompt: 'Les tests de tests/test_core.py échouent. Trouve la cause dans textstats/core.py et corrige-la, sans modifier les tests. Lance ensuite les tests pour vérifier.',
    score: (ws) => hidden(ws, 'bugfix-textstats.py'),
  },
  'feature-median': {
    mode: 'agent',
    prompt: 'Ajoute une fonction median(values) à stats.py : médiane d’une liste de nombres (moyenne des deux valeurs centrales si la taille est paire), sans modifier la liste reçue, et ValueError si la liste est vide. Ajoute ses tests dans tests/test_stats.py et vérifie qu’ils passent.',
    score: (ws) => hidden(ws, 'feature-median.py'),
  },
  'understand-shop': {
    mode: 'ask',
    prompt: 'Explore ce projet. Quelle fonction calcule le total TTC d’un panier (donne son nom exact et son fichier), quel taux de TVA s’applique aux livres, et à partir de quel montant la livraison est-elle gratuite ?',
    score: (_ws, answer) => {
      const checks = [/cart_total_ttc/, /cart\.py/, /5[,.]5\s*%|0[,.]055/, /\b50\b/];
      const hit = checks.filter((re) => re.test(answer)).length;
      return { pass: hit === checks.length, detail: `${hit}/${checks.length} faits exacts` };
    },
  },
};
const selected = opt('tasks', Object.keys(TASKS).join(',')).split(',');

function hidden(ws, file) {
  const r = spawnSync('python', [path.join(here, 'hidden', file)], { cwd: ws, encoding: 'utf8', timeout: 120_000 });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  return { pass: r.status === 0, detail: tail.slice(0, 300) };
}

function freshWorkspace(task, label) {
  const ws = path.join(outDir, `${label}-${task}`);
  cpSync(path.join(here, 'fixtures', task), ws, { recursive: true });
  return ws;
}

// ---------------------------------------------------------------- Claude Code
async function runClaude(task, ws) {
  const t = TASKS[task];
  const args = ['-p', t.prompt, '--output-format', 'json', '--permission-mode', t.mode === 'ask' ? 'plan' : 'acceptEdits', '--allowedTools', 'Bash(python:*)'];
  const started = Date.now();
  const r = spawnSync('claude', args, { cwd: ws, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' });
  let answer = '';
  let parsed;
  try { parsed = JSON.parse(r.stdout); answer = parsed.result ?? ''; } catch { answer = r.stdout ?? ''; }
  // An API or login error (expired session: 401) means Claude Code never worked on the task: not measured.
  if (parsed?.is_error) return { answer: '', seconds: Math.round((Date.now() - started) / 1000), unmeasured: `Claude Code en erreur : ${String(parsed.result).slice(0, 200)}` };
  return { answer, seconds: Math.round((Date.now() - started) / 1000), error: r.status === 0 ? undefined : (r.stderr || r.error?.message || `code ${r.status}`).slice(0, 300) };
}

// ---------------------------------------------------------------- Studio
let base;
let server;
async function request(method, route, body, ms = 60_000) {
  const r = await fetch(`${base}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function startStudio() {
  const { MazzServer } = await import('../../packages/core/dist/index.js');
  const port = 3345;
  base = `http://127.0.0.1:${port}`;
  server = new MazzServer({ port, host: '127.0.0.1', dataDir: path.join(outDir, 'server-data') });
  await server.start();
  const local = providerId === 'llama-local' || providerId === 'lm-studio' || providerId === 'ollama';
  await request('PUT', '/api/settings', {
    ai: { executionMode: local ? 'local_strict' : 'cloud', defaultProviderId: providerId, confirmRemoteSend: false },
    agent: { defaultMode: 'agent', maxConcurrentTasks: 1, autoCompact: false, memory: false, projectInstructions: false, modelProfile: profile },
    access: { mode: 'project', extraRoots: [] },
    // Commands are asked, then approved only when they run Python on the task's files (never pip, npm, installs).
    permissions: { write: 'allow', delete: 'deny', terminal: 'ask', git: 'deny', network: local ? 'deny' : 'allow', web: 'deny', mcp: 'deny' },
    knowledge: { autoContext: false },
    ...(reasoning ? { models: { acceleration: { reasoning, ...(reasoningBudget ? { reasoningBudget: Number(reasoningBudget) } : {}) } } } : {}),
  });
  if (keyEnv || keyFile) {
    const key = (keyFile ? readFileSync(keyFile, 'utf8') : process.env[keyEnv] ?? '').trim();
    if (!key) throw new Error(`clé API absente (${keyFile || keyEnv})`);
    await request('PUT', `/api/providers/${providerId}/key`, { key });
  }
  if (opt('list-models', '') === '1') {
    const models = await request('GET', `/api/providers/${providerId}/models`).catch((e) => ({ error: e.message }));
    console.log(JSON.stringify(models).slice(0, 4000));
    await server.stop?.();
    process.exit(0);
  }
  if (providerId === 'llama-local') {
    await request('POST', '/api/models/server/start', {
      modelPath: modelArg, binaryPath: process.env.MAZZ_LLAMA_SERVER || 'llama-server',
      port: 8094, contextSize: ctx, threads: 4, gpuLayers: 0, jinja: true, kvCacheType: 'q8_0',
    }, 300_000);
  }
}

async function runStudio(task, ws) {
  const t = TASKS[task];
  const modelId = providerId === 'llama-local' ? path.basename(modelArg) : modelArg;
  await request('POST', '/api/workspace/open', { path: ws });
  const { session } = await request('POST', '/api/sessions', { projectRoot: ws, providerId, modelId, mode: t.mode, title: task });
  const started = Date.now();
  const response = await fetch(`${base}/api/agent/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, goal: t.prompt, mode: t.mode, selection: { providerId, modelId } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new Error(`run -> ${response.status} ${await response.text()}`);
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let tools = 0;
  let complete;
  const events = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (!ev?.type) continue;
      if (ev.type !== 'token' && ev.type !== 'thought' && ev.type !== 'progress') events.push(ev);
      if (ev.type === 'token') answer += ev.delta;
      if (ev.type === 'tool_result') tools++;
      // Writes are allowed by the bench settings. A command is approved once only if it runs Python on project
      // files: no package installation, no other program, nothing outside the copy of the fixture.
      if (ev.type === 'approval_request') {
        const command = String(ev.params?.command ?? '');
        const safe = ev.category === 'terminal' ? /^\s*(python|py)(\s+-m\s+(unittest|pytest))?\s+[\w./\\-]+(\s+[\w.:-]+)*\s*$/i.test(command) && !/\bpip\b|install/i.test(command) : ev.category !== 'delete';
        await request('POST', '/api/agent/approve', { approvalId: ev.callId, approved: safe, scope: 'once' }).catch(() => undefined);
      }
      if (ev.type === 'question') await request('POST', '/api/agent/answer', { questionId: ev.callId, answer: ev.options?.[0] ?? 'Continue.' }).catch(() => undefined);
      if (ev.type === 'complete') complete = ev;
    }
    if (complete) break;
  }
  writeFileSync(`${ws}_events.json`, JSON.stringify(events, null, 1));
  const text = answer.replace(/<think>[\s\S]*?<\/think>/g, '') || complete?.summary || '';
  return { answer: text, seconds: Math.round((Date.now() - started) / 1000), tools, error: complete?.success === false ? complete.summary?.slice(0, 300) : undefined };
}

// ---------------------------------------------------------------- main
const label = runner === 'claude' ? 'claude-code' : `${providerId}-${path.basename(modelArg || 'model').replace(/\.gguf$/i, '')}`;
const results = [];
try {
  if (runner === 'studio') await startStudio();
  for (const task of selected) {
    if (!TASKS[task]) throw new Error(`tâche inconnue : ${task}`);
    const ws = freshWorkspace(task, label);
    let run;
    try {
      run = runner === 'claude' ? await runClaude(task, ws) : await runStudio(task, ws);
    } catch (err) {
      run = { answer: '', seconds: 0, error: String(err?.message ?? err).slice(0, 300) };
    }
    if (run.unmeasured) {
      results.push({ runner: label, task, pass: null, detail: run.unmeasured, seconds: run.seconds });
      console.log(`${label}  ${task}  NON MESURÉ  ${run.unmeasured}`);
      continue;
    }
    const score = TASKS[task].score(ws, run.answer);
    const row = { runner: label, task, pass: score.pass, detail: score.detail, seconds: run.seconds, tools: run.tools, error: run.error };
    results.push(row);
    console.log(`${label}  ${task}  ${row.pass ? 'RÉUSSI' : 'ÉCHEC'}  ${row.seconds} s${row.tools !== undefined ? `  ${row.tools} outils` : ''}  ${row.detail}${row.error ? `  [${row.error}]` : ''}`);
    writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(results, null, 2));
  }
} finally {
  if (runner === 'studio' && base) {
    if (providerId === 'llama-local') await request('POST', '/api/models/server/stop', {}).catch(() => undefined);
    await server?.stop?.();
  }
}
const ok = results.filter((r) => r.pass).length;
const measured = results.filter((r) => r.pass !== null).length;
console.log(`${label} : ${ok}/${measured} tâches réussies${measured < results.length ? ` (${results.length - measured} non mesurée(s))` : ''}`);
process.exit(0);
