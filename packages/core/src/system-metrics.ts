import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';

export interface ProcessMemory {
  pid: number;
  /** Working set reported by Windows tasklist (resident memory), in bytes. */
  workingSetBytes: number;
  source: 'tasklist' | 'ps';
}

export interface GpuInfo {
  name: string;
  driver?: string;
  vramBytes?: number;
  vendor?: 'nvidia' | 'amd' | 'intel' | 'other';
  source: 'nvidia-smi' | 'wmi';
}

export interface GpuTelemetryCard {
  index: number;
  name: string;
  utilizationPercent?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
}

export interface SystemMetrics {
  sampledAt: number;
  cpu: { model: string; logicalCores: number; usagePercent?: number; usageWindowMs?: number };
  memory: { totalBytes: number; availableBytes: number; usedPercent: number };
  studio: { rssBytes: number; heapUsedBytes: number };
  llamaServer?: ProcessMemory;
  gpu: { detected: GpuInfo[]; telemetry: 'nvidia-smi' | 'unavailable'; cards?: GpuTelemetryCard[] };
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

let gpuCache: GpuInfo[] | null = null;
let nvidiaSmiAvailable: boolean | null = null;

/** Absolute locations of nvidia-smi when the driver did not add it to PATH (older installs, locked-down PATH). */
const NVIDIA_SMI_PATHS = [
  'C:\\Windows\\System32\\nvidia-smi.exe',
  'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
  'C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\nvsmi\\nvidia-smi.exe',
];
// undefined = not resolved yet, null = proven absent, string = usable command (bare name or absolute path).
let nvidiaSmiCmd: string | null | undefined;

function vendorOf(name: string): GpuInfo['vendor'] {
  const n = name.toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('quadro') || n.includes('tesla')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon') || n.includes('ati ')) return 'amd';
  if (n.includes('intel') || n.includes('arc ')) return 'intel';
  return 'other';
}

function execText(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** Finds a usable nvidia-smi: PATH first, then the driver's own folders (System32 and the legacy NVSMI path). */
async function resolveNvidiaSmi(): Promise<string | null> {
  if (nvidiaSmiCmd !== undefined) return nvidiaSmiCmd;
  if ((await execText('nvidia-smi', ['-L'], 4000)).trim()) { nvidiaSmiCmd = 'nvidia-smi'; return nvidiaSmiCmd; }
  for (const candidate of NVIDIA_SMI_PATHS) {
    if (existsSync(candidate) && (await execText(candidate, ['-L'], 4000)).trim()) { nvidiaSmiCmd = candidate; return nvidiaSmiCmd; }
  }
  nvidiaSmiCmd = null;
  return null;
}

async function nvidiaSmi(query: string): Promise<string[]> {
  const cmd = await resolveNvidiaSmi();
  if (!cmd) { if (nvidiaSmiAvailable === null) nvidiaSmiAvailable = false; return []; }
  const out = await execText(cmd, ['--query-gpu=' + query, '--format=csv,noheader,nounits'], 5000);
  if (out.trim()) nvidiaSmiAvailable = true;
  else if (nvidiaSmiAvailable === null) nvidiaSmiAvailable = false;
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * True VRAM of non-NVIDIA adapters. WMI AdapterRAM is a 32-bit field (clamped at 4 GiB), so AMD/Intel cards
 * read from the display class registry key HardwareInformation.qwMemorySize, a 64-bit value. Returns a name ->
 * bytes map (empty when the key is absent, e.g. integrated GPUs that share system memory).
 */
async function registryVram(): Promise<Map<string, number>> {
  const out = await execText('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; " +
    "$o=@(); Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; " +
    "if ($p.'HardwareInformation.qwMemorySize' -and $p.DriverDesc) { $o += [pscustomobject]@{ Name=$p.DriverDesc; Vram=[uint64]$p.'HardwareInformation.qwMemorySize' } } }; " +
    '@($o) | ConvertTo-Json -Compress',
  ], 8000);
  const map = new Map<string, number>();
  try {
    const raw = JSON.parse(out || '[]');
    for (const g of (Array.isArray(raw) ? raw : [raw]) as Array<{ Name?: string; Vram?: number }>) {
      const name = (g.Name ?? '').trim();
      if (name && Number(g.Vram) > 0) map.set(name.toLowerCase(), Number(g.Vram));
    }
  } catch {
    // registry unavailable: no true VRAM for AMD/Intel, AdapterRAM stays best effort
  }
  return map;
}

/** NVIDIA first (exact VRAM from the driver), then WMI for every other adapter (AMD, Intel, virtual). */
export async function detectGpus(): Promise<GpuInfo[]> {
  if (gpuCache) return gpuCache;
  const list: GpuInfo[] = [];
  const nvidia = await nvidiaSmi('name,memory.total,driver_version');
  for (const line of nvidia) {
    const [name, vramMiB, driver] = line.split(',').map((part) => part.trim());
    if (!name) continue;
    const mib = Number(vramMiB);
    list.push({
      name,
      driver: driver || undefined,
      vramBytes: Number.isFinite(mib) && mib > 0 ? Math.round(mib * 1024 * 1024) : undefined,
      vendor: 'nvidia',
      source: 'nvidia-smi',
    });
  }
  if (process.platform === 'win32') {
    const regVram = await registryVram();
    const out = await execText('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress',
    ], 8000);
    try {
      const raw = JSON.parse(out || '[]');
      const wmi = (Array.isArray(raw) ? raw : [raw]) as Array<{ Name?: string; DriverVersion?: string; AdapterRAM?: number }>;
      for (const g of wmi) {
        const name = (g.Name ?? '').trim();
        if (!name) continue;
        if (list.some((known) => known.name.toLowerCase() === name.toLowerCase())) continue;
        if (nvidia.length > 0 && vendorOf(name) === 'nvidia') continue;
        const ram = Number(g.AdapterRAM);
        // WMI AdapterRAM is a 32-bit field: values at 4 GiB mean "too large to report", not 4 GiB.
        const adapterVram = Number.isFinite(ram) && ram > 0 && ram < 0xfff00000 ? ram : undefined;
        let vram = adapterVram;
        if (!vram) {
          const fromReg = regVram.get(name.toLowerCase());
          if (fromReg !== undefined && fromReg > 0) vram = fromReg;
        }
        list.push({ name, driver: g.DriverVersion || undefined, vramBytes: vram, vendor: vendorOf(name), source: 'wmi' });
      }
    } catch {
      // WMI unavailable: NVIDIA cards already collected above.
    }
  }
  gpuCache = list.filter((g) => g.name);
  return gpuCache;
}

/** Live NVIDIA utilization/VRAM. Empty when nvidia-smi is absent or the driver does not expose it. */
export async function gpuTelemetry(): Promise<GpuTelemetryCard[]> {
  if (nvidiaSmiAvailable === false) return [];
  const lines = await nvidiaSmi('index,name,utilization.gpu,memory.used,memory.total');
  const cards: GpuTelemetryCard[] = [];
  for (const line of lines) {
    const [index, name, util, used, total] = line.split(',').map((part) => part.trim());
    const card: GpuTelemetryCard = { index: Number(index) || 0, name };
    const u = Number(util);
    const mUsed = Number(used);
    const mTotal = Number(total);
    if (Number.isFinite(u)) card.utilizationPercent = u;
    if (Number.isFinite(mUsed)) card.memoryUsedBytes = Math.round(mUsed * 1024 * 1024);
    if (Number.isFinite(mTotal)) card.memoryTotalBytes = Math.round(mTotal * 1024 * 1024);
    cards.push(card);
  }
  return cards;
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
    const cards = await gpuTelemetry();
    this.cached = {
      sampledAt: now,
      cpu: { model: cpus[0]?.model.trim() ?? 'inconnu', logicalCores: cpus.length, usagePercent, usageWindowMs },
      memory: { totalBytes: total, availableBytes: free, usedPercent: ((total - free) / total) * 100 },
      studio: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      llamaServer: llamaPid ? await processMemory(llamaPid) : undefined,
      gpu: {
        detected: await detectGpus(),
        telemetry: cards.length ? 'nvidia-smi' : 'unavailable',
        cards: cards.length ? cards : undefined,
      },
      uptimeSec: Math.round(process.uptime()),
    };
    return this.cached;
  }
}
