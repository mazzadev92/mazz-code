import { execFile, execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult, DetectedToolchain } from '@mazz/shared';
import { resolveSafePath } from './fs.js';

export const GCC_MAX_RUNTIME_MS = 120_000;
export const GCC_MAX_CAPTURE_CHARS = 64 * 1024;

export interface BoundedProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
  durationMs: number;
}

function terminateCompilerTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, (error) => {
      if (error) proc.kill();
    });
    return;
  }
  proc.kill('SIGKILL');
}

/** Run a compiler without allowing an infinite process or unbounded diagnostics. */
export function runBoundedCompilerProcess(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs = GCC_MAX_RUNTIME_MS,
  maxCaptureChars = GCC_MAX_CAPTURE_CHARS,
): Promise<BoundedProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let killFallback: NodeJS.Timeout | undefined;
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killFallback) clearTimeout(killFallback);
      resolve({
        code, stdout, stderr, timedOut, stdoutTruncated, stderrTruncated,
        ...(error ? { error } : {}), durationMs: Date.now() - startedAt,
      });
    };
    const appendBounded = (current: string, chunk: Buffer | string): { value: string; truncated: boolean } => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const remaining = Math.max(0, maxCaptureChars - current.length);
      return text.length <= remaining
        ? { value: current + text, truncated: false }
        : { value: current + text.slice(0, remaining), truncated: true };
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (!proc) return;
      terminateCompilerTree(proc);
      // A broken taskkill installation must not leave the request pending.
      killFallback = setTimeout(() => proc.kill(), 6_000);
    }, Math.max(1, timeoutMs));
    timeout.unref();
    let proc: ChildProcess;
    try {
      proc = spawn(executable, args, { cwd, windowsHide: true });
    } catch (error) {
      finish(null, (error as Error).message);
      return;
    }
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      const captured = appendBounded(stdout, chunk);
      stdout = captured.value;
      stdoutTruncated ||= captured.truncated;
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const captured = appendBounded(stderr, chunk);
      stderr = captured.value;
      stderrTruncated ||= captured.truncated;
    });
    proc.once('error', (error) => finish(null, error.message));
    proc.once('close', (code) => finish(code));
  });
}

function showCapturedOutput(value: string, truncated: boolean, stream: string): string {
  return `${value.trim()}${truncated ? `${value.trim() ? '\n' : ''}[${stream} tronquée après ${GCC_MAX_CAPTURE_CHARS} caractères]` : ''}`;
}

export function detectToolchains(): DetectedToolchain[] {
  const tools = [
    { name: 'gcc', command: 'gcc', fallbackPaths: ['C:\\TDM-GCC-64\\bin\\gcc.exe', 'C:\\MinGW\\bin\\gcc.exe'] },
    { name: 'cmake', command: 'cmake', fallbackPaths: ['C:\\Program Files\\CMake\\bin\\cmake.exe'] },
    { name: 'cargo', command: 'cargo', fallbackPaths: [path.join(process.env.USERPROFILE || '', '.cargo', 'bin', 'cargo.exe')] },
    { name: 'node', command: 'node', fallbackPaths: ['C:\\Program Files\\nodejs\\node.exe'] },
    { name: 'python', command: 'python', fallbackPaths: ['C:\\Python314\\python.exe', 'C:\\Python312\\python.exe'] },
  ];

  const detected: DetectedToolchain[] = [];

  for (const t of tools) {
    let resolvedPath = '';
    let version = '';
    let available = false;

    try {
      const out = execSync(`where.exe ${t.command} 2>nul`, { encoding: 'utf-8' }).trim();
      if (out) {
        resolvedPath = out.split('\r\n')[0].trim();
        available = true;
      }
    } catch {
      for (const fp of t.fallbackPaths) {
        try {
          if (existsSync(fp)) {
            resolvedPath = fp;
            available = true;
            break;
          }
        } catch {}
      }
    }

    if (available && resolvedPath) {
      try {
        if (t.name === 'gcc') {
          version = execSync(`"${resolvedPath}" --version`, { encoding: 'utf-8' }).split('\n')[0].trim();
        } else if (t.name === 'cmake') {
          version = execSync(`"${resolvedPath}" --version`, { encoding: 'utf-8' }).split('\n')[0].trim();
        } else if (t.name === 'cargo') {
          version = execSync(`"${resolvedPath}" --version`, { encoding: 'utf-8' }).split('\n')[0].trim();
        } else if (t.name === 'node') {
          version = execSync(`"${resolvedPath}" -v`, { encoding: 'utf-8' }).trim();
        } else if (t.name === 'python') {
          version = execSync(`"${resolvedPath}" --version`, { encoding: 'utf-8' }).trim();
        }
      } catch {}
    }

    detected.push({
      name: t.name,
      command: t.command,
      path: resolvedPath,
      version: version || undefined,
      isAvailable: available,
    });
  }

  return detected;
}

export class CompilerGccTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'compiler.gcc',
    description: 'Compile du C/C++ avec GCC en exécutable ou en bibliothèque partagée (DLL Windows, SO Linux, dylib macOS).',
    category: 'compiler',
    parameters: {
      type: 'object',
      properties: {
        sourceFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Liste des fichiers sources C relatifs au workspace (ex: ["main.c"])',
        },
        outputExe: {
          type: 'string',
          description: 'Chemin du binaire produit (ex: "hello.exe" ou "bin/crc32.dll"). Le dossier parent est créé si nécessaire.',
        },
        kind: {
          type: 'string',
          enum: ['executable', 'shared_library'],
          description: 'Type de binaire. shared_library ajoute le flag de liaison et exige .dll sous Windows, .so sous Linux ou .dylib sous macOS.',
        },
        flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Flags GCC facultatifs (ex: ["-Wall", "-O2"])',
        },
      },
      required: ['sourceFiles', 'outputExe'],
    },
    requiresPermission: true,
  };

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    try {
      const sourceFiles = params.sourceFiles as string[];
      const outputExe = params.outputExe as string;
      const requestedFlags = Array.isArray(params.flags) ? params.flags as string[] : ['-Wall'];
      const outputExtension = path.extname(outputExe).toLowerCase();
      const sharedExtension = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
      const isSharedLibrary = params.kind === 'shared_library'
        || requestedFlags.some((flag) => flag === '-shared' || flag === '-dynamiclib')
        || [sharedExtension, '.dll', '.so', '.dylib'].includes(outputExtension);
      if (params.kind !== undefined && params.kind !== 'executable' && params.kind !== 'shared_library') {
        throw new Error('kind doit être executable ou shared_library.');
      }
      if (isSharedLibrary && outputExtension !== sharedExtension) {
        throw new Error(`Une bibliothèque partagée doit utiliser l’extension ${sharedExtension} sur cette plateforme.`);
      }
      if (!isSharedLibrary && ['.dll', '.so', '.dylib'].includes(outputExtension)) {
        throw new Error('Un exécutable ne peut pas utiliser une extension de bibliothèque partagée. Choisissez kind=shared_library.');
      }

      if (!Array.isArray(sourceFiles) || sourceFiles.length === 0) {
        throw new Error('Paramètre "sourceFiles" invalide ou vide.');
      }
      if (typeof outputExe !== 'string' || !outputExe.trim()) {
        throw new Error('Paramètre "outputExe" manquant.');
      }

      // Check toolchain
      const toolchains = detectToolchains();
      const gcc = toolchains.find((t) => t.name === 'gcc' && t.isAvailable);
      if (!gcc) {
        throw new Error('Compilateur GCC introuvable sur le système. Veuillez vérifier l\'installation de TDM-GCC ou MinGW.');
      }

      // Resolve safe paths
      const safeSources = sourceFiles.map((sf) => resolveSafePath(context.workspaceRoot, sf, context.allowedRoots));
      const safeOutput = resolveSafePath(context.workspaceRoot, outputExe, context.allowedRoots);
      await fs.mkdir(path.dirname(safeOutput), { recursive: true });

      const sharedFlags = isSharedLibrary
        ? [process.platform === 'darwin' ? '-dynamiclib' : '-shared', ...(process.platform === 'win32' ? [] : ['-fPIC'])]
        : [];
      const args = [...requestedFlags, ...sharedFlags.filter((flag) => !requestedFlags.includes(flag)), ...safeSources, '-o', safeOutput];

      const compiled = await runBoundedCompilerProcess(gcc.path || 'gcc', args, context.workspaceRoot);
      const success = compiled.code === 0 && !compiled.timedOut && !compiled.error;
      let outputSize: number | null = null;
      if (success) {
        try {
          const stat = await fs.stat(safeOutput);
          outputSize = stat.size;
        } catch {}
      }
      const stdout = showCapturedOutput(compiled.stdout, compiled.stdoutTruncated, 'stdout');
      const stderr = showCapturedOutput(compiled.stderr, compiled.stderrTruncated, 'stderr');
      const error = compiled.timedOut
        ? `La compilation GCC a dépassé la limite de ${GCC_MAX_RUNTIME_MS} ms.${stderr ? `\n${stderr}` : ''}`
        : compiled.error
          ? `Erreur d'exécution GCC : ${compiled.error}`
          : !success ? stderr || `La compilation GCC a échoué avec le code ${compiled.code}` : undefined;
      return {
        success,
        output: {
          compiler: 'gcc',
          binaryKind: isSharedLibrary ? 'shared_library' : 'executable',
          compilerPath: gcc.path,
          outputBinary: outputExe,
          outputSizeBytes: outputSize,
          stdout,
          stderr,
          timedOut: compiled.timedOut,
          stdoutTruncated: compiled.stdoutTruncated,
          stderrTruncated: compiled.stderrTruncated,
        },
        error,
        exitCode: compiled.code ?? 1,
        durationMs: compiled.durationMs,
      };
    } catch (err) {
      return {
        success: false,
        output: null,
        error: (err as Error).message,
        durationMs: Date.now() - start,
      };
    }
  }
}
