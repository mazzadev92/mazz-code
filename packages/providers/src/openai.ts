import type {
  AgentEvent,
  ChatMessage,
  ModelCapability,
  ProviderType,
  ToolCallRequest,
  ToolDefinition,
  JSONSchemaProperty,
  ToolJSONSchema,
} from '@mazz/shared';
import {
  assertUniqueWireToolNames,
  providerToolCallArgumentsIssue,
  providerToolCallIdDuplicateIssue,
  providerToolCallIdIssue,
  providerToolCallLimitIssue,
  providerToolCallNameFragmentIssue,
  providerToolCallNameIssue,
  PROVIDER_TOOL_CALL_LIMITS,
  resolveToolName,
  sanitizeProviderDiagnostic,
  toWireToolName,
  type ChatOptions,
  type IModelProvider,
  type ProviderConfigureOptions,
} from './base.js';
import { TelemetryRecorder, isAbortError } from './telemetry-recorder.js';
import { defaultTokenScheduler, planTokenBudget } from './token-budget.js';

const MINIMUM_OUTPUT_BUDGET = 64;

const RETRYABLE_STATUS = new Set([413, 429, 502, 503]);
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_RETRY_WAIT_MS = 65_000;

/**
 * Wait before retrying a rate-limited call: the Retry-After header, else the delay the provider writes in its
 * message ("try again in 1.605s", "in 340ms", "in 1m2.5s"), else exponential backoff. Capped at 65 s.
 */
export function retryDelayMs(retryAfter: string | null, body: string, attempt: number): number {
  const header = retryAfter !== null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
  let ms = Number.isFinite(header) ? header * 1000 : NaN;
  if (!Number.isFinite(ms)) {
    const m = /try again in\s+(?:(\d+)m)?\s*(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(body);
    if (m) ms = (Number(m[1] ?? 0) * 60 + (m[3] === 'ms' ? Number(m[2]) / 1000 : Number(m[2]))) * 1000;
  }
  if (!Number.isFinite(ms)) ms = 2000 * 2 ** (attempt - 1);
  return Math.min(MAX_RETRY_WAIT_MS, Math.max(250, Math.ceil(ms) + 250));
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
}

export class ProviderToolProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderToolProtocolError';
  }
}

function validateSchemaDefinition(schema: unknown, path: string): string | undefined {
  if (!isRecord(schema) || typeof schema.type !== 'string') return `${path}: définition de schéma invalide.`;
  const supportedTypes = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
  if (!supportedTypes.has(schema.type)) return `${path}: type de schéma non pris en charge (${schema.type}).`;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.some((value) => typeof value !== 'string'))) {
    return `${path}: enum doit être un tableau de chaînes.`;
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((value) => typeof value !== 'string'))) {
    return `${path}: required doit être un tableau de noms.`;
  }
  const requiredNames = Array.isArray(schema.required) ? schema.required as string[] : [];
  if (schema.type === 'object') {
    const properties = schema.properties === undefined ? {} : schema.properties;
    if (!isRecord(properties)) return `${path}: properties doit être un objet.`;
    for (const name of requiredNames) {
      if (!Object.hasOwn(properties, name)) return `${path}.${name}: propriété requise sans schéma associé.`;
    }
    for (const [name, child] of Object.entries(properties)) {
      const issue = validateSchemaDefinition(child, `${path}.${name}`);
      if (issue) return issue;
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
      const issue = validateSchemaDefinition(schema.additionalProperties, `${path}.*`);
      if (issue) return issue;
    }
  } else if (schema.type === 'array') {
    if (schema.items !== undefined) {
      const issue = validateSchemaDefinition(schema.items, `${path}[]`);
      if (issue) return issue;
    }
  } else if (schema.items !== undefined || schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    return `${path}: propriétés object/array incompatibles avec le type ${schema.type}.`;
  }
  return undefined;
}

export function assertProviderToolDefinitions(tools: readonly ToolDefinition[]): void {
  assertUniqueWireToolNames(tools);
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new ProviderToolProtocolError(`Définition d’outil dupliquée : « ${tool.name} ».`);
    names.add(tool.name);
    const wireName = toWireToolName(tool.name);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(wireName)) {
      throw new ProviderToolProtocolError(`Nom d’outil non pris en charge par l’API : « ${wireName} ».`);
    }
    const schemaIssue = validateSchemaDefinition(tool.parameters, `arguments(${tool.name})`);
    if (schemaIssue || tool.parameters.type !== 'object') {
      throw new ProviderToolProtocolError(schemaIssue ?? `Le schéma d’arguments de « ${tool.name} » doit être un objet.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSchemaValue(value: unknown, schema: JSONSchemaProperty, path: string): string | undefined {
  if (!schema || typeof schema !== 'object' || typeof schema.type !== 'string') return `${path}: schéma de propriété invalide.`;
  if (schema.enum && !schema.enum.includes(value as string)) return `${path}: valeur absente de l’énumération autorisée.`;

  switch (schema.type) {
    case 'string': if (typeof value !== 'string') return `${path}: chaîne attendue.`; break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) return `${path}: nombre fini attendu.`; break;
    case 'integer': if (!Number.isSafeInteger(value)) return `${path}: entier sûr attendu.`; break;
    case 'boolean': if (typeof value !== 'boolean') return `${path}: booléen attendu.`; break;
    case 'array':
      if (!Array.isArray(value)) return `${path}: tableau attendu.`;
      if (schema.items) {
        for (let index = 0; index < value.length; index += 1) {
          const issue = validateSchemaValue(value[index], schema.items, `${path}[${index}]`);
          if (issue) return issue;
        }
      }
      break;
    case 'object': {
      if (!isRecord(value)) return `${path}: objet attendu.`;
      const properties = schema.properties ?? {};
      if (!isRecord(properties)) return `${path}: propriétés de schéma invalides.`;
      const required = schema.required ?? [];
      if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) return `${path}: liste required invalide.`;
      for (const name of required) {
        if (!Object.hasOwn(value, name)) return `${path}.${name}: paramètre obligatoire absent.`;
        if (!Object.hasOwn(properties, name)) return `${path}.${name}: schéma required sans propriété correspondante.`;
      }
      for (const [name, child] of Object.entries(value)) {
        const propertySchema = properties[name];
        if (!propertySchema) {
          const additional = (schema as JSONSchemaProperty & { additionalProperties?: unknown }).additionalProperties;
          if (additional === false) return `${path}.${name}: paramètre supplémentaire interdit.`;
          if (isRecord(additional)) {
            const issue = validateSchemaValue(child, additional as unknown as JSONSchemaProperty, `${path}.${name}`);
            if (issue) return issue;
          }
          continue;
        }
        const issue = validateSchemaValue(child, propertySchema, `${path}.${name}`);
        if (issue) return issue;
      }
      break;
    }
    default: return `${path}: type de schéma non pris en charge (${schema.type}).`;
  }
  return undefined;
}

/** Validate a decoded function argument object against the exact schema offered in this turn. */
export function validateToolArguments(value: unknown, schema: ToolJSONSchema): Record<string, unknown> {
  if (!isRecord(value)) throw new ProviderToolProtocolError('Les arguments d’outil doivent être un objet JSON.');
  if (!schema || schema.type !== 'object' || !isRecord(schema.properties)) {
    throw new ProviderToolProtocolError('Le schéma d’arguments envoyé au fournisseur est invalide.');
  }
  const properties = schema.properties as Record<string, JSONSchemaProperty>;
  const required = schema.required ?? [];
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
    throw new ProviderToolProtocolError('Le schéma d’arguments envoyé au fournisseur a une liste required invalide.');
  }
  for (const name of required) {
    if (!Object.hasOwn(properties, name)) throw new ProviderToolProtocolError(`Schéma d’arguments invalide : « ${name} » est requis sans schéma de propriété.`);
    if (!Object.hasOwn(value, name)) throw new ProviderToolProtocolError(`Argument requis manquant : « ${name} ».`);
  }
  for (const [name, child] of Object.entries(value)) {
    const propertySchema = properties[name];
    if (propertySchema) {
      const issue = validateSchemaValue(child, propertySchema, name);
      if (issue) throw new ProviderToolProtocolError(issue);
      continue;
    }
    const additional = (schema as ToolJSONSchema & { additionalProperties?: unknown }).additionalProperties;
    if (additional === false) throw new ProviderToolProtocolError(`Argument supplémentaire interdit : « ${name} ».`);
    if (isRecord(additional)) {
      const issue = validateSchemaValue(child, additional as unknown as JSONSchemaProperty, name);
      if (issue) throw new ProviderToolProtocolError(issue);
    }
  }
  return value;
}

interface PendingFunctionCall { id?: string; name: string; arguments: string; }

/** Reassembles fragmented OpenAI-compatible tool deltas and resolves only offered tools. */
export class ToolCallAccumulator {
  private readonly pending = new Map<number, PendingFunctionCall>();
  private totalArgumentCharacters = 0;

  addFragments(fragments: unknown): void {
    if (!Array.isArray(fragments)) throw new ProviderToolProtocolError('Le fragment tool_calls doit être un tableau.');
    if (fragments.length > PROVIDER_TOOL_CALL_LIMITS.calls) throw new ProviderToolProtocolError('Trop de fragments tool_call dans un événement fournisseur.');
    for (const raw of fragments) {
      if (!isRecord(raw)) throw new ProviderToolProtocolError('Fragment tool_call non objet.');
      if (raw.type !== undefined && raw.type !== 'function') throw new ProviderToolProtocolError('Type de tool_call inattendu.');
      if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0) throw new ProviderToolProtocolError('Index tool_call absent ou invalide.');
      const index = raw.index as number;

      let current = this.pending.get(index);
      if (!current) {
        const countIssue = providerToolCallLimitIssue(this.pending.size);
        if (countIssue) throw new ProviderToolProtocolError(countIssue);
        current = { name: '', arguments: '' };
      }
      if (raw.id !== undefined) {
        if (typeof raw.id !== 'string') throw new ProviderToolProtocolError('Identifiant tool_call vide ou invalide.');
        const issue = providerToolCallIdIssue(raw.id);
        if (issue) throw new ProviderToolProtocolError(issue);
        if (current.id && current.id !== raw.id) throw new ProviderToolProtocolError('Identifiant tool_call changé au milieu du flux.');
        current.id = raw.id;
      }
      if (raw.function !== undefined && !isRecord(raw.function)) throw new ProviderToolProtocolError('Objet function invalide dans tool_call.');
      const fn = isRecord(raw.function) ? raw.function : {};
      if (fn.name !== undefined) {
        if (typeof fn.name !== 'string') throw new ProviderToolProtocolError('Fragment de nom d’outil invalide.');
        const issue = providerToolCallNameFragmentIssue(fn.name, current.name.length);
        if (issue) throw new ProviderToolProtocolError(issue);
        current.name += fn.name;
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== 'string') throw new ProviderToolProtocolError('Les fragments d’arguments doivent être des chaînes JSON.');
        const issue = providerToolCallArgumentsIssue(fn.arguments, current.arguments.length, this.totalArgumentCharacters);
        if (issue) throw new ProviderToolProtocolError(issue);
        current.arguments += fn.arguments;
        this.totalArgumentCharacters += fn.arguments.length;
      }
      this.pending.set(index, current);
    }
  }

  /**
   * `recoverArguments`: bad JSON or a schema mismatch in one call's arguments no longer rejects the whole
   * response; the call is returned (bad JSON as `{ raw }`) and the agent loop answers it with a tool_result
   * error the model can read. Envelope problems (id, name, allow-list) always reject.
   */
  resolve(offeredTools: readonly ToolDefinition[], recoverArguments = false): ToolCallRequest[] {
    const calls: ToolCallRequest[] = [];
    const ids = new Set<string>();
    for (const [, pending] of [...this.pending.entries()].sort(([a], [b]) => a - b)) {
      if (typeof pending.id !== 'string') throw new ProviderToolProtocolError('Tool call incomplet : id, nom et arguments JSON sont obligatoires.');
      const callId = pending.id;
      const idIssue = providerToolCallIdIssue(callId);
      const nameIssue = providerToolCallNameIssue(pending.name);
      if (idIssue || nameIssue || !pending.arguments.trim()) {
        if (idIssue) throw new ProviderToolProtocolError(idIssue);
        if (nameIssue) throw new ProviderToolProtocolError(nameIssue);
        throw new ProviderToolProtocolError('Tool call incomplet : id, nom et arguments JSON sont obligatoires.');
      }
      const duplicateIdIssue = providerToolCallIdDuplicateIssue(callId, ids);
      if (duplicateIdIssue) throw new ProviderToolProtocolError(duplicateIdIssue);
      ids.add(callId);
      const canonicalName = resolveToolName(pending.name, offeredTools);
      if (!canonicalName) throw new ProviderToolProtocolError(`Outil inconnu ou alias ambigu : « ${pending.name} » n’appartient pas aux schémas autorisés.`);
      const definition = offeredTools.find((tool) => tool.name === canonicalName);
      if (!definition) throw new ProviderToolProtocolError(`Outil non autorisé : « ${canonicalName} ».`);
      let decoded: unknown;
      try { decoded = JSON.parse(pending.arguments); }
      catch {
        if (!recoverArguments) throw new ProviderToolProtocolError(`Arguments JSON invalides pour « ${canonicalName} ».`);
        calls.push({ id: callId, name: canonicalName, arguments: { raw: pending.arguments.slice(0, 2000) } });
        continue;
      }
      try {
        calls.push({ id: callId, name: canonicalName, arguments: validateToolArguments(decoded, definition.parameters) });
      } catch (error) {
        if (!recoverArguments || !(error instanceof ProviderToolProtocolError) || !isRecord(decoded)) throw error;
        calls.push({ id: callId, name: canonicalName, arguments: decoded });
      }
    }
    return calls;
  }

  get size(): number { return this.pending.size; }
}

const SSE_DONE = Symbol('provider-sse-done');

/** Parses fragmented Server-Sent Events and rejects malformed JSON data frames. */
export async function* readOpenAiSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let dataLines: string[] = [];
  let framing: 'sse' | 'jsonl' | undefined;
  let sawDone = false;
  const dispatch = (): unknown | undefined => {
    if (!dataLines.length) return undefined;
    framing = 'sse';
    const payload = dataLines.join('\n');
    dataLines = [];
    if (payload.trim() === '[DONE]') {
      sawDone = true;
      return SSE_DONE;
    }
    try { return JSON.parse(payload); }
    catch { throw new ProviderToolProtocolError('Trame SSE data malformée : JSON invalide.'); }
  };
  const consumeLine = (line: string): unknown | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const trimmed = line.trim();
    // A number of OpenAI-compatible local servers emit one JSON object per
    // line instead of Server-Sent Events. Accept that framing only as a whole
    // response mode; mixing it with SSE data would make message boundaries
    // ambiguous. A malformed object-looking line is an error, never dropped.
    if (trimmed.startsWith('{')) {
      if (framing === 'sse' || dataLines.length) throw new ProviderToolProtocolError('Flux fournisseur mêlant les trames SSE et JSONL.');
      framing = 'jsonl';
      try { return JSON.parse(trimmed); }
      catch { throw new ProviderToolProtocolError('Trame JSONL malformée : JSON invalide.'); }
    }
    if (trimmed === '[DONE]' && framing !== 'sse') {
      framing = 'jsonl';
      sawDone = true;
      return SSE_DONE;
    }
    if (framing === 'jsonl') {
      if (line.startsWith('data:')) throw new ProviderToolProtocolError('Flux fournisseur mêlant les trames JSONL et SSE.');
      try { return JSON.parse(trimmed); }
      catch { throw new ProviderToolProtocolError('Trame JSONL malformée : JSON invalide.'); }
    }
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return undefined;
    framing = 'sse';
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      while (true) {
        const lf = buffer.indexOf('\n');
        const cr = buffer.indexOf('\r');
        const lineEnd = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (lineEnd < 0 || (!done && buffer[lineEnd] === '\r' && lineEnd === buffer.length - 1)) break;
        const line = buffer.slice(0, lineEnd);
        const lineEndingLength = buffer[lineEnd] === '\r' && buffer[lineEnd + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(lineEnd + lineEndingLength);
        const event = consumeLine(line);
        if (event !== undefined) yield event;
      }
      if (done) {
        if (buffer) {
          const event = consumeLine(buffer);
          if (event !== undefined) yield event;
        }
        const finalEvent = dispatch();
        if (finalEvent !== undefined) yield finalEvent;
        // A clean HTTP body end is the terminal frame for JSONL. Tool calls
        // still require their provider's explicit finish_reason downstream.
        if (framing === 'jsonl' && !sawDone) yield SSE_DONE;
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined); // best effort: stream/transport/flush already closed or failed elsewhere
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function isOpenAiSseDoneEvent(value: unknown): boolean {
  return value === SSE_DONE;
}

export function validateCompletionChunk(value: unknown): Record<string, any> {
  // Some providers (Groq, OpenRouter) report failures inside the stream: {"error": {"message": ...}}.
  if (isRecord(value) && value.error !== undefined && !Array.isArray(value.choices)) {
    const e = value.error;
    const message = isRecord(e) ? [e.code ?? e.type, e.message].filter((x) => typeof x === 'string' && x).join(' : ') : String(e);
    throw new ProviderToolProtocolError(`Erreur du fournisseur dans le flux : ${message || 'sans détail'}`);
  }
  if (!isRecord(value) || !Array.isArray(value.choices)) throw new ProviderToolProtocolError('Réponse de flux invalide : choices doit être un tableau.');
  if (value.choices.length > 1) throw new ProviderToolProtocolError('Réponse de flux ambiguë : le fournisseur a renvoyé plusieurs choix inattendus.');
  if (value.usage !== undefined) {
    if (!isRecord(value.usage)) throw new ProviderToolProtocolError('Compteurs d’usage invalides dans la réponse fournisseur.');
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      const count = value.usage[key];
      if (count !== undefined && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
        throw new ProviderToolProtocolError(`Compteur d’usage invalide : ${key}.`);
      }
    }
  }
  if (value.choices.length === 0) return value;
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) throw new ProviderToolProtocolError('Choix de flux invalide : delta objet attendu.');
  if (choice.index !== undefined && (!Number.isSafeInteger(choice.index) || choice.index !== 0)) throw new ProviderToolProtocolError('Index de choix invalide ou ambigu.');
  if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== 'string') {
    throw new ProviderToolProtocolError('finish_reason invalide.');
  }
  const delta = choice.delta;
  if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') throw new ProviderToolProtocolError('Fragment de contenu invalide.');
  if (delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string') throw new ProviderToolProtocolError('Fragment reasoning_content invalide.');
  if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw new ProviderToolProtocolError('Fragment tool_calls invalide.');
  if (delta.function_call !== undefined) throw new ProviderToolProtocolError('Ancien format function_call non pris en charge; tool_calls moderne attendu.');
  return value;
}

function resolveCompleteToolCalls(rawCalls: unknown, tools: readonly ToolDefinition[]): ToolCallRequest[] {
  if (rawCalls === undefined) return [];
  if (!Array.isArray(rawCalls)) throw new ProviderToolProtocolError('tool_calls doit être un tableau.');
  const accumulator = new ToolCallAccumulator();
  accumulator.addFragments(rawCalls.map((raw, index) => {
    if (!isRecord(raw) || raw.type !== 'function') throw new ProviderToolProtocolError('Réponse tool_call sans type function.');
    return { ...raw, index };
  }));
  return accumulator.resolve(tools);
}

/**
 * Drops a rejected text-only tool-call attempt once a later tool has succeeded.
 * The rejected assistant text and its corrective user message are useful for
 * recovery, but become dead context after the requested action has completed.
 */
export function compactResolvedToolRejections(messages: ChatMessage[]): ChatMessage[] {
  const remove = new Set<number>();
  for (let index = 1; index < messages.length; index++) {
    const rejection = messages[index];
    const rejectedAttempt = messages[index - 1];
    if (rejection.role !== 'user' || !/^\s*<tool_call_rejected>/.test(rejection.content) ||
        rejectedAttempt.role !== 'assistant' || rejectedAttempt.toolCalls?.length || !rejectedAttempt.content.trim()) continue;

    const hasLaterSuccessfulTool = messages.slice(index + 1).some((message) => {
      if (message.role !== 'tool') return false;
      try {
        const result: unknown = JSON.parse(message.content);
        return !result || typeof result !== 'object' || !Object.hasOwn(result, 'error');
      } catch {
        return false;
      }
    });
    if (hasLaterSuccessfulTool) {
      remove.add(index - 1);
      remove.add(index);
    }
  }
  return remove.size ? messages.filter((_, index) => !remove.has(index)) : messages;
}

/** Maps the internal message shape to the OpenAI chat format, keeping tool-call linkage. */
export function toOpenAiMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: m.role,
    content:
      m.role === 'user' && m.images?.length
        ? [{ type: 'text', text: m.content }, ...m.images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.dataBase64}` } }))]
        : m.content,
  };
  if (m.name && m.role === 'tool') out.name = m.name;
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: toWireToolName(tc.name), arguments: JSON.stringify(tc.arguments) },
    }));
  }
  return out;
}

export interface OpenAiProviderOptions {
  id: string;
  type?: ProviderType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  defaultModel?: string;
  knownModels?: string[];
  modelFilter?: (modelId: string) => boolean;
  locality?: 'local' | 'remote';
  requiresApiKey?: boolean;
  /** Pass schema-invalid tool arguments on to the agent loop for a readable correction (local models). */
  recoverToolArguments?: boolean;
}

export class OpenAiCompatibleProvider implements IModelProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly name: string;
  baseUrl: string;
  readonly locality: 'local' | 'remote';
  private readonly recoverToolArguments: boolean;
  readonly requiresApiKey: boolean;

  private apiKey?: string;
  private extraHeaders: Record<string, string>;
  private defaultModel?: string;
  private knownModels?: string[];
  private modelFilter?: (modelId: string) => boolean;

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id;
    this.type = options.type || 'openai_compatible';
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders || {};
    this.defaultModel = options.defaultModel;
    this.knownModels = options.knownModels;
    this.modelFilter = options.modelFilter;
    this.locality = options.locality || (this.baseUrl.includes('127.0.0.1') || this.baseUrl.includes('localhost') ? 'local' : 'remote');
    this.requiresApiKey = options.requiresApiKey ?? this.locality === 'remote';
    this.recoverToolArguments = options.recoverToolArguments ?? false;
  }

  configure(options: ProviderConfigureOptions): void {
    if (options.apiKey !== undefined) this.apiKey = options.apiKey || undefined;
    if (options.baseUrl) this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private diagnosticSecrets(): (string | undefined)[] {
    return [this.apiKey, ...Object.values(this.extraHeaders)];
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    const requestSecrets = this.diagnosticSecrets();
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        redirect: 'error',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return {
          ok: false,
          message: sanitizeProviderDiagnostic(`Réponse HTTP ${res.status}: ${res.statusText}`, requestSecrets),
          latencyMs,
        };
      }
      const data = await res.json() as any;
      const count = Array.isArray(data.data) ? data.data.length : 0;
      return {
        ok: true,
        message: `Connecté avec succès. ${count} modèle(s) détecté(s).`,
        latencyMs,
      };
    } catch (err) {
      return {
        ok: false,
        message: sanitizeProviderDiagnostic(`Échec de connexion à ${this.baseUrl}: ${(err as Error).message}`, requestSecrets),
        latencyMs: Date.now() - start,
      };
    }
  }

  async listModels(): Promise<ModelCapability[]> {
    // A keyless remote provider cannot answer; skip the network round trip.
    if (this.requiresApiKey && !this.apiKey) return [];
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        redirect: 'error',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(this.locality === 'local' ? 1500 : 5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      if (!Array.isArray(data.data)) throw new Error('Format invalide');

      let models: ModelCapability[] = data.data.map((m: any) => ({
        id: m.id,
        name: m.id,
        providerId: this.id,
        locality: this.locality,
        supportsStreaming: true,
        toolCalling: 'unverified' as const,
        isAvailable: true,
      }));
      if (this.modelFilter) {
        models = models.filter((m) => this.modelFilter!(m.id));
      }
      return models;
    } catch {
      const fallbackList = this.knownModels?.length
        ? this.knownModels
        : (this.defaultModel ? [this.defaultModel] : []);
      return fallbackList.map((modelId) => ({
        id: modelId,
        name: modelId,
        providerId: this.id,
        locality: this.locality,
        supportsStreaming: true,
        toolCalling: 'unverified' as const,
        isAvailable: false,
      }));
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<AgentEvent> {
    const requestSecrets = this.diagnosticSecrets();
    try { assertProviderToolDefinitions(tools); } catch (err) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_TOOL_DEFINITIONS', message: sanitizeProviderDiagnostic(err, requestSecrets), fatal: true };
      return;
    }
    const recorder = new TelemetryRecorder({
      providerId: this.id,
      modelId: options.modelId,
      locality: this.locality,
      backend: this.type,
    });

    const formattedTools = tools.length > 0
      ? tools.map((t) => ({
          type: 'function',
          function: {
            name: toWireToolName(t.name),
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;

    const requestMessages = compactResolvedToolRejections(messages).map((m) => toOpenAiMessage(m));

    const payload: Record<string, unknown> = {
      model: options.modelId,
      messages: requestMessages,
      stream: true,
      // Ask for a final usage chunk; servers that do not know the option ignore it.
      stream_options: { include_usage: true },
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens,
    };
    if (options.topP !== undefined) payload.top_p = options.topP;
    if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
    if (this.type === 'llama_cpp' && options.topK !== undefined) payload.top_k = options.topK;

    if (formattedTools) {
      payload.tools = formattedTools;
      // Explicitly enable the provider's structured function-call path when
      // offered. Models without native support can still use the guarded text
      // compatibility parser in the agent loop.
      payload.tool_choice = options.toolChoice === 'required' ? 'required' : 'auto';
      // Some llama.cpp Qwen reasoning templates can answer in prose when a
      // required call reuses a warm KV prefix. Re-evaluate forced calls.
      if (this.type === 'llama_cpp' && options.toolChoice === 'required') payload.cache_prompt = false;
    }

    let res: Response;
    try {
      if (this.type === 'llama_cpp' && !messages.some(m => m.images?.length)) {
        const origin=this.baseUrl.replace(/\/v1\/?$/, '');
        const budgetFetch=async (route:string,body?:unknown):Promise<any>=>{
          const response=await fetch(origin+route,{method:body?'POST':'GET',redirect:'error',headers:this.getHeaders(),body:body?JSON.stringify(body):undefined,signal:options.signal ?? AbortSignal.timeout(10000)});
          if(!response.ok)throw new Error(`Comptage contexte impossible (${route}, HTTP ${response.status})`);
          return response.json();
        };
        const props=await budgetFetch('/props');
        const nativeContext=Number(props.default_generation_settings?.n_ctx);
        if(!Number.isSafeInteger(nativeContext)||nativeContext<=0)throw new Error('Fenêtre native du runtime non disponible.');
        const template=await budgetFetch('/apply-template',{messages:payload.messages,...(payload.tools?{tools:payload.tools}:{}),...(payload.tool_choice?{tool_choice:payload.tool_choice}:{})});
        if(typeof template.prompt!=='string')throw new Error('Le runtime ne renvoie pas le gabarit exact du prompt.');
        const count=await budgetFetch('/tokenize',{content:template.prompt,add_special:true,parse_special:true});
        if(!Array.isArray(count.tokens))throw new Error('Réponse tokenizer invalide.');
        const promptTokens=count.tokens.length;
        const requestedOutputTokens=options.maxTokens ?? 512;
        const safetyTokens=16;
        const availableOutputTokens=nativeContext-promptTokens-safetyTokens;
        if(availableOutputTokens<MINIMUM_OUTPUT_BUDGET){
          yield {type:'error',taskId:options.taskId,timestamp:Date.now(),code:'CONTEXT_BUDGET_EXCEEDED',message:`Le prompt mesuré (${promptTokens}) laisse ${availableOutputTokens} tokens de sortie, sous le minimum opérationnel (${MINIMUM_OUTPUT_BUDGET}) dans une fenêtre native de ${nativeContext}. Compactez la session ou réduisez les pièces jointes.`,fatal:true};
          return;
        }
        const reservedOutputTokens=Math.min(requestedOutputTokens,availableOutputTokens);
        const outputBudgetAdjusted=reservedOutputTokens<requestedOutputTokens;
        payload.max_tokens=reservedOutputTokens;
        const contextBudget={promptTokens,requestedOutputTokens,reservedOutputTokens,safetyTokens,nativeContext,outputBudgetAdjusted,tokenizer:props.model_path || props.model_alias || options.modelId,method:'llama.cpp /apply-template + /tokenize (parse_special=true)'};
        yield {type:'status',taskId:options.taskId,timestamp:Date.now(),stage:'context-budget',message:`Contexte mesuré : ${promptTokens} tokens d’entrée + ${reservedOutputTokens} réservés en sortie / ${nativeContext} natifs${outputBudgetAdjusted?` (budget de sortie réduit depuis ${requestedOutputTokens})`:''}.`,contextBudget};
      }
      if(!messages.some(m=>m.images?.length))yield {
        type:'status',taskId:options.taskId,timestamp:Date.now(),stage:'context-snapshot',
        message:'Messages et schémas d’outils réellement envoyés au fournisseur pour cet appel.',
        contextSnapshot:{providerId:this.id,modelId:options.modelId,temperature:typeof payload.temperature === 'number' ? payload.temperature : undefined,topP:typeof payload.top_p === 'number' ? payload.top_p : undefined,topK:typeof payload.top_k === 'number' ? payload.top_k : undefined,presencePenalty:typeof payload.presence_penalty === 'number' ? payload.presence_penalty : undefined,toolChoice:typeof payload.tool_choice === 'string' ? payload.tool_choice : 'none',responseFormat:isRecord(payload.response_format) && typeof payload.response_format.type === 'string' ? payload.response_format.type : undefined,cachePrompt:payload.cache_prompt !== false,messages:payload.messages as Array<Record<string,unknown>>,tools:(payload.tools || []) as Array<Record<string,unknown>>},
      };

      let releaseTokenReservation: (() => void) | undefined;
      if (this.locality === 'remote') {
        const budgetPlan = planTokenBudget(this.id, options.modelId, messages, tools, (payload.max_tokens as number | undefined) ?? 2048, this.baseUrl);
        if (budgetPlan.exceedsTpmBudget) {
          const errMsg = `Contexte trop volumineux pour le quota TPM de ${this.name} (${budgetPlan.promptTokens} tokens de prompt estimés > plafond TPM ${budgetPlan.tpmLimit}).`;
          yield {
            type: 'error',
            taskId: options.taskId,
            timestamp: Date.now(),
            code: 'HTTP_413',
            message: errMsg,
            fatal: true,
          };
          return;
        }
        if (budgetPlan.isClamped) {
          payload.max_tokens = budgetPlan.allocatedMaxTokens;
          yield {
            type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'token-budget',
            message: `Budget proactif (${this.name}) : ${budgetPlan.promptTokens} tokens de prompt estimés, max_tokens ajusté à ${budgetPlan.allocatedMaxTokens} (plafond TPM ${budgetPlan.tpmLimit}).`,
          };
        } else if (payload.max_tokens === undefined) {
          payload.max_tokens = budgetPlan.allocatedMaxTokens;
        }

        const scheduled = await defaultTokenScheduler.acquire(this.id, budgetPlan.promptTokens + (payload.max_tokens as number), options.signal);
        releaseTokenReservation = scheduled.release;
        if (scheduled.waitMs > 0) {
          yield {
            type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'rate-limit-wait',
            message: `${this.name} : attente préventive de débit de ${Math.ceil(scheduled.waitMs / 1000)} s pour respecter le quota TPM.`,
          };
        }
      }

      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          redirect: 'error',
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
          signal: options.signal,
        });
      } finally {
        releaseTokenReservation?.();
      }
    } catch (err) {
      if (isAbortError(err)) {
        yield recorder.toUsageEvent(options.taskId, 'aborted');
        return;
      }
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: 'PROVIDER_UNREACHABLE',
        message: sanitizeProviderDiagnostic(`Fournisseur ${this.name} injoignable (${this.baseUrl}) : ${(err as Error).message}`, requestSecrets),
        fatal: true,
      };
      return;
    }

    // Remote rate limits and overloads (413, 429, 502, 503) are waited out, as the provider asks, then retried. A local
    // server's failure (model loading, crash) is reported at once: retrying it would only hide the problem.
    for (let attempt = 1; this.locality === 'remote' && !res.ok && RETRYABLE_STATUS.has(res.status) && attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      const body = await res.text().catch(() => '');
      const waitMs = retryDelayMs(res.headers.get('retry-after'), body, attempt);
      defaultTokenScheduler.recordBackoff(this.id, waitMs);

      if (res.status === 413 || /rate_limit_exceeded|tpm limit/i.test(body)) {
        const currentMax = typeof payload.max_tokens === 'number' ? payload.max_tokens : 2048;
        const reducedMax = Math.max(128, Math.floor(currentMax / 2));
        payload.max_tokens = reducedMax;
        yield {
          type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'rate-limit',
          message: `${this.name} : quota TPM dépassé (HTTP 413), max_tokens réduit à ${reducedMax}, nouvel essai dans ${Math.ceil(waitMs / 1000)} s (${attempt}/${MAX_RATE_LIMIT_RETRIES}).`,
        };
      } else {
        yield {
          type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'rate-limit',
          message: `${this.name} : limite atteinte (HTTP ${res.status}), nouvel essai dans ${Math.ceil(waitMs / 1000)} s (${attempt}/${MAX_RATE_LIMIT_RETRIES}).`,
        };
      }
      try {
        await abortableSleep(waitMs, options.signal);
        res = await fetch(`${this.baseUrl}/chat/completions`, { redirect: 'error', method: 'POST', headers: this.getHeaders(), body: JSON.stringify(payload), signal: options.signal });
      } catch (err) {
        if (isAbortError(err)) {
          yield recorder.toUsageEvent(options.taskId, 'aborted');
          return;
        }
        yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PROVIDER_UNREACHABLE', message: sanitizeProviderDiagnostic(`Fournisseur ${this.name} injoignable (${this.baseUrl}) : ${(err as Error).message}`, requestSecrets), fatal: true };
        return;
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch((err: unknown) => sanitizeProviderDiagnostic(err, requestSecrets));
      const retryAfter = res.headers.get('retry-after');
      const retryDetail = retryAfter ? ` [Retry-After: ${retryAfter}]` : '';
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: `HTTP_${res.status}`,
        message: sanitizeProviderDiagnostic(`Erreur provider ${this.name} (${res.status}): ${errText.slice(0, 2000)}${retryDetail}`, requestSecrets),
        fatal: true,
      };
      return;
    }

    if (!res.body) {
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: 'NO_RESPONSE_BODY',
        message: 'Le serveur n’a renvoyé aucun corps de réponse en streaming.',
        fatal: true,
      };
      return;
    }

    let stopReason: 'complete' | 'tool_calls' | 'aborted' | 'error' = 'complete';
    const pendingToolCalls = new ToolCallAccumulator();
    let sawDone = false;
    let finishReason: string | undefined;
    let toolChunks = 0;
    let lastProgressAt = 0;

    try {
      for await (const rawChunk of readOpenAiSseEvents(res.body)) {
        if (isOpenAiSseDoneEvent(rawChunk)) {
          if (sawDone) throw new ProviderToolProtocolError('Marqueur SSE [DONE] dupliqué.');
          sawDone = true;
          continue;
        }
        if (sawDone) throw new ProviderToolProtocolError('Événement reçu après le marqueur SSE [DONE].');
        const chunk = validateCompletionChunk(rawChunk);
        if (chunk.timings) recorder.setTimings(chunk.timings);
        if (chunk.usage) {
          recorder.setUsage({
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          });
          const totalToks = (chunk.usage.total_tokens as number | undefined) ?? ((chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0));
          if (totalToks > 0) defaultTokenScheduler.recordUsage(this.id, totalToks);
        }

        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const hasOutput = Boolean(delta.content || delta.reasoning_content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length));
        if (finishReason !== undefined && (hasOutput || (choice.finish_reason !== undefined && choice.finish_reason !== null))) {
          throw new ProviderToolProtocolError('Données de choix reçues après finish_reason.');
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = choice.finish_reason;
          if (finishReason === 'tool_calls') stopReason = 'tool_calls';
        }

        if (delta.content) {
          recorder.onOutputChunk();
          yield { type: 'token', taskId: options.taskId, timestamp: Date.now(), delta: delta.content };
        }
        if (delta.reasoning_content) {
          recorder.onOutputChunk();
          yield { type: 'thought', taskId: options.taskId, timestamp: Date.now(), delta: delta.reasoning_content };
        }
        if (Array.isArray(delta.tool_calls)) {
          recorder.onOutputChunk();
          toolChunks += 1;
          if (Date.now() - lastProgressAt > 300) {
            lastProgressAt = Date.now();
            yield { type: 'progress', taskId: options.taskId, timestamp: lastProgressAt, phase: 'tool_call', outputChunks: toolChunks };
          }
          pendingToolCalls.addFragments(delta.tool_calls);
        }
      }
      if (!sawDone) throw new ProviderToolProtocolError('Flux SSE interrompu : marqueur terminal [DONE] absent.');
      if (pendingToolCalls.size > 0 && stopReason !== 'tool_calls') {
        // llama.cpp templates sometimes terminate a complete native tool call
        // with `stop` (or omit finish_reason) while still ending the SSE stream
        // cleanly. Trust it only after the complete call passes the same schema,
        // allow-list, ID and JSON validation as the normal tool_calls path.
        const llamaTerminalWithCalls = this.type === 'llama_cpp'
          && (finishReason === undefined || finishReason === 'stop' || finishReason === 'length');
        if (!llamaTerminalWithCalls) {
          throw new ProviderToolProtocolError(`Le fournisseur a renvoyé des appels d’outils sans finish_reason=tool_calls (finish_reason=${finishReason ?? 'absent'}).`);
        }
        // A length stop is accepted only if the complete tool-call envelope
        // survived parsing and schema validation; truncated arguments fail here.
        pendingToolCalls.resolve(tools, this.recoverToolArguments);
        stopReason = 'tool_calls';
      }

      if (stopReason === 'tool_calls') {
        if (pendingToolCalls.size === 0) throw new ProviderToolProtocolError('finish_reason=tool_calls sans appel d’outil complet.');
        const validatedCalls = pendingToolCalls.resolve(tools, this.recoverToolArguments);
        for (const call of validatedCalls) {
          yield { type: 'tool_start', taskId: options.taskId, timestamp: Date.now(), toolName: call.name, callId: call.id, params: call.arguments };
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        stopReason = 'aborted';
      } else {
        stopReason = 'error';
        yield {
          type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_PROVIDER_RESPONSE',
          message: sanitizeProviderDiagnostic(err, requestSecrets), fatal: true,
        };
      }
    }

    yield recorder.toUsageEvent(options.taskId, stopReason);
  }

  async *completePrefix(
    prompt: string,
    options: ChatOptions & { stop?: string[]; grammar?: string },
  ): AsyncIterable<AgentEvent> {
    const requestSecrets = this.diagnosticSecrets();
    const recorder = new TelemetryRecorder({
      providerId: this.id,
      modelId: options.modelId,
      locality: this.locality,
      backend: this.type,
    });
    if (this.type !== 'llama_cpp') {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PREFIX_COMPLETION_UNSUPPORTED', message: 'La complétion de préfixe brute est disponible uniquement pour le fournisseur llama.cpp.', fatal: true };
      return;
    }
    if (!prompt.trim()) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PREFIX_COMPLETION_EMPTY', message: 'Le préfixe de code est vide.', fatal: true };
      return;
    }

    const origin = this.baseUrl.replace(/\/v1\/?$/u, '');
    // Local CPU models can take longer than a normal HTTP API to tokenize and
    // stream a bounded completion. Keep this finite without misclassifying a
    // slow but healthy local run as a dead provider.
    const signal = options.signal ?? AbortSignal.timeout(120_000);
    const budgetFetch = async (route: string, body?: unknown): Promise<any> => {
      const response = await fetch(`${origin}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: this.getHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new Error(`Mesure de contexte impossible (${route}, HTTP ${response.status}).`);
      return response.json();
    };

    let nativeContext: number;
    let promptTokens: number;
    let props: any;
    try {
      const measured = await Promise.all([
        budgetFetch('/props'),
        budgetFetch('/tokenize', { content: prompt, add_special: true, parse_special: true }),
      ]);
      props = measured[0];
      const tokenized = measured[1];
      nativeContext = Number(props.default_generation_settings?.n_ctx);
      promptTokens = Array.isArray(tokenized.tokens) ? tokenized.tokens.length : NaN;
      if (!Number.isSafeInteger(nativeContext) || nativeContext <= 0 || !Number.isSafeInteger(promptTokens) || promptTokens < 0) {
        throw new Error('Le runtime n’a pas fourni une fenêtre de contexte ou un comptage de tokens valide.');
      }
    } catch (error) {
      if (isAbortError(error)) {
        yield recorder.toUsageEvent(options.taskId, 'aborted');
        return;
      }
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PREFIX_CONTEXT_MEASUREMENT_FAILED', message: sanitizeProviderDiagnostic(error, requestSecrets), fatal: true };
      return;
    }

    const safetyTokens = 16;
    const availableOutputTokens = nativeContext - promptTokens - safetyTokens;
    if (availableOutputTokens < MINIMUM_OUTPUT_BUDGET) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'CONTEXT_BUDGET_EXCEEDED', message: `Le préfixe mesuré (${promptTokens}) laisse ${availableOutputTokens} tokens de sortie, sous le minimum opérationnel (${MINIMUM_OUTPUT_BUDGET}) dans une fenêtre native de ${nativeContext}.`, fatal: true };
      return;
    }
    const requestedOutputTokens = options.maxTokens ?? 512;
    const nPredict = Math.min(requestedOutputTokens, availableOutputTokens);
    yield {
      type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'context-budget',
      message: `Préfixe mesuré : ${promptTokens} tokens d’entrée + ${nPredict} réservés en sortie / ${nativeContext} natifs.`,
      contextBudget: {
        promptTokens, requestedOutputTokens, reservedOutputTokens: nPredict, safetyTokens,
        nativeContext, outputBudgetAdjusted: nPredict < requestedOutputTokens,
        tokenizer: props.model_path || props.model_alias || options.modelId,
        method: 'llama.cpp /tokenize + /completion (préfixe brut)',
      },
    };
    yield {
      type: 'status', taskId: options.taskId, timestamp: Date.now(), stage: 'context-snapshot',
      message: 'Préfixe de code brut envoyé à llama.cpp sans historique conversationnel ni schéma d’outil.',
      contextSnapshot: {
        providerId: this.id, modelId: options.modelId,
        temperature: options.temperature ?? 0.2,
        topP: options.topP, topK: options.topK, presencePenalty: options.presencePenalty,
        toolChoice: 'none', responseFormat: 'raw-prefix', cachePrompt: true,
        messages: [{ role: 'prefix', content: prompt }], tools: [],
      },
    };

    let response: Response;
    try {
      response = await fetch(`${origin}/completion`, {
        method: 'POST', redirect: 'error', headers: this.getHeaders(),
        body: JSON.stringify({
          prompt,
          n_predict: nPredict,
          temperature: options.temperature ?? 0.2,
          ...(options.topP !== undefined ? { top_p: options.topP } : {}),
          ...(options.topK !== undefined ? { top_k: options.topK } : {}),
          ...(options.presencePenalty !== undefined ? { presence_penalty: options.presencePenalty } : {}),
          ...(options.stop?.length ? { stop: options.stop } : {}),
          ...(options.grammar ? { grammar: options.grammar } : {}),
          stream: true,
          cache_prompt: true,
          timings_per_token: false,
        }),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        yield recorder.toUsageEvent(options.taskId, 'aborted');
        return;
      }
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PREFIX_PROVIDER_UNREACHABLE', message: sanitizeProviderDiagnostic(error, requestSecrets), fatal: true };
      return;
    }
    if (!response.ok) {
      const detail = await response.text().catch((error: unknown) => sanitizeProviderDiagnostic(error, requestSecrets));
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: `PREFIX_HTTP_${response.status}`, message: sanitizeProviderDiagnostic(`Erreur llama.cpp /completion (${response.status}) : ${detail.slice(0, 1600)}`, requestSecrets), fatal: true };
      return;
    }
    if (!response.body) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'PREFIX_NO_RESPONSE_BODY', message: 'llama.cpp /completion n’a renvoyé aucun flux de sortie.', fatal: true };
      return;
    }

    let sawDone = false;
    let sawTerminalStop = false;
    let stopReason = 'complete';
    try {
      for await (const rawEvent of readOpenAiSseEvents(response.body)) {
        if (isOpenAiSseDoneEvent(rawEvent)) {
          if (sawDone) throw new ProviderToolProtocolError('Marqueur SSE [DONE] dupliqué pour /completion.');
          sawDone = true;
          continue;
        }
        if (sawDone || !isRecord(rawEvent)) throw new ProviderToolProtocolError('Événement /completion invalide ou reçu après [DONE].');
        if (rawEvent.error !== undefined) throw new ProviderToolProtocolError(`llama.cpp /completion : ${String(rawEvent.error).slice(0, 500)}`);
        if (rawEvent.stop !== undefined && typeof rawEvent.stop !== 'boolean') {
          throw new ProviderToolProtocolError('Le champ stop de /completion doit être un booléen.');
        }
        if (rawEvent.stop === true) sawTerminalStop = true;
        if (rawEvent.timings && isRecord(rawEvent.timings)) {
          const promptCount = rawEvent.timings.prompt_n;
          const predictedCount = rawEvent.timings.predicted_n;
          recorder.setTimings(rawEvent.timings);
          recorder.setUsage({
            promptTokens: typeof promptCount === 'number' && Number.isSafeInteger(promptCount) ? promptCount : undefined,
            completionTokens: typeof predictedCount === 'number' && Number.isSafeInteger(predictedCount) ? predictedCount : undefined,
          });
        }
        if (rawEvent.stop_type !== undefined) {
          if (typeof rawEvent.stop_type !== 'string' || !['none', 'eos', 'limit', 'word'].includes(rawEvent.stop_type)) {
            throw new ProviderToolProtocolError('Le champ stop_type de /completion est invalide.');
          }
          if (rawEvent.stop_type !== 'none') sawTerminalStop = true;
          stopReason = rawEvent.stop_type;
        }
        if (rawEvent.truncated === true) throw new ProviderToolProtocolError('llama.cpp a tronqué le préfixe ou sa complétion à la limite de contexte.');
        if (rawEvent.content !== undefined && typeof rawEvent.content !== 'string') throw new ProviderToolProtocolError('Le champ content de /completion doit être du texte.');
        if (typeof rawEvent.content === 'string' && rawEvent.content.length) {
          recorder.onOutputChunk();
          yield { type: 'token', taskId: options.taskId, timestamp: Date.now(), delta: rawEvent.content };
        }
      }
      // llama.cpp's raw /completion SSE protocol terminates with stop=true;
      // unlike its OpenAI-compatible chat stream, it need not send [DONE].
      if (!sawDone && !sawTerminalStop) throw new ProviderToolProtocolError('Flux /completion interrompu sans marqueur de fin (stop=true ou [DONE]).');
    } catch (error) {
      if (isAbortError(error)) {
        yield recorder.toUsageEvent(options.taskId, 'aborted');
        return;
      }
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_PREFIX_RESPONSE', message: sanitizeProviderDiagnostic(error, requestSecrets), fatal: true };
      yield recorder.toUsageEvent(options.taskId, 'error');
      return;
    }
    if (stopReason === 'limit') recorder.note('La complétion brute a atteint sa limite de n_predict; le contrôleur doit valider le code final.');
    yield recorder.toUsageEvent(options.taskId, 'complete');
  }

  async chatComplete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCallRequest[]; usage?: any }> {
    const requestSecrets = this.diagnosticSecrets();
    try {
      assertProviderToolDefinitions(tools);
    } catch (err) {
      throw new Error(sanitizeProviderDiagnostic(err, requestSecrets));
    }
    const formattedTools = tools.length > 0
      ? tools.map((t) => ({
          type: 'function',
          function: {
            name: toWireToolName(t.name),
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;

    const payload: Record<string, unknown> = {
      model: options.modelId,
      messages: messages.map((m) => toOpenAiMessage(m)),
      stream: false,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens,
    };
    if (options.topP !== undefined) payload.top_p = options.topP;
    if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
    if (this.type === 'llama_cpp' && options.topK !== undefined) payload.top_k = options.topK;
    if (options.responseSchema) payload.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: options.responseSchema } };

    if (formattedTools) {
      payload.tools = formattedTools;
      payload.tool_choice = options.toolChoice === 'required' ? 'required' : 'auto';
      if (this.type === 'llama_cpp' && options.toolChoice === 'required') payload.cache_prompt = false;
    }

    let releaseTokenReservation: (() => void) | undefined;
    if (this.locality === 'remote') {
      const budgetPlan = planTokenBudget(this.id, options.modelId, messages, tools, (payload.max_tokens as number | undefined) ?? 2048);
      if (budgetPlan.isClamped) {
        payload.max_tokens = budgetPlan.allocatedMaxTokens;
      } else if (payload.max_tokens === undefined) {
        payload.max_tokens = budgetPlan.allocatedMaxTokens;
      }
      const scheduled = await defaultTokenScheduler.acquire(this.id, budgetPlan.promptTokens + (payload.max_tokens as number), options.signal);
      releaseTokenReservation = scheduled.release;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        // A local endpoint must never redirect a prompt (or credentials) to a
        // different origin. The streaming path already uses this policy.
        redirect: 'error',
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: options.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new Error(sanitizeProviderDiagnostic(err, requestSecrets));
    } finally {
      releaseTokenReservation?.();
    }

    if (!res.ok) {
      const err = await res.text().catch((readError: unknown) => sanitizeProviderDiagnostic(readError, requestSecrets));
      throw new Error(sanitizeProviderDiagnostic(`HTTP ${res.status}: ${err}`, requestSecrets));
    }

    let data: unknown;
    try {
      data = await res.json() as unknown;
    } catch (err) {
      throw new Error(sanitizeProviderDiagnostic(err, requestSecrets));
    }
    try {
      if (!isRecord(data) || !Array.isArray(data.choices) || data.choices.length !== 1) {
        throw new ProviderToolProtocolError('Réponse chat.completions invalide : un choix unique est attendu.');
      }
      const choice = data.choices[0];
      if (!isRecord(choice) || !isRecord(choice.message)) throw new ProviderToolProtocolError('Message assistant absent ou invalide.');
      if (choice.finish_reason !== undefined && choice.finish_reason !== null && typeof choice.finish_reason !== 'string') {
        throw new ProviderToolProtocolError('finish_reason invalide dans la réponse complète.');
      }
      const message = choice.message;
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') {
        throw new ProviderToolProtocolError('Contenu assistant invalide dans la réponse complète.');
      }
      const resolved = resolveCompleteToolCalls(message.tool_calls, tools);
      const llamaTerminalWithCalls = this.type === 'llama_cpp'
        && (choice.finish_reason === undefined || choice.finish_reason === null || choice.finish_reason === 'stop' || choice.finish_reason === 'length');
      if (resolved.length > 0 && choice.finish_reason !== 'tool_calls' && !llamaTerminalWithCalls) {
        throw new ProviderToolProtocolError(`Le fournisseur a renvoyé des tool_calls sans finish_reason=tool_calls (finish_reason=${choice.finish_reason ?? 'absent'}).`);
      }
      if (resolved.length === 0 && choice.finish_reason === 'tool_calls') {
        throw new ProviderToolProtocolError('finish_reason=tool_calls sans appel d’outil.');
      }
      if (data.usage !== undefined) {
        if (!isRecord(data.usage)) throw new ProviderToolProtocolError('Compteurs d’usage invalides dans la réponse complète.');
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          if (data.usage[key] !== undefined && (!Number.isSafeInteger(data.usage[key]) || (data.usage[key] as number) < 0)) {
            throw new ProviderToolProtocolError(`Compteur d’usage invalide : ${key}.`);
          }
        }
        const usageRecord = data.usage as Record<string, number | undefined>;
        const totalToks = usageRecord.total_tokens ?? ((usageRecord.prompt_tokens ?? 0) + (usageRecord.completion_tokens ?? 0));
        if (typeof totalToks === 'number' && totalToks > 0) defaultTokenScheduler.recordUsage(this.id, totalToks);
      }
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls: resolved.length ? resolved : undefined,
        usage: data.usage,
      };
    } catch (err) {
      throw new Error(sanitizeProviderDiagnostic(err, requestSecrets));
    }
  }
}
