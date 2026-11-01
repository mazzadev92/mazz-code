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

async function collectRun(options: Parameters<MazzAgentLoop['run']>[0]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of new MazzAgentLoop().run(options)) events.push(event);
  return events;
}

test('Validation de plan : une étape regroupant plusieurs cibles (s3: cyberdesk/app, services/.gitkeep) est rejetée avec suggestion explicite de séparation et injecte une consigne de correction', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-plan-multitarget-'));
  try {
    const multiTargetPlan = {
      objective: 'Initialiser les composants du projet',
      constraints: ['Workspace local uniquement'],
      acceptanceCriteria: ['Tous les fichiers requis sont créés'],
      items: [
        { id: 's1', content: 'Lit la structure avec fs.list', dependencies: [], status: 'in_progress' },
        { id: 's2', content: 'Prépare configuration.json avec fs.write', dependencies: ['s1'], status: 'pending' },
        { id: 's3', content: 'Crée cyberdesk/app et services/.gitkeep avec fs.write', dependencies: ['s2'], status: 'pending' },
      ],
    };

    const correctedPlan = {
      objective: 'Initialiser les composants du projet',
      constraints: ['Workspace local uniquement'],
      acceptanceCriteria: ['Tous les fichiers requis sont créés'],
      items: [
        { id: 's1', content: 'Lit la structure avec fs.list', dependencies: [], status: 'in_progress' },
        { id: 's2', content: 'Prépare configuration.json avec fs.write', dependencies: ['s1'], status: 'pending' },
        { id: 's3_1', content: 'Crée cyberdesk/app avec fs.write', dependencies: ['s2'], status: 'pending' },
        { id: 's3_2', content: 'Crée services/.gitkeep avec fs.write', dependencies: ['s3_1'], status: 'pending' },
      ],
    };

    const provider = new DeterministicTestProvider([
      // Turn 1: Model submits multi-target plan (rejected with suggestions s3_1 and s3_2)
      { toolCall: { id: 'call-plan-1', name: 'plan.update', arguments: multiTargetPlan } },
      // Turn 2: Model receives <plan_validation_error> and submits corrected atomic plan
      { toolCall: { id: 'call-plan-2', name: 'plan.update', arguments: correctedPlan } },
      // Turn 3: Conclude
      { message: 'Plan validé et décomposé en étapes atomiques explicites.' },
    ]);

    const events = await collectRun({
      taskId: 'plan-multitarget-recovery-test',
      goal: 'Initialise le projet en plusieurs étapes.',
      workspaceRoot: root,
      selection: selection(root),
      provider,
    });

    // 1. Verify Turn 1 tool result failed with explicit split suggestions
    const firstResult = events.find((e) => e.type === 'tool_result' && e.callId === 'call-plan-1');
    assert.ok(firstResult && firstResult.type === 'tool_result');
    assert.equal(firstResult.success, false);
    assert.match(firstResult.error ?? '', /étapes dépendantes/u);
    assert.match(firstResult.error ?? '', /s3_1/u);
    assert.match(firstResult.error ?? '', /s3_2/u);

    // 2. Verify Turn 2 tool result succeeded with the corrected plan
    const secondResult = events.find((e) => e.type === 'tool_result' && e.callId === 'call-plan-2');
    assert.ok(secondResult && secondResult.type === 'tool_result');
    assert.equal(secondResult.success, true);

    // 3. Verify plan event was emitted with the 4 steps
    const planEvent = events.find((e) => e.type === 'plan');
    assert.ok(planEvent && planEvent.type === 'plan');
    assert.equal(planEvent.items.length, 4);
    assert.match(planEvent.items[2].content, /cyberdesk\/app/u);
    assert.match(planEvent.items[3].content, /services\/\.gitkeep/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Récupération d’outil non déclaré : INVALID_PROVIDER_RESPONSE ne crashe pas le run, injecte une consigne de correction et permet au modèle de réussir', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mazz-undeclared-tool-'));
  try {
    let callCount = 0;
    const mockProvider = {
      id: 'mock-undeclared',
      name: 'Mock Undeclared Tool Provider',
      type: 'openai',
      locality: 'local' as const,
      async *chatStream() {
        callCount++;
        if (callCount === 1) {
          // Turn 1: provider rejects because tool 'plan.update' was supposedly not in request.tools
          yield {
            type: 'error' as const,
            taskId: 'undeclared-test',
            timestamp: Date.now(),
            code: 'INVALID_PROVIDER_RESPONSE',
            message: "attempted to call tool 'plan.update' which was not in request.tools",
            fatal: true,
          };
          return;
        }
        // Turn 2: after recovery, provider receives valid call and succeeds
        yield {
          type: 'tool_start' as const,
          taskId: 'undeclared-test',
          timestamp: Date.now(),
          toolName: 'fs.list',
          callId: 'list-root',
          params: { path: '.' },
        };
      },
    };

    const events = await collectRun({
      taskId: 'undeclared-test',
      goal: 'Liste les fichiers du workspace.',
      workspaceRoot: root,
      selection: {
        providerId: 'mock-undeclared',
        modelId: 'test-model',
        executionMode: 'local_strict' as const,
        allowedWorkspaceRoots: [root],
      },
      provider: mockProvider as any,
    });

    // Verify recovery happened: a status event with stage 'provider-retry' was yielded
    const retryStatus = events.find((e) => e.type === 'status' && e.stage === 'provider-retry');
    assert.ok(retryStatus && retryStatus.type === 'status');
    assert.match(retryStatus.message, /Appel d’outil non déclaré intercepté/u);

    // Verify tool execution succeeded in turn 2
    const toolResult = events.find((e) => e.type === 'tool_result' && e.callId === 'list-root');
    assert.ok(toolResult && toolResult.type === 'tool_result');
    assert.equal(toolResult.success, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
