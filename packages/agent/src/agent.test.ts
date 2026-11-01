import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MazzAgentLoop } from './index.js';
import { PLAN_DEFINITION } from './specialists.js';
import { DeterministicTestProvider } from '@mazz/providers/testing';
import type { AgentEvent, ToolDefinition } from '@mazz/shared';
import { validateToolArgs } from '@mazz/tools';

test('Mazz Agent Loop: end-to-end task execution with real tools and streaming events', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-agent-test-'));

  try {
    // Program deterministic steps for the test:
    // Step 1: LLM outputs thought + tool call `fs.write`
    // Step 2: LLM observes result and gives final answer
    const fakeProvider = new DeterministicTestProvider([
      {
        thought: 'Je vais créer le fichier de configuration test.json',
        toolCall: {
          id: 'call_1',
          name: 'fs.write',
          arguments: {
            path: 'test.json',
            content: JSON.stringify({ status: 'ok', engine: 'MAZZ' }),
          },
        },
      },
      {
        thought: 'Fichier créé, je conclus la tâche.',
        message: 'Le fichier test.json a été créé avec succès.',
      },
    ]);

    const agent = new MazzAgentLoop();
    const events: AgentEvent[] = [];

    for await (const ev of agent.run({
      taskId: 'test-agent-task-1',
      goal: 'Crée un fichier test.json',
      workspaceRoot: tempDir,
      selection: {
        providerId: 'deterministic-test',
        modelId: 'mazz-deterministic-v1',
        executionMode: 'local_strict',
        allowedWorkspaceRoots: [tempDir],
      },
      provider: fakeProvider,
    })) {
      events.push(ev);
    }

    // Verify events sequence
    const types = events.map((e) => e.type);
    assert.ok(types.includes('status'));
    assert.ok(types.includes('thought'));
    assert.ok(types.includes('tool_start'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('token'));
    assert.ok(types.includes('complete'));

    // Verify file exists on real disk
    const content = await fs.readFile(path.join(tempDir, 'test.json'), 'utf-8');
    assert.ok(content.includes('MAZZ'));

  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test('Mazz Agent Loop: checkpoint, diff and approval refusal are enforced by the loop', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-agent-approval-'));
  try {
    await fs.writeFile(path.join(tempDir, 'keep.txt'), 'original', 'utf-8');
    const script = () =>
      new DeterministicTestProvider([
        { toolCall: { id: 'c1', name: 'fs.write', arguments: { path: 'keep.txt', content: 'modifié' } } },
        { message: 'Fin.' },
      ]);
    const selection = { providerId: 'deterministic-test', modelId: 'm', executionMode: 'local_strict' as const, allowedWorkspaceRoots: [tempDir] };

    // Refused: the file must stay untouched and the result must say so.
    const refused: AgentEvent[] = [];
    // Auto is an agentic mode, not a permission bypass: a refused write stays refused.
    for await (const ev of new MazzAgentLoop().run({ taskId: 'deny', goal: 'x', workspaceRoot: tempDir, mode: 'auto', selection, provider: script(), permissionLevel: 'ask_on_write', requestApproval: async () => false })) refused.push(ev);
    assert.equal(await fs.readFile(path.join(tempDir, 'keep.txt'), 'utf-8'), 'original');
    const denied = refused.find((e) => e.type === 'tool_result') as any;
    assert.equal(denied.success, false);
    assert.match(denied.error, /refus/);

    // Approved: a checkpoint is announced before the write and the diff is forwarded.
    const ok: AgentEvent[] = [];
    for await (const ev of new MazzAgentLoop().run({ taskId: 'allow', goal: 'x', workspaceRoot: tempDir, selection, provider: script(), permissionLevel: 'ask_on_write', requestApproval: async () => true })) ok.push(ev);
    const types = ok.map((e) => e.type);
    assert.ok(types.indexOf('checkpoint') < types.indexOf('tool_result'));
    const diff = ok.find((e) => e.type === 'diff') as any;
    assert.equal(diff.oldContent, 'original');
    assert.equal(diff.newContent, 'modifié');
    assert.equal((ok.find((e) => e.type === 'complete') as any).success, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Mazz Agent Loop: read-only modes never expose write tools to the model', async () => {
  const seen: string[][] = [];
  const provider = new DeterministicTestProvider([{ message: 'ok' }]);
  const original = provider.chatStream.bind(provider);
  provider.chatStream = (messages, tools, options) => {
    seen.push(tools.map((t) => t.name));
    return original(messages, tools, options);
  };
  for await (const _ of new MazzAgentLoop().run({ taskId: 'ro', goal: 'x', workspaceRoot: os.tmpdir(), mode: 'review', selection: { providerId: 'deterministic-test', modelId: 'm', executionMode: 'local_strict', allowedWorkspaceRoots: [] }, provider })) void _;
  assert.ok(seen[0].includes('fs.read'));
  assert.ok(!seen[0].includes('fs.write'));
  assert.ok(!seen[0].includes('terminal.run'));
});

test('Harness: per-task tool selection, tools.request and specialist delegation', async () => {
  const { selectToolsForTask } = await import('./index.js');
  const { defaultToolRegistry } = await import('@mazz/tools');
  const all = defaultToolRegistry.list();
  const plain = selectToolsForTask(all, 'Explique ce module', true).offered.map((d) => d.name);
  assert.deepEqual(plain.slice(0, 5), ['fs.list', 'fs.read', 'code.search', 'code.map', 'code.outline']);
  assert.ok(!plain.includes('compiler.gcc'));
  const focused = selectToolsForTask(all, 'Crée source.txt, relis-la avec fs.read et utilise terminal.run pour vérifier.', true).offered.map((d) => d.name);
  assert.deepEqual(focused, ['fs.read', 'fs.write', 'terminal.run']);
  assert.ok(!focused.includes('fs.patch') && !focused.includes('code.search'), 'les schémas non pertinents ne réduisent pas le contexte d’un petit modèle');
  const build = selectToolsForTask(all, 'Compile main.c avec gcc puis commit', true).offered.map((d) => d.name);
  assert.ok(build.includes('compiler.gcc') && build.includes('git.status'));
  // Core order is identical whatever the request: the cached prompt prefix survives.
  assert.deepEqual(build.slice(0, 8), selectToolsForTask(all, 'autre chose', true).offered.map((d) => d.name).slice(0, 8));

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-harness-'));
  try {
    await fs.writeFile(path.join(tempDir, 'main.c'), 'int add(int a, int b) { return a + b; }\n');
    const seenTools: string[][] = [];
    const provider = new DeterministicTestProvider([
      { toolCall: { id: 'r1', name: 'tools.request', arguments: { names: ['git.status', 'agent.delegate'] } } },
      { toolCall: { id: 'd1', name: 'agent.delegate', arguments: { role: 'explorer', task: 'Où est définie add ?' } } },
      // specialist (nested loop, same scripted engine)
      { toolCall: { id: 's1', name: 'code.outline', arguments: { path: 'main.c' } } },
      { message: 'add est définie dans main.c ligne 1.' },
      // back to the orchestrator
      { message: 'Synthèse reçue.' },
    ]);
    const original = provider.chatStream.bind(provider);
    provider.chatStream = (m, tools, o) => {
      seenTools.push(tools.map((t) => t.name));
      return original(m, tools, o);
    };
    const events: AgentEvent[] = [];
    for await (const ev of new MazzAgentLoop().run({ taskId: 'h', goal: 'Trouve la fonction add', workspaceRoot: tempDir, selection: { providerId: 'deterministic-test', modelId: 'm', executionMode: 'local_strict', allowedWorkspaceRoots: [tempDir] }, provider })) events.push(ev);

    assert.ok(seenTools[0].includes('tools.request') && !seenTools[0].includes('git.status'));
    assert.ok(seenTools[1].includes('git.status') && seenTools[1].includes('agent.delegate'), 'requested catalog tools are offered on the next model turn');
    // Specialist sees only its own tools and cannot delegate further.
    assert.deepEqual(seenTools[2].sort(), ['code.map', 'code.outline', 'code.search', 'fs.list', 'fs.read']);
    const delegated = events.find((e) => e.type === 'tool_result' && e.toolName === 'agent.delegate') as any;
    assert.equal(delegated.success, true);
    assert.match(delegated.output.summary, /main\.c ligne 1/);
    assert.ok(events.some((e) => e.type === 'status' && /\[Explorateur\]/.test((e as any).message)));
    assert.ok(!events.some((e) => e.type === 'token' && /main\.c ligne 1/.test((e as any).delta)), 'specialist text stays internal');
    assert.equal((events.at(-1) as any).success, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('Harness: literal-only prompts are separated from requests that need project context', async () => {
  const { isLiteralOnlyRequest } = await import('./index.js');
  assert.equal(isLiteralOnlyRequest('Respond with exactly LOCAL_MODEL_ONE and no other text.'), true);
  assert.equal(isLiteralOnlyRequest('Reply exactly with the word MAZZ_OK.'), true);
  assert.equal(isLiteralOnlyRequest('Réponds exactement par OK et rien d’autre.'), true);
  assert.equal(isLiteralOnlyRequest('Read main.c and reply exactly with its file name.'), false);
  assert.equal(isLiteralOnlyRequest('Calculate 12 * 7 and return exactly the result.'), false);
});

test('mutation permission is delegated to the UI gate instead of asking the user twice', async () => {
  const { compactToolDefinition, STABLE_SYSTEM_PROMPT } = await import('./tool-profile.js');
  const { ASK_DEFINITION } = await import('./specialists.js');
  const compactAsk = compactToolDefinition(ASK_DEFINITION);
  assert.match(STABLE_SYSTEM_PROMPT, /appelle directement l'outil de modification/);
  assert.match(STABLE_SYSTEM_PROMPT, /n'utilise pas user\.ask pour demander cette permission/);
  assert.match(compactAsk.description, /autorisation UI/);
  assert.match(ASK_DEFINITION.description, /information ou un vrai choix manque/);
});

test('the physical vault inventory tool is selected for inventory requests', async () => {
  const { compactToolDefinition, selectToolsForTask } = await import('./tool-profile.js');
  const inventory: ToolDefinition = {
    name: 'knowledge.inventory',
    description: 'Inventorie en lecture seule les vaults déclarés.',
    category: 'memory',
    parameters: { type: 'object', properties: {} },
    requiresPermission: false,
  };
  const selected = selectToolsForTask([inventory], 'Fais un inventaire physique des vaults et compte les fichiers.', false);
  assert.deepEqual(selected.offered.map((tool) => tool.name), ['knowledge.inventory']);
  const selectedByProtocolName = selectToolsForTask([inventory], 'Appelle knowledge.inventory pour obtenir les totaux.', false);
  assert.deepEqual(selectedByProtocolName.offered.map((tool) => tool.name), ['knowledge.inventory']);
  assert.match(compactToolDefinition(inventory).description, /fichiers physiques/u);

  const engines: ToolDefinition = {
    name: 'knowledge.engines',
    description: 'Liste les outils MCP Bib1 réellement disponibles.',
    category: 'mcp',
    parameters: { type: 'object', properties: {} },
    requiresPermission: false,
  };
  const engineSelection = selectToolsForTask([engines], 'Affiche le registre MCP des engines installés.', false);
  assert.deepEqual(engineSelection.offered.map((tool) => tool.name), ['knowledge.engines']);
  assert.match(compactToolDefinition(engines).description, /registre MAZZ/u);
});

test('Built-ins: plan.update emits the task list, user.ask waits for the answer, project instructions reach the system prompt', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-agent-plan-'));
  try {
    const provider = new DeterministicTestProvider([
      { toolCall: { id: 'p1', name: 'plan.update', arguments: { objective: 'Créer un fichier de configuration.', constraints: ['Respecter les conventions du projet.'], acceptanceCriteria: ['Le plan distingue la lecture de l’écriture.'], items: [{ id: 'read', content: 'Lire package.json avec fs.read', dependencies: [], status: 'in_progress' }, { id: 'write', content: 'Écrire settings.json avec fs.write', dependencies: ['read'], status: 'pending' }] } } },
      { toolCall: { id: 'q1', name: 'user.ask', arguments: { question: 'Quel format ?', options: ['JSON', 'YAML'] } } },
      { message: 'fini' },
    ]);
    const seen: Array<{ role: string; content: string }> = [];
    const original = provider.chatStream.bind(provider);
    provider.chatStream = (messages, tools, opts) => {
      if (!seen.length) seen.push(...messages.map((m) => ({ role: m.role, content: m.content })));
      return original(messages, tools, opts);
    };
    const asked: string[] = [];
    const events: AgentEvent[] = [];
    for await (const ev of new MazzAgentLoop().run({
      taskId: 't-plan',
      goal: 'Crée un fichier de config en plusieurs étapes',
      workspaceRoot: tempDir,
      selection: { providerId: 'deterministic-test', modelId: 'm', executionMode: 'local_strict', allowedWorkspaceRoots: [tempDir] },
      provider,
      projectInstructions: 'Toujours indenter avec 2 espaces.',
      askUser: async (q, opts) => (asked.push(`${q}|${opts.join(',')}`), 'YAML'),
    })) events.push(ev);
    const plan = events.find((e) => e.type === 'plan');
    assert.ok(plan && plan.type === 'plan' && plan.items.length === 2 && plan.items[0].status === 'in_progress');
    assert.deepEqual(asked, ['Quel format ?|JSON,YAML']);
    const answer = events.find((e) => e.type === 'tool_result' && e.toolName === 'user.ask');
    assert.ok(answer && answer.type === 'tool_result' && JSON.stringify(answer.output).includes('YAML'));
    assert.match(seen[0].content, /instructions_projet[\s\S]*2 espaces/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('plan.update publishes every field the runtime requires for a structured dependency plan', () => {
  const schema = PLAN_DEFINITION.parameters;
  const properties = schema.properties;
  assert.deepEqual(schema.required, ['items']);
  assert.equal(properties.objective.type, 'string');
  assert.equal(properties.constraints.type, 'array');
  assert.equal(properties.acceptanceCriteria.type, 'array');
  assert.equal(properties.items.items?.properties?.id.type, 'string');
  assert.equal(properties.items.items?.properties?.dependencies.type, 'array');
  assert.deepEqual(properties.items.items?.required, ['id', 'content', 'dependencies', 'status']);

  const completeInitialPlan = {
    objective: 'Créer et vérifier un artefact.',
    constraints: ['Rester dans le workspace.'],
    acceptanceCriteria: ['Le résultat est relu.'],
    items: [{ id: 'create', content: 'Créer le fichier', dependencies: [], status: 'in_progress' }],
  };
  assert.deepEqual(validateToolArgs(schema, completeInitialPlan), []);
  assert.match(validateToolArgs(schema, { items: [{ content: 'Créer le fichier', status: 'in_progress' }] }).join(' '), /items\[0\]\.id.*requis/);
});
