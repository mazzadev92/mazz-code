import type {
  AgentEvent,
  ChatMessage,
  ExecutionMode,
  ModelSelection,
  ToolDefinition,
} from '@mazz/shared';
import type { ChatOptions, IModelProvider } from './base.js';
import { defaultProviderRegistry, isLocalUrl, ProviderRegistry } from './registry.js';
import { sanitizeProviderDiagnostic } from './base.js';
import { estimateRequestTokens, getProviderLimits } from './token-budget.js';

export interface CascadeCandidate {
  providerId: string;
  modelId: string;
  priority: number;
  enabled: boolean;
  label?: string;
  quotaInfo?: string;
}

export interface ProviderHealthRecord {
  providerId: string;
  name: string;
  baseUrl: string;
  locality: 'local' | 'remote';
  requiresApiKey: boolean;
  hasApiKey: boolean;
  status: 'healthy' | 'degraded' | 'cooling_down' | 'unavailable';
  isAvailable: boolean;
  coolingDownUntil?: number;
  cooldownRemainingSec?: number;
  lastError?: string;
  lastStatusCode?: number;
  lastLatencyMs?: number;
  retryAfterSec?: number;
  knownQuota?: string;
  quotaDisclaimer?: string;
}

export interface CascadeTelemetry {
  effectiveProviderId: string;
  effectiveProviderName: string;
  effectiveModelId: string;
  latencyMs: number;
  attemptsCount: number;
  fallbacksOccurred: Array<{
    fromProviderId: string;
    fromModelId: string;
    toProviderId: string;
    toModelId: string;
    reason: string;
    statusCode?: number;
    retryAfterSec?: number;
  }>;
}

export const KNOWN_PROVIDER_QUOTAS: Record<string, { quota: string; disclaimer: string }> = {
  'ovh-ai': {
    quota: '2 requêtes / minute / IP / modèle',
    disclaimer: 'Quota indicatif non garanti. Service public expérimental OVHcloud sujet à variation ou indisponibilité.',
  },
  'llmfaucet': {
    quota: '20 requêtes / jour / IP',
    disclaimer: 'Quota indicatif non garanti. Faucet communautaire gratuit pouvant être temporairement saturé ou hors ligne.',
  },
  'llama-local': {
    quota: 'Illimité (matériel local)',
    disclaimer: 'Dépend des ressources CPU et RAM disponibles sur votre machine.',
  },
  'lm-studio': {
    quota: 'Illimité (matériel local)',
    disclaimer: 'Dépend du serveur LM Studio local.',
  },
  'ollama': {
    quota: 'Illimité (matériel local)',
    disclaimer: 'Dépend du serveur Ollama local.',
  },
  'groq-api': {
    quota: 'Selon clé API Groq (ex. 8 000 TPM)',
    disclaimer: 'Sujet aux limites de débit (TPM / RPM) imposées par le service hébergé.',
  },
};

export const DEFAULT_CASCADE_STEPS: CascadeCandidate[] = [
  { providerId: 'llama-local', modelId: '', priority: 1, enabled: true, label: 'Modèle local configuré' },
  { providerId: 'groq-api', modelId: 'llama-3.3-70b-versatile', priority: 2, enabled: true, label: 'Provider API principal configuré' },
  { providerId: 'llmfaucet', modelId: 'auto:coding', priority: 3, enabled: true, label: 'llmfaucet auto:coding (Anonyme)' },
  { providerId: 'ovh-ai', modelId: 'Mistral-Nemo-Instruct-2407', priority: 4, enabled: true, label: 'OVHcloud AI Endpoints (Anonyme)' },
];

export interface ErrorClassification {
  recoverable: boolean;
  statusCode?: number;
  retryAfterSec?: number;
  reason: string;
}

/**
 * Extracts a numeric Retry-After (in seconds) from headers, response body, or error text.
 */
export function extractRetryAfter(errorOrHeader: unknown, body?: string): number | undefined {
  if (typeof errorOrHeader === 'string' || typeof errorOrHeader === 'number') {
    const val = Number(errorOrHeader);
    if (Number.isFinite(val) && val > 0) return Math.ceil(val);
  }
  const text = `${errorOrHeader ?? ''} ${body ?? ''}`;
  const match = /retry[- ]after[:\s]+(\d+)/i.exec(text)
    || /try again in\s+(?:(\d+)m)?\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(text)
    || /reset[:\s]+(\d+)/i.exec(text);
  if (match) {
    if (match[3] === 'ms') return Math.max(1, Math.ceil(Number(match[2]) / 1000));
    if (match[1] && match[2]) return Number(match[1]) * 60 + Math.ceil(Number(match[2]));
    const sec = Number(match[1] || match[2]);
    if (Number.isFinite(sec) && sec > 0) return Math.ceil(sec);
  }
  return undefined;
}

/**
 * Determines whether an error is recoverable (e.g. 429, 5xx, timeout, network failure, model not found)
 * or non-recoverable (e.g. 400 Bad Request, 413 context too long, user abort, Local Strict violation).
 */
export function classifyProviderError(error: unknown, body?: string): ErrorClassification {
  if (!error) {
    return { recoverable: false, reason: 'Erreur indéterminée.' };
  }

  const err = error as Record<string, unknown>;
  const rawMsg = typeof err.message === 'string' ? err.message : String(error);
  const code = typeof err.code === 'string' ? err.code : '';
  const statusMatch = /\b(?:HTTP[ _]?)?([1-5]\d\d)\b|\(([1-5]\d\d)\)/i.exec(rawMsg)
    || /^HTTP_?(\d{3})$/i.exec(code);
  const status = typeof err.status === 'number'
    ? err.status
    : (typeof err.statusCode === 'number'
      ? err.statusCode
      : (statusMatch ? Number(statusMatch[1] || statusMatch[2]) : undefined));

  // 1. Explicit user cancellation or AbortError
  if (err.name === 'AbortError' || /aborted/i.test(rawMsg)) {
    return { recoverable: false, reason: 'Requête interrompue par l’utilisateur.' };
  }

  // 2. Strict policy or validation errors
  if (/LOCAL STRICT/i.test(rawMsg) || code === 'LOCAL_STRICT_VIOLATION') {
    return { recoverable: false, reason: 'Violation du mode LOCAL STRICT : les flux distants sont interdits.' };
  }
  if (err.name === 'ProviderToolProtocolError' || code === 'INVALID_TOOL_DEFINITIONS') {
    return { recoverable: false, reason: `Erreur de protocole d’outil : ${rawMsg}` };
  }

  // 3. HTTP 413: context length / TPM payload too large
  if (/maximum context length|context window exceeded/i.test(rawMsg)) {
    return { recoverable: false, statusCode: 413, reason: `Dépassement de la longueur de contexte (413) : ${rawMsg}` };
  }
  if (status === 413 || code === 'HTTP_413' || /413|rate_limit_exceeded|tpm limit|tokens per minute/i.test(rawMsg)) {
    const retrySec = extractRetryAfter(rawMsg, body) ?? 60;
    return { recoverable: true, statusCode: 413, retryAfterSec: retrySec, reason: `Limite TPM atteinte (HTTP 413) : ${rawMsg}` };
  }

  // 4. HTTP 400: Bad Request
  if (status === 400 || /HTTP 400\b|Bad Request/i.test(rawMsg)) {
    return { recoverable: false, statusCode: 400, reason: `Requête invalide (HTTP 400) : ${rawMsg}` };
  }

  // 5. HTTP 429: Rate Limit
  if (status === 429 || /HTTP 429\b|rate limit|too many requests|quota exceeded/i.test(rawMsg) || code === 'HTTP_429') {
    const retrySec = extractRetryAfter(rawMsg, body) ?? 60;
    return {
      recoverable: true,
      statusCode: 429,
      retryAfterSec: retrySec,
      reason: `Limite de requêtes atteinte (HTTP 429). Réessai possible après ${retrySec}s.`,
    };
  }

  // 6. HTTP 5xx: Server errors
  if ((status !== undefined && status >= 500 && status < 600) || /HTTP 5\d\d\b|Bad Gateway|Service Unavailable|Gateway Timeout/i.test(rawMsg) || /^HTTP_5\d\d$/.test(code)) {
    const statusCode = status ?? (Number(/HTTP_?(\d{3})/.exec(code || rawMsg)?.[1]) || 503);
    const retrySec = extractRetryAfter(rawMsg, body) ?? 30;
    return {
      recoverable: true,
      statusCode,
      retryAfterSec: retrySec,
      reason: `Serveur distant indisponible (HTTP ${statusCode}).`,
    };
  }

  // 7. HTTP 404: Model or endpoint unavailable
  if (status === 404 || /HTTP 404\b|model.*not found|model_not_found/i.test(rawMsg) || code === 'HTTP_404') {
    return {
      recoverable: true,
      statusCode: 404,
      retryAfterSec: 30,
      reason: `Modèle ou endpoint introuvable sur ce fournisseur (HTTP 404).`,
    };
  }

  // 8. Network connectivity errors (DNS, refusal, timeout)
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /getaddrinfo ENOTFOUND|ECONNREFUSED|connect ETIMEDOUT|fetch failed|network timeout/i.test(rawMsg)
  ) {
    return {
      recoverable: true,
      retryAfterSec: 30,
      reason: `Erreur de connexion réseau (${code || 'réseau indisponible'}) : ${rawMsg}`,
    };
  }

  // 9. In-stream / chunk decoding errors
  if (code === 'PROVIDER_STREAM_ERROR' || code === 'INVALID_PROVIDER_RESPONSE' || /flux.*interrompu|stream error/i.test(rawMsg)) {
    return {
      recoverable: true,
      retryAfterSec: 20,
      reason: `Interruption anormale du flux de réponse : ${rawMsg}`,
    };
  }

  // Default: unclassified errors are considered non-recoverable to prevent unintended fallback
  return {
    recoverable: false,
    reason: rawMsg,
  };
}

export class CascadeManager {
  private cooldowns = new Map<string, { expiryMs: number; reason: string; statusCode?: number; retryAfterSec?: number }>();
  private healthHistory = new Map<string, { lastError?: string; lastStatusCode?: number; lastLatencyMs?: number; lastCheckedAt: number }>();
  private registry: ProviderRegistry;

  constructor(registry: ProviderRegistry = defaultProviderRegistry) {
    this.registry = registry;
  }

  setCooldown(providerId: string, durationSec: number, reason: string, statusCode?: number): void {
    const expiryMs = Date.now() + Math.max(1, durationSec) * 1000;
    this.cooldowns.set(providerId, { expiryMs, reason, statusCode, retryAfterSec: durationSec });
    const hist = this.healthHistory.get(providerId) || { lastCheckedAt: Date.now() };
    hist.lastError = reason;
    hist.lastStatusCode = statusCode;
    hist.lastCheckedAt = Date.now();
    this.healthHistory.set(providerId, hist);
  }

  clearCooldown(providerId: string): void {
    this.cooldowns.delete(providerId);
  }

  getCooldownRemainingSec(providerId: string): number {
    const cd = this.cooldowns.get(providerId);
    if (!cd) return 0;
    const remaining = Math.ceil((cd.expiryMs - Date.now()) / 1000);
    if (remaining <= 0) {
      this.cooldowns.delete(providerId);
      return 0;
    }
    return remaining;
  }

  getHealth(providerId: string): ProviderHealthRecord {
    const provider = this.registry.get(providerId);
    const cdRemaining = this.getCooldownRemainingSec(providerId);
    const hist = this.healthHistory.get(providerId);
    const quota = KNOWN_PROVIDER_QUOTAS[providerId];

    const baseUrl = provider?.baseUrl ?? '';
    const locality = provider?.locality ?? (isLocalUrl(baseUrl) ? 'local' : 'remote');
    const requiresApiKey = provider?.requiresApiKey ?? (locality === 'remote');
    const hasApiKey = provider?.hasApiKey ? provider.hasApiKey() : false;

    let status: 'healthy' | 'degraded' | 'cooling_down' | 'unavailable' = 'healthy';
    if (cdRemaining > 0) {
      status = 'cooling_down';
    } else if (hist?.lastStatusCode && hist.lastStatusCode >= 500) {
      status = 'unavailable';
    } else if (hist?.lastError) {
      status = 'degraded';
    }

    return {
      providerId,
      name: provider?.name ?? providerId,
      baseUrl,
      locality,
      requiresApiKey,
      hasApiKey,
      status,
      isAvailable: cdRemaining === 0,
      coolingDownUntil: cdRemaining > 0 ? Date.now() + cdRemaining * 1000 : undefined,
      cooldownRemainingSec: cdRemaining > 0 ? cdRemaining : undefined,
      lastError: hist?.lastError,
      lastStatusCode: hist?.lastStatusCode,
      lastLatencyMs: hist?.lastLatencyMs,
      knownQuota: quota?.quota,
      quotaDisclaimer: quota?.disclaimer,
    };
  }

  getAllHealth(): ProviderHealthRecord[] {
    const allProviders = this.registry.list();
    return allProviders.map((p) => this.getHealth(p.id));
  }

  /**
   * Sorts candidates by priority and filters out cooling down or unavailable candidates.
   */
  filterAndOrderCandidates(candidates: CascadeCandidate[], executionMode?: ExecutionMode): CascadeCandidate[] {
    const active = candidates
      .filter((c) => c.enabled)
      .sort((a, b) => a.priority - b.priority);

    if (executionMode === 'local_strict') {
      return active.filter((c) => {
        const p = this.registry.get(c.providerId);
        return p && p.locality !== 'remote' && isLocalUrl(p.baseUrl);
      });
    }

    return active;
  }

  /**
   * Execute chat generation with automatic cascade fallback on recoverable errors.
   */
  async *executeWithCascade(
    candidates: CascadeCandidate[],
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions & { executionMode?: ExecutionMode; maxFallbacks?: number }
  ): AsyncIterable<AgentEvent> {
    const startTime = Date.now();
    const ordered = this.filterAndOrderCandidates(candidates, options.executionMode);

    if (ordered.length === 0) {
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: 'NO_ACTIVE_CASCADE_CANDIDATE',
        message: 'Aucun fournisseur actif ou éligible dans la séquence de cascade.',
        fatal: true,
      };
      return;
    }

    const attempted = new Set<string>();
    const fallbacksOccurred: CascadeTelemetry['fallbacksOccurred'] = [];
    const maxFallbacks = options.maxFallbacks ?? 3;
    let fallbackCount = 0;
    let lastErrorClassification: ErrorClassification | undefined;

    for (let index = 0; index < ordered.length; index++) {
      const candidate = ordered[index];
      if (attempted.has(candidate.providerId)) continue;

      const provider = this.registry.get(candidate.providerId);
      if (!provider) continue;

      // Check if provider is currently cooling down
      const cdSec = this.getCooldownRemainingSec(candidate.providerId);
      if (cdSec > 0) {
        // If there are other candidates left, skip the cooling down one
        const remainingCandidates = ordered.slice(index + 1).filter((c) => !attempted.has(c.providerId) && this.getCooldownRemainingSec(c.providerId) === 0);
        if (remainingCandidates.length > 0) {
          continue;
        }
      }

      attempted.add(candidate.providerId);
      const attemptStart = Date.now();

      // Pre-flight token limit verification for TPM-constrained providers (e.g. Groq 8000 TPM)
      const limits = getProviderLimits(candidate.providerId, (provider as any).baseUrl);
      if (limits.isTpmConstrained) {
        const estimatedPrompt = estimateRequestTokens(messages, tools);
        if (estimatedPrompt + limits.minimumOutputTokens > limits.tpm - limits.safetyReserveTokens) {
          const nextCandidates = ordered.slice(index + 1).filter((c) => !attempted.has(c.providerId));
          if (nextCandidates.length > 0) {
            yield {
              type: 'status',
              taskId: options.taskId,
              timestamp: Date.now(),
              stage: 'cascade_bypass',
              message: `Contexte trop volumineux pour ${provider.name} (${estimatedPrompt} tokens estimés > quota TPM ${limits.tpm}). Bascule automatique vers le candidat suivant (${nextCandidates[0].label || nextCandidates[0].providerId}).`,
            };
            fallbacksOccurred.push({
              fromProviderId: candidate.providerId,
              fromModelId: candidate.modelId,
              toProviderId: nextCandidates[0].providerId,
              toModelId: nextCandidates[0].modelId,
              reason: `Contexte (${estimatedPrompt} tokens) supérieur au quota TPM de ${limits.tpm}`,
              statusCode: 413,
            });
            fallbackCount++;
            continue;
          }
        }
      }

      if (fallbackCount > 0) {
        yield {
          type: 'status',
          taskId: options.taskId,
          timestamp: Date.now(),
          stage: 'cascade_fallback',
          message: `Bascule cascade vers ${provider.name} (${candidate.modelId || 'modèle par défaut'})...`,
        };
      }

      const bufferedTokens: Extract<AgentEvent, { type: 'token' }>[] = [];
      let hadFatalErrorInStream = false;
      let streamErrorClassification: ErrorClassification | undefined;
      let emittedAnyEvent = false;

      try {
        const stream = provider.chatStream(messages, tools, {
          ...options,
          modelId: candidate.modelId || (provider as any).defaultModel || options.modelId,
        });

        let providerSucceeded = true;
        for await (const event of stream) {
          if (event.type === 'error' && event.fatal) {
            providerSucceeded = false;
            hadFatalErrorInStream = true;
            streamErrorClassification = classifyProviderError({ code: event.code, message: event.message });
            break;
          }

          emittedAnyEvent = true;
          yield event;
        }

        if (hadFatalErrorInStream && streamErrorClassification) {
          throw Object.assign(new Error(streamErrorClassification.reason), {
            statusCode: streamErrorClassification.statusCode,
            retryAfterSec: streamErrorClassification.retryAfterSec,
            code: streamErrorClassification.statusCode ? `HTTP_${streamErrorClassification.statusCode}` : 'PROVIDER_FAILED',
          });
        }

        if (!providerSucceeded) return;

        // Successfully completed turn with this provider!
        const latencyMs = Date.now() - attemptStart;
        const hist = this.healthHistory.get(candidate.providerId) || { lastCheckedAt: Date.now() };
        hist.lastLatencyMs = latencyMs;
        hist.lastError = undefined;
        hist.lastStatusCode = 200;
        this.healthHistory.set(candidate.providerId, hist);
        this.clearCooldown(candidate.providerId);

        const quota = KNOWN_PROVIDER_QUOTAS[candidate.providerId];
        yield {
          type: 'status',
          taskId: options.taskId,
          timestamp: Date.now(),
          stage: 'cascade_info',
          message: `Fournisseur actif : ${provider.name} | Modèle : ${candidate.modelId || options.modelId} | Latence : ${latencyMs}ms${quota ? ` | Quota : ${quota.quota} (${quota.disclaimer})` : ''}`,
        };

        return;
      } catch (err) {
        const classification = streamErrorClassification ?? classifyProviderError(err);
        lastErrorClassification = classification;

        const hist = this.healthHistory.get(candidate.providerId) || { lastCheckedAt: Date.now() };
        hist.lastError = classification.reason;
        hist.lastStatusCode = classification.statusCode;
        hist.lastLatencyMs = Date.now() - attemptStart;
        this.healthHistory.set(candidate.providerId, hist);

        if (classification.recoverable) {
          const cooldownSec = classification.retryAfterSec ?? (classification.statusCode === 429 ? 60 : 30);
          this.setCooldown(candidate.providerId, cooldownSec, classification.reason, classification.statusCode);

          const nextCandidate = ordered.slice(index + 1).find((c) => !attempted.has(c.providerId));
          if (nextCandidate && fallbackCount < maxFallbacks) {
            fallbacksOccurred.push({
              fromProviderId: candidate.providerId,
              fromModelId: candidate.modelId,
              toProviderId: nextCandidate.providerId,
              toModelId: nextCandidate.modelId,
              reason: classification.reason,
              statusCode: classification.statusCode,
              retryAfterSec: classification.retryAfterSec,
            });
            fallbackCount++;
            continue;
          }

          yield {
            type: 'error',
            taskId: options.taskId,
            timestamp: Date.now(),
            code: 'CASCADE_EXHAUSTED',
            message: `Tous les fournisseurs de la cascade ont échoué (${attempted.size} testé(s)). Dernier échec (${provider.name}) : ${classification.reason}`,
            fatal: true,
          };
          return;
        }

        // Non-recoverable error
        yield {
          type: 'error',
          taskId: options.taskId,
          timestamp: Date.now(),
          code: classification.statusCode ? `HTTP_${classification.statusCode}` : 'PROVIDER_FAILED',
          message: sanitizeProviderDiagnostic(`Échec du fournisseur ${provider.name} : ${classification.reason}`, []),
          fatal: true,
        };
        return;
      }
    }

    // If loop finishes without returning, all candidates were exhausted
    yield {
      type: 'error',
      taskId: options.taskId,
      timestamp: Date.now(),
      code: 'CASCADE_EXHAUSTED',
      message: `Tous les fournisseurs de la cascade ont échoué (${attempted.size} testé(s)). Dernier échec : ${lastErrorClassification?.reason ?? 'erreur inconnue'}.`,
      fatal: true,
    };
  }
}

export const defaultCascadeManager = new CascadeManager();
