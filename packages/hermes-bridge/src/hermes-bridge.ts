import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { HermesDelegationRequest, HermesDelegationResult } from '@mazz/shared';

const DEFAULT_MAX_TOKENS = 1024;
const MAX_TOKENS = 32_768;
const DEFAULT_MAX_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 300;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_TURNS = 40;

const ALLOWED_TOOLSETS = new Set([
  'file', 'web', 'search', 'browser', 'vision', 'skills', 'todo', 'memory',
  'session_search', 'clarify', 'image_gen', 'tts',
]);

export interface HermesBridgeStatus {
  isInstalled: boolean;
  pythonPath?: string;
  cliPath?: string;
  hermesVersion?: string;
  diagnostics: string[];
}

export interface HermesStreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  exitCode: number;
}

export class HermesProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseHermesStream(stdout: string): HermesStreamResult {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new HermesProtocolError('Hermes n’a renvoyé aucun événement JSON.');

  let terminal: Record<string, unknown> | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    let event: unknown;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      throw new HermesProtocolError(`Ligne ${i + 1} de la sortie Hermes : JSON invalide.`);
    }
    if (!isRecord(event) || typeof event.type !== 'string') {
      throw new HermesProtocolError(`Ligne ${i + 1} de la sortie Hermes : enveloppe d’événement invalide.`);
    }
    if (!nonNegativeInteger(event.timestamp)) {
      throw new HermesProtocolError(`Ligne ${i + 1} : timestamp d’événement Hermes invalide.`);
    }

    switch (event.type) {
      case 'system':
        if (event.subtype !== 'init' || typeof event.model !== 'string' || typeof event.session_id !== 'string') {
          throw new HermesProtocolError(`Ligne ${i + 1} : événement system/init incomplet.`);
        }
        break;
      case 'text':
        if (typeof event.text !== 'string') throw new HermesProtocolError(`Ligne ${i + 1} : événement text invalide.`);
        break;
      case 'tool_use':
        if (typeof event.name !== 'string' || (event.input !== undefined && !isRecord(event.input))) {
          throw new HermesProtocolError(`Ligne ${i + 1} : événement tool_use invalide.`);
        }
        break;
      case 'tool_result':
        if (typeof event.name !== 'string' || typeof event.is_error !== 'boolean'
          || !nonNegativeInteger(event.duration_ms)
          || !(typeof event.output === 'string' || isRecord(event.output) || Array.isArray(event.output))) {
          throw new HermesProtocolError(`Ligne ${i + 1} : événement tool_result invalide.`);
        }
        if (event.is_error) throw new HermesProtocolError(`Hermes signale un échec d’outil (${event.name}).`);
        break;
      case 'result':
        if (terminal) throw new HermesProtocolError('Hermes a renvoyé plusieurs événements terminaux result.');
        if (i !== lines.length - 1) throw new HermesProtocolError('L’événement terminal result n’est pas le dernier événement.');
        if (typeof event.session_id !== 'string' || !nonNegativeInteger(event.exit_code) || typeof event.text !== 'string'
          || !nonNegativeInteger(event.duration_ms) || !isRecord(event.tokens)
          || !nonNegativeInteger(event.tokens.input) || !nonNegativeInteger(event.tokens.output)
          || !nonNegativeInteger(event.tokens.total)) {
          throw new HermesProtocolError('L’événement terminal result ne respecte pas le schéma Hermes documenté.');
        }
        if (event.error !== undefined && (typeof event.error !== 'string' || event.error.length > 0)) {
          throw new HermesProtocolError(`Hermes a terminé avec une erreur : ${String(event.error).slice(0, 500)}`);
        }
        terminal = event;
        break;
      default:
        throw new HermesProtocolError(`Type d’événement Hermes inconnu : ${event.type}.`);
    }
  }

  if (!terminal) throw new HermesProtocolError('Événement terminal result absent de la sortie Hermes.');
  const tokens = terminal.tokens as Record<string, unknown>;
  const text = terminal.text as string;
  if (terminal.exit_code !== 0) throw new HermesProtocolError(`Hermes a échoué (exit_code=${terminal.exit_code}).`);
  if (!text.trim()) throw new HermesProtocolError('Hermes a terminé sans message final.');
  if ((tokens.total as number) < (tokens.input as number) + (tokens.output as number)) {
    throw new HermesProtocolError('Les compteurs de tokens Hermes sont incohérents.');
  }
  return {
    text,
    inputTokens: tokens.input as number,
    outputTokens: tokens.output as number,
    totalTokens: tokens.total as number,
    durationMs: terminal.duration_ms as number,
    exitCode: terminal.exit_code as number,
  };
}

export interface HermesCliInvocation {
  executable: string;
  args: string[];
  prompt: string;
  maxTokens: number;
  maxTurns: number;
  workspacePath: string;
}

export function buildHermesCliInvocation(
  executable: string,
  request: HermesDelegationRequest,
  workspacePath: string,
): HermesCliInvocation {
  const maxTokens = boundedInteger(request.maxTokens, DEFAULT_MAX_TOKENS, 1, MAX_TOKENS);
  const maxTurns = Math.min(MAX_TURNS, Math.max(1, Math.ceil(maxTokens / 512)));
  const toolsets = normalizeToolsets(request.allowedTools);
  const prompt = [
    `MAZZ delegation task ${request.taskId}`,
    `Workspace root: ${workspacePath}`,
    `Maximum output-token budget: ${maxTokens}. Stop before exceeding it. MAZZ will reject a result whose reported output token count exceeds this cap.`,
    'Do not invoke another agent, Hermes, or any orchestrator. Work only on the requested subtask.',
    `Task:\n${request.objective}`,
  ].join('\n\n');
  const args = [
    '--in', workspacePath,
    'chat', '--oneshot', '--quiet', '--format', 'stream-json',
    '--max-turns', String(maxTurns),
    '--toolsets', toolsets.join(','),
    '--query-file', '-',
  ];
  return { executable, args, prompt, maxTokens, maxTurns, workspacePath };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error('Le budget doit être un nombre fini.');
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeToolsets(allowedTools: string[] | undefined): string[] {
  if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
    throw new Error('La délégation Hermes exige une liste explicite de toolsets autorisés.');
  }
  const normalized = [...new Set(allowedTools.map((tool) => tool.trim().toLowerCase().replaceAll('-', '_')))];
  for (const toolset of normalized) {
    if (!toolset || !ALLOWED_TOOLSETS.has(toolset)) {
      throw new Error(`Toolset Hermes refusé ou non pris en charge : ${toolset || '(vide)'}.`);
    }
  }
  return normalized.sort();
}

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: Error;
}

export function runBoundedProcess(
  executable: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputLimitExceeded = false;
    let finished = false;
    let proc: ChildProcess;

    try {
      proc = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, outputLimitExceeded: false, spawnError: err as Error });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, timeoutMs);

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut, outputLimitExceeded });
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        outputLimitExceeded = true;
        killProcessTree(proc);
        return;
      }
      stdout += chunk.toString('utf8');
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length <= MAX_STDERR_BYTES) {
        stderr += chunk.toString('utf8');
      }
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, signal: null, timedOut: false, outputLimitExceeded: false, spawnError: err });
    });

    proc.on('close', (code, signal) => finish(code, signal));
    proc.stdin?.once('error', () => {});
    proc.stdin?.end(input, 'utf8');
  });
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
  }
}

function failureResult(taskId: string, start: number, error: string, finalMessage = error): HermesDelegationResult {
  return {
    taskId,
    success: false,
    finalMessage,
    artifactsCreated: [],
    durationSeconds: Math.max(0, (Date.now() - start) / 1000),
    error,
  };
}

function findHermesCli(pythonPath?: string): { executable: string; version: string } | undefined {
  const candidates: string[] = [];
  if (pythonPath && isAbsolute(pythonPath)) {
    const scriptsDir = dirname(pythonPath);
    candidates.push(join(scriptsDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  }
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    candidates.push(join(userProfile, '.cargo', 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  }
  candidates.push(...(process.platform === 'win32' ? ['hermes.exe'] : ['hermes']));
  for (const executable of [...new Set(candidates)]) {
    const result = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) continue;
    const version = (result.stdout || result.stderr || '').trim();
    if (version) return { executable, version };
  }
  return undefined;
}

export class HermesBridge {
  private customPythonPath?: string;

  constructor(customPythonPath?: string) {
    this.customPythonPath = customPythonPath;
  }

  setPythonPath(pythonPath?: string): void {
    this.customPythonPath = pythonPath || undefined;
  }

  detect(): HermesBridgeStatus {
    const found = findHermesCli(this.customPythonPath);
    if (!found) {
      return {
        isInstalled: false,
        pythonPath: this.customPythonPath,
        diagnostics: ['CLI Hermes Agent introuvable. Le pont exige la commande hermes/hermes.exe ; aucun lancement Python simulé n’est utilisé.'],
      };
    }
    return {
      isInstalled: true,
      pythonPath: this.customPythonPath,
      cliPath: found.executable,
      hermesVersion: found.version,
      diagnostics: [`CLI Hermes détecté (${found.version}).`],
    };
  }

  async delegateTask(request: HermesDelegationRequest): Promise<HermesDelegationResult> {
    const start = Date.now();
    if (!request || typeof request.taskId !== 'string' || !request.taskId.trim()
      || typeof request.objective !== 'string' || !request.objective.trim()
      || typeof request.workspacePath !== 'string' || !request.workspacePath.trim()) {
      return failureResult(typeof request?.taskId === 'string' ? request.taskId : '', start, 'Requête Hermes invalide : taskId, objective et workspacePath sont obligatoires.');
    }

    let maxTokens: number;
    let maxDurationSeconds: number;
    try {
      maxTokens = boundedInteger(request.maxTokens, DEFAULT_MAX_TOKENS, 1, MAX_TOKENS);
      maxDurationSeconds = boundedInteger(request.maxDurationSeconds, DEFAULT_MAX_DURATION_SECONDS, 1, MAX_DURATION_SECONDS);
      normalizeToolsets(request.allowedTools);
      if (request.returnArtifacts) {
        throw new Error('La CLI Hermes ne fournit pas d’inventaire d’artefacts dans son enveloppe stream-json.');
      }
    } catch (error) {
      return failureResult(request.taskId, start, error instanceof Error ? error.message : String(error));
    }

    let workspacePath: string;
    try {
      workspacePath = await realpath(resolve(request.workspacePath));
      const workspaceInfo = await stat(workspacePath);
      if (!workspaceInfo.isDirectory()) throw new Error('workspacePath doit désigner un dossier existant.');
    } catch (error) {
      return failureResult(request.taskId, start, `Workspace invalide : ${error instanceof Error ? error.message : String(error)}`);
    }

    const status = this.detect();
    if (!status.isInstalled || !status.cliPath) {
      return failureResult(request.taskId, start, 'Délégation impossible : le CLI Hermes Agent n’est pas installé.');
    }

    let invocation: HermesCliInvocation;
    try {
      invocation = buildHermesCliInvocation(status.cliPath, { ...request, maxTokens }, workspacePath);
    } catch (error) {
      return failureResult(request.taskId, start, error instanceof Error ? error.message : String(error));
    }

    const outcome = await runBoundedProcess(
      invocation.executable,
      invocation.args,
      invocation.workspacePath,
      invocation.prompt,
      maxDurationSeconds * 1000,
    );
    const durationSeconds = Math.max(0, (Date.now() - start) / 1000);
    if (outcome.timedOut) return failureResult(request.taskId, start, `Hermes interrompu après ${maxDurationSeconds}s (délai maximal atteint).`);
    if (outcome.outputLimitExceeded) return failureResult(request.taskId, start, 'Hermes interrompu : la sortie dépasse la limite de sécurité de 2 Mio.');
    if (outcome.spawnError) return failureResult(request.taskId, start, `Impossible de lancer le CLI Hermes : ${outcome.spawnError.message}`);
    if (outcome.exitCode !== 0) {
      const detail = outcome.stderr.trim().slice(-1000);
      return failureResult(request.taskId, start, `Hermes a quitté avec le code ${String(outcome.exitCode)}${detail ? ` : ${detail}` : ''}`);
    }

    let parsed: HermesStreamResult;
    try {
      parsed = parseHermesStream(outcome.stdout);
    } catch (error) {
      return failureResult(request.taskId, start, error instanceof Error ? error.message : String(error));
    }

    if (parsed.outputTokens > maxTokens) {
      return {
        taskId: request.taskId,
        success: false,
        finalMessage: parsed.text,
        artifactsCreated: [],
        durationSeconds,
        tokenCount: parsed.totalTokens,
        error: `Hermes a dépassé le budget de sortie demandé (${parsed.outputTokens} > ${maxTokens} tokens). La CLI n’expose pas de limite max_tokens par invocation ; le résultat est donc rejeté après contrôle de l’usage rapporté.`,
      };
    }

    return {
      taskId: request.taskId,
      success: true,
      finalMessage: parsed.text,
      artifactsCreated: [],
      durationSeconds,
      tokenCount: parsed.totalTokens,
    };
  }
}

export const defaultHermesBridge = new HermesBridge();
