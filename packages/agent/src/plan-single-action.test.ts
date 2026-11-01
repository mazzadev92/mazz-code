import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentEvent } from '@mazz/shared';
import { DeterministicTestProvider } from '@mazz/providers/testing';
import { MazzAgentLoop } from './agent-loop.js';

const selection = (root: string) => ({
  providerId: 'deterministic-test',
  modelId: 'deterministic',
  executionMode: 'local_strict' as const,
  allowedWorkspaceRoots: [root],
});

function writePlan(content: string) {
  return {
    objective: 'Écrire un fichier dans le workspace de test.',
    constraints: ['Rester dans le workspace temporaire.'],
    acceptanceCriteria: ['Le résultat réel correspond au fichier ciblé.'],
    items: [{ id: 'write', content, dependencies: [], status: 'in_progress' }],
  };
}

async function collectRun(options: Parameters<MazzAgentLoop['run']>[0]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new MazzAgentLoop().run(options)) events.push(event);
  return events;
}

test('un plan atomique écrit sa cible exacte et termine l’étape après le résultat réel', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-plan-single-action-valid-'));
  try {
    const provider = new DeterministicTestProvider([
      { toolCall: { id: 'plan', name: 'plan.update', arguments: writePlan('Écris result.txt avec fs.write.') } },
      { toolCall: { id: 'write', name: 'fs.write', arguments: { path: 'result.txt', content: 'PLAN_ACTION_OK\n' } } },
      { message: 'result.txt a été créé.' },
    ]);
    const events = await collectRun({
      taskId: 'plan-single-action-valid',
      goal: 'Réalise ce travail en plusieurs étapes : écris result.txt.',
      workspaceRoot: root,
      selection: selection(root),
      provider,
      toolSelection: 'all',
    });

    const write = events.find((event) => event.type === 'tool_result' && event.callId === 'write');
    assert.ok(write?.type === 'tool_result');
    assert.equal(write.success, true, JSON.stringify(write));
    assert.equal(await fs.readFile(path.join(root, 'result.txt'), 'utf8'), 'PLAN_ACTION_OK\n');

    const finalPlan = events.filter((event) => event.type === 'plan').at(-1) as (AgentEvent & {
      items: Array<{ status: string; evidence: Array<{ toolName: string; target?: string }> }>;
    }) | undefined;
    assert.ok(finalPlan);
    assert.equal(finalPlan.items[0].status, 'completed');
    assert.deepEqual(finalPlan.items[0].evidence.map((proof) => [proof.toolName, proof.target]), [['fs.write', 'result.txt']]);
    assert.equal((events.at(-1) as Extract<AgentEvent, { type: 'complete' }>).success, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('un plan multi-action ou multi-chemin est rejeté avant toute mutation', async () => {
  const invalidSteps = [
    {
      content: 'Écris action.txt puis relis action.txt avec fs.write et fs.read.',
      paths: ['action.txt'],
    },
    {
      content: 'Écris first.txt et second.txt avec fs.write.',
      paths: ['first.txt', 'second.txt'],
    },
  ];

  for (const [index, invalid] of invalidSteps.entries()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `mazz-plan-single-action-invalid-${index}-`));
    try {
      const firstTarget = invalid.paths[0]!;
      const provider = new DeterministicTestProvider([
        { toolCall: { id: 'invalid-plan', name: 'plan.update', arguments: writePlan(invalid.content) } },
        { toolCall: { id: 'write-after-rejection', name: 'fs.write', arguments: { path: firstTarget, content: 'MUST_NOT_WRITE\n' } } },
        { message: 'Le plan doit être découpé avant toute mutation.' },
      ]);
      const events = await collectRun({
        taskId: `plan-single-action-invalid-${index}`,
        goal: 'Réalise en plusieurs étapes le travail demandé.',
        workspaceRoot: root,
        selection: selection(root),
        provider,
        toolSelection: 'all',
      });

      const planResult = events.find((event) => event.type === 'tool_result' && event.callId === 'invalid-plan');
      assert.ok(planResult?.type === 'tool_result');
      assert.equal(planResult.success, false, JSON.stringify(planResult));
      assert.match(planResult.error ?? '', /étapes dépendantes/u);
      assert.equal(events.some((event) => event.type === 'plan'), false);

      const rejectedWrite = events.find((event) => event.type === 'tool_result' && event.callId === 'write-after-rejection');
      assert.ok(rejectedWrite?.type === 'tool_result');
      assert.equal(rejectedWrite.success, false, JSON.stringify(rejectedWrite));
      for (const target of invalid.paths) {
        await assert.rejects(fs.stat(path.join(root, target)), { code: 'ENOENT' });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('une preuve d’écriture sur une cible incohérente ne modifie aucun fichier', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-plan-single-action-target-'));
  const wrongPath = path.join(root, 'other.txt');
  await fs.writeFile(wrongPath, 'ORIGINAL_CONTENT\n', 'utf8');
  try {
    const provider = new DeterministicTestProvider([
      { toolCall: { id: 'plan', name: 'plan.update', arguments: writePlan('Écris expected.txt avec fs.write.') } },
      { toolCall: { id: 'wrong-target', name: 'fs.write', arguments: { path: 'other.txt', content: 'MUST_NOT_REPLACE\n' } } },
      { message: 'L’écriture a été bloquée car la cible ne correspond pas au plan.' },
    ]);
    const events = await collectRun({
      taskId: 'plan-single-action-target',
      goal: 'Réalise ce travail en plusieurs étapes : écris expected.txt.',
      workspaceRoot: root,
      selection: selection(root),
      provider,
      toolSelection: 'all',
    });

    const rejectedWrite = events.find((event) => event.type === 'tool_result' && event.callId === 'wrong-target');
    assert.ok(rejectedWrite?.type === 'tool_result');
    assert.equal(rejectedWrite.success, false, JSON.stringify(rejectedWrite));
    assert.match(rejectedWrite.error ?? '', /ne correspond pas à l’étape active/u);
    assert.equal(await fs.readFile(wrongPath, 'utf8'), 'ORIGINAL_CONTENT\n');
    await assert.rejects(fs.stat(path.join(root, 'expected.txt')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
