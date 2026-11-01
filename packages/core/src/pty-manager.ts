import { createRequire } from 'node:module';

/**
 * Interactive terminals (Windows ConPTY through node-pty): programs that ask
 * questions, REPLs, TUIs. Output goes to SSE listeners and to a bounded replay
 * buffer, so a reloaded page finds its terminal as it was.
 */

interface IPty {
  pid: number;
  onData(cb: (d: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): IPty };

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

const MAX_REPLAY = 200 * 1024;

export interface PtySession {
  id: string;
  shell: string;
  cwd: string;
  startedAt: number;
  exitCode?: number;
  replay: string;
  listeners: Set<(chunk: { type: 'data'; data: string } | { type: 'exit'; exitCode: number }) => void>;
  pty: IPty;
}

const SHELLS: Record<string, { file: string; args: string[] }> = {
  powershell: { file: 'powershell.exe', args: ['-NoLogo'] },
  pwsh: { file: 'pwsh.exe', args: ['-NoLogo'] },
  cmd: { file: 'cmd.exe', args: [] },
};

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  available(): boolean {
    return loadPty() !== null;
  }

  create(shell: string, cwd: string, cols: number, rows: number): PtySession {
    const mod = loadPty();
    if (!mod) throw new Error('Terminal interactif indisponible : module node-pty introuvable.');
    const sh = SHELLS[shell] ?? SHELLS.powershell;
    const pty = mod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env } });
    const id = `pty_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const s: PtySession = { id, shell, cwd, startedAt: Date.now(), replay: '', listeners: new Set(), pty };
    pty.onData((data) => {
      s.replay += data;
      if (s.replay.length > MAX_REPLAY) s.replay = s.replay.slice(-MAX_REPLAY);
      for (const l of s.listeners) l({ type: 'data', data });
    });
    pty.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      for (const l of s.listeners) l({ type: 'exit', exitCode });
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
        s.pty.kill();
      } catch {
        // already gone
      }
    }
    this.sessions.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
