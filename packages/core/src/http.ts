import type * as http from 'node:http';

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export interface RouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<any>;
}

export type Handler = (ctx: RouteContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

/** Minimal router: "/api/sessions/:id" style patterns, JSON results by default. */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([a-zA-Z]+)/g, (_m, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$'
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(path: string, h: Handler): void { this.add('GET', path, h); }
  post(path: string, h: Handler): void { this.add('POST', path, h); }
  put(path: string, h: Handler): void { this.add('PUT', path, h); }
  patch(path: string, h: Handler): void { this.add('PATCH', path, h); }
  delete(path: string, h: Handler): void { this.add('DELETE', path, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

const MAX_BODY = 6 * 1024 * 1024;

export function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Corps de requête trop volumineux (6 Mo maximum).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'JSON invalide dans le corps de requête.'));
      }
    });
    req.on('error', reject);
  });
}

/** Raw request body (file uploads), bounded. */
export function readRawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new HttpError(413, `Fichier trop volumineux (${Math.round(maxBytes / 1048576)} Mo maximum).`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function startSse(res: http.ServerResponse): (data: unknown, event?: string) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  return (data, event) => {
    if (res.writableEnded) return;
    res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  };
}

/**
 * Local-only access guard. A web page on another origin must never drive this
 * server (it can run commands): requests carrying a foreign Origin, or a Host
 * other than the loopback address (DNS rebinding), are refused.
 */
export function checkOrigin(req: http.IncomingMessage, port: number, extraOrigins: string[]): { ok: boolean; allowOrigin?: string; reason?: string } {
  const host = (req.headers.host || '').toLowerCase();
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowedHosts.includes(host)) {
    return { ok: false, reason: `Hôte non autorisé : ${host || '(vide)'}` };
  }
  const origin = req.headers.origin;
  if (!origin) return { ok: true };
  const allowedOrigins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
    ...extraOrigins,
  ];
  if (allowedOrigins.includes(origin)) return { ok: true, allowOrigin: origin };
  return { ok: false, reason: `Origine non autorisée : ${origin}` };
}
