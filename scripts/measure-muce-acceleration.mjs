// Real measurement: plain llama-server vs MUCE "superchargeur" flags, same binary, same model.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BIN = 'D:/MAZZ GPU ACX/dist/MUCE-v0.1.0/runtimes/llama-avx2/llama-server.exe';
const MODEL = process.argv[2] ?? 'D:/TESSERA/Mgguf/Qwen_Qwen3-1.7B-Q4_K_M.gguf';
const PORT = 8099;
const base = ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '--threads', '4', '--ctx-size', '4096', '--batch-size', '512', '--jinja', '--parallel', '1', '--reasoning', 'off'];
const CONFIGS = {
  ...(process.env.ONLY_MUCE16 ? {} : { baseline: [], muce: ['--spec-type', 'ngram-mod', '--spec-ngram-mod-n-match', '24', '--spec-ngram-mod-n-min', '4', '--spec-ngram-mod-n-max', '48', '--poll', '100', '--prio', '2'] }),
  ...(process.env.ONLY_MUCE16 ? { muce16: ['--spec-type', 'ngram-mod', '--spec-ngram-mod-n-match', '24', '--spec-ngram-mod-n-min', '4', '--spec-ngram-mod-n-max', '16', '--poll', '100', '--prio', '2'] } : {}),
  ...(process.env.FULL ? { pollprio: ['--poll', '100', '--prio', '2'] } : {}),
};

const code = fs.readFileSync('D:/Mazz Code/MAZZ_AGENT_STUDIO/packages/tools/src/terminal.ts', 'utf-8').split('\n').slice(0, 60).join('\n');
const PROMPTS = {
  ...(process.env.ONLY_CODE ? {} : { libre: 'Explique en détail, en 8 phrases, comment fonctionne la hiérarchie de caches d’un processeur moderne.',
  }),
  edition_code: `Voici un fichier TypeScript. Réécris-le en entier, à l’identique, en renommant seulement la classe TerminalRunTool en ShellTool. Réponds uniquement avec le code.\n\n\`\`\`ts\n${code}\n\`\`\``,
  ...(process.env.ONLY_CODE ? {} : { json: 'Génère un tableau JSON de 15 objets {"id": n, "nom": "item-n", "actif": true, "tags": ["a","b"]} avec n de 1 à 15. Réponds uniquement avec le JSON.' }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('not ready');
}

const results = [];
for (const [name, extra] of Object.entries(CONFIGS)) {
  const proc = spawn(BIN, [...base, ...extra], { stdio: 'ignore', windowsHide: true });
  try {
    await waitReady();
    // warm-up
    await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Bonjour' }], max_tokens: 8, temperature: 0 }) });
    for (const [pname, prompt] of Object.entries(PROMPTS)) {
      for (let rep = 0; rep < 2; rep++) {
        const t0 = Date.now();
        const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0, cache_prompt: false }),
        });
        const j = await r.json();
        const t = j.timings ?? {};
        results.push({ config: name, prompt: pname, rep, gen_tokens: t.predicted_n, tg_tok_s: +(t.predicted_per_second ?? 0).toFixed(2), pp_tok_s: +(t.prompt_per_second ?? 0).toFixed(1), prompt_tokens: t.prompt_n, draft_n: t.draft_n, draft_accepted: t.draft_n_accepted, wall_ms: Date.now() - t0 });
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  } finally {
    proc.kill();
    await sleep(1500);
  }
}
fs.writeFileSync(process.argv[3] ?? 'spec_bench.json', JSON.stringify({ model: MODEL, results }, null, 2));
