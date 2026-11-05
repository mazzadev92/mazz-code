import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isIP } from 'node:net';
import * as path from 'node:path';
import { MessageChannel, Worker } from 'node:worker_threads';
import type { McpHostMessage } from './mcp-node-worker.js';
import type { ExecutionMode, ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolJSONSchema } from '@mazz/shared';
import type { ToolRegistry } from '@mazz/tools';

/**
 * MCP client manager. Servers are configured in settings and started on demand
 * (never at Studio start, to spare a 4-core machine). Each tool of a running
 * server is registered in the agent tool registry as `mcp.<server>.<tool>`,
 * with permission category "mcp", and unregistered when the server stops.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'node';
  command?: string;
  /** Absolute path of the .js/.mjs module of an in-process ("node") server, run confined in a worker. */
  entryPoint?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  /** Non-secret HTTP headers (HTTP transport). */
  headers?: Record<string, string>;
  /**
   * Where the secret kept in the vault (entry "mcp:<id>") is passed: HTTP header
   * name (default Authorization, "Bearer " added) or environment variable (stdio).
   */
  secretName?: string;
  enabled: boolean;
  /** Started automatically when an agent task begins (otherwise manual start). */
  autoStart: boolean;
}

export type McpState = 'stopped' | 'starting' | 'running' | 'error';

export interface McpServerStatus {
  id: string;
  state: McpState;
  tools: Array<{ name: string; registeredAs: string; description: string }>;
  error?: string;
  startedAt?: number;
  /** Child PID for stdio servers, used for lifecycle diagnostics. */
  processId?: number;
  serverInfo?: { name?: string; version?: string };
  stderrTail: string[];
}

interface Running {
  client: Client;
  transport: { close(): Promise<void> };
  registered: string[];
  remoteHttp: boolean;
}

interface Starting {
  transport: { close(): Promise<void> };
  remoteHttp: boolean;
}

export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Hostname-only loopback check: strict mode never relies on DNS resolution. */
export function isMcpHttpLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host === 'localhost') return true;
    if (isIP(host) === 4) return Number(host.split('.')[0]) === 127;
    return isIP(host) === 6 && host === '::1';
  } catch {
    return false;
  }
}

export function validateMcpConfig(c: Partial<McpServerConfig>): McpServerConfig {
  if (!c.id || !ID_RE.test(c.id)) throw new Error('Identifiant MCP invalide : minuscules, chiffres et tirets (1 à 31).');
  if (c.transport !== 'stdio' && c.transport !== 'http' && c.transport !== 'node') throw new Error('Transport MCP : "stdio", "http" ou "node".');
  if (c.transport === 'stdio' && (!c.command || typeof c.command !== 'string')) throw new Error('Commande requise pour un serveur stdio.');
  if (c.transport === 'node' && (typeof c.entryPoint !== 'string' || !path.isAbsolute(c.entryPoint) || !/\.(m?js|cjs)$/i.test(c.entryPoint))) {
    throw new Error('Point d’entrée absolu .js/.mjs/.cjs requis pour un serveur MCP en processus.');
  }
  if (c.transport === 'http') {
    try {
      const u = new URL(String(c.url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      throw new Error('URL http(s) requise pour un serveur HTTP.');
    }
  }
  return {
    id: c.id,
    name: String(c.name || c.id).slice(0, 80),
    transport: c.transport,
    command: c.command,
    entryPoint: c.transport === 'node' ? path.resolve(c.entryPoint!) : undefined,
    args: Array.isArray(c.args) ? c.args.map(String).slice(0, 50) : [],
    cwd: c.cwd || undefined,
    env: c.env && typeof c.env === 'object' ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)])) : undefined,
    url: c.url,
    headers: c.headers && typeof c.headers === 'object' ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, String(v)]).filter(([k]) => /^[A-Za-z0-9-]{1,64}$/.test(k))) : undefined,
    secretName: typeof c.secretName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.secretName) ? c.secretName : undefined,
    enabled: c.enabled !== false,
    autoStart: c.autoStart === true,
  };
}

function wireToolName(serverId: string, tool: string): string {
  // Dots separate namespace levels; the provider maps them to "__" for remote APIs.
  return `mcp.${serverId}.${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

class McpTool implements ITool {
  constructor(
    readonly definition: ToolDefinition,
    private readonly client: Client,
    private readonly remoteName: string,
    private readonly remoteHttp: boolean,
    private readonly getExecutionMode: () => ExecutionMode,
    private readonly isStrictTransitionActive: () => boolean
  ) {}

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      if (this.remoteHttp && (context.executionMode === 'local_strict' || this.getExecutionMode() === 'local_strict' || this.isStrictTransitionActive())) {
        throw new Error('Mode local strict : l’appel MCP HTTP vers un hôte non loopback est refusé.');
      }
      const res = (await this.client.callTool({ name: this.remoteName, arguments: params }, undefined, { timeout: 120000, signal: context.signal })) as {
        content?: Array<{ type: string; text?: string; mimeType?: string }>;
        isError?: boolean;
        structuredContent?: unknown;
      };
      const parts = res.content ?? [];
      const text = parts
        .map((p) => (p.type === 'text' ? p.text : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ''}]`))
        .join('\n')
        .slice(0, 24000);
      return {
        success: !res.isError,
        output: { text, structured: res.structuredContent },
        error: res.isError ? text.slice(0, 2000) || 'Erreur renvoyée par le serveur MCP.' : undefined,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return { success: false, output: null, error: `MCP : ${(err as Error).message}`, durationMs: Date.now() - start };
    }
  }
}

/**
 * Client transport of an in-process MCP server: the module runs in a worker thread confined by
 * mcp-node-worker.ts. Requests go to the worker's stdin; its stdout/stderr arrive as typed messages on
 * a MessagePort. close() terminates the worker, which drops its whole module cache.
 */
export class WorkerMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private worker?: Worker;
  private readonly buffer = new ReadBuffer();
  private closed = false;

  constructor(private readonly entryPoint: string, private readonly onStderr: (text: string) => void = () => undefined) {}

  async start(): Promise<void> {
    if (this.worker) throw new Error('Transport MCP en processus déjà démarré.');
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(new URL('./mcp-node-worker.js', import.meta.url), {
      workerData: { entryPoint: this.entryPoint, port: port2 },
      transferList: [port2],
      stdin: true,
    });
    this.worker = worker;
    port1.on('message', (message: McpHostMessage) => {
      if (message.type === 'stdout') {
        this.buffer.append(Buffer.from(message.data, 'utf8'));
        for (;;) {
          let parsed: JSONRPCMessage | null;
          try {
            parsed = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (!parsed) break;
          this.onmessage?.(parsed);
        }
      } else if (message.type === 'stderr') this.onStderr(message.data);
      else if (message.type === 'fatal') {
        const error = new Error(`Chargement du serveur MCP impossible : ${message.message}`);
        this.onStderr(error.message);
        this.onerror?.(error);
        // Closing rejects the pending initialize request instead of waiting for the connect timeout.
        void this.close();
      }
    });
    worker.on('error', (err: unknown) => this.onerror?.(err instanceof Error ? err : new Error(String(err))));
    worker.on('exit', () => {
      port1.close();
      this.finish();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.worker?.stdin;
    if (!stdin || this.closed) throw new Error('Serveur MCP en processus arrêté.');
    await new Promise<void>((resolve, reject) => stdin.write(serializeMessage(message), (err) => err ? reject(err) : resolve()));
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}

export class McpManager {
  private running = new Map<string, Running>();
  private starting = new Map<string, Starting>();
  private status = new Map<string, McpServerStatus>();
  private strictTransitionActive = false;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly getConfigs: () => McpServerConfig[],
    private readonly getSecret: (id: string) => string | undefined = () => undefined,
    private readonly getExecutionMode: () => ExecutionMode = () => 'manual',
    private readonly fetchImpl?: McpFetch
  ) {}

  /** Block new non-loopback HTTP MCP work immediately, then close existing transports. */
  async beginLocalStrictTransition(): Promise<void> {
    this.strictTransitionActive = true;
    const remoteIds = new Set([
      ...Array.from(this.running.entries()).filter(([, running]) => running.remoteHttp).map(([id]) => id),
      ...Array.from(this.starting.entries()).filter(([, pending]) => pending.remoteHttp).map(([id]) => id),
    ]);
    await Promise.all(Array.from(remoteIds, (id) => this.stop(id)));
  }

  /** Called after settings persistence succeeds or fails without entering strict mode. */
  completeLocalStrictTransition(): void {
    this.strictTransitionActive = false;
  }

  list(): Array<McpServerConfig & { status: McpServerStatus }> {
    return this.getConfigs().map((c) => {
      const status = this.status.get(c.id) ?? { id: c.id, state: 'stopped' as const, tools: [], stderrTail: [] };
      if ((this.strictTransitionActive || this.getExecutionMode() === 'local_strict') && c.transport === 'http' && !isMcpHttpLoopbackUrl(c.url ?? '')) {
        return { ...c, status: { ...status, state: 'error' as const, tools: [], error: 'Mode local strict : serveur MCP HTTP distant désactivé.' } };
      }
      return { ...c, status };
    });
  }

  async start(id: string, executionMode: ExecutionMode = this.getExecutionMode()): Promise<McpServerStatus> {
    const cfg = this.getConfigs().find((c) => c.id === id);
    if (!cfg) throw new Error(`Serveur MCP inconnu : ${id}`);
    if (!cfg.enabled) throw new Error(`Serveur MCP désactivé : ${id}`);
    const remoteHttp = cfg.transport === 'http' && !isMcpHttpLoopbackUrl(cfg.url ?? '');
    if (remoteHttp && (this.strictTransitionActive || executionMode === 'local_strict' || this.getExecutionMode() === 'local_strict')) {
      return {
        id,
        state: 'error',
        tools: [],
        error: 'Mode local strict : démarrage MCP HTTP vers un hôte non loopback refusé.',
        stderrTail: this.status.get(id)?.stderrTail ?? [],
      };
    }
    if (this.running.has(id)) return this.status.get(id)!;
    if (this.starting.has(id)) return this.status.get(id)!;
    const st: McpServerStatus = { id, state: 'starting', tools: [], stderrTail: [] };
    this.status.set(id, st);
    let transport: StdioClientTransport | StreamableHTTPClientTransport | WorkerMcpTransport | undefined;
    const keepStderr = (text: string) => {
      for (const l of text.split(/\r?\n/)) if (l.trim()) st.stderrTail.push(l.slice(0, 300));
      if (st.stderrTail.length > 40) st.stderrTail.splice(0, st.stderrTail.length - 40);
    };
    try {
      const secret = this.getSecret(id);
      if (cfg.transport === 'node') {
        transport = new WorkerMcpTransport(cfg.entryPoint!, keepStderr);
      } else if (cfg.transport === 'stdio') {
        const stdio = new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          cwd: cfg.cwd,
          // StdioClientTransport already inherits its documented safe OS
          // environment allowlist. Passing process.env here would additionally
          // expose every Studio credential to each configured MCP child.
          env: { ...(cfg.env ?? {}), ...(secret && cfg.secretName ? { [cfg.secretName]: secret } : {}) },
          stderr: 'pipe',
        });
        transport = stdio;
      } else {
        const headers: Record<string, string> = { ...(cfg.headers ?? {}) };
        if (secret) {
          const name = cfg.secretName || 'Authorization';
          headers[name] = name.toLowerCase() === 'authorization' && !/^(bearer|basic|token)\s/i.test(secret) ? `Bearer ${secret}` : secret;
        }
        transport = new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers }, fetch: this.fetchImpl });
      }
      this.starting.set(id, { transport, remoteHttp });
      const client = new Client({ name: 'mazz-agent-studio', version: '1.1.0' });
      const connect = client.connect(transport);
      if (transport instanceof StdioClientTransport) {
        transport.stderr?.on('data', (d: Buffer) => keepStderr(d.toString()));
      }
      let connectTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          connect,
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(() => reject(new Error('Délai de connexion dépassé (30 s).')), 30000);
          }),
        ]);
      } finally {
        // A successful MCP handshake must not leave a live 30-second timer
        // holding the Studio process (or a test runner) open.
        if (connectTimer) clearTimeout(connectTimer);
      }
      this.assertRemoteHttpAllowed(remoteHttp, executionMode);
      if (transport instanceof StdioClientTransport && transport.pid !== null) {
        st.processId = transport.pid;
      }

      const tools: Array<{ name: string; description?: string; inputSchema: unknown }> = [];
      let cursor: string | undefined;
      do {
        this.assertRemoteHttpAllowed(remoteHttp, executionMode);
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as typeof tools));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 500);

      this.assertRemoteHttpAllowed(remoteHttp, executionMode);
      const mappedNames = new Set<string>();
      for (const t of tools) {
        if (typeof t.name !== 'string' || !t.name.trim()) throw new Error('Le serveur MCP a annoncé un outil sans nom valide.');
        const name = wireToolName(id, t.name);
        if (mappedNames.has(name)) throw new Error(`Collision de noms MCP après normalisation : ${t.name} devient ${name}.`);
        if (this.registry.has(name)) throw new Error(`Le nom d’outil MCP est déjà utilisé dans le Studio : ${name}.`);
        mappedNames.add(name);
      }
      const registered: string[] = [];
      try {
        for (const t of tools) {
          const name = wireToolName(id, t.name);
          const schema = (t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} }) as ToolJSONSchema;
          const def: ToolDefinition = {
            name,
            description: `[MCP ${cfg.name}] ${(t.description ?? t.name).slice(0, 400)}`,
            category: 'mcp',
            parameters: { type: 'object', properties: schema.properties ?? {}, ...(schema.required ? { required: schema.required } : {}) },
            requiresPermission: true,
          };
          this.registry.register(new McpTool(def, client, t.name, remoteHttp, this.getExecutionMode, () => this.strictTransitionActive));
          registered.push(name);
          st.tools.push({ name: t.name, registeredAs: name, description: (t.description ?? '').slice(0, 300) });
        }
      } catch (err) {
        for (const name of registered) this.registry.unregister(name);
        st.tools = [];
        throw err;
      }
      this.running.set(id, { client, transport, registered, remoteHttp });
      this.starting.delete(id);
      st.state = 'running';
      st.startedAt = Date.now();
      st.serverInfo = client.getServerVersion() as { name?: string; version?: string } | undefined;
      client.onclose = () => this.cleanup(id, 'Connexion fermée par le serveur.');
      return st;
    } catch (err) {
      this.starting.delete(id);
      st.state = 'error';
      st.error = (err as Error).message;
      await this.stop(id).catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
      await transport?.close().catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
      st.state = 'error';
      return st;
    }
  }

  private assertRemoteHttpAllowed(remoteHttp: boolean, executionMode: ExecutionMode): void {
    if (remoteHttp && (this.strictTransitionActive || executionMode === 'local_strict' || this.getExecutionMode() === 'local_strict')) {
      throw new Error('Mode local strict : le serveur MCP HTTP distant a été désactivé.');
    }
  }

  private cleanup(id: string, error?: string): void {
    const r = this.running.get(id);
    if (!r) return;
    for (const n of r.registered) this.registry.unregister(n);
    this.running.delete(id);
    const st = this.status.get(id);
    if (st) {
      st.state = error ? 'error' : 'stopped';
      st.error = error;
      st.tools = [];
      st.processId = undefined;
    }
  }

  async stop(id: string): Promise<void> {
    const r = this.running.get(id);
    if (!r) {
      const pending = this.starting.get(id);
      if (pending) {
        this.starting.delete(id);
        await pending.transport.close().catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
      }
      const st = this.status.get(id);
      if (st) {
        if (st.state !== 'error') st.state = 'stopped';
        st.processId = undefined;
      }
      return;
    }
    r.client.onclose = undefined;
    this.cleanup(id);
    await r.transport.close().catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(new Set([...this.running.keys(), ...this.starting.keys()])).map((id) => this.stop(id)));
  }

  /** Starts enabled servers flagged autoStart (called when an agent task begins). */
  async ensureAutoStarted(executionMode: ExecutionMode = this.getExecutionMode()): Promise<string[]> {
    const started: string[] = [];
    for (const c of this.getConfigs()) {
      if (c.enabled && c.autoStart && !this.running.has(c.id)) {
        const st = await this.start(c.id, executionMode);
        if (st.state === 'running') started.push(c.id);
      }
    }
    return started;
  }
}
