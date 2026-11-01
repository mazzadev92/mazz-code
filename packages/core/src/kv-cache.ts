import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { LlamaServerSupervisor } from '@mazz/model-manager';

/**
 * Per-session KV cache on disk for llama-server (single slot).
 *
 * The slot holds the KV cache of whoever used it last. Before a task of session
 * S, the current owner's cache is saved to disk and S's cache is restored if it
 * exists, so returning to a long conversation (or after a server restart) does
 * not recompute its whole prompt. Files are keyed by model and context size:
 * a cache is never restored into another model.
 *
 * Measured on Qwen3 0.6B, 1 516-token prompt: cold prefill 13.9 s, save 157 ms
 * (174 MB), restore 263 ms then 1 token recomputed.
 */

export interface KvPrepareResult {
  saved?: { sessionId: string; tokens: number; ms: number };
  restored?: { tokens: number; ms: number };
  skipped?: string;
}

export class KvSessionCache {
  private owner: string | undefined;
  private modelKey: string | undefined;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly supervisor: LlamaServerSupervisor,
    private maxBytes: number
  ) {}

  setMaxBytes(bytes: number): void {
    this.maxBytes = bytes;
  }

  /** Called after llama-server (re)starts: the slot is empty. */
  reset(modelPath: string | undefined, contextSize: number | undefined): void {
    this.owner = undefined;
    this.modelKey = modelPath
      ? createHash('sha1').update(`${path.resolve(modelPath).toLowerCase()}|${contextSize ?? 0}`).digest('hex').slice(0, 12)
      : undefined;
  }

  fileFor(sessionId: string): string | undefined {
    if (!this.modelKey) return undefined;
    // llama.cpp only accepts plain file names inside --slot-save-path.
    return `${this.modelKey}__${sessionId.replace(/[^\w-]/g, '_')}.bin`;
  }

  /** Serialized: two tasks never move the slot at the same time. */
  prepare(sessionId: string | null): Promise<KvPrepareResult> {
    const run = this.busy.then(() => this.doPrepare(sessionId));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async doPrepare(sessionId: string | null): Promise<KvPrepareResult> {
    if (!this.modelKey) return { skipped: 'aucun modèle chargé' };
    if (sessionId && this.owner === sessionId) return { skipped: 'slot déjà attribué à cette session' };
    const out: KvPrepareResult = {};
    if (this.owner) {
      const r = await this.supervisor.slotAction('save', this.fileFor(this.owner));
      if (r.ok) out.saved = { sessionId: this.owner, tokens: r.data?.n_saved ?? 0, ms: r.ms };
    }
    this.owner = undefined;
    if (sessionId) {
      const file = this.fileFor(sessionId)!;
      let exists = false;
      try {
        await fs.access(path.join(this.dir, file));
        exists = true;
      } catch {
        exists = false;
      }
      if (exists) {
        const r = await this.supervisor.slotAction('restore', file);
        if (r.ok) {
          out.restored = { tokens: r.data?.n_restored ?? 0, ms: r.ms };
          await fs.utimes(path.join(this.dir, file), new Date(), new Date()).catch(() => undefined);
        }
      }
      // Without a saved cache the slot is left as is: llama.cpp reuses the common prefix
      // (stable system prompt + tool definitions) and recomputes only what differs.
      this.owner = sessionId;
    }
    await this.prune();
    return out;
  }

  /** Saves the current owner's cache (server stop, explicit request). */
  async flush(): Promise<void> {
    if (this.owner && this.modelKey) {
      await this.supervisor.slotAction('save', this.fileFor(this.owner));
    }
  }

  async remove(sessionId: string): Promise<void> {
    if (this.owner === sessionId) this.owner = undefined;
    try {
      for (const f of await fs.readdir(this.dir)) {
        if (f.endsWith(`__${sessionId.replace(/[^\w-]/g, '_')}.bin`)) await fs.rm(path.join(this.dir, f), { force: true });
      }
    } catch {
      // directory absent
    }
  }

  async usage(): Promise<{ files: number; bytes: number; owner?: string; maxBytes: number }> {
    let files = 0;
    let bytes = 0;
    try {
      for (const f of await fs.readdir(this.dir)) {
        if (!f.endsWith('.bin')) continue;
        files++;
        bytes += (await fs.stat(path.join(this.dir, f))).size;
      }
    } catch {
      // directory absent
    }
    return { files, bytes, owner: this.owner, maxBytes: this.maxBytes };
  }

  /** Oldest files are deleted first when the directory exceeds the disk budget. */
  async prune(): Promise<void> {
    let entries: Array<{ f: string; size: number; t: number }> = [];
    try {
      for (const f of await fs.readdir(this.dir)) {
        if (!f.endsWith('.bin')) continue;
        const st = await fs.stat(path.join(this.dir, f));
        entries.push({ f, size: st.size, t: st.mtimeMs });
      }
    } catch {
      return;
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    entries = entries.sort((a, b) => a.t - b.t);
    const keep = this.owner ? this.fileFor(this.owner) : undefined;
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      if (e.f === keep) continue;
      await fs.rm(path.join(this.dir, e.f), { force: true });
      total -= e.size;
    }
  }

  async clear(): Promise<void> {
    this.owner = undefined;
    await fs.rm(this.dir, { recursive: true, force: true });
    await fs.mkdir(this.dir, { recursive: true });
  }
}
