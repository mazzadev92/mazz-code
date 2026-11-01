// Backend bench: speed, streaming and tool calling of any OpenAI-compatible endpoint
// (local llama-server, MAZZ Control, Kaggle/Colab tunnel, external API).
// Only measured numbers are written; a value the server does not report stays null.
//
//   node scripts/bench-backends.mjs --base http://127.0.0.1:7070/v1 --model Mazz-Technos-Base-4B-Abliterated.Q4_K_M
//   node scripts/bench-backends.mjs --base https://xxx.trycloudflare.com/v1 --model m --key-env MAZZ_CLOUD_KEY
// Options: --runs 3  --max-tokens 160  --out docs/bench  --timeout-s 600
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const base = opt('base', 'http://127.0.0.1:7070/v1').replace(/\/$/, '');
const model = opt('model', '');
const runs = Number(opt('runs', '3'));
const maxTokens = Number(opt('max-tokens', '160'));
const outDir = path.resolve(opt('out', 'docs/bench'));
const timeoutMs = Number(opt('timeout-s', '600')) * 1000;
const keyEnv = opt('key-env', '');
const key = keyEnv ? process.env[keyEnv] ?? '' : '';

const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };

const PROMPTS = [
  { id: 'code', text: 'Write a Python function is_prime(n) with a docstring. Code only.' },
  { id: 'explain', text: 'Explique en 5 phrases ce qu\'est un cache KV dans un LLM.' },
  { id: 'rewrite', text: 'Rewrite this loop as a list comprehension: out = []\nfor x in xs:\n    if x % 2 == 0:\n        out.append(x * x)' },
];

const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a text file of the project.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['path'],
    },
  },
};

async function streamOnce(prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = performance.now();
  let firstToken = null;
  let chunks = 0;
  let text = '';
  let timings = null;
  let usage = null;
  let wellFormed = true;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
        seed: 42,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok || !res.body) return { error: `HTTP ${res.status}` };
    const decoder = new TextDecoder();
    let buffer = '';
    let sawDone = false;
    for await (const part of res.body) {
      buffer += decoder.decode(part, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { sawDone = true; continue; }
        let obj;
        try { obj = JSON.parse(data); } catch { wellFormed = false; continue; }
        if (obj.timings) timings = obj.timings;
        if (obj.usage) usage = obj.usage;
        const delta = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.delta?.reasoning_content ?? '';
        if (delta) {
          if (firstToken === null) firstToken = performance.now();
          chunks += 1;
          text += delta;
        }
      }
    }
    const end = performance.now();
    const genSeconds = firstToken === null ? null : (end - firstToken) / 1000;
    const completion = usage?.completion_tokens ?? timings?.predicted_n ?? null;
    return {
      ttftMs: firstToken === null ? null : Math.round(firstToken - started),
      totalMs: Math.round(end - started),
      completionTokens: completion,
      promptTokens: usage?.prompt_tokens ?? timings?.prompt_n ?? null,
      // Server-reported speeds when present (llama.cpp timings), else derived from the stream.
      genTokPerSec: timings?.predicted_per_second ?? (completion && genSeconds ? completion / genSeconds : null),
      promptTokPerSec: timings?.prompt_per_second ?? null,
      speedSource: timings ? 'runtime_timings' : completion ? 'provider_usage' : 'unknown',
      streamConform: wellFormed && sawDone,
      chunks,
      chars: text.length,
    };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : String(e.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function toolCallOnce() {
  const started = performance.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        seed: 42,
        max_tokens: 200,
        tools: [TOOL],
        tool_choice: 'auto',
        messages: [{ role: 'user', content: 'Open the file src/main.py, lines 10 to 40.' }],
      }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    let args = null;
    let valid = false;
    if (call?.function?.name === 'read_file') {
      try {
        args = JSON.parse(call.function.arguments);
        valid = typeof args.path === 'string' && args.path.length > 0;
      } catch { valid = false; }
    }
    return {
      ms: Math.round(performance.now() - started),
      native: Boolean(call),
      name: call?.function?.name ?? null,
      validArgs: valid,
      args,
      textFallback: call ? null : (body.choices?.[0]?.message?.content ?? '').slice(0, 200),
    };
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const results = { base, model, date: new Date().toISOString(), host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, ramGb: Math.round(os.totalmem() / 2 ** 30) }, prompts: {}, tool: [] };
for (const p of PROMPTS) {
  results.prompts[p.id] = [];
  for (let i = 0; i < runs; i += 1) {
    const r = await streamOnce(p.text);
    results.prompts[p.id].push(r);
    console.log(p.id, i + 1, JSON.stringify(r));
  }
}
for (let i = 0; i < runs; i += 1) {
  const r = await toolCallOnce();
  results.tool.push(r);
  console.log('tool', i + 1, JSON.stringify(r));
}

const all = Object.values(results.prompts).flat();
results.summary = {
  ttftMsMedian: median(all.map((r) => r.ttftMs)),
  genTokPerSecMedian: median(all.map((r) => r.genTokPerSec)),
  promptTokPerSecMedian: median(all.map((r) => r.promptTokPerSec)),
  streamConform: `${all.filter((r) => r.streamConform).length}/${all.length}`,
  toolCallValid: `${results.tool.filter((r) => r.validArgs).length}/${results.tool.length}`,
  errors: all.filter((r) => r.error).length + results.tool.filter((r) => r.error).length,
};
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `backend-${model.replace(/[^A-Za-z0-9._-]/g, '_') || 'default'}-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log('SUMMARY', JSON.stringify(results.summary));
console.log('written', file);
