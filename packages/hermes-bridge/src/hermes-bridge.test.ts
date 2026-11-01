import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HermesDelegationRequest } from '@mazz/shared';
import {
  buildHermesCliInvocation,
  parseHermesStream,
  runBoundedProcess,
} from './hermes-bridge.js';

function resultEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    session_id: 'contract-test-session',
    exit_code: 0,
    text: 'Résultat vérifié',
    tokens: { input: 19, output: 7, total: 26 },
    duration_ms: 31,
    ...overrides,
  };
}

function jsonl(...events: Record<string, unknown>[]): string {
  return `${events.map((event) => JSON.stringify({ timestamp: 1_798_132_000_000, ...event })).join('\n')}\n`;
}

const request: HermesDelegationRequest = {
  taskId: 'contract-1',
  objective: 'Lire le manifeste et en résumer les sections.',
  workspacePath: 'C:\\repo',
  allowedTools: ['file', 'web'],
  maxTokens: 700,
  maxDurationSeconds: 12,
};

test('parseHermesStream accepts only a complete terminal result event', () => {
  const parsed = parseHermesStream(jsonl(
    { type: 'system', subtype: 'init', model: 'configured-model', session_id: 's1' },
    { type: 'text', text: 'Résultat vérifié' },
    resultEvent(),
  ));
  assert.deepEqual(parsed, {
    text: 'Résultat vérifié',
    inputTokens: 19,
    outputTokens: 7,
    totalTokens: 26,
    durationMs: 31,
    exitCode: 0,
  });
});

test('parseHermesStream rejects plain text, malformed events, errors and nonterminal results', () => {
  for (const stdout of [
    'plain text that only looks successful',
    jsonl({ type: 'result', exit_code: 0, text: 'ok', tokens: {}, duration_ms: 1 }),
    jsonl(resultEvent(), { type: 'text', text: 'late event' }),
    jsonl(resultEvent({ exit_code: 1, error: 'provider failure' })),
    jsonl(resultEvent({ text: '' })),
    jsonl({ type: 'future_event', payload: {} }, resultEvent()),
  ]) {
    assert.throws(() => parseHermesStream(stdout));
  }
});

test('CLI invocation carries a canonical workspace, bounded budgets, and explicit toolsets', () => {
  const invocation = buildHermesCliInvocation('hermes.exe', request, 'C:\\repo');
  assert.deepEqual(invocation.args, [
    '--in', 'C:\\repo', 'chat', '--oneshot', '--quiet', '--format', 'stream-json',
    '--max-turns', '2', '--toolsets', 'file,web', '--query-file', '-',
  ]);
  assert.match(invocation.prompt, /Maximum output-token budget: 700/);
  assert.equal(invocation.maxTurns, 2);

  const capped = buildHermesCliInvocation('hermes.exe', { ...request, maxTokens: 999_999 }, 'C:\\repo');
  assert.equal(capped.maxTokens, 32_768);
  assert.equal(capped.maxTurns, 40);
  assert.throws(() => buildHermesCliInvocation('hermes.exe', { ...request, allowedTools: ['delegation'] }, 'C:\\repo'), /refusé/);
  assert.throws(() => buildHermesCliInvocation('hermes.exe', { ...request, allowedTools: [] }, 'C:\\repo'), /liste explicite/);
});

test('an owned process tree is stopped when its real child process exceeds the deadline', async (t) => {
  // A disposable Node parent spawns a long-lived Node child. This verifies the
  // bridge process-tree cleanup contract, not Hermes installation or behavior.
  const script = [
    "const {spawn}=require('node:child_process');",
    "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    "process.stdout.write(String(c.pid)+'\\n');",
    'setInterval(()=>{},1000);',
  ].join('');
  const outcome = await runBoundedProcess(process.execPath, ['-e', script], process.cwd(), '', 250);
  assert.equal(outcome.timedOut, true);
  const childPid = Number(outcome.stdout.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0, 'child PID was not captured before timeout');

  // Windows taskkill /T may return as soon as the process is signalled. Give
  // the kernel a short bounded interval to reap the descendant before asserting.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 40));
    } catch {
      return;
    }
  }
  t.after(() => {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
  });
  assert.fail(`owned child process ${childPid} survived process-tree termination`);
});
