import type {
  ChatMessage,
  ToolDefinition,
} from '@mazz/shared';

export interface ProviderLimits {
  tpm: number;
  rpm: number;
  contextWindow: number;
  isTpmConstrained: boolean;
  safetyReserveTokens: number;
  minimumOutputTokens: number;
}

const DEFAULT_LIMITS: Record<string, ProviderLimits> = {
  'groq-api': {
    tpm: 8_000,
    rpm: 30,
    contextWindow: 131_072,
    isTpmConstrained: true,
    safetyReserveTokens: 350,
    minimumOutputTokens: 256,
  },
  'llama-local': {
    tpm: 1_000_000,
    rpm: 10_000,
    contextWindow: 4_096,
    isTpmConstrained: false,
    safetyReserveTokens: 64,
    minimumOutputTokens: 64,
  },
  'deepseek-api': {
    tpm: 60_000,
    rpm: 60,
    contextWindow: 65_536,
    isTpmConstrained: false,
    safetyReserveTokens: 500,
    minimumOutputTokens: 256,
  },
  'openai-api': {
    tpm: 30_000,
    rpm: 60,
    contextWindow: 32_768,
    isTpmConstrained: false,
    safetyReserveTokens: 500,
    minimumOutputTokens: 256,
  },
};

export function getProviderLimits(providerId: string, baseUrl?: string): ProviderLimits {
  if (providerId === 'groq-api' || providerId.toLowerCase().includes('groq') || (baseUrl && baseUrl.toLowerCase().includes('groq.com'))) {
    return DEFAULT_LIMITS['groq-api'];
  }
  if (DEFAULT_LIMITS[providerId]) {
    return DEFAULT_LIMITS[providerId];
  }
  return {
    tpm: 30_000,
    rpm: 60,
    contextWindow: 32_768,
    isTpmConstrained: false,
    safetyReserveTokens: 500,
    minimumOutputTokens: 256,
  };
}

/**
 * Fast, accurate token estimator for code and multilingual text (heuristic: ~3.6 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content ? message.content.length : 0;
  let tokens = Math.ceil(chars / 3.6) + 4;
  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      tokens += Math.ceil((tc.name.length + JSON.stringify(tc.arguments).length) / 3.6) + 6;
    }
  }
  if (message.toolCallId) {
    tokens += Math.ceil(message.toolCallId.length / 3.6) + 2;
  }
  if (message.images?.length) {
    tokens += message.images.length * 85;
  }
  return tokens;
}

export function estimateToolTokens(tool: ToolDefinition): number {
  const schemaStr = JSON.stringify(tool.parameters);
  const descStr = tool.description || '';
  const nameStr = tool.name;
  return Math.ceil((nameStr.length + descStr.length + schemaStr.length) / 3.6) + 8;
}

export function estimateRequestTokens(messages: readonly ChatMessage[], tools?: readonly ToolDefinition[]): number {
  let total = 3;
  for (const m of messages) {
    total += estimateMessageTokens(m);
  }
  if (tools) {
    for (const t of tools) {
      total += estimateToolTokens(t);
    }
  }
  return total;
}

export interface BudgetPlan {
  promptTokens: number;
  requestedMaxTokens: number;
  allocatedMaxTokens: number;
  headroom: number;
  isClamped: boolean;
  suggestCompactTools: boolean;
  needsContextCompression: boolean;
  exceedsTpmBudget: boolean;
  tpmLimit: number;
}

export function planTokenBudget(
  providerId: string,
  modelId: string,
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  requestedMaxTokens = 2048,
  baseUrl?: string
): BudgetPlan {
  const limits = getProviderLimits(providerId, baseUrl);
  const promptTokens = estimateRequestTokens(messages, tools);

  let ceiling = limits.isTpmConstrained ? limits.tpm : limits.contextWindow;
  if (providerId === 'llama-local') {
    ceiling = limits.contextWindow;
  }

  const availableHeadroom = ceiling - promptTokens - limits.safetyReserveTokens;
  const clampedHeadroom = Math.max(limits.minimumOutputTokens, availableHeadroom);
  const allocated = Math.min(requestedMaxTokens, clampedHeadroom);
  const isClamped = allocated < requestedMaxTokens;
  const suggestCompact = limits.isTpmConstrained && promptTokens > (ceiling * 0.45);
  const needsCompression = limits.isTpmConstrained && (promptTokens > (ceiling * 0.70) || (promptTokens + allocated > ceiling - limits.safetyReserveTokens));
  const exceedsBudget = limits.isTpmConstrained && (promptTokens + limits.minimumOutputTokens > ceiling - limits.safetyReserveTokens);

  return {
    promptTokens,
    requestedMaxTokens,
    allocatedMaxTokens: allocated,
    headroom: availableHeadroom,
    isClamped,
    suggestCompactTools: suggestCompact,
    needsContextCompression: needsCompression,
    exceedsTpmBudget: exceedsBudget,
    tpmLimit: limits.isTpmConstrained ? limits.tpm : ceiling,
  };
}

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export class TokenScheduler {
  private history = new Map<string, RequestRecord[]>();
  private backoffUntil = new Map<string, number>();
  private inFlight = new Map<string, number>();

  recordUsage(providerId: string, tokens: number): void {
    const now = Date.now();
    const records = this.history.get(providerId) ?? [];
    records.push({ timestamp: now, tokens });
    this.history.set(providerId, this.pruneOld(records, now));
  }

  release(providerId: string, estimatedTokens: number): void {
    const cur = this.inFlight.get(providerId) ?? 0;
    this.inFlight.set(providerId, Math.max(0, cur - estimatedTokens));
  }

  recordBackoff(providerId: string, delayMs: number): void {
    const until = Date.now() + Math.max(0, delayMs);
    const existing = this.backoffUntil.get(providerId) ?? 0;
    if (until > existing) {
      this.backoffUntil.set(providerId, until);
    }
  }

  getBackoffRemaining(providerId: string): number {
    const until = this.backoffUntil.get(providerId) ?? 0;
    return Math.max(0, until - Date.now());
  }

  private pruneOld(records: RequestRecord[], now: number): RequestRecord[] {
    const windowStart = now - 60_000;
    return records.filter((r) => r.timestamp > windowStart);
  }

  getCurrentWindowUsage(providerId: string): { tokens: number; requests: number } {
    const now = Date.now();
    const records = this.pruneOld(this.history.get(providerId) ?? [], now);
    this.history.set(providerId, records);
    let tokens = 0;
    for (const r of records) tokens += r.tokens;
    return { tokens, requests: records.length };
  }

  async acquire(providerId: string, estimatedTokens: number, signal?: AbortSignal): Promise<{ waitMs: number; release: () => void }> {
    const limits = getProviderLimits(providerId);

    const backoffMs = this.getBackoffRemaining(providerId);
    if (backoffMs > 0) {
      await this.sleep(backoffMs, signal);
    }

    const releaseFn = () => this.release(providerId, estimatedTokens);

    if (!limits.isTpmConstrained) {
      return { waitMs: backoffMs, release: releaseFn };
    }

    let waitedTotal = backoffMs;
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('Interrompu'), { name: 'AbortError' });
      }

      const now = Date.now();
      const records = this.pruneOld(this.history.get(providerId) ?? [], now);
      this.history.set(providerId, records);

      let currentTokens = 0;
      for (const r of records) currentTokens += r.tokens;
      const inFlightTokens = this.inFlight.get(providerId) ?? 0;

      if (currentTokens + inFlightTokens + estimatedTokens <= limits.tpm || records.length === 0) {
        this.inFlight.set(providerId, inFlightTokens + estimatedTokens);
        return { waitMs: waitedTotal, release: releaseFn };
      }

      const oldest = records[0];
      const waitTime = Math.max(250, (oldest.timestamp + 60_000) - now + 50);
      waitedTotal += waitTime;
      await this.sleep(waitTime, signal);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(Object.assign(new Error('Interrompu'), { name: 'AbortError' }));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('Interrompu'), { name: 'AbortError' }));
      }, { once: true });
    });
  }

  reset(): void {
    this.history.clear();
    this.backoffUntil.clear();
    this.inFlight.clear();
  }
}

export const defaultTokenScheduler = new TokenScheduler();
