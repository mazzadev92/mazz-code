import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { attachKillOnCloseJob, type KillOnCloseJob } from '@mazz/shared';

/**
 * Interactive terminals (Windows ConPTY through node-pty): programs that ask
 * questions, REPLs, TUIs. Output goes to SSE listeners and to a bounded replay
 * buffer, so a reloaded page finds its terminal as it was.
 */

export interface IPty {
  pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): IPty };

const require = createRequire(import.meta.url);
let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('@lydell/node-pty') as PtyModule;
    } catch {
      ptyModule = null;
    }
  }
  return ptyModule;
}

/** Replay scrollback per terminal (spec 03): 10 000 lines and 32 MiB at most, oldest output evicted first. */
export const PTY_REPLAY_MAX_LINES = 10_000;
export const PTY_REPLAY_MAX_CHARS = 32 * 1024 * 1024;
/** Re-shows the cursor and resets attributes, so a crashed TUI does not leave the console blind. */
export const PTY_RESET_SEQUENCE = '\x1b[?25h\x1b[0m';

/** Appends to a replay buffer and evicts from the front beyond the line and size limits. */
export function appendReplay(replay: string, data: string, maxLines = PTY_REPLAY_MAX_LINES, maxChars = PTY_REPLAY_MAX_CHARS): string {
  let out = replay + data;
  if (out.length > maxChars) out = out.slice(-maxChars);
  let excess = (out.match(/\n/g)?.length ?? 0) - maxLines;
  if (excess > 0) {
    let cut = 0;
    while (excess-- > 0) cut = out.indexOf('\n', cut) + 1;
    out = out.slice(cut);
  }
  return out;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Replay buffer with amortised O(1) appends: chunks are kept as they arrive with running line and character
 * counts, and whole oldest chunks are evicted. The old string version rescanned up to 32 MiB per chunk.
 */
export class ReplayBuffer {
  private parts: string[] = [];
  private chars = 0;
  private lines = 0;

  constructor(private readonly maxLines = PTY_REPLAY_MAX_LINES, private readonly maxChars = PTY_REPLAY_MAX_CHARS) {}

  append(data: string): void {
    this.parts.push(data);
    this.chars += data.length;
    this.lines += countNewlines(data);
    while ((this.chars > this.maxChars || this.lines > this.maxLines) && this.parts.length > 1) {
      const oldest = this.parts.shift() as string;
      this.chars -= oldest.length;
      this.lines -= countNewlines(oldest);
    }
    if (this.chars > this.maxChars || this.lines > this.maxLines) {
      const only = appendReplay('', this.parts[0], this.maxLines, this.maxChars); // a single oversized chunk: trim inside it
      this.parts = [only];
      this.chars = only.length;
      this.lines = countNewlines(only);
    }
  }

  text(): string {
    if (this.parts.length > 1) this.parts = [this.parts.join('')];
    return this.parts[0] ?? '';
  }
}

export interface PtySession {
  id: string;
  shell: string;
  cwd: string;
  startedAt: number;
  exitCode?: number;
  /** Scrollback for replay on reconnect (read-only view of `buffer`). */
  readonly replay: string;
  readonly buffer: ReplayBuffer;
  listeners: Set<(chunk: { type: 'data'; data: string } | { type: 'exit'; exitCode: number }) => void>;
  pty: IPty;
  /** Job Object holding the shell tree: closed on exit/close, and by Windows if Studio dies. */
  job: KillOnCloseJob;
}

// UTF-8 from the first prompt: code page 65001 for cmd, the .NET output encoding as well for PowerShell.
const PS_UTF8 = '[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); chcp 65001 > $null';
export const PTY_SHELLS: Record<string, { file: string; args: string[] }> = {
  powershell: { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', PS_UTF8] },
  pwsh: { file: 'pwsh.exe', args: ['-NoLogo', '-NoExit', '-Command', PS_UTF8] },
  cmd: { file: 'cmd.exe', args: ['/K', 'chcp 65001 >nul'] },
};

/** Ends the shell and every process it started: taskkill /T /F on the root PID under Windows. */
function killTree(pty: IPty): void {
  if (process.platform === 'win32' && pty.pid) {
    const r = spawnSync('taskkill', ['/PID', String(pty.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    if (r.status === 0) return;
  }
  pty.kill();
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  /** `mod`, `kill` and `attachJob` are injectable for tests; production loads node-pty, kills the process tree and wraps it in a Job Object. */
  constructor(
    private readonly loader: () => PtyModule | null = loadPty,
    private readonly kill: (pty: IPty) => void = killTree,
    private readonly attachJob: (pid: number) => KillOnCloseJob = attachKillOnCloseJob,
  ) {}

  available(): boolean {
    return this.loader() !== null;
  }

  create(shell: string, cwd: string, cols: number, rows: number): PtySession {
    const mod = this.loader();
    if (!mod) throw new Error('Terminal interactif indisponible : module node-pty introuvable.');
    const sh = PTY_SHELLS[shell] ?? PTY_SHELLS.powershell;
    // ConPTY only (spec 03): the winpty fallback is never used.
    const pty = mod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env }, useConpty: true });
    const id = `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const buffer = new ReplayBuffer();
    const s: PtySession = { id, shell, cwd, startedAt: Date.now(), get replay() { return buffer.text(); }, buffer, listeners: new Set(), pty, job: this.attachJob(pty.pid) };
    pty.onData((data) => {
      s.buffer.append(data);
      for (const l of s.listeners) l({ type: 'data', data });
    });
    pty.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      // The shell is gone: its leftover background processes go with the job.
      s.job.close();
      s.buffer.append(PTY_RESET_SEQUENCE);
      for (const l of s.listeners) {
        l({ type: 'data', data: PTY_RESET_SEQUENCE });
        l({ type: 'exit', exitCode });
      }
    });
    this.sessions.set(id, s);
    return s;
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  list(): Array<{ id: string; shell: string; cwd: string; startedAt: number; running: boolean }> {
    return [...this.sessions.values()].map((s) => ({ id: s.id, shell: s.shell, cwd: s.cwd, startedAt: s.startedAt, running: s.exitCode === undefined }));
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || s.exitCode !== undefined) throw new Error('Terminal introuvable ou terminé.');
    s.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s && s.exitCode === undefined) s.pty.resize(Math.max(10, Math.min(500, cols)), Math.max(4, Math.min(200, rows)));
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.exitCode === undefined) {
      try {
        this.kill(s.pty);
      } catch {
        // already gone
      }
      for (const l of s.listeners) l({ type: 'data', data: PTY_RESET_SEQUENCE });
    }
    s.job.close();
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
