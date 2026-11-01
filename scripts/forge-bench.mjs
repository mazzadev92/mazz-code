// Forge benchmark: the same tasks, several configurations, measured on a live llama-server.
// A task is a blueprint plus a difficulty variant:
//   standard  the blueprint as written;
//   hard      every `must` anchor removed, so wrong pieces pass the step checks and only compile/test
//             failures catch them (this is where repair and best-of-N matter);
//   coarse    one step per function listing all of its steps: the whole body is written at once.
// Usage: node scripts/forge-bench.mjs <out dir> [--url http://127.0.0.1:8091] [--model id]
//        [--tasks crc32-ctypes:hard,vecmath-ctypes:hard] [--configs repair,norepair] [--runs 1]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ForgeRunner, loadBlueprints } from '../packages/agent/dist/index.js';
import { OpenAiCompatibleProvider } from '../packages/providers/dist/index.js';
import { ToolRegistry } from '../packages/tools/dist/index.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outDir = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : 'forge-bench');
const baseUrl = opt('url', 'http://127.0.0.1:8091');
const modelId = opt('model', 'Qwen_Qwen3-0.6B-Q4_K_M.gguf');
const tasks = opt('tasks', 'crc32-ctypes:hard,vecmath-ctypes:hard').split(',').map((t) => t.split(':'));
const configs = opt('configs', 'repair,norepair').split(',');
const runs = Number(opt('runs', '1'));
const blueprintDir = process.env.MAZZ_BLUEPRINTS || 'D:\\Mazz Code\\Bib1\\_BLUEPRINTS';
mkdirSync(outDir, { recursive: true });

const blueprints = new Map(loadBlueprints([blueprintDir]).map((b) => [b.id, b]));
const variant = (bp, kind) => {
  if (kind === 'standard') return bp;
  if (kind === 'hard') return { ...bp, units: bp.units.map((u) => ({ ...u, steps: u.steps.map(({ must: _drop, ...s }) => s) })) };
  // coarse: each code unit gets one step listing all of its steps, so the model writes the whole body at once
  // (step-by-step scaffolding gone; only whole-body candidates and their repairs can pass).
  if (kind === 'coarse') return { ...bp, units: bp.units.map((u) => (u.lang === 'markdown' ? u : { ...u, steps: [{ text: u.steps.map((s) => s.text).join('; ') }] })) };
  throw new Error(`variante inconnue : ${kind}`);
};

const provider = new OpenAiCompatibleProvider({ id: 'llama-bench', type: 'llama_cpp', name: 'llama.cpp', baseUrl: `${baseUrl}/v1`, locality: 'local' });
const results = [];
for (let r = 1; r <= runs; r++) {
  for (const [id, kind = 'standard'] of tasks) {
    const bp = blueprints.get(id);
    if (!bp) throw new Error(`blueprint introuvable : ${id}`);
    for (const config of configs) {
      const label = `${id}:${kind}:${config}#${r}`;
      const workspace = path.join(outDir, label.replace(/[:#]/g, '_'));
      const started = Date.now();
      const units = new Map();
      let complete;
      let fatal;
      const events = [];
      try {
        for await (const ev of new ForgeRunner().run({
          taskId: `bench_${started}`, goal: bp.title, workspaceRoot: workspace, provider, modelId,
          tools: new ToolRegistry(), permissionLevel: 'trusted_workspace', blueprint: variant(bp, kind),
          repair: config !== 'norepair',
        })) {
          if (ev.type === 'forge') events.push(ev);
          if (ev.type === 'forge' && ev.phase === 'candidate') {
            const u = units.get(ev.unitId) ?? { candidates: 0, repairs: 0, done: false, winner: undefined };
            u.candidates++;
            if (ev.strategy === 'repair') u.repairs++;
            units.set(ev.unitId, u);
          }
          if (ev.type === 'forge' && ev.phase === 'unit_done') {
            const u = units.get(ev.unitId);
            u.done = true;
            u.winner = ev.strategy;
          }
          if (ev.type === 'complete') complete = ev;
        }
      } catch (err) {
        fatal = String(err?.message ?? err);
      }
      const all = [...units.values()];
      const row = {
        label, blueprint: id, variant: kind, config, run: r,
        success: Boolean(complete?.success), unitsDone: all.filter((u) => u.done).length, unitsTotal: bp.units.length,
        candidates: all.reduce((a, u) => a + u.candidates, 0), repairs: all.reduce((a, u) => a + u.repairs, 0),
        repairWins: all.filter((u) => u.winner === 'repair').length, seconds: Math.round((Date.now() - started) / 1000),
        failedUnit: [...units.entries()].find(([, u]) => !u.done)?.[0], fatal,
      };
      results.push(row);
      // Every candidate with its verdict, strategy and real error: what the repair saw and what it produced.
      writeFileSync(`${workspace}_events.json`, JSON.stringify(events, null, 1));
      console.log(`${label}  ${row.success ? 'OK ' : 'ECHEC'}  ${row.unitsDone}/${row.unitsTotal} unités  ${row.candidates} candidats  ${row.repairs} réparations (${row.repairWins} gagnantes)  ${row.seconds} s${row.failedUnit ? `  bloquée : ${row.failedUnit}` : ''}`);
      writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ model: modelId, date: new Date().toISOString(), results }, null, 2));
    }
  }
}

// Summary per task and configuration (all runs pooled).
const groups = new Map();
for (const row of results) {
  const key = `${row.blueprint}:${row.variant}:${row.config}`;
  const g = groups.get(key) ?? { runs: 0, ok: 0, units: 0, total: 0, candidates: 0, repairs: 0, repairWins: 0, seconds: 0 };
  g.runs++; g.ok += row.success ? 1 : 0; g.units += row.unitsDone; g.total += row.unitsTotal;
  g.candidates += row.candidates; g.repairs += row.repairs; g.repairWins += row.repairWins; g.seconds += row.seconds;
  groups.set(key, g);
}
const lines = [`# Banc Forge — ${modelId}`, '', `${new Date().toISOString()}, ${runs} passage(s) par configuration.`, '',
  '| Tâche | Réussites | Unités validées | Candidats (moy.) | Réparations (gagnantes) | Durée moy. |', '| :--- | :--- | :--- | :--- | :--- | :--- |'];
for (const [key, g] of groups) {
  lines.push(`| ${key} | ${g.ok}/${g.runs} | ${g.units}/${g.total} | ${Math.round(g.candidates / g.runs)} | ${g.repairs} (${g.repairWins}) | ${Math.round(g.seconds / g.runs)} s |`);
}
writeFileSync(path.join(outDir, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`\n${lines.join('\n')}`);
