import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { workerData, type MessagePort } from 'node:worker_threads';

/**
 * Confinement host of an in-process MCP server (spec 03 §2.1), run inside a worker thread:
 * - every child_process entry point throws SelfExecBlockedError (no recursive self-execution);
 * - process.stdout / process.stderr writes become typed JSON messages on a MessagePort;
 * - the server is imported with import(pathToFileURL(entryPoint)) in a fresh worker, so each (re)load
 *   starts from an empty module cache; the query string also defeats any shared loader cache.
 * The JSON-RPC requests arrive on the worker's process.stdin (Worker option `stdin: true`).
 */

export class SelfExecBlockedError extends Error {
  constructor(fn: string) {
    super(`SelfExecBlockedError: child_process.${fn} est interdit dans un serveur MCP chargé en processus.`);
    this.name = 'SelfExecBlockedError';
  }
}

export type McpHostMessage =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'ready' }
  | { type: 'fatal'; message: string };

const { entryPoint, port } = workerData as { entryPoint: string; port: MessagePort };
const post = (message: McpHostMessage): void => port.postMessage(message);

const blocked = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
const mutable = childProcess as unknown as Record<string, unknown>;
for (const fn of blocked) {
  mutable[fn] = () => {
    throw new SelfExecBlockedError(fn);
  };
}
// Named ESM imports (`import { spawn } from 'node:child_process'`) see the blocked versions too.
syncBuiltinESMExports();

function redirect(stream: NodeJS.WriteStream, type: 'stdout' | 'stderr'): void {
  stream.write = ((chunk: string | Uint8Array, encodingOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) => {
    const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encodingOrCb === 'string' ? encodingOrCb : 'utf8');
    post({ type, data });
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    done?.(null);
    return true;
  }) as typeof stream.write;
}
redirect(process.stdout, 'stdout');
redirect(process.stderr, 'stderr');

try {
  await import(`${pathToFileURL(entryPoint).href}?mazz-load=${Date.now()}`);
  post({ type: 'ready' });
} catch (err) {
  post({ type: 'fatal', message: (err as Error)?.message ?? String(err) });
}
