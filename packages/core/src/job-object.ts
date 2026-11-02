import { spawn } from 'node:child_process';

/**
 * Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE around a process tree.
 *
 * Node has no FFI in its standard library, so CreateJobObject/AssignProcessToJobObject cannot be called
 * from JavaScript without a native addon (ffi-napi, koffi, a compiled .node). Instead, a PowerShell
 * helper compiles a few P/Invoke declarations (Add-Type, part of Windows), creates the job, assigns the
 * target PID to it and then holds the only job handle while it waits on stdin. When Studio exits or
 * crashes, the OS closes the pipe, the helper exits, its handle closes and Windows terminates every
 * process still in the job. close() does the same on purpose.
 *
 * Limits: assignment happens after the helper starts (about a second), so a grandchild spawned before
 * that is not in the job; killing paths therefore keep `taskkill /T /F` as well.
 */

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
trap { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MazzJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended {
    public Basic BasicLimits; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  public static IntPtr Attach(uint pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended info = new Extended();
    info.BasicLimits.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) throw new Win32Exception();
    IntPtr process = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (process == IntPtr.Zero) throw new Win32Exception();
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
    return job;
  }
}
'@
$null = [MazzJob]::Attach([uint32]$env:MAZZ_JOB_PID)
[Console]::Out.WriteLine('ATTACHED')
[Console]::Out.Flush()
$null = [Console]::In.ReadToEnd()
`;

export interface KillOnCloseJob {
  /** Resolves true once the PID is in the job, false when the helper could not attach it (reason logged). */
  attached: Promise<boolean>;
  /** Closes the job handle: Windows terminates every process still in the job. */
  close(): void;
}

const NOOP_JOB: KillOnCloseJob = { attached: Promise.resolve(false), close: () => undefined };

export function attachKillOnCloseJob(pid: number | undefined): KillOnCloseJob {
  if (process.platform !== 'win32' || !pid) return NOOP_JOB;
  // The script goes in -EncodedCommand so stdin stays free: its end is the helper's signal to close the job.
  const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
  const helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MAZZ_JOB_PID: String(pid) },
  });
  let stderr = '';
  const attached = new Promise<boolean>((resolve) => {
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', (chunk: string) => { if (chunk.includes('ATTACHED')) resolve(true); });
    helper.stderr.setEncoding('utf8');
    helper.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2_000); });
    helper.on('error', (err) => {
      console.error(`[job-object] helper PowerShell indisponible : ${err.message}`);
      resolve(false);
    });
    helper.on('exit', (code) => {
      if (code !== 0) console.error(`[job-object] PID ${pid} non rattaché (code ${code}) : ${stderr.trim().split('\n')[0] ?? ''}`);
      resolve(false);
    });
  });
  // Writing to an already exited helper must not crash Studio.
  helper.stdin.on('error', () => undefined);
  return {
    attached,
    close: () => {
      if (!helper.stdin.destroyed) helper.stdin.end();
    },
  };
}
