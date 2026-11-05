import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';

/**
 * Internet access for the agent: web.search and web.fetch. Both refuse in
 * "local strict" mode. web.fetch never reaches loopback or private networks,
 * so a model cannot drive the Studio API (127.0.0.1:3333) or the local LAN.
 */

export interface WebConfig {
  engine: 'duckduckgo' | 'searxng' | 'brave';
  searxngUrl: string;
  braveKey?: string;
  localStrict: boolean;
}

// A browser user agent: DuckDuckGo returns an empty page to unknown agents.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 5 * 1024 * 1024;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Parses the DuckDuckGo HTML results page (no API key). */
export function parseDuckDuckGo(html: string, max: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && hits.length < max) {
    // The snippet belongs to this result if it comes before the next title.
    const rest = html.slice(re.lastIndex);
    const next = rest.search(/class="result__a"/);
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(next >= 0 ? rest.slice(0, next) : rest);
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    hits.push({ title: stripTags(m[2]), url, snippet: stripTags(snip?.[1] ?? '') });
  }
  return hits;
}

/** Readable text from HTML: drops scripts, styles and navigation, keeps headings, links and lists. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  const text = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n`)
    .replace(/<a[^>]+href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
      const label = stripTags(t);
      return label ? `[${label}](${decodeEntities(href)})` : '';
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t: string) => `\n\`\`\`\n${decodeEntities(t.replace(/<[^>]+>/g, ''))}\n\`\`\`\n`)
    .replace(/<(br|\/p|\/div|\/tr|\/section|\/table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeEntities(l).replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

function ipv4Number(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const octets = ip.split('.').map(Number);
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function ipv6Number(ip: string): bigint | null {
  let value = ip.toLowerCase();
  // An IPv6 address may spell its final 32 bits as dotted IPv4.
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) {
    const ipv4 = ipv4Number(dotted[1]);
    if (ipv4 === null) return null;
    const high = ((ipv4 >>> 16) & 0xffff).toString(16);
    const low = (ipv4 & 0xffff).toString(16);
    value = value.slice(0, -dotted[1].length) + `${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): string[] => half ? half.split(':') : [];
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

function hasIPv6Prefix(value: bigint, network: bigint, bits: number): boolean {
  return value >> BigInt(128 - bits) === network >> BigInt(128 - bits);
}

function privateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const value = ipv6Number(ip);
    if (value === null) return true;

    // IPv4-mapped IPv6 literals must be classified by their embedded IPv4,
    // regardless of whether that IPv4 was written in dotted or hexadecimal form.
    if (value >> 32n === 0xffffn) {
      const embedded = Number(value & 0xffffffffn);
      const mapped = `${embedded >>> 24}.${(embedded >>> 16) & 255}.${(embedded >>> 8) & 255}.${embedded & 255}`;
      return privateAddress(mapped);
    }

    // Only global-unicast space is eligible. This rejects unspecified, loopback,
    // ULA, link/site-local, multicast, discard-only, and other reserved ranges.
    if (!hasIPv6Prefix(value, 0x20000000000000000000000000000000n, 3)) return true;

    // Exclude protocol/special-purpose and documentation ranges inside 2000::/3.
    const specialRanges: Array<[bigint, number]> = [
      [0x20010000000000000000000000000000n, 23], // IETF protocol assignments (2001::/23)
      [0x20010db8000000000000000000000000n, 32], // documentation (2001:db8::/32)
      [0x20020000000000000000000000000000n, 16], // 6to4, which embeds arbitrary IPv4 destinations
      [0x3fff0000000000000000000000000000n, 20], // documentation (3fff::/20)
    ];
    return specialRanges.some(([network, bits]) => hasIPv6Prefix(value, network, bits));
  }

  const value = ipv4Number(ip);
  if (value === null) return true;
  const a = value >>> 24;
  const b = (value >>> 16) & 255;
  const c = (value >>> 8) & 255;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || (b === 168) || (b === 88 && c === 99)))
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
}

interface ResolvedPublicEndpoint {
  url: URL;
  address: string;
}

/** Resolves once, rejects any unsafe answer, and keeps one vetted address for transport. */
async function resolvePublicEndpoint(raw: string): Promise<ResolvedPublicEndpoint> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`URL invalide : ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Seules les adresses http et https sont acceptées.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Adresse locale refusée : web.fetch ne lit que des pages publiques.');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length) throw new Error(`Aucune adresse IP trouvée pour ${host}.`);
  if (ips.some(privateAddress)) throw new Error(`Adresse privée ou locale refusée (${host}).`);
  return { url, address: ips[0] };
}

/** Throws unless the URL is public http(s). */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return (await resolvePublicEndpoint(raw)).url;
}

/**
 * Performs the actual HTTP(S) request through the previously vetted address.
 * The URL hostname remains the HTTP Host and TLS verification/SNI name; only
 * socket address resolution is pinned. A per-request agent prevents a pooled
 * socket from bypassing the current resolution. Exported for deterministic tests.
 */
export function requestPinnedAddress(url: URL, address: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  const family = isIP(address);
  if (!family) return Promise.reject(new Error(`Adresse IP épinglée invalide : ${address}`));
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const result = options.all ? [{ address, family }] : address;
    queueMicrotask(() => callback(null, result, family));
  };
  const headers = new Headers({ 'User-Agent': UA, 'Accept-Encoding': 'identity' });
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  const nodeHeaders = Object.fromEntries(headers.entries());
  const options = {
    protocol: url.protocol,
    hostname: host,
    port: url.port ? Number(url.port) : undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method,
    headers: nodeHeaders,
    lookup: pinnedLookup,
    agent: false,
    ...(url.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(options, (incoming) => {
      const status = incoming.statusCode ?? 502;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new Error(`Statut HTTP non pris en charge : ${status}`));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else responseHeaders.set(name, value);
      }
      const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      if (body === null) incoming.resume();
      const result = new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders });
      Object.defineProperty(result, 'url', { value: url.toString() });
      resolve(result);
    });

    const signal = init.signal;
    const abort = () => request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Requête HTTP interrompue.'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', abort));
    request.once('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Délai de requête HTTP dépassé.')));
    const requestBody = init.body;
    if (requestBody !== null && requestBody !== undefined && typeof requestBody !== 'string' && !(requestBody instanceof Uint8Array)) {
      request.destroy(new Error('Corps de requête non pris en charge par le transport HTTP local.'));
    } else {
      request.end(requestBody as string | Uint8Array | undefined);
    }
  });
}

async function fetchPublic(raw: string, init: RequestInit = {}, timeoutMs = 20000): Promise<Response> {
  let { url, address } = await resolvePublicEndpoint(raw);
  // Redirects are followed by hand so that each hop is checked.
  for (let hop = 0; hop < 5; hop++) {
    const res = await requestPinnedAddress(url, address, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }, timeoutMs);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
      ({ url, address } = await resolvePublicEndpoint(new URL(res.headers.get('location')!, url).toString()));
      continue;
    }
    return res;
  }
  throw new Error('Trop de redirections.');
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function webSearch(query: string, max: number, cfg: WebConfig): Promise<SearchHit[]> {
  if (cfg.engine === 'brave') {
    if (!cfg.braveKey) throw new Error('Clé Brave Search absente (Paramètres, Internet).');
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': cfg.braveKey }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Brave Search : HTTP ${r.status}`);
    const j = (await r.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string }> } };
    return (j.web?.results ?? []).slice(0, max).map((x) => ({ title: stripTags(x.title), url: x.url, snippet: stripTags(x.description ?? '') }));
  }
  if (cfg.engine === 'searxng') {
    if (!cfg.searxngUrl) throw new Error('URL SearXNG absente (Paramètres, Internet).');
    const r = await fetch(`${cfg.searxngUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`SearXNG : HTTP ${r.status}`);
    const j = (await r.json()) as { results?: Array<{ title: string; url: string; content?: string }> };
    return (j.results ?? []).slice(0, max).map((x) => ({ title: x.title, url: x.url, snippet: x.content ?? '' }));
  }
  // No region nor Accept-Language: with them DuckDuckGo answers 202 with a robot check page.
  const res = await fetchPublic('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(query)}` });
  if (!res.ok) throw new Error(`DuckDuckGo : HTTP ${res.status}`);
  const hits = parseDuckDuckGo(await readLimited(res), max);
  if (!hits.length && res.status === 202) throw new Error('DuckDuckGo demande une vérification anti-robot ; réessayez plus tard ou choisissez SearXNG ou Brave Search (Paramètres, Internet).');
  return hits;
}

export class WebSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web.search',
    description: 'Recherche sur internet ; renvoie titres, adresses et extraits.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Requête' },
        max: { type: 'number', description: 'Nombre de résultats (défaut 8)' },
      },
      required: ['query'],
    },
    requiresPermission: true,
  };

  constructor(private readonly config: () => WebConfig) {}

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    const cfg = this.config();
    if (cfg.localStrict) return { success: false, output: null, error: 'Mode local strict : internet est désactivé (Paramètres, IA).', durationMs: 0 };
    try {
      const max = Math.min(15, Math.max(1, Math.floor(Number(params.max ?? 8))));
      const hits = await webSearch(String(params.query), max, cfg);
      return { success: true, output: { engine: cfg.engine, query: params.query, results: hits }, durationMs: Date.now() - start };
    } catch (err) {
      return { success: false, output: null, error: `Recherche impossible : ${(err as Error).message}`, durationMs: Date.now() - start };
    }
  }
}

export class WebFetchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'web.fetch',
    description: 'Lit une page web publique et la renvoie en texte (titres, liens, listes).',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Adresse http(s)' },
        offset: { type: 'number', description: 'Position de départ en caractères' },
      },
      required: ['url'],
    },
    requiresPermission: true,
  };

  constructor(private readonly config: () => WebConfig) {}

  async execute(params: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const start = Date.now();
    if (this.config().localStrict) return { success: false, output: null, error: 'Mode local strict : internet est désactivé (Paramètres, IA).', durationMs: 0 };
    try {
      const res = await fetchPublic(String(params.url), { headers: { 'Accept-Language': 'fr,en;q=0.8' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok) return { success: false, output: { status: res.status }, error: res.status === 429 ? 'HTTP 429 : le site limite les requêtes rapprochées, réessayer plus tard ou lire une autre source.' : `HTTP ${res.status}`, durationMs: Date.now() - start };
      if (!/text|json|xml|javascript/.test(type)) return { success: false, output: { contentType: type }, error: `Contenu non textuel (${type}).`, durationMs: Date.now() - start };
      const raw = await readLimited(res);
      const { title, text } = /html/.test(type) ? htmlToText(raw) : { title: '', text: raw };
      const offset = Math.max(0, Math.floor(Number(params.offset ?? 0)));
      const chunk = text.slice(offset, offset + 12000);
      return {
        success: true,
        output: { url: res.url || params.url, title, text: chunk, offset, total: text.length, done: offset + chunk.length >= text.length },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return { success: false, output: null, error: `Lecture impossible : ${(err as Error).message}`, durationMs: Date.now() - start };
    }
  }
}
