import { execFile } from 'node:child_process';
import * as os from 'node:os';

export interface ProcessMemory {
  pid: number;
  /** Working set reported by Windows tasklist (resident memory), in bytes. */
  workingSetBytes: number;
  source: 'tasklist' | 'ps';
}

export interface SystemMetrics {
  sampledAt: number;
  cpu: { model: string; logicalCores: number; usagePercent?: number; usageWindowMs?: number };
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  studio: { rssBytes: number; heapUsedBytes: number };
  llamaServer?: ProcessMemory;
  gpu: { detected: Array<{ name: string; driver?: string }>; telemetry: 'unavailable' };
  uptimeSec: number;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

/** Working set of one process, without spawning PowerShell (tasklist is ~10x cheaper). */
export function processMemory(pid: number): Promise<ProcessMemory | undefined> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        // "llama-server.exe","1234","Console","1","812 345 Ko"
        const cols = stdout.trim().split('","');
        if (cols.length < 5) return resolve(undefined);
        const kb = Number(cols[4].replace(/[^0-9]/g, ''));
        resolve(Number.isFinite(kb) && kb > 0 ? { pid, workingSetBytes: kb * 1024, source: 'tasklist' } : undefined);
      });
    } else {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 3000 }, (err, stdout) => {
        const kb = Number(stdout.trim());
        resolve(!err && kb > 0 ? { pid, workingSetBytes: kb * 1024, source: 'ps' } : undefined);
      });
    }
  });
}

let gpuCache: Array<{ name: string; driver?: string }> | null = null;

function detectGpus(): Promise<Array<{ name: string; driver?: string }>> {
  if (gpuCache) return Promise.resolve(gpuCache);
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      gpuCache = [];
      return resolve(gpuCache);
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        try {
          const raw = err ? [] : JSON.parse(stdout || '[]');
          const list = (Array.isArray(raw) ? raw : [raw]).map((g: { Name: string; DriverVersion?: string }) => ({ name: g.Name, driver: g.DriverVersion }));
          gpuCache = list.filter((g) => g.name);
        } catch {
          gpuCache = [];
        }
        resolve(gpuCache);
      }
    );
  });
}

/**
 * Samples system metrics on demand. CPU usage is the busy share between two
 * consecutive calls; the first call has no window and reports undefined.
 * Results are cached for `minIntervalMs` to keep polling cheap on 4 cores.
 */
export class SystemSampler {
  private prev?: { t: number; idle: number; total: number };
  private cached?: SystemMetrics;

  constructor(private readonly minIntervalMs = 1000) {}

  async sample(llamaPid?: number): Promise<SystemMetrics> {
    const now = Date.now();
    if (this.cached && now - this.cached.sampledAt < this.minIntervalMs && this.cached.llamaServer?.pid === llamaPid) {
      return this.cached;
    }
    const times = cpuTimes();
    let usagePercent: number | undefined;
    let usageWindowMs: number | undefined;
    if (this.prev) {
      const dTotal = times.total - this.prev.total;
      const dIdle = times.idle - this.prev.idle;
      if (dTotal > 0) {
        usagePercent = Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
        usageWindowMs = now - this.prev.t;
      }
    }
    this.prev = { t: now, ...times };
    const total = os.totalmem();
    const free = os.freemem();
    const mem = process.memoryUsage();
    const cpus = os.cpus();
    this.cached = {
      sampledAt: now,
      cpu: { model: cpus[0]?.model.trim() ?? 'inconnu', logicalCores: cpus.length, usagePercent, usageWindowMs },
      memory: { totalBytes: total, availableBytes: free, usedPercent: ((total - free) / total) * 100 },
      studio: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      llamaServer: llamaPid ? await processMemory(llamaPid) : undefined,
      gpu: { detected: await detectGpus(), telemetry: 'unavailable' },
      uptimeSec: Math.round(process.uptime()),
    };
    return this.cached;
  }
}
