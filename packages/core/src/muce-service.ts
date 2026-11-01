import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * MUCE HTTP service (server/muce_service.py): a Python bridge on 127.0.0.1:8098
 * in front of MUCE's llama-server (8097), with speculative decoding flags and
 * the /muce/v1/telemetry endpoint. The Studio attaches to a running service or
 * starts it, and only stops a service it started itself.
 */

export const MUCE_SERVICE_PORT = 8098;
const DEFAULT_BASE = `http://127.0.0.1:${MUCE_SERVICE_PORT}`;
const NON_EXECUTION_TOOL_NAMES = new Set(['user.ask', 'plan.update', 'tools.request', 'agent.delegate']);

/** Exclude orchestration and human wait time from measured execution latency. */
export function shouldReportToolLatency(toolName: string): boolean {
  return !NON_EXECUTION_TOOL_NAMES.has(toolName);
}

export interface MuceServiceStartOptions {
  muceHome: string;
  python: string;
  modelPath: string;
  context: number;
  threads: number;
  batch: number;
  cacheType: 'f16' | 'q8_0' | 'q4_0';
  specType: string;
  ngramMatch: number;
  ngramMin: number;
  ngramMax: number;
  poll: number;
  prio: number;
  reasoning?: 'on' | 'off' | 'auto';
}

export interface MuceServiceState {
  running: boolean;
  ownedByStudio: boolean;
  model?: string;
  config?: Record<string, unknown>;
  error?: string;
  log: string[];
}

export class MuceServiceManager {
  private child?: ChildProcess;
  private home?: string;
  private log: string[] = [];
  private lastError?: string;

  constructor(private readonly baseUrl = DEFAULT_BASE) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Le service MUCE doit rester accessible uniquement en boucle locale.');
    }
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/muce/v1/status`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return false;
      const st = (await r.json()) as { schema?: number; inference_backend?: string };
      return st.schema === 1 && typeof st.inference_backend === 'string';
    } catch {
      return false;
    }
  }

  async state(): Promise<MuceServiceState> {
    const base: MuceServiceState = { running: false, ownedByStudio: !!this.child, error: this.lastError, log: this.log.slice(-40) };
    if (!(await this.health())) return base;
    try {
      const st = (await (await fetch(`${this.baseUrl}/muce/v1/status`, { signal: AbortSignal.timeout(3000) })).json()) as { model?: string; config?: Record<string, unknown> };
      return { ...base, running: true, model: st.model, config: st.config };
    } catch {
      return { ...base, running: true };
    }
  }

  /** Raw /muce/v1/telemetry block, or undefined when the service is not reachable. */
  async telemetry(): Promise<Record<string, unknown> | undefined> {
    try {
      const r = await fetch(`${this.baseUrl}/muce/v1/telemetry`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return undefined;
      return ((await r.json()) as { telemetry?: Record<string, unknown> }).telemetry;
    } catch {
      return undefined;
    }
  }

  /** Best-effort feedback loop for real tool execution timings from the agent. */
  async recordToolLatency(toolName: string, latencyMs: number): Promise<boolean> {
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(toolName) || !Number.isFinite(latencyMs) || latencyMs <= 0) return false;
    try {
      const response = await fetch(`${this.baseUrl}/muce/v1/telemetry/tool_latency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool_name: toolName, latency_ms: Math.round(latencyMs * 100) / 100 }),
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const result = (await response.json()) as { recorded?: boolean };
      return result.recorded === true;
    } catch {
      // Telemetry is observational; an unavailable MUCE service never blocks an agent tool.
      return false;
    }
  }

  async start(o: MuceServiceStartOptions): Promise<MuceServiceState> {
    if (await this.health()) return this.state();
    if (!Number.isInteger(o.batch) || o.batch < 1 || o.batch > 2048) {
      throw new Error('Le service MUCE accepte une taille de batch comprise entre 1 et 2048.');
    }
    const script = findMuceFile(o.muceHome, 'server/muce_service.py');
    if (!script) throw new Error(`Service MUCE introuvable (server/muce_service.py) dans ${o.muceHome} ni dans le dépôt source parent.`);
    const root = path.dirname(path.dirname(script));
    this.home = root;
    this.log = [];
    this.lastError = undefined;
    const args = [
      script,
      '--model', o.modelPath,
      '--threads', String(o.threads),
      '--context', String(o.context),
      '--batch', String(o.batch),
      '--cache-type', o.cacheType,
      '--spec-type', o.specType,
      '--poll', String(o.poll),
      '--prio', String(o.prio),
    ];
    if (o.specType === 'ngram-mod') args.push('--spec-ngram-mod-n-match', String(o.ngramMatch), '--spec-ngram-mod-n-min', String(o.ngramMin), '--spec-ngram-mod-n-max', String(o.ngramMax));
    if (o.reasoning) args.push('--reasoning', o.reasoning);
    const child = spawn(o.python, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    this.child = child;
    const push = (d: Buffer) => {
      for (const l of d.toString('utf-8').split(/\r?\n/)) if (l.trim()) this.log.push(l.slice(0, 400));
      if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (code) this.lastError = `Le service MUCE s’est arrêté (code ${code}). ${this.log.slice(-3).join(' ')}`;
    });
    child.on('error', (err) => {
      this.lastError = `Lancement impossible (${o.python}) : ${err.message}`;
    });
    // Model load included: up to 3 minutes on a 4-core CPU.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (!this.child) break;
      if (await this.health()) return this.state();
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error(this.lastError ?? `Le service MUCE n’a pas répondu sur ${this.baseUrl}. ${this.log.slice(-4).join(' ')}`);
  }

  /** Graceful stop through the control token, then the process tree if still alive. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      const stateFile = path.join(this.home ?? '', 'profiles', 'muce-service.json');
      const st = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as { control_token?: string };
      if (st.control_token) {
        await fetch(`${this.baseUrl}/muce/v1/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MUCE-Control': st.control_token }, body: '{}', signal: AbortSignal.timeout(3000) });
      }
    } catch {
      // no state file or service already gone
    }
    const exited = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 15_000);
      child.once('exit', () => (clearTimeout(t), resolve(true)));
    });
    if (!exited && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    this.child = undefined;
  }
}

/** Runs a MUCE Python script (no shell), UTF-8 output. */
export function runPython(python: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(python, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, (err, stdout, stderr) =>
      resolve({ stdout: String(stdout), stderr: String(stderr) || (err ? err.message : ''), code: err ? 1 : 0 })
    );
  });
}

/**
 * Python tools of MUCE live in the source tree; a packaged home (dist/MUCE-x)
 * does not contain them, so the parent folders are searched too.
 */
export function findMuceFile(home: string, rel: string): string | undefined {
  let dir = path.resolve(home);
  for (let i = 0; i < 3; i++) {
    const p = path.join(dir, rel);
    if (existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
