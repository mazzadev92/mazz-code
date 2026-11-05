import type { ChatMessage } from '@mazz/shared';
import { llamaAuthHeaders } from '@mazz/shared';

export const COMPACTION_TIMEOUT_MS = 20_000;
export const COMPACTION_MAX_TOKENS = 400;
const TRANSCRIPT_CHARS = 12_000;

/** Endpoint in use: MAZZ_COMPACTION_URL overrides the setting; empty = disabled. */
export function resolveCompactionEndpoint(setting: string | undefined): string {
  return (process.env.MAZZ_COMPACTION_URL?.trim() || setting?.trim() || '').replace(/\/+$/u, '');
}

function isLoopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
}

function transcript(messages: readonly ChatMessage[]): string {
  const lines = messages.map((m) => {
    if (m.role === 'assistant') return `ASSISTANT: ${m.content.slice(0, 300)} ${(m.toolCalls ?? []).map((c) => `[appel ${c.name} ${JSON.stringify(c.arguments).slice(0, 200)}]`).join(' ')}`.trim();
    if (m.role === 'tool') return `RÉSULTAT: ${m.content.slice(0, 600)}`;
    return `${m.role.toUpperCase()}: ${m.content.slice(0, 600)}`;
  });
  const joined = lines.join('\n');
  return joined.length > TRANSCRIPT_CHARS ? joined.slice(-TRANSCRIPT_CHARS) : joined;
}

/**
 * Asks the draft llama-server (OpenAI-compatible /v1/chat/completions) for a short summary of the exchanges about to be
 * dropped. Throws on timeout, HTTP error or empty answer: the caller falls back to the mechanical drop.
 */
export async function summariseExchanges(endpoint: string, dropped: readonly ChatMessage[], timeoutMs = COMPACTION_TIMEOUT_MS): Promise<string> {
  const base = new URL(endpoint);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`protocole non pris en charge (${base.protocol})`);
  const url = new URL('v1/chat/completions', base.href.endsWith('/') ? base.href : `${base.href}/`);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(isLoopback(base) ? llamaAuthHeaders() : {}) },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'Résume en français, en 5 lignes maximum, ce que ces échanges d’outils ont établi : fichiers lus ou modifiés, commandes lancées, résultats et erreurs utiles. Aucun commentaire, uniquement le résumé.' },
        { role: 'user', content: transcript(dropped) },
      ],
      max_tokens: COMPACTION_MAX_TOKENS,
      temperature: 0,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('réponse vide');
  return text.trim().slice(0, 2_000);
}
