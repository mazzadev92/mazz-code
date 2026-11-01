// Runs MAZZ Forge against a live llama-server, outside the UI, and records every event.
// Usage: node scripts/forge-run.mjs <workspace> <llama base url> <model id> [goal]
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ExperienceStore, ForgeRunner } from '../packages/agent/dist/index.js';
import { OpenAiCompatibleProvider } from '../packages/providers/dist/index.js';
import { ToolRegistry } from '../packages/tools/dist/index.js';

const [workspace, baseUrl = 'http://127.0.0.1:8091', modelId = 'Qwen_Qwen3-0.6B-Q4_K_M.gguf',
  goal = 'Crée un projet Python+C complet de calcul CRC-32/ISO-HDLC sur des fichiers.'] = process.argv.slice(2);
if (!workspace) throw new Error('workspace manquant');
mkdirSync(workspace, { recursive: true });

// Bib1 search through its own CLI (imported sources included; their status is cited).
const BIB1 = process.env.MAZZ_BIB1 || 'D:\\Mazz Code\\Bib1';
const knowledgeSearch = (query) => new Promise((resolve) => {
  execFile('python', ['-m', 'mazz_knowledge', 'search', '--query', query, '--include-imports'], { cwd: BIB1, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, maxBuffer: 1 << 22 }, (_err, stdout) => {
    try { resolve(JSON.parse(stdout.slice(stdout.indexOf('[')))); } catch { resolve([]); }
  });
});
const provider = new OpenAiCompatibleProvider({ id: 'llama-forge', type: 'llama_cpp', name: 'llama.cpp', baseUrl: `${baseUrl}/v1`, locality: 'local' });
const events = [];
const started = Date.now();
for await (const ev of new ForgeRunner().run({
  taskId: `forge_${started}`, goal, workspaceRoot: path.resolve(workspace), provider, modelId,
  tools: new ToolRegistry(), permissionLevel: 'trusted_workspace', knowledgeSearch,
  blueprintDirs: [process.env.MAZZ_BLUEPRINTS || 'D:\\Mazz Code\\Bib1\\_BLUEPRINTS'],
  // Optional learned arm choice; unset = the fixed portfolio of the measured runs.
  experience: process.env.MAZZ_FORGE_EXPERIENCE ? new ExperienceStore(process.env.MAZZ_FORGE_EXPERIENCE).load() : undefined,
})) {
  events.push(ev);
  const t = ((ev.timestamp - started) / 1000).toFixed(1).padStart(6);
  if (ev.type === 'forge') {
    if (ev.phase === 'candidate') console.log(`${t}s  ${ev.unitId} #${ev.candidate} ${ev.strategy} ${ev.verdict}  ${ev.verdict === 'pass' ? '' : (ev.detail || '').slice(0, 140)}`);
    else console.log(`${t}s  [${ev.phase}] ${ev.unitId ?? ''} ${ev.detail ?? ''} ${ev.phase === 'unit_done' ? `(${ev.strategy}, ${ev.candidates} candidats)` : ''}`);
  } else if (ev.type === 'tool_result') console.log(`${t}s  outil ${ev.toolName} ${ev.success ? 'OK' : 'ECHEC'} ${ev.success ? '' : (ev.error || '').slice(0, 200)}`);
  else if (ev.type === 'error' || ev.type === 'complete') console.log(`${t}s  ${ev.type}: ${ev.message ?? ev.summary}`);
}
writeFileSync(path.join(workspace, '..', `${path.basename(workspace)}_events.json`), JSON.stringify(events, null, 1));
