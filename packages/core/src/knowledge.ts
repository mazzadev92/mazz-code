import { spawn, type ChildProcess } from 'node:child_process';
import { attachKillOnCloseJob, type KillOnCloseJob } from '@mazz/shared';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ITool } from '@mazz/shared';

/**
 * MAZZ Universal Knowledge (D:\Mazz Code\Bib1, Python engine with its own
 * HTTP API): started on demand, its `knowledge.search` adapter is registered
 * for every model, and the Studio retrieves cited context before each request
 * (deterministic router: small local models do not have to decide to search).
 */

export interface KnowledgeConfig {
  home: string;
  port: number;
  python: string;
}

export interface KnowledgeContext {
  query: string;
  context: string;
  characters: number;
  citations?: Array<{ label: string; path: string; line: number; heading?: string; status?: string }>;
}

export class LegacyKnowledgeManager {
  private child?: ChildProcess;
  private job?: KillOnCloseJob;
  private log: string[] = [];

  constructor(private readonly cfg: () => KnowledgeConfig) {}

  private base(): string {
    return `http://127.0.0.1:${this.cfg().port}`;
  }

  available(): boolean {
    return existsSync(path.join(this.cfg().home, 'mazz_knowledge', '__main__.py'));
  }

  async health(): Promise<boolean> {
    try {
      return (await fetch(`${this.base()}/search?q=test&k=1`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }

  /** Starts `python -m mazz_knowledge serve` if nothing answers on the port. */
  async ensure(): Promise<boolean> {
    if (await this.health()) return true;
    if (!this.available() || this.child) return false;
    const c = this.cfg();
    // The Python setting may name the install folder rather than the executable.
    const python = resolvePython(c.python);
    const child = spawn(python, ['-m', 'mazz_knowledge', 'serve', '--port', String(c.port)], { cwd: c.home, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child = child;
    this.job = attachKillOnCloseJob(child.pid);
    const push = (d: Buffer) => {
      for (const l of d.toString('utf-8').split(/\r?\n/)) if (l.trim()) this.log.push(l.slice(0, 300));
      if (this.log.length > 100) this.log.splice(0, this.log.length - 100);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (err) => {
      this.log.push(`Lancement impossible (${python}) : ${err.message}`);
      if (this.child === child) this.child = undefined;
      this.job?.close();
      this.job = undefined;
    });
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
      this.job?.close();
      this.job = undefined;
    });
    for (let i = 0; i < 120; i++) {
      if (await this.health()) return true;
      if (!this.child) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  status() {
    return { home: this.cfg().home, port: this.cfg().port, available: this.available(), ownedByStudio: !!this.child, log: this.log.slice(-20) };
  }

  async context(query: string, k = 3, budget = 2800): Promise<KnowledgeContext | null> {
    if (!(await this.ensure())) return null;
    const qs = new URLSearchParams({ q: query.slice(0, 2000), k: String(k), budget: String(budget), hybrid: 'true', include_imports: 'false' });
    try {
      const r = await fetch(`${this.base()}/context?${qs}`, { signal: AbortSignal.timeout(8000) });
      return r.ok ? ((await r.json()) as KnowledgeContext) : null;
    } catch {
      return null;
    }
  }

  /** The engine's own ITool adapter (integrations/knowledge-tool.mjs). */
  async loadTool(): Promise<ITool | null> {
    const file = path.join(this.cfg().home, 'integrations', 'knowledge-tool.mjs');
    if (!existsSync(file)) return null;
    const mod = (await import(pathToFileURL(file).href)) as { KnowledgeSearchTool: new (url: string) => ITool };
    const tool = new mod.KnowledgeSearchTool(this.base());
    const exec = tool.execute.bind(tool);
    // The engine is started on first use.
    tool.execute = async (p, c) => ((await this.ensure()) ? exec(p, c) : { success: false, output: null, error: 'Moteur de connaissances indisponible (Bib1).', durationMs: 0 });
    return tool;
  }

  stop(): void {
    this.job?.close();
    this.job = undefined;
    if (this.child?.pid) spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    this.child = undefined;
  }
}

/** The Python setting may name the install folder rather than the executable. */
export function resolvePython(p = 'python'): string {
  const exe = p || 'python';
  return !exe.toLowerCase().endsWith('.exe') && existsSync(path.join(exe, 'python.exe')) ? path.join(exe, 'python.exe') : exe;
}

export class KnowledgeManager extends LegacyKnowledgeManager {}
