import { spawn, type ChildProcess } from 'node:child_process';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { resolveSafePath } from './fs.js';
import { childEnv } from './child-env.js';

/**
 * Background commands (dev servers, watchers, long builds): started by the
 * agent, they outlive the tool call and the task. Output is kept in a bounded
 * buffer that the agent reads incrementally; the Studio stops them all on exit.
 */

const MAX_BUFFER = 256 * 1024;

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** Output since start; the oldest part is dropped beyond MAX_BUFFER. */
  output: string;
  /** Characters dropped from the head of `output`. */
  dropped: number;
  proc?: ChildProcess;
  taskId?: string;
}

export interface JobInfo {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  running: boolean;
  outputChars: number;
  taskId?: string;
}

class JobManager {
  private jobs = new Map<string, BackgroundJob>();
  private seq = 0;

  start(command: string, cwd: string, shell: 'powershell' | 'cmd', taskId?: string): BackgroundJob {
    const id = `job_${(++this.seq).toString(36)}_${Date.now().toString(36).slice(-4)}`;
    const args = shell === 'cmd' ? ['/d', '/s', '/c', `chcp 65001>nul & ${command}`] : ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`];
    const proc = spawn(shell === 'cmd' ? 'cmd.exe' : 'powershell.exe', args, { cwd, windowsHide: true, env: childEnv() });
    const job: BackgroundJob = { id, command, cwd, startedAt: Date.now(), output: '', dropped: 0, proc, taskId };
    const push = (d: Buffer) => {
      job.output += d.toString('utf-8');
      if (job.output.length > MAX_BUFFER) {
        const cut = job.output.length - MAX_BUFFER;
        job.output = job.output.slice(cut);
        job.dropped += cut;
      }
    };
    proc.stdout?.on('data', push);
    proc.stderr?.on('data', push);
    proc.on('close', (code) => {
      job.exitCode = code;
      job.endedAt = Date.now();
      job.proc = undefined;
    });
    proc.on('error', (err) => {
      job.output += `\n[erreur de lancement] ${err.message}\n`;
      job.exitCode = -1;
      job.endedAt = Date.now();
      job.proc = undefined;
    });
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /** Output after absolute position `since` (characters since the job started). */
  read(id: string, since = 0): { text: string; next: number; truncatedBefore: boolean } {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Tâche de fond inconnue : ${id}`);
    const start = Math.max(0, since - job.dropped);
    return { text: job.output.slice(start), next: job.dropped + job.output.length, truncatedBefore: since < job.dropped };
  }

  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job?.proc?.pid) return false;
    // The shell's children (servers, watchers) must go too: kill the whole tree.
    const killer = spawn('taskkill', ['/PID', String(job.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    // stop() is also used by synchronous shutdown paths; do not make it wait
    // there, but consume spawn errors so a missing taskkill cannot crash Studio.
    killer.on('error', () => undefined);
    return true;
  }

  /** Stop a job and wait until both taskkill and the managed shell have exited. */
  async stopAndWait(id: string, timeoutMs = 5000): Promise<boolean> {
    const job = this.jobs.get(id);
    const proc = job?.proc;
    if (!job || !proc?.pid) return false;

    const pid = proc.pid;
    const processClosed = new Promise<void>((resolve) => {
      if (job.proc !== proc) {
        resolve();
        return;
      }
      proc.once('close', () => resolve());
    });
    const processTree = await this.terminateProcessTree(pid, timeoutMs);

    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Le processus ${pid} ne s’est pas arrêté après ${timeoutMs} ms.`)), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([processClosed, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const deadline = Date.now() + timeoutMs;
    const allPids = [...new Set([pid, ...processTree])];
    while (allPids.some((processId) => this.isProcessAlive(processId))) {
      if (Date.now() >= deadline) {
        const remaining = allPids.filter((processId) => this.isProcessAlive(processId));
        throw new Error(`L’arbre de processus ${pid} est encore actif après l’arrêt : ${remaining.join(', ')}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return job.proc !== proc;
  }

  private async terminateProcessTree(pid: number, timeoutMs: number): Promise<number[]> {
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
      return [pid];
    }

    // taskkill /T can miss detached children created by PowerShell Start-Process.
    // Snapshot the actual Win32 parent tree, then terminate every captured PID.
    const script = [
      `$root = ${pid}`,
      '$all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId)',
      '$ids = [System.Collections.Generic.List[int]]::new()',
      '$null = $ids.Add([int]$root)',
      'for ($i = 0; $i -lt $ids.Count; $i++) {',
      '  $parent = $ids[$i]',
      '  foreach ($item in $all) {',
      '    $child = [int]$item.ProcessId',
      '    if ([int]$item.ParentProcessId -eq $parent -and -not $ids.Contains($child)) { $null = $ids.Add($child) }',
      '  }',
      '  if ($ids.Count -gt 4096) { throw "Process tree exceeds the safe limit." }',
      '}',
      '$ids.Reverse()',
      'foreach ($target in $ids) { Stop-Process -Id $target -Force -ErrorAction SilentlyContinue }',
      'foreach ($target in $ids) { [Console]::Out.WriteLine([int]$target) }',
    ].join('; ');

    return new Promise<number[]>((resolve, reject) => {
      const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      let errorOutput = '';
      let settled = false;
      const finish = (error?: Error, pids?: number[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(pids ?? []);
      };
      const timer = setTimeout(() => {
        killer.kill();
        finish(new Error(`L’arrêt de l’arbre de processus ${pid} dépasse ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref?.();
      killer.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('ascii');
        if (output.length > 64 * 1024) finish(new Error('La liste des processus dépasse la limite autorisée.'));
      });
      killer.stderr?.on('data', (chunk: Buffer) => {
        errorOutput = (errorOutput + chunk.toString('utf8')).slice(-4000);
      });
      killer.once('error', (error) => finish(new Error(`Impossible d’énumérer l’arbre de processus ${pid} : ${error.message}`)));
      killer.once('close', (code) => {
        if (code !== 0) {
          finish(new Error(`PowerShell n’a pas pu arrêter l’arbre de processus ${pid} (code ${String(code)}): ${errorOutput.trim()}`));
          return;
        }
        const pids = output.split(/\r?\n/).map((line) => Number(line.trim())).filter((value) => Number.isSafeInteger(value) && value > 0);
        if (!pids.includes(pid)) {
          finish(new Error(`L’arbre de processus ${pid} n’a pas été confirmé par Windows.`));
          return;
        }
        finish(undefined, pids);
      });
    });
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw err;
    }
  }

  stopAll(): void {
    for (const id of this.jobs.keys()) this.stop(id);
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => ({ id: j.id, command: j.command, cwd: j.cwd, startedAt: j.startedAt, endedAt: j.endedAt, exitCode: j.exitCode, running: !!j.proc, outputChars: j.dropped + j.output.length, taskId: j.taskId }));
  }

  remove(id: string): void {
    this.stop(id);
    this.jobs.delete(id);
  }
}

export const backgroundJobs = new JobManager();

export class TerminalStartTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'terminal.start',
    description: 'Lance une commande en arrière-plan (serveur, surveillance, long build) et rend un identifiant ; lire la sortie avec terminal.read.',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Commande complète' },
        shell: { type: 'string', enum: ['powershell', 'cmd'] },
        cwd: { type: 'string', description: 'Dossier d’exécution (défaut : le projet)' },
      },
      required: ['command'],
    },
    requiresPermission: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const command = String(params.command ?? '').trim();
      if (!command) throw new Error('Paramètre "command" vide.');
      const cwd = typeof params.cwd === 'string' && params.cwd.trim() ? resolveSafePath(context.workspaceRoot, params.cwd, context.allowedRoots) : context.workspaceRoot;
      const job = backgroundJobs.start(command, cwd, params.shell === 'cmd' ? 'cmd' : 'powershell', context.taskId);
      // A short wait catches immediate failures (unknown command, port in use).
      await new Promise((r) => setTimeout(r, 1500));
      const first = backgroundJobs.read(job.id);
      return { success: job.exitCode === undefined || job.exitCode === 0, output: { id: job.id, running: !!job.proc, exitCode: job.exitCode, output: first.text.slice(-4000), next: first.next }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}

export class TerminalReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'terminal.read',
    description: 'Lit la sortie d’une commande en arrière-plan depuis une position (champ next du dernier appel).',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        since: { type: 'number', description: 'Position renvoyée par l’appel précédent (défaut 0)' },
        waitMs: { type: 'number', description: 'Attente avant lecture, 0 à 30000 ms' },
      },
      required: ['id'],
    },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const id = String(params.id);
      const wait = Math.min(30000, Math.max(0, Number(params.waitMs ?? 0)));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const job = backgroundJobs.get(id);
      const r = backgroundJobs.read(id, Math.max(0, Number(params.since ?? 0)));
      return { success: true, output: { id, running: !!job?.proc, exitCode: job?.exitCode, output: r.text.slice(-12000), next: r.next, truncatedBefore: r.truncatedBefore }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}

export class TerminalStopTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'terminal.stop',
    description: 'Arrête une commande en arrière-plan et ses processus enfants.',
    category: 'terminal',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    requiresPermission: false,
  };

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const ok = await backgroundJobs.stopAndWait(String(params.id));
      return { success: ok, output: { id: params.id, stopped: ok }, error: ok ? undefined : 'Tâche inconnue ou déjà terminée.', durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: { id: params.id, stopped: false }, error: (err as Error).message, durationMs: Date.now() - start };
    }
  }
}
