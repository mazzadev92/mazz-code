// UI demo server without any model: isolated data dir, scripted test engine that replays one
// agent turn (reasoning, plan, grouped tool calls, file write, long Markdown answer), slowed down
// so streaming can be watched. Usage: node scripts/ui-demo-server.mjs <out dir> [port, default 3360]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

process.env.MAZZ_TEST_PROVIDER = '1';
const { MazzServer } = await import('../packages/core/dist/index.js');
const { defaultProviderRegistry } = await import('../packages/providers/dist/index.js');

// 3350 is taken by the core tests; the demo stays off it.
const [outDir = 'ui-demo', portArg = '3360'] = process.argv.slice(2);
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const workspace = path.resolve(outDir, 'workspace');
mkdirSync(path.join(workspace, 'src'), { recursive: true });
writeFileSync(path.join(workspace, 'src', 'main.c'), '#include <stdio.h>\n\nint main(void) {\n    printf("bonjour\\n");\n    return 0;\n}\n');
writeFileSync(path.join(workspace, 'README.md'), '# Démo\n\nProjet de démonstration de l’interface.\n');

const plan = (statuses, initial = false) => ({
  ...(initial ? { objective: 'Ajouter une fonction de somme et la vérifier.', constraints: ['Rester dans le workspace.'], acceptanceCriteria: ['Le fichier compile.'] } : {}),
  items: [
    { id: 's1', content: 'Lire src/main.c avec fs.read', dependencies: [], status: statuses[0] },
    { id: 's2', content: 'Écrire src/somme.c avec fs.write', dependencies: ['s1'], status: statuses[1] },
    { id: 's3', content: 'Relire src/somme.c avec fs.read', dependencies: ['s2'], status: statuses[2] },
  ],
});
const answer = [
  '## Résultat', '',
  'La fonction `somme` est ajoutée dans `src/somme.c`. Elle additionne les entiers d’un tableau et renvoie 0 pour un tableau vide.', '',
  '```c', 'int somme(const int *v, int n) {', '    int s = 0;', '    for (int i = 0; i < n; i++) s += v[i];', '    return s;', '}', '```', '',
  '| Fichier | Rôle |', '| :--- | :--- |', '| `src/main.c` | point d’entrée |', '| `src/somme.c` | nouvelle fonction |', '',
  '1. Lecture du projet', '2. Écriture du fichier', '3. Relecture', '',
  'Prochaine étape possible : ajouter un test unitaire.',
].join('\n');
// Each run rewrites src/somme.c differently (header and initial value), so from the second run on
// the write approval shows two separate change blocks to review.
let runNo = 1;
const somme = (n) => `/* version ${n} */\nint somme(const int *v, int n) {\n    int s = ${n - 1};\n    for (int i = 0; i < n; i++) s += v[i];\n    return s;\n}\n`;
const demo = (n) => [
  { thought: 'Je regarde d’abord la structure du projet, puis j’écris la fonction demandée.', toolCall: { id: 'p1', name: 'plan.update', arguments: plan(['in_progress', 'pending', 'pending'], true) } },
  { toolCalls: [
    { id: 'l1', name: 'fs.list', arguments: { path: '.' } },
    { id: 'r1', name: 'fs.read', arguments: { path: 'src/main.c' } },
    { id: 'r2', name: 'fs.read', arguments: { path: 'README.md' } },
  ] },
  { toolCall: { id: 't1', name: 'tools.request', arguments: { names: ['agent.delegate'] } } },
  // Sub-agent: the next two scripted steps are the specialist's own model calls.
  { toolCall: { id: 'd1', name: 'agent.delegate', arguments: { role: 'explorer', task: 'Repère les conventions de nommage du projet dans src/.' } } },
  { toolCalls: [{ id: 'e1', name: 'fs.list', arguments: { path: 'src' } }, { id: 'e2', name: 'fs.read', arguments: { path: 'src/main.c' } }] },
  { message: 'Conventions : noms en minuscules, un fichier .c par fonction publique, entête stdio uniquement.' },
  { toolCall: { id: 'p2', name: 'plan.update', arguments: plan(['completed', 'in_progress', 'pending']) } },
  { toolCall: { id: 'w1', name: 'fs.write', arguments: { path: 'src/somme.c', content: somme(n) } } },
  { toolCall: { id: 'r3', name: 'fs.read', arguments: { path: 'src/somme.c' } } },
  { toolCall: { id: 'p3', name: 'plan.update', arguments: plan(['completed', 'completed', 'completed']) } },
  { message: answer },
];

const PLAN = [{ message: ['Plan proposé :', '', '1. Lire `src/main.c` avec fs.read.', '2. Écrire `src/somme.c` avec fs.write.', '3. Relire `src/somme.c` avec fs.read et vérifier la boucle.'].join('\n') }];

// One demo turn per run; tokens are spaced out so the stream is visible.
const det = defaultProviderRegistry.get('deterministic-test');
const original = det.chatStream.bind(det);
det.chatStream = async function* (messages, tools, options) {
  // Plan mode: read-only, the scripted answer is a numbered plan and nothing else.
  const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
  if (det.stepIndex >= det.script.length) det.setScript(system.includes('Produis un plan d’action numéroté') ? PLAN : demo(++runNo));
  for await (const ev of original(messages, tools, options)) {
    if (ev.type === 'token' || ev.type === 'thought') await new Promise((r) => setTimeout(r, 25));
    else if (ev.type === 'tool_start') await new Promise((r) => setTimeout(r, 300));
    yield ev;
  }
};

async function request(method, route, body) {
  const r = await fetch(`${base}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${route} -> ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const server = new MazzServer({ port, host: '127.0.0.1', dataDir: path.resolve(outDir, 'server-data') });
await server.start();
await request('POST', '/api/workspace/open', { path: workspace });
await request('PUT', '/api/settings', {
  ai: { executionMode: 'local_strict', defaultProviderId: 'deterministic-test', defaultModelId: 'mazz-deterministic-v1' },
  agent: { defaultMode: 'agent', autoCompact: false, memory: false, projectInstructions: false },
  access: { mode: 'project', extraRoots: [] },
  permissions: { write: 'ask', delete: 'deny', terminal: 'deny', git: 'deny', network: 'deny', web: 'deny', mcp: 'deny' },
  knowledge: { autoContext: false },
});
console.log(`Démo prête : ${base}`);
