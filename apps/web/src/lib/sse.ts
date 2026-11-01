// Server-Sent Events over fetch (POST bodies and AbortSignal, which EventSource lacks).

export interface SseMessage {
  event?: string;
  id?: string;
  data: string;
}

/** Incremental SSE parser: feed text chunks, get complete messages. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: SseMessage[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const msg: SseMessage = { data: '' };
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') msg.event = value;
        else if (field === 'id') msg.id = value;
      }
      if (data.length === 0) continue;
      msg.data = data.join('\n');
      out.push(msg);
    }
    return out;
  }
}

export interface SseOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  onMessage: (msg: SseMessage) => void;
}

/**
 * Opens an SSE stream and resolves when it ends. Rejects with the server error
 * message on non-2xx responses, and with an Error named "NetworkError" when the
 * connection drops mid-stream (callers may re-attach).
 */
export async function streamSse(url: string, opts: SseOptions): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || 'POST',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw Object.assign(new Error('Serveur Studio injoignable.'), { name: 'NetworkError' });
  }
  if (!res.ok || !res.body) {
    let message = `Erreur HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) message = j.error;
    } catch {
      // body was not JSON
    }
    throw Object.assign(new Error(message), { status: res.status });
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  let sawDone = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const msg of parser.push(value)) {
        if (msg.data === '[DONE]') {
          sawDone = true;
          continue;
        }
        opts.onMessage(msg);
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw Object.assign(new Error('Connexion au flux interrompue.'), { name: 'NetworkError' });
  }
  if (!sawDone) {
    throw Object.assign(new Error('Flux terminé sans signal de fin.'), { name: 'NetworkError' });
  }
}
