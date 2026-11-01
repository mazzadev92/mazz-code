import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveSafePath } from './fs.js';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';

/** A single command cannot retain more than 1 MiB of output in the agent history. */
export const TERMINAL_CAPTURE_BYTES_PER_STREAM = 512 * 1024;
export const TERMINAL_MAX_TIMEOUT_MS = 5 * 60 * 1000;

/** Return a finite, positive timeout capped for model-provided arguments. */
export function boundedTerminalTimeout(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 30000;
  return Math.min(requested, TERMINAL_MAX_TIMEOUT_MS);
}

interface CapturedOutput {
  text: string;
  observedBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

/** Keep UTF-8 text on code-point boundaries while still draining the child stream. */
function boundedTextCapture(maxBytes = TERMINAL_CAPTURE_BYTES_PER_STREAM) {
  const decoder = new StringDecoder('utf8');
  const chunks: string[] = [];
  let observedBytes = 0;
  let capturedBytes = 0;
  let truncated = false;
  let ended = false;

  const append = (text: string) => {
    if (!text) return;
    const remaining = maxBytes - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes <= remaining) {
      chunks.push(text);
      capturedBytes += textBytes;
      return;
    }

    let prefix = '';
    let prefixBytes = 0;
    for (const codePoint of text) {
      const bytes = Buffer.byteLength(codePoint, 'utf8');
      if (prefixBytes + bytes > remaining) break;
      prefix += codePoint;
      prefixBytes += bytes;
    }
    if (prefix) chunks.push(prefix);
    capturedBytes += prefixBytes;
    truncated = true;
  };

  return {
    write(chunk: Buffer) {
      if (ended) return;
      observedBytes += chunk.byteLength;
      append(decoder.write(chunk));
    },
    finish(): CapturedOutput {
      if (!ended) {
        ended = true;
        append(decoder.end());
      }
      return { text: chunks.join(''), observedBytes, capturedBytes, truncated };
    },
  };
}

/** Stop descendants as well as the shell when a command is cancelled or times out. */
async function terminateProcessTree(proc: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = proc.pid;
  if (process.platform === 'win32' && pid) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let deadline: NodeJS.Timeout | undefined;
      const fallback = () => {
        try {
          proc.kill(signal);
        } catch {
          // The process may already have exited.
        }
      };
      const finish = (treeKillSucceeded: boolean) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        if (!treeKillSucceeded) fallback();
        resolve();
      };
      try {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        deadline = setTimeout(() => {
          try { killer.kill('SIGKILL'); } catch { /* already exited */ }
          finish(false);
        }, 3000);
        killer.once('error', () => finish(false));
        killer.once('close', (code) => finish(code === 0));
      } catch {
        finish(false);
      }
    });
    return;
  }
  // Non-Windows fallback.
  try {
    proc.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

export class TerminalRunTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'terminal.run',
    description: 'Exécute une commande PowerShell ou CMD dans le dossier workspace sous Windows.',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'La commande complète à exécuter' },
        timeoutMs: { type: 'number', description: 'Timeout en millisecondes (défaut 30000)' },
        shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Shell à utiliser' },
        cwd: { type: 'string', description: 'Dossier d’exécution (défaut : le projet)' },
      },
      required: ['command'],
    },
    requiresPermission: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (typeof params.command !== 'string' || !params.command.trim()) {
        throw new Error('Paramètre "command" manquant ou vide.');
      }

      if (context.permissionLevel === 'read_only') {
        throw new Error('Permission refusée : l’exécution de commandes est bloquée en mode "read_only".');
      }

      const command = params.command.trim();
      const cwd = typeof params.cwd === 'string' && params.cwd.trim() ? resolveSafePath(context.workspaceRoot, params.cwd, context.allowedRoots) : context.workspaceRoot;
      const timeoutMs = boundedTerminalTimeout(params.timeoutMs);
      const shellType = params.shell === 'cmd' ? 'cmd.exe' : 'powershell.exe';
      // UTF-8 code page / output encoding so accented messages are not garbled.
      const shellArgs =
        shellType === 'cmd.exe'
          ? ['/d', '/s', '/c', `chcp 65001>nul & ${command}`]
          : ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`];

      return await new Promise<ToolExecutionResult>((resolve) => {
        const stdout = boundedTextCapture();
        const stderr = boundedTextCapture();
        let finished = false;
        let timer: NodeJS.Timeout;

        const proc = spawn(shellType, shellArgs, {
          cwd,
          windowsHide: true,
          env: { ...process.env },
        });

        const detachAbort = () => context.signal?.removeEventListener('abort', onAbort);
        const output = (extra: Record<string, unknown> = {}) => {
          const out = stdout.finish();
          const err = stderr.finish();
          return {
            stdout: out.text,
            stderr: err.text,
            stdoutBytesObserved: out.observedBytes,
            stderrBytesObserved: err.observedBytes,
            stdoutBytesCaptured: out.capturedBytes,
            stderrBytesCaptured: err.capturedBytes,
            outputTruncated: out.truncated || err.truncated,
            ...extra,
          };
        };
        const settle = (result: (captured: ReturnType<typeof output>) => ToolExecutionResult) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          detachAbort();
          resolve(result(output()));
        };
        const terminateAndSettle = (signal: NodeJS.Signals, result: (captured: ReturnType<typeof output>) => ToolExecutionResult) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          detachAbort();
          // A surviving descendant can inherit these pipe handles and keep the
          // Node worker alive after the shell has been killed. Stop draining
          // immediately, but do not report completion until tree termination
          // itself has finished (or reached its bounded fallback deadline).
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          void terminateProcessTree(proc, signal).finally(() => resolve(result(output())));
        };

        timer = setTimeout(() => {
          terminateAndSettle('SIGTERM', (captured) => ({
            success: false,
            output: { ...captured, timeout: true },
            error: `Commande interrompue après ${timeoutMs}ms (timeout).`,
            exitCode: -1,
            durationMs: Date.now() - start,
          }));
        }, timeoutMs);

        const onAbort = () => {
          terminateAndSettle('SIGKILL', (captured) => ({
            success: false,
            output: { ...captured, aborted: true },
            error: 'Commande annulée par le signal utilisateur.',
            exitCode: -2,
            durationMs: Date.now() - start,
          }));
        };
        if (context.signal) {
          context.signal.addEventListener('abort', onAbort, { once: true });
          if (context.signal.aborted) onAbort();
        }

        proc.stdout?.on('data', (data) => {
          if (!finished) stdout.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });

        proc.stderr?.on('data', (data) => {
          if (!finished) stderr.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });

        proc.on('close', (code) => {
          if (!finished) {
            settle((captured) => ({
              success: code === 0,
              output: { ...captured, stdout: captured.stdout.trim(), stderr: captured.stderr.trim() },
              error: code !== 0 ? captured.stderr.trim() || `Processus terminé avec le code d'erreur ${code}` : undefined,
              exitCode: code ?? 0,
              durationMs: Date.now() - start,
            }));
          }
        });

        proc.on('error', (err) => {
          settle(() => ({
            success: false,
            output: null,
            error: err.message,
            exitCode: 1,
            durationMs: Date.now() - start,
          }));
        });
      });
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}
