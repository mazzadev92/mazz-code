import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import * as path from 'node:path';

export interface DiskSpace { path: string; freeBytes: number; totalBytes: number }

export interface VolumeInfo {
  mount: string;
  label?: string;
  fileSystem?: string;
  totalBytes: number;
  freeBytes: number;
  type: 'fixed' | 'removable' | 'network' | 'other';
  /** Physical media behind the volume: solid-state, spinning, or unknown (best effort, needs the Storage module). */
  mediaType?: 'ssd' | 'hdd' | 'unknown';
  /** Transport reported by Windows (SATA, NVMe, USB...), when the Storage module answers. */
  busType?: string;
}

function mediaFrom(raw: unknown): VolumeInfo['mediaType'] {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'ssd') return 'ssd';
  if (v === 'hdd') return 'hdd';
  return undefined;
}

function powershellJson(script: string): Promise<unknown> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try { resolve(JSON.parse(stdout || 'null')); } catch { resolve(null); }
      });
  });
}

/** Every mounted local volume, so the UI never claims a single disk when the machine has several. */
export async function listVolumes(): Promise<VolumeInfo[]> {
  if (process.platform === 'win32') {
    // Logical disks for the letters, plus (best effort) the physical media behind each one so the UI can say
    // "SSD" or "disque dur" instead of just "interne". Get-PhysicalDisk/Get-Partition need the Storage module
    // and are wrapped: when they are unavailable the volumes are still returned without a media type.
    const script = [
      '$out = @()',
      '$phys = @{}; $part = @{}',
      'try { Get-PhysicalDisk | ForEach-Object { $phys[[string]$_.DeviceId] = $_ } } catch {}',
      'try { Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { $part[[string]$_.DriveLetter] = $_.DiskNumber } } catch {}',
      'foreach ($l in (Get-CimInstance Win32_LogicalDisk | Where-Object { $_.Size -gt 0 })) {',
      '  $letter = $l.DeviceID.TrimEnd(":")',
      '  $diskNum = $part[$letter]; $media = $null; $bus = $null',
      '  if ($null -ne $diskNum -and $phys.ContainsKey([string]$diskNum)) { $media = [string]$phys[[string]$diskNum].MediaType; $bus = [string]$phys[[string]$diskNum].BusType }',
      '  $out += [pscustomobject]@{ DeviceID=$l.DeviceID; VolumeName=$l.VolumeName; FileSystem=$l.FileSystem; Size=$l.Size; FreeSpace=$l.FreeSpace; DriveType=$l.DriveType; MediaType=$media; BusType=$bus }',
      '}',
      '@($out) | ConvertTo-Json -Compress',
    ].join('; ');
    const raw = await powershellJson(script);
    if (raw === null) return [];
    const rows = (Array.isArray(raw) ? raw : [raw]) as Array<{
      DeviceID?: string; VolumeName?: string; FileSystem?: string; Size?: number; FreeSpace?: number;
      DriveType?: number; MediaType?: string | null; BusType?: string | null;
    }>;
    const typeOf = (code?: number): VolumeInfo['type'] =>
      code === 2 ? 'removable' : code === 3 ? 'fixed' : code === 4 ? 'network' : 'other';
    return rows
      .filter((row) => row.DeviceID && Number(row.Size) > 0)
      .map((row) => {
        const type = typeOf(row.DriveType);
        return {
          mount: row.DeviceID!.endsWith('\\') ? row.DeviceID! : `${row.DeviceID!}\\`,
          label: row.VolumeName || undefined,
          fileSystem: row.FileSystem || undefined,
          totalBytes: Number(row.Size) || 0,
          freeBytes: Number(row.FreeSpace) || 0,
          type,
          mediaType: type === 'removable' ? 'unknown' : mediaFrom(row.MediaType),
          busType: row.BusType || undefined,
        };
      })
      .sort((a, b) => a.mount.localeCompare(b.mount));
  }
  try {
    const s = await statfs('/');
    return [{
      mount: '/',
      totalBytes: Number(s.blocks) * Number(s.bsize),
      freeBytes: Number(s.bavail) * Number(s.bsize),
      type: 'fixed',
    }];
  } catch {
    return [];
  }
}

/** Free/total space of the volume holding `p` (nearest existing ancestor). null when statfs is unavailable. */
export async function diskSpace(p: string): Promise<DiskSpace | null> {
  try {
    let dir = path.resolve(p);
    while (!existsSync(dir)) {
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    const s = await statfs(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const totalBytes = Number(s.blocks) * Number(s.bsize);
    return Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0 ? { path: p, freeBytes, totalBytes } : null;
  } catch {
    return null;
  }
}
