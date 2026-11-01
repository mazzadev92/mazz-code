import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultMuceBridge } from '@mazz/muce-bridge';

/**
 * Hardware profile and llama.cpp auto-tuning.
 *
 * The profile is read from the machine (WMI on Windows, MUCE `hardware` when
 * configured for ISA flags). Recommendations are derived from it with simple
 * documented rules; the auto-tune then MEASURES generation and prompt speed
 * per thread count with llama-bench and recommends the fastest one.
 */

export interface HardwareProfile {
  cpu: { model: string; physicalCores?: number; logicalCores: number; l3CacheKb?: number; avx2?: boolean; fma?: boolean; isaSource: 'muce' | 'unknown' };
  memory: { totalBytes: number; availableBytes: number };
  gpu: string[];
  recommendations: {
    threads: number;
    parallel: number;
    cacheRamMb: number;
    contextSize: number;
    maxModelBytes: number;
    reasons: string[];
  };
}

let cache: { at: number; value: HardwareProfile } | null = null;

function run(cmd: string, args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

export async function hardwareProfile(refresh = false): Promise<HardwareProfile> {
  if (cache && !refresh && Date.now() - cache.at < 5 * 60000) {
    return { ...cache.value, memory: { totalBytes: os.totalmem(), availableBytes: os.freemem() } };
  }
  let physical: number | undefined;
  let l3: number | undefined;
  let gpu: string[] = [];
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$p = Get-CimInstance Win32_Processor | Select-Object -First 1 NumberOfCores,L3CacheSize; $g = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }); @{ cores = $p.NumberOfCores; l3 = $p.L3CacheSize; gpu = $g } | ConvertTo-Json -Compress',
    ]);
    try {
      const j = JSON.parse(out);
      physical = Number(j.cores) || undefined;
      l3 = Number(j.l3) || undefined;
      gpu = (Array.isArray(j.gpu) ? j.gpu : [j.gpu]).filter(Boolean);
    } catch {
      // WMI unavailable: fields stay unknown
    }
  }
  let avx2: boolean | undefined;
  let fma: boolean | undefined;
  let isaSource: 'muce' | 'unknown' = 'unknown';
  const muce = await defaultMuceBridge.inspect();
  if (muce.isCliAvailable) {
    const hw = await defaultMuceBridge.runCommand('hardware', 8000);
    const d = hw.data as { avx2?: number; fma?: number } | undefined;
    if (hw.success && d) {
      avx2 = d.avx2 === 1;
      fma = d.fma === 1;
      isaSource = 'muce';
    }
  }
  const logical = os.cpus().length;
  const total = os.totalmem();
  const avail = os.freemem();
  const reasons: string[] = [];
  const threads = physical ?? Math.max(1, Math.floor(logical / 2));
  reasons.push(physical ? `${physical} cœurs physiques : un thread par cœur (llama.cpp sature la bande mémoire avant les threads logiques).` : 'Cœurs physiques inconnus : moitié des threads logiques.');
  const parallel = 1;
  reasons.push('Un seul slot : sur un processeur grand public, décoder deux requêtes en parallèle partage le même temps CPU.');
  const cacheRamMb = Math.max(256, Math.min(2048, Math.round(total / (1024 * 1024) / 16)));
  reasons.push(`Cache de prompt en RAM limité à ${cacheRamMb} Mo (1/16 de la RAM ; llama.cpp en réserve jusqu’à 8 Go par défaut).`);
  const contextSize = total >= 30e9 ? 8192 : 4096;
  reasons.push(`Contexte par défaut ${contextSize} jetons pour ${Math.round(total / 1e9)} Go de RAM.`);
  const maxModelBytes = Math.round(total * 0.4);
  reasons.push(`Modèles conseillés jusqu’à ${Math.round(maxModelBytes / 1e9)} Go de poids (40 % de la RAM), soit environ 4B en Q4_K_M.`);
  if (avx2 === false) reasons.push('AVX2 absent : choisir un build llama.cpp sans AVX2.');
  const value: HardwareProfile = {
    cpu: { model: os.cpus()[0]?.model.trim() ?? 'inconnu', physicalCores: physical, logicalCores: logical, l3CacheKb: l3, avx2, fma, isaSource },
    memory: { totalBytes: total, availableBytes: avail },
    gpu,
    recommendations: { threads, parallel, cacheRamMb, contextSize, maxModelBytes, reasons },
  };
  cache = { at: Date.now(), value };
  return value;
}

export interface AutotuneRow {
  threads: number;
  ppTokS?: number;
  tgTokS?: number;
}

export interface AutotuneResult {
  modelFile: string;
  bench: string;
  method: string;
  rows: AutotuneRow[];
  recommended: { threads: number; tgTokS?: number; ppTokS?: number };
  durationMs: number;
  build?: string;
}

/** Measures pp and tg per thread count with llama-bench (model loaded once per thread value). */
export async function runAutotune(benchExe: string, modelPath: string, threadsOverride?: number[]): Promise<AutotuneResult> {
  const hw = await hardwareProfile();
  const maxT = hw.cpu.logicalCores;
  const base = hw.cpu.physicalCores ?? maxT;
  const candidates = (threadsOverride?.length ? threadsOverride : [Math.max(1, base - 2), base - 1, base, maxT])
    .filter((t) => Number.isInteger(t) && t >= 1 && t <= 64)
    .filter((t, i, a) => a.indexOf(t) === i)
    .sort((a, b) => a - b);
  const args = ['-m', modelPath, '-t', candidates.join(','), '-p', '64', '-n', '32', '-r', '2', '-o', 'json'];
  const t0 = Date.now();
  const out = await new Promise<string>((resolve, reject) => {
    execFile(benchExe, args, { cwd: path.dirname(benchExe), windowsHide: true, timeout: 15 * 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`llama-bench a échoué : ${(stderr || err.message).trim().slice(-400)}`));
      else resolve(stdout);
    });
  });
  const data = JSON.parse(out.slice(out.indexOf('['))) as Array<{ n_threads: number; n_prompt: number; n_gen: number; avg_ts: number; build_commit?: string }>;
  const rows: AutotuneRow[] = candidates.map((t) => ({
    threads: t,
    ppTokS: data.find((d) => d.n_threads === t && d.n_prompt > 0)?.avg_ts,
    tgTokS: data.find((d) => d.n_threads === t && d.n_gen > 0)?.avg_ts,
  }));
  // Agent work is dominated by generation: the fastest tg wins; pp breaks ties within 3 %.
  const best = [...rows].sort((a, b) => {
    const dt = (b.tgTokS ?? 0) - (a.tgTokS ?? 0);
    if (Math.abs(dt) > 0.03 * Math.max(a.tgTokS ?? 0, b.tgTokS ?? 0)) return dt;
    return (b.ppTokS ?? 0) - (a.ppTokS ?? 0);
  })[0];
  return {
    modelFile: path.basename(modelPath),
    bench: benchExe,
    method: 'llama-bench : prompt 64 jetons, génération 32 jetons, 2 répétitions par nombre de threads',
    rows,
    recommended: { threads: best.threads, tgTokS: best.tgTokS, ppTokS: best.ppTokS },
    durationMs: Date.now() - t0,
    build: data[0]?.build_commit,
  };
}
