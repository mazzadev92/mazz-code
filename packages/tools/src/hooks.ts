import { spawn } from 'node:child_process';
import * as os from 'node:os';
import type { ToolHooks } from '@mazz/shared';
import { childEnv } from './child-env.js';

/**
 * PreToolUse / PostToolUse hooks (spec 03b §3.2): a user-configured command receives the tool call as
 * JSON on stdin. Exit code 2 blocks the call (PreToolUse) or reports a problem (PostToolUse), and its
 * stderr is returned to the model. Any other exit code lets the call proceed. A hook that does not
 * finish in time, or cannot start, blocks: a guard that silently stops guarding is worse than none.
 */

export const HOOK_DEFAULT_TIMEOUT_MS = 10_000;
export const HOOK_MAX_TIMEOUT_MS = 60_000;
const HOOK_STDERR_LIMIT = 4_000;

export type HookEvent = 'PreToolUse' | 'PostToolUse';
export interface HookOutcome { blocked: boolean; message: string }

/** Runs one hook command; resolves (never rejects) with its exit code and bounded stderr. */
export function runHookCommand(command: string, payload: unknown, timeoutMs: number, cwd = os.homedir()): Promise<{ code: number | null; stderr: string; timedOut: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (value: { code: number | null; stderr: string; timedOut: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Never start in the (untrusted) workspace: Windows would resolve node.exe or git.cmd planted there
      // before PATH. The project root travels in the stdin payload instead.
      const env = { ...childEnv(), ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) };
      child = spawn(command, { cwd, shell: true, windowsHide: true, env, stdio: ['pipe', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ code: null, stderr: '', timedOut: false, error: (error as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // The shell may have children: on Windows only taskkill /T reaches the whole tree.
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < HOOK_STDERR_LIMIT) stderr += chunk; });
    child.on('error', (error) => finish({ code: null, stderr, timedOut, error: error.message }));
    child.on('close', (code) => finish({ code, stderr: stderr.slice(0, HOOK_STDERR_LIMIT).trim(), timedOut }));
    // A hook that ignores stdin closes the pipe early: that is not an error.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(payload));
  });
}

/** Runs every hook of one event in order; the first blocking hook wins. */
export async function runToolHooks(event: HookEvent, hooks: ToolHooks | undefined, payload: Record<string, unknown>): Promise<HookOutcome | undefined> {
  const commands = (event === 'PreToolUse' ? hooks?.preToolUse : hooks?.postToolUse)?.filter((c) => typeof c === 'string' && c.trim()) ?? [];
  const timeoutMs = Math.min(Math.max(Number(hooks?.timeoutMs) || HOOK_DEFAULT_TIMEOUT_MS, 100), HOOK_MAX_TIMEOUT_MS);
  for (const command of commands) {
    const run = await runHookCommand(command, { hook_event_name: event, ...payload }, timeoutMs);
    if (run.timedOut) return { blocked: true, message: `Hook ${event} « ${command} » sans réponse après ${timeoutMs} ms : appel bloqué.` };
    if (run.error) return { blocked: true, message: `Hook ${event} « ${command} » impossible à lancer : ${run.error}` };
    if (run.code === 2) return { blocked: true, message: `Hook ${event} : ${run.stderr || 'refus sans message.'}` };
  }
  return undefined;
}
