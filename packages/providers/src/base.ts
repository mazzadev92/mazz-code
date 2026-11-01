import type {
  AgentEvent,
  ChatMessage,
  ModelCapability,
  ProviderType,
  ToolCallRequest,
  ToolDefinition,
} from '@mazz/shared';

export interface ChatOptions {
  modelId: string;
  taskId: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  maxTokens?: number;
  /** Require a function call when the agent has exposed exactly one safe tool. */
  toolChoice?: 'auto' | 'required';
  /** JSON Schema for the reply; llama.cpp turns it into a grammar (response_format json_schema). */
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ProviderConfigureOptions {
  /** New key; empty string or null removes it. Never logged nor returned. */
  apiKey?: string | null;
  baseUrl?: string;
}

export interface IModelProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly name: string;
  readonly baseUrl: string;
  /** Where computation happens; providers without it are treated by URL. */
  readonly locality?: 'local' | 'remote';
  readonly requiresApiKey?: boolean;
  configure?(options: ProviderConfigureOptions): void;
  hasApiKey?(): boolean;

  testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number }>;
  listModels(): Promise<ModelCapability[]>;
  chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<AgentEvent>;
  /**
   * Complete a raw code prefix without a conversational chat template. Local
   * llama.cpp providers implement this through their native /completion API;
   * other providers may omit it and use chatStream instead.
   */
  completePrefix?(
    prompt: string,
    options: ChatOptions & { stop?: string[]; grammar?: string },
  ): AsyncIterable<AgentEvent>;
  chatComplete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCallRequest[]; usage?: any }>;
}

const PROVIDER_SECRET_ASSIGNMENT = /(["']?\b(?:api[-_ ]?key|x[-_]?api[-_]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|auth(?:orization)?(?:[-_ ]?token)?|bearer|client[-_ ]?secret|secret|private[-_ ]?key|password|passwd|passphrase|credential|token|signature|sig|sas|key)["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s&;,}\]]+))/gi;
const PROVIDER_TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gi,
  /\b(?:rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{12,}\b/gi,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\b(?:hf|npm)_[A-Za-z0-9_-]{12,}\b/gi,
  /\bpypi-[A-Za-z0-9_-]{12,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

/** Redact credentials from provider failures while preserving useful diagnostics. */
export function sanitizeProviderDiagnostic(value: unknown, knownSecrets: readonly (string | undefined)[] = []): string {
  let safe = value instanceof Error ? value.message : String(value);

  for (const secret of knownSecrets) {
    if (!secret) continue;
    const candidates = new Set([secret]);
    // URI encoding can fail for an unpaired UTF-16 surrogate. Diagnostics must
    // still be sanitised even when a malformed key is supplied through config.
    try {
      const encoded = encodeURIComponent(secret);
      candidates.add(encoded);
      candidates.add(encoded.replace(/%[0-9A-F]{2}/gi, (escape) => escape.toLowerCase()));
    } catch {
      // The literal value remains redacted below.
    }
    for (const candidate of candidates) {
      // Do not exempt short credentials: development and private gateways can
      // use short tokens too, and a provider may echo them without a key label.
      if (candidate) safe = safe.split(candidate).join('[REDACTED]');
    }
  }

  safe = safe.replace(/\b(Bearer|Basic)\s+[^\s"'&,;)}\]]+/gi, '$1 [REDACTED]');
  safe = safe.replace(PROVIDER_SECRET_ASSIGNMENT, (_match, prefix: string, doubleQuoted: string | undefined, singleQuoted: string | undefined) => {
    if (doubleQuoted !== undefined) return `${prefix}"[REDACTED]"`;
    if (singleQuoted !== undefined) return `${prefix}'[REDACTED]'`;
    return `${prefix}[REDACTED]`;
  });
  // User-info in a URL is private even when it is not labelled as a password.
  safe = safe.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[REDACTED]@');
  for (const pattern of PROVIDER_TOKEN_PATTERNS) safe = safe.replace(pattern, '[REDACTED]');
  return safe;
}

/**
 * Tool names use dots internally ("fs.write"); OpenAI, Anthropic and Gemini only
 * accept [a-zA-Z0-9_-]. The double underscore keeps the mapping reversible.
 */
export function toWireToolName(name: string): string {
  return name.replace(/\./g, '__');
}

export function fromWireToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/**
 * Bounds for untrusted provider tool-call envelopes. They are deliberately
 * generous for real file/code arguments while preventing an endless stream or
 * a malformed response from retaining unbounded data in memory.
 */
export const PROVIDER_TOOL_CALL_LIMITS = Object.freeze({
  calls: 128,
  idCharacters: 256,
  nameCharacters: 256,
  argumentsPerCallCharacters: 4 * 1024 * 1024,
  argumentsTotalCharacters: 16 * 1024 * 1024,
});

export function providerToolCallIdIssue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return 'Identifiant tool_call vide ou invalide.';
  if (value.length > PROVIDER_TOOL_CALL_LIMITS.idCharacters) return `Identifiant tool_call trop long (maximum ${PROVIDER_TOOL_CALL_LIMITS.idCharacters} caractères).`;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'Identifiant tool_call contenant un caractère de contrôle.';
  return undefined;
}

export function providerToolCallNameIssue(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) return 'Nom d’outil vide ou invalide.';
  if (value.length > PROVIDER_TOOL_CALL_LIMITS.nameCharacters) return `Nom d’outil trop long (maximum ${PROVIDER_TOOL_CALL_LIMITS.nameCharacters} caractères).`;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'Nom d’outil contenant un caractère de contrôle.';
  return undefined;
}

export function providerToolCallNameFragmentIssue(value: unknown, currentCharacters: number): string | undefined {
  if (typeof value !== 'string') return 'Fragment de nom d’outil invalide.';
  if (currentCharacters + value.length > PROVIDER_TOOL_CALL_LIMITS.nameCharacters) return `Nom d’outil trop long (maximum ${PROVIDER_TOOL_CALL_LIMITS.nameCharacters} caractères).`;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return 'Nom d’outil contenant un caractère de contrôle.';
  return undefined;
}

export function providerToolCallArgumentsIssue(fragment: unknown, currentCharacters: number, totalCharacters: number): string | undefined {
  if (typeof fragment !== 'string') return 'Les fragments d’arguments doivent être des chaînes JSON.';
  if (currentCharacters + fragment.length > PROVIDER_TOOL_CALL_LIMITS.argumentsPerCallCharacters) {
    return `Arguments d’outil trop volumineux (maximum ${PROVIDER_TOOL_CALL_LIMITS.argumentsPerCallCharacters} caractères par appel).`;
  }
  if (totalCharacters + fragment.length > PROVIDER_TOOL_CALL_LIMITS.argumentsTotalCharacters) {
    return `Arguments d’outil au-delà de la limite cumulée (${PROVIDER_TOOL_CALL_LIMITS.argumentsTotalCharacters} caractères par réponse).`;
  }
  return undefined;
}

export function providerToolCallLimitIssue(callCount: number): string | undefined {
  return callCount >= PROVIDER_TOOL_CALL_LIMITS.calls
    ? `Trop d’appels d’outils dans une réponse (maximum ${PROVIDER_TOOL_CALL_LIMITS.calls}).`
    : undefined;
}

export function providerToolCallIdDuplicateIssue(id: string, seenIds: ReadonlySet<string>): string | undefined {
  return seenIds.has(id) ? `Identifiant tool_call dupliqué : ${id}.` : undefined;
}

/** Resolve provider wire names only against the definitions sent for this turn. */
export function resolveToolName(name: string, offeredTools: readonly ToolDefinition[]): string | undefined {
  const exact = offeredTools.filter((tool) => tool.name === name);
  if (exact.length === 1) return exact[0].name;
  if (exact.length > 1) return undefined;

  const decoded = fromWireToolName(name);
  const singleUnderscore = name.replace(/(?<!_)_(?!_)/gu, '.');
  // Small local models often omit the doubled wire separator and emit a single
  // underscore (fs_patch) or change punctuation. Fold only against the current
  // offered catalogue. Combine all plausible interpretations before deciding;
  // an exact-looking decomposition must not hide a second plausible alias.
  // Tool names are protocol identifiers, so their case-fold must not depend on
  // the host's locale (e.g. Turkish dotted/dotless I rules).
  const fold = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const folded = offeredTools.filter((tool) => fold(tool.name) === fold(name));
  const possible = new Set(
    offeredTools
      .filter((tool) => tool.name === decoded || tool.name === singleUnderscore || toWireToolName(tool.name) === name || folded.includes(tool))
      .map((tool) => tool.name),
  );
  return possible.size === 1 ? possible.values().next().value : undefined;
}

/** Reject transport-name collisions instead of sending an ambiguous tool list. */
export function assertUniqueWireToolNames(offeredTools: readonly ToolDefinition[]): void {
  const byWireName = new Map<string, string>();
  for (const tool of offeredTools) {
    const wireName = toWireToolName(tool.name);
    const previous = byWireName.get(wireName);
    if (previous && previous !== tool.name) {
      throw new Error(`Noms d’outils ambigus sur le fournisseur : "${previous}" et "${tool.name}" deviennent "${wireName}".`);
    }
    byWireName.set(wireName, tool.name);
  }
}
