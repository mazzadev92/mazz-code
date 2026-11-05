import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import {
  attachKillOnCloseJob, ensureLlamaKey, llamaAuthHeaders, llamaKeyPath,
  type GgufMetadata, type KillOnCloseJob,
} from '@mazz/shared';
import { parseGgufHeader } from './gguf-parser.js';

export interface LlamaServerConfig {
  binaryPath?: string;
  modelPath: string;
  port?: number;
  host?: string;
  contextSize?: number;
  threads?: number;
  batchSize?: number;
  gpuLayers?: number;
  /** Enables Jinja chat templates, required by llama.cpp for tool calling. */
  jinja?: boolean;
  /** Extra model-specific variables passed to the Jinja chat template. */
  chatTemplateKwargs?: Record<string, string | number | boolean | null>;
  /** Serves /v1/embeddings instead of generation-oriented defaults. */
  embeddings?: boolean;
  /** Maximum wait for /health to answer 200, in ms. */
  readyTimeoutMs?: number;
  /** Server slots (-np). 1 on a 4-core CPU: parallel decoding brings no throughput. */
  parallel?: number;
  /** Host-RAM prompt cache limit in MiB (--cache-ram). llama.cpp defaults to 8192. */
  cacheRamMb?: number;
  /** Directory where slot KV caches are saved and restored (--slot-save-path). */
  slotSavePath?: string;
  /** Physical batch (-ub); embeddings need it as large as the longest input. */
  ubatchSize?: number;
  /** Multimodal projector (--mmproj) giving the model image input. */
  mmprojPath?: string;
  /** Draft model for speculative decoding (-md); must share the main model's vocabulary. */
  draftModelPath?: string;
  /** Maximum drafted tokens per step (--spec-draft-n-max). */
  draftMax?: number;
  /**
   * Model-free speculative decoding by n-gram lookup in the context, busy
   * polling and high priority.
   */
  specType?: 'none' | 'ngram-mod' | 'ngram-simple' | 'ngram-map-k' | 'ngram-cache';
  ngramMatch?: number;
  ngramMin?: number;
  ngramMax?: number;
  /** --poll 0..100: busy-wait for work instead of sleeping (lower latency, more CPU). */
  poll?: number;
  /** --prio -1..3 */
  prio?: number;
  /** --reasoning on|off|auto: thinking of hybrid models (Qwen3). */
  reasoning?: 'on' | 'off' | 'auto';
  /** --reasoning-budget: thinking tokens per reply before the model must act (unset: unlimited). */
  reasoningBudget?: number;
  /** --cache-type-k/-v: f16 (default), q8_0 halves KV memory for long contexts. */
  kvCacheType?: 'f16' | 'q8_0' | 'q4_0';
  /** -fa on|off|auto (required by llama.cpp for a quantised V cache). */
  flashAttn?: 'on' | 'off' | 'auto';
  /** API key file passed to llama-server. Defaults to the key shared with the gateway. */
  apiKeyFile?: string;
}

export type LlamaServerState = 'stopped' | 'starting' | 'ready' | 'error' | 'exited';

export interface LlamaLogLine {
  t: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface LlamaServerStatus {
  state: LlamaServerState;
  /** Kept for API compatibility: true while the process is alive and ready. */
  isRunning: boolean;
  pid?: number;
  port: number;
  host: string;
  binaryPath?: string;
  modelPath?: string;
  metadata?: GgufMetadata;
  config?: LlamaServerConfig;
  args?: string[];
  startedAt?: number;
  readyAt?: number;
  /** Time from spawn to first healthy answer (model load), in ms. */
  loadMs?: number;
  uptimeSeconds?: number;
  exitCode?: number | null;
  lastError?: string;
}

const MAX_LOG_LINES = 600;

/** True when nothing is listening on host:port, so Studio never starts on top of a foreign server. */
function portIsFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host, exclusive: true });
  });
}

/** Finds llama-server on PATH (where.exe) and in the supplied candidate paths. */
export async function discoverLlamaServer(candidates: string[] = []): Promise<string[]> {
  const found = new Set<string>();
  const defaultPaths = [
    process.env.MAZZ_LLAMA_SERVER ?? '',
    path.resolve(process.cwd(), '../_build/ik_llama.cpp/build/bin/Release/llama-server.exe'),
    path.resolve(process.cwd(), '../../_build/ik_llama.cpp/build/bin/Release/llama-server.exe'),
  ];
  for (const c of [...candidates, ...defaultPaths]) {
    if (c && existsSync(c)) found.add(path.resolve(c));
  }
  const exe = process.platform === 'win32' ? 'where.exe' : 'which';
  await new Promise<void>((resolve) => {
    execFile(exe, ['llama-server'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        for (const line of stdout.split(/\r?\n/)) if (line.trim()) found.add(line.trim());
      }
      resolve();
    });
  });
  return Array.from(found);
}

export class LlamaServerSupervisor {
  private process: ChildProcess | null = null;
  private job: KillOnCloseJob | null = null;
  private status: LlamaServerStatus = { state: 'stopped', isRunning: false, port: 8080, host: '127.0.0.1' };
  private logBuffer: LlamaLogLine[] = [];
  private logSeq = 0;

  getStatus(): LlamaServerStatus {
    const s = { ...this.status };
    if (s.startedAt && (s.state === 'ready' || s.state === 'starting')) {
      s.uptimeSeconds = Math.round((Date.now() - s.startedAt) / 1000);
    }
    return s;
  }

  /** Lines after sequence number `since` (for incremental polling). */
  getLogs(since = 0): { lines: LlamaLogLine[]; seq: number } {
    const first = this.logSeq - this.logBuffer.length;
    const from = Math.max(0, since - first);
    return { lines: this.logBuffer.slice(from), seq: this.logSeq };
  }

  private log(stream: LlamaLogLine['stream'], chunk: string): void {
    for (const text of chunk.split(/\r?\n/)) {
      if (!text.trim()) continue;
      this.logBuffer.push({ t: Date.now(), stream, text: text.slice(0, 2000) });
      this.logSeq++;
      if (this.logBuffer.length > MAX_LOG_LINES) this.logBuffer.shift();
    }
  }

  baseUrl(): string {
    return `http://${this.status.host}:${this.status.port}`;
  }

  static buildArgs(config: LlamaServerConfig, meta?: GgufMetadata): string[] {
    const args = [
      '-m', config.modelPath,
      '--host', config.host || '127.0.0.1',
      '--port', String(config.port || 8080),
      '--threads', String(config.threads || 4),
      '--ctx-size', String(config.contextSize || Math.min(meta?.contextLength ?? 4096, 4096)),
    ];
    if (config.batchSize && config.batchSize > 0) args.push('--batch-size', String(config.batchSize));
    if (config.ubatchSize && config.ubatchSize > 0) args.push('--ubatch-size', String(config.ubatchSize));
    if (config.gpuLayers && config.gpuLayers > 0) args.push('--n-gpu-layers', String(config.gpuLayers));
    if (config.jinja) args.push('--jinja');
    if (config.chatTemplateKwargs && Object.keys(config.chatTemplateKwargs).length) {
      args.push('--chat-template-kwargs', JSON.stringify(config.chatTemplateKwargs));
    }
    if (config.embeddings) args.push('--embeddings');
    if (config.parallel && config.parallel > 0) args.push('--parallel', String(config.parallel));
    if (config.cacheRamMb !== undefined && config.cacheRamMb >= 0) args.push('--cache-ram', String(config.cacheRamMb));
    if (config.slotSavePath) args.push('--slot-save-path', config.slotSavePath);
    if (config.mmprojPath) args.push('--mmproj', config.mmprojPath);
    if (config.reasoning) args.push('--reasoning', config.reasoning);
    if (config.reasoning !== 'off' && typeof config.reasoningBudget === 'number' && config.reasoningBudget >= 0) {
      args.push('--reasoning-budget', String(config.reasoningBudget), '--reasoning-budget-message', 'Réflexion terminée : agis maintenant.');
    }
    if (config.poll !== undefined) args.push('--poll', String(config.poll));
    if (config.prio !== undefined && config.prio !== 0) args.push('--prio', String(config.prio));
    if (config.kvCacheType && config.kvCacheType !== 'f16') args.push('--cache-type-k', config.kvCacheType, '--cache-type-v', config.kvCacheType);
    if (config.flashAttn) args.push('--flash-attn', config.flashAttn);
    // A draft model takes precedence: llama.cpp runs one speculative method at a time.
    if (!config.draftModelPath && config.specType && config.specType !== 'none') {
      args.push('--spec-type', config.specType);
      if (config.specType === 'ngram-mod') {
        args.push('--spec-ngram-mod-n-match', String(config.ngramMatch ?? 24), '--spec-ngram-mod-n-min', String(config.ngramMin ?? 4), '--spec-ngram-mod-n-max', String(config.ngramMax ?? 16));
      }
    }
    if (config.draftModelPath) {
      args.push('--model-draft', config.draftModelPath);
      if (config.draftMax && config.draftMax > 0) args.push('--spec-draft-n-max', String(config.draftMax));
    }
    // Path only: llama-server reads the value, so it never shows up in `ps` or this.args.
    args.push('--api-key-file', config.apiKeyFile || llamaKeyPath());
    return args;
  }

  async start(config: LlamaServerConfig): Promise<{ success: boolean; error?: string; status: LlamaServerStatus }> {
    if (this.process && (this.status.state === 'ready' || this.status.state === 'starting')) {
      return {
        success: false,
        error: `Un serveur llama.cpp est déjà actif (PID ${this.status.pid}). Arrêtez-le avant d'en démarrer un autre.`,
        status: this.getStatus(),
      };
    }

    const host = config.host || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return { success: false, error: 'Seule l’écoute locale (127.0.0.1) est autorisée.', status: this.getStatus() };
    }
    const port = config.port || 8080;
    const binPath = config.binaryPath || 'llama-server';

    if (!(await portIsFree(port, host))) {
      const error = `Le port ${host}:${port} est déjà utilisé par un autre processus. Arrêtez-le ou choisissez un autre port.`;
      this.status = { state: 'error', isRunning: false, port, host, modelPath: config.modelPath, lastError: error };
      return { success: false, error, status: this.getStatus() };
    }

    const metadata = await parseGgufHeader(config.modelPath);
    if (!metadata.isValidGguf || metadata.vocabOnly) {
      const error = `Modèle non chargeable : ${metadata.error || 'fichier GGUF invalide'}`;
      this.status = { state: 'error', isRunning: false, port, host, modelPath: config.modelPath, lastError: error };
      return { success: false, error, status: this.getStatus() };
    }

    try {
      if (!config.apiKeyFile) ensureLlamaKey();
    } catch (err) {
      const error = `Clé llama-server indisponible : ${(err as Error).message}`;
      this.status = { state: 'error', isRunning: false, port, host, lastError: error };
      return { success: false, error, status: this.getStatus() };
    }
    const args = LlamaServerSupervisor.buildArgs({ ...config, host, port }, metadata);
    this.logBuffer = [];
    this.log('system', `Lancement : ${binPath} ${args.join(' ')}`);

    let proc: ChildProcess;
    try {
      proc = spawn(binPath, args, { windowsHide: true, cwd: path.isAbsolute(binPath) ? path.dirname(binPath) : undefined });
    } catch (err) {
      const error = `Impossible de lancer llama-server : ${(err as Error).message}`;
      this.status = { state: 'error', isRunning: false, port, host, lastError: error };
      return { success: false, error, status: this.getStatus() };
    }

    const startedAt = Date.now();
    this.process = proc;
    // Kill-on-close: a crash or a closed Studio window must not leave llama-server holding the port.
    this.job = attachKillOnCloseJob(proc.pid);
    this.status = {
      state: 'starting',
      isRunning: false,
      pid: proc.pid,
      port,
      host,
      binaryPath: binPath,
      modelPath: config.modelPath,
      metadata,
      config: { ...config, host, port },
      args,
      startedAt,
    };

    let spawnError: string | undefined;
    proc.on('error', (err) => {
      spawnError = err.message;
      this.log('system', `Erreur processus : ${err.message}`);
    });
    proc.stdout?.on('data', (d) => this.log('stdout', d.toString()));
    proc.stderr?.on('data', (d) => this.log('stderr', d.toString()));
    proc.on('exit', (code) => {
      this.log('system', `Processus terminé (code ${code}).`);
      if (this.process === proc) {
        const wasStopping = this.status.state === 'stopped';
        this.process = null;
        this.job?.close();
        this.job = null;
        if (!wasStopping) {
          const tail = this.logBuffer.slice(-6).map((l) => l.text).join(' | ');
          this.status = {
            ...this.status,
            state: this.status.state === 'ready' ? 'exited' : 'error',
            isRunning: false,
            exitCode: code,
            lastError: this.status.state === 'ready' ? `llama-server s'est arrêté (code ${code}).` : `Échec du chargement (code ${code}) : ${tail}`,
          };
        }
      }
    });

    const deadline = startedAt + (config.readyTimeoutMs ?? 120000);
    while (Date.now() < deadline) {
      if (spawnError) {
        const error = /ENOENT/.test(spawnError)
          ? `Exécutable introuvable : "${binPath}". Indiquez le chemin de llama-server.exe dans Paramètres > Modèles.`
          : spawnError;
        this.process = null;
        this.status = { ...this.status, state: 'error', isRunning: false, lastError: error };
        return { success: false, error, status: this.getStatus() };
      }
      if (this.process !== proc) {
        return { success: false, error: this.status.lastError || 'Processus terminé pendant le chargement.', status: this.getStatus() };
      }
      try {
        const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          const readyAt = Date.now();
          this.status = { ...this.status, state: 'ready', isRunning: true, readyAt, loadMs: readyAt - startedAt };
          this.log('system', `Serveur prêt en ${readyAt - startedAt} ms.`);
          return { success: true, status: this.getStatus() };
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    return {
      success: false,
      error: 'Délai de chargement dépassé ; le processus reste en cours de démarrage.',
      status: this.getStatus(),
    };
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    const proc = this.process;
    this.status = { state: 'stopped', isRunning: false, port: this.status.port, host: this.status.host };
    this.job?.close();
    this.job = null;
    if (!proc) return { success: true };
    try {
      proc.kill();
      this.process = null;
      this.log('system', 'Arrêt demandé.');
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /** llama.cpp /props: context size, chat template, build. Undefined if not ready. */
  async props(): Promise<Record<string, unknown> | undefined> {
    if (this.status.state !== 'ready') return undefined;
    try {
      const res = await fetch(`${this.baseUrl()}/props`, { headers: llamaAuthHeaders(), signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /** Slot KV cache action (save / restore / erase) through llama.cpp /slots. */
  async slotAction(action: 'save' | 'restore' | 'erase', filename?: string, slot = 0): Promise<{ ok: boolean; data?: any; error?: string; ms: number }> {
    const t0 = Date.now();
    if (this.status.state !== 'ready') return { ok: false, error: 'llama-server non prêt', ms: 0 };
    try {
      const res = await fetch(`${this.baseUrl()}/slots/${slot}?action=${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...llamaAuthHeaders() },
        body: JSON.stringify(filename ? { filename } : {}),
        signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      return res.ok ? { ok: true, data, ms: Date.now() - t0 } : { ok: false, error: typeof data === 'object' ? data?.error?.message ?? text : text, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message, ms: Date.now() - t0 };
    }
  }

  pid(): number | undefined {
    return this.process?.pid;
  }
}
