import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { attachKillOnCloseJob } from '@mazz/shared';

/**
 * Non-interactive command runner: one process per command, stdout/stderr
 * streamed live, exit code reported. This is NOT a PTY: programs waiting for
 * keyboard input will block until timeout or cancellation.
 */

export type ShellId = 'powershell' | 'cmd' | 'pwsh';

export interface TerminalChunk {
  type: 'start' | 'stdout' | 'stderr' | 'exit' | 'error';
  t: number;
  data?: string;
  exitCode?: number | null;
  durationMs?: number;
  pid?: number;
  timedOut?: boolean;
  cancelled?: boolean;
}

export interface ShellInfo {
  id: ShellId;
  label: string;
  executable: string;
  available: boolean;
}

export function detectShells(): ShellInfo[] {
  if (process.platform !== 'win32') {
    return [{ id: 'powershell', label: 'sh', executable: '/bin/sh', available: existsSync('/bin/sh') }];
  }
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const ps = `${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const cmd = `${sysRoot}\\System32\\cmd.exe`;
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  return [
    { id: 'powershell', label: 'Windows PowerShell 5.1', executable: ps, available: existsSync(ps) },
    { id: 'pwsh', label: 'PowerShell 7', executable: pwsh, available: existsSync(pwsh) },
    { id: 'cmd', label: 'Invite de commandes (cmd)', executable: cmd, available: existsSync(cmd) },
  ];
}

function argsFor(shell: ShellId, command: string): string[] {
  if (process.platform !== 'win32') return ['-c', command];
  if (shell === 'cmd') return ['/d', '/s', '/c', `chcp 65001>nul & ${command}`];
  // UTF-8 output so accented characters survive the pipe.
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`];
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    proc.kill('SIGKILL');
  }
}

export class TerminalRunner {
  private runs = new Map<string, { proc: ChildProcess; cancel: () => void; command: string; startedAt: number; cwd: string }>();

  active(): Array<{ runId: string; command: string; startedAt: number; cwd: string }> {
    return Array.from(this.runs.entries()).map(([runId, r]) => ({ runId, command: r.command, startedAt: r.startedAt, cwd: r.cwd }));
  }

  run(
    runId: string,
    opts: { command: string; shell: ShellId; cwd: string; timeoutMs: number },
    onChunk: (c: TerminalChunk) => void
  ): Promise<{ exitCode: number | null; durationMs: number }> {
    if (this.runs.has(runId)) {
      const t = Date.now();
      onChunk({ type: 'error', t, data: 'Un processus terminal porte déjà cet identifiant actif.' });
      onChunk({ type: 'exit', t, exitCode: null, durationMs: 0, timedOut: false, cancelled: false });
      return Promise.resolve({ exitCode: null, durationMs: 0 });
    }
    const shell = detectShells().find((s) => s.id === opts.shell && s.available) || detectShells().find((s) => s.available);
    if (!shell) {
      onChunk({ type: 'error', t: Date.now(), data: 'Aucun shell disponible.' });
      return Promise.resolve({ exitCode: null, durationMs: 0 });
    }
    const start = Date.now();
    return new Promise((resolve) => {
      let done = false;
      let timedOut = false;
      let cancelled = false;
      const proc = spawn(shell.executable, argsFor(shell.id, opts.command), {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      // Kill-on-close Job Object: if Studio dies mid-command, Windows ends the whole tree.
      const job = attachKillOnCloseJob(proc.pid);

      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        job.close();
        this.runs.delete(runId);
        const durationMs = Date.now() - start;
        onChunk({ type: 'exit', t: Date.now(), exitCode, durationMs, timedOut, cancelled });
        resolve({ exitCode, durationMs });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(proc);
      }, opts.timeoutMs);

      // Register synchronously before invoking callbacks. A callback can
      // re-enter run() with the same id; it must be rejected without replacing
      // this process's cancellation handle.
      this.runs.set(runId, {
        proc,
        command: opts.command,
        startedAt: start,
        cwd: opts.cwd,
        cancel: () => {
          cancelled = true;
          killTree(proc);
        },
      });

      proc.stdout?.setEncoding('utf-8');
      proc.stderr?.setEncoding('utf-8');
      proc.stdout?.on('data', (d: string) => onChunk({ type: 'stdout', t: Date.now(), data: d }));
      proc.stderr?.on('data', (d: string) => onChunk({ type: 'stderr', t: Date.now(), data: d }));
      proc.on('error', (err) => {
        onChunk({ type: 'error', t: Date.now(), data: err.message });
        finish(null);
      });
      proc.on('close', (code) => finish(code));
      onChunk({ type: 'start', t: start, pid: proc.pid });
    });
  }

  cancel(runId: string): boolean {
    const r = this.runs.get(runId);
    if (!r) return false;
    r.cancel();
    return true;
  }
}
