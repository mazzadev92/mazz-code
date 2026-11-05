import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { InferenceTelemetry } from '@mazz/shared';
import { DebouncedWriter, readJson } from './storage.js';

/** One measured model call, linked to where it came from. */
export interface TelemetryRecord extends InferenceTelemetry {
  id: string;
  kind: 'agent' | 'inference_test' | 'benchmark';
  taskId?: string;
  sessionId?: string;
  /** Runtime parameters known at measurement time (llama-server launch config). */
  runtime?: { contextSize?: number; threads?: number; batchSize?: number; modelFile?: string; quantization?: string };
}

export class TelemetryStore {
  private records: TelemetryRecord[] = [];
  private readonly writer: DebouncedWriter;
  private readonly file: string;

  constructor(dataDir: string, private retention = 500) {
    this.file = path.join(dataDir, 'telemetry.json');
    this.writer = new DebouncedWriter(this.file, 1000);
  }

  async load(): Promise<void> {
    const data = await readJson<TelemetryRecord[]>(this.file, []);
    this.records = Array.isArray(data) ? data : [];
  }

  setRetention(n: number): void {
    this.retention = n;
  }

  add(rec: Omit<TelemetryRecord, 'id'>): TelemetryRecord {
    const full = { ...rec, id: `m_${rec.endedAt.toString(36)}_${Math.random().toString(36).slice(2, 6)}` };
    this.records.push(full);
    if (this.records.length > this.retention) this.records.splice(0, this.records.length - this.retention);
    this.writer.schedule(this.records);
    return full;
  }

  list(filter: { sessionId?: string; kind?: string; limit?: number } = {}): TelemetryRecord[] {
    let out = this.records;
    if (filter.sessionId) out = out.filter((r) => r.sessionId === filter.sessionId);
    if (filter.kind) out = out.filter((r) => r.kind === filter.kind);
    return out.slice(-(filter.limit ?? 200));
  }

  async clear(): Promise<void> {
    this.records = [];
    this.writer.schedule(this.records);
    await this.writer.flush();
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }
}

export interface BenchmarkResult {
  id: string;
  createdAt: number;
  engine: 'llama.cpp';
  /** Identical key means identical methodology: only such runs are compared. */
  methodologyKey: string;
  modelFile: string;
  quantization?: string;
  contextSize?: number;
  threads?: number;
  batchSize?: number;
  promptTokens: number;
  nPredict: number;
  repetitions: number;
  runs: Array<{ ppTokS?: number; tgTokS?: number; promptMs?: number; generationMs?: number; predicted?: number }>;
  meanPpTokS?: number;
  meanTgTokS?: number;
  serverWorkingSetMb?: number;
  buildInfo?: string;
}

export class BenchmarkStore {
  private results: BenchmarkResult[] = [];
  private readonly file: string;
  private readonly writer: DebouncedWriter;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'benchmarks.json');
    this.writer = new DebouncedWriter(this.file, 200);
  }

  async load(): Promise<void> {
    const data = await readJson<BenchmarkResult[]>(this.file, []);
    this.results = Array.isArray(data) ? data : [];
  }

  add(r: BenchmarkResult): void {
    this.results.push(r);
    if (this.results.length > 200) this.results.shift();
    this.writer.schedule(this.results);
  }

  list(): BenchmarkResult[] {
    return [...this.results].reverse();
  }

  async remove(id: string): Promise<boolean> {
    const n = this.results.length;
    this.results = this.results.filter((r) => r.id !== id);
    this.writer.schedule(this.results);
    await this.writer.flush();
    return this.results.length !== n;
  }
}

export interface AuditEntry {
  t: number;
  kind: 'approval' | 'policy' | 'file' | 'terminal' | 'git' | 'secret' | 'settings' | 'model' | 'rollback';
  action: string;
  decision?: 'allowed' | 'denied' | 'timeout';
  detail?: string;
  taskId?: string;
}

const AUDIT_KINDS: readonly AuditEntry['kind'][] = ['approval', 'policy', 'file', 'terminal', 'git', 'secret', 'settings', 'model', 'rollback'];
const AUDIT_DECISIONS: readonly NonNullable<AuditEntry['decision']>[] = ['allowed', 'denied', 'timeout'];

const SECRET_ASSIGNMENT = /(["']?\b(?:api[-_ ]?key|x[-_]?api[-_]?key|key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|auth(?:orization)?(?:[-_ ]?token)?|bearer|client[-_ ]?secret|secret(?:[-_ ]?(?:access|signing|private))?[-_ ]?key|private[-_ ]?key|password|passwd|passphrase|credential|token|secret|signature|sig|sas|aws[-_ ]?access[-_ ]?key(?:[-_ ]?id)?)["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s&;,}\]]+))/gi;
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/gi,
  /\b(?:rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{12,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\b(?:hf|npm)_[A-Za-z0-9_-]{12,}\b/gi,
  /\bpypi-[A-Za-z0-9_-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

function redactAuditText(value: string): string {
  // Do this first so an Authorization assignment cannot hide the scheme from
  // the header-specific pass and leave its credential value behind.
  let safe = value.replace(/\b(Bearer|Basic)\s+[^\s"'&,;)}\]]+/gi, '$1 [REDACTED]');
  safe = safe.replace(SECRET_ASSIGNMENT, (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    if (doubleQuoted !== undefined) return `${prefix}"[REDACTED]"`;
    if (singleQuoted !== undefined) return `${prefix}'[REDACTED]'`;
    return `${prefix}[REDACTED]`;
  });

  // URL user-info is credentials too; keep the username and host for diagnosis.
  safe = safe.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/@\s]+:)[^/@\s?#]+(@)/gi, '$1[REDACTED]$2');
  for (const pattern of TOKEN_PATTERNS) safe = safe.replace(pattern, '[REDACTED]');
  return safe;
}

function sanitizeAuditEntry(value: AuditEntry): AuditEntry {
  const entry = value as Partial<AuditEntry>;
  return {
    t: typeof entry.t === 'number' && Number.isFinite(entry.t) ? entry.t : Date.now(),
    kind: AUDIT_KINDS.includes(entry.kind as AuditEntry['kind']) ? entry.kind as AuditEntry['kind'] : 'policy',
    action: typeof entry.action === 'string' ? redactAuditText(entry.action).slice(0, 300) : 'unknown',
    ...(AUDIT_DECISIONS.includes(entry.decision as NonNullable<AuditEntry['decision']>) ? { decision: entry.decision } : {}),
    ...(typeof entry.detail === 'string' ? { detail: redactAuditText(entry.detail).slice(0, 500) } : {}),
    ...(typeof entry.taskId === 'string' ? { taskId: redactAuditText(entry.taskId).slice(0, 200) } : {}),
  };
}

/** Append-only JSONL audit trail; redact credential-shaped values before persistence and exposure. */
export class AuditLog {
  private readonly file: string;
  private recent: AuditEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string, private retention = 2000) {
    this.file = path.join(dataDir, 'audit.jsonl');
  }

  async load(): Promise<void> {
    await this.writeQueue;
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      this.recent = raw
        .split('\n')
        .filter(Boolean)
        .slice(-this.retention)
        .map((l) => {
          try {
            const entry = JSON.parse(l) as AuditEntry;
            return entry && typeof entry === 'object' ? sanitizeAuditEntry(entry) : null;
          } catch {
            return null;
          }
        })
        .filter((x): x is AuditEntry => x !== null);
    } catch {
      this.recent = [];
    }
  }

  record(entry: Omit<AuditEntry, 't'>): void {
    const full = sanitizeAuditEntry({ ...entry, t: Date.now() } as AuditEntry);
    this.recent.push(full);
    if (this.recent.length > this.retention) this.recent.shift();
    this.enqueueWrite(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, JSON.stringify(full) + '\n', 'utf-8');
    });
  }

  list(limit = 300): AuditEntry[] {
    return this.recent.slice(-limit).reverse().map(sanitizeAuditEntry);
  }

  async clear(): Promise<void> {
    this.recent = [];
    await this.enqueueWrite(() => fs.rm(this.file, { force: true }));
  }

  private enqueueWrite(operation: () => Promise<unknown>): Promise<void> {
    this.writeQueue = this.writeQueue.then(operation).then(() => undefined).catch((error) => { console.error(`[records] écriture impossible (${this.file}) : ${(error as Error).message}`); });
    return this.writeQueue;
  }
}
