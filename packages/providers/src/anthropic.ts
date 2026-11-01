import type {
  AgentEvent,
  ChatMessage,
  ModelCapability,
  ToolCallRequest,
  ToolDefinition,
} from '@mazz/shared';
import {
  providerToolCallArgumentsIssue,
  providerToolCallIdDuplicateIssue,
  providerToolCallIdIssue,
  providerToolCallLimitIssue,
  providerToolCallNameIssue,
  resolveToolName,
  sanitizeProviderDiagnostic,
  toWireToolName,
  type ChatOptions,
  type IModelProvider,
  type ProviderConfigureOptions,
} from './base.js';
import { TelemetryRecorder, isAbortError } from './telemetry-recorder.js';
import { assertProviderToolDefinitions, ProviderToolProtocolError, validateToolArguments } from './openai.js';

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProviderToolProtocolError(`Compteur Anthropic invalide : ${label}.`);
  }
  return value as number;
}

/** Decodes fragmented Anthropic SSE frames and verifies the named event envelope. */
async function* readAnthropicSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const dispatch = (): Record<string, any> | undefined => {
    if (!dataLines.length) {
      eventName = undefined;
      return undefined;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    let parsed: unknown;
    try { parsed = JSON.parse(data); }
    catch { throw new ProviderToolProtocolError('Trame SSE Anthropic malformée : JSON invalide.'); }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      throw new ProviderToolProtocolError('Enveloppe SSE Anthropic invalide : type d’événement absent.');
    }
    if (eventName && eventName !== parsed.type) {
      throw new ProviderToolProtocolError(`Événement SSE « ${eventName} » incohérent avec le type « ${parsed.type} ».`);
    }
    eventName = undefined;
    return parsed;
  };

  const consumeLine = (line: string): Record<string, any> | undefined => {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return undefined;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
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
        const endingLength = buffer[lineEnd] === '\r' && buffer[lineEnd + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(lineEnd + endingLength);
        const event = consumeLine(line);
        if (event) yield event;
      }
      if (done) {
        if (buffer) {
          const event = consumeLine(buffer);
          if (event) yield event;
        }
        const finalEvent = dispatch();
        if (finalEvent) yield finalEvent;
        break;
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export interface AnthropicProviderOptions {
  id: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class AnthropicProvider implements IModelProvider {
  readonly id: string;
  readonly type = 'anthropic';
  readonly name: string;
  baseUrl: string;
  readonly locality = 'remote' as const;
  readonly requiresApiKey = true;

  private apiKey?: string;

  constructor(options: AnthropicProviderOptions) {
    this.id = options.id;
    this.name = options.name || 'Anthropic Claude';
    this.baseUrl = (options.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
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
      'anthropic-version': '2023-06-01',
    };
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    const requestSecrets = [this.apiKey];
    if (!this.apiKey) {
      return { ok: false, message: 'Clé API Anthropic non renseignée.', latencyMs: 0 };
    }
    try {
      // Listing models authenticates the key without generating billed tokens.
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - start;
      if (res.ok || res.status === 200) {
        return { ok: true, message: 'Authentification Anthropic réussie.', latencyMs };
      }
      const err = await res.text().catch((readError: unknown) => sanitizeProviderDiagnostic(readError, requestSecrets));
      return { ok: false, message: sanitizeProviderDiagnostic(`Erreur HTTP ${res.status}: ${err.slice(0, 500)}`, requestSecrets), latencyMs };
    } catch (err) {
      return { ok: false, message: sanitizeProviderDiagnostic(`Connexion impossible: ${(err as Error).message}`, requestSecrets), latencyMs: Date.now() - start };
    }
  }

  async listModels(): Promise<ModelCapability[]> {
    if (!this.apiKey) return [];
    try {
      const res = await fetch(`${this.baseUrl}/v1/models?limit=100`, {
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      return (data.data || []).map((m) => ({
        id: m.id,
        name: m.display_name || m.id,
        providerId: this.id,
        locality: 'remote' as const,
        supportsStreaming: true,
        toolCalling: 'unverified' as const,
        isAvailable: true,
      }));
    } catch {
      return [];
    }
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<AgentEvent> {
    const requestSecrets = [this.apiKey];
    try { assertProviderToolDefinitions(tools); } catch (err) {
      yield {
        type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_TOOL_DEFINITIONS',
        message: sanitizeProviderDiagnostic(err, requestSecrets), fatal: true,
      };
      return;
    }
    if (!this.apiKey) {
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: 'MISSING_API_KEY',
        message: 'Clé API Anthropic requise.',
        fatal: true,
      };
      return;
    }

    const recorder = new TelemetryRecorder({
      providerId: this.id,
      modelId: options.modelId,
      locality: 'remote',
      backend: this.type,
    });

    // Separate system message from conversation
    let systemPrompt: string | undefined;
    const filteredMessages: Array<{ role: 'user' | 'assistant'; content: any }> = [];

    for (const m of messages) {
      if (m.role === 'system') {
        systemPrompt = (systemPrompt ? systemPrompt + '\n' : '') + m.content;
      } else if (m.role === 'user') {
        filteredMessages.push({
          role: 'user',
          content: m.images?.length
            ? [...m.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.dataBase64 } })), { type: 'text', text: m.content }]
            : m.content,
        });
      } else if (m.role === 'assistant') {
        if (m.toolCalls?.length) {
          const blocks: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
          for (const tc of m.toolCalls) {
            blocks.push({ type: 'tool_use', id: tc.id, name: toWireToolName(tc.name), input: tc.arguments });
          }
          filteredMessages.push({ role: 'assistant', content: blocks });
        } else {
          filteredMessages.push({ role: 'assistant', content: m.content });
        }
      } else if (m.role === 'tool') {
        filteredMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId || 'unknown_tool',
              content: m.content,
            },
          ],
        });
      }
    }

    const anthropicTools = tools.map((t) => ({
      name: toWireToolName(t.name),
      description: t.description,
      input_schema: t.parameters,
    }));

    const payload: Record<string, unknown> = {
      model: options.modelId,
      max_tokens: options.maxTokens || 4096,
      messages: filteredMessages,
      stream: true,
      temperature: options.temperature ?? 0.2,
    };

    if (systemPrompt) payload.system = systemPrompt;
    if (anthropicTools.length > 0) {
      payload.tools = anthropicTools;
      if (options.toolChoice === 'required') payload.tool_choice = { type: 'any' };
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
        signal: options.signal,
      });
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
        message: sanitizeProviderDiagnostic(`Anthropic injoignable : ${(err as Error).message}`, requestSecrets),
        fatal: true,
      };
      return;
    }

    if (!res.ok) {
      const err = await res.text().catch((readError: unknown) => sanitizeProviderDiagnostic(readError, requestSecrets));
      yield {
        type: 'error',
        taskId: options.taskId,
        timestamp: Date.now(),
        code: `HTTP_${res.status}`,
        message: sanitizeProviderDiagnostic(`Erreur Anthropic (${res.status}): ${err}`, requestSecrets),
        fatal: true,
      };
      return;
    }

    if (!res.body) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'NO_RESPONSE_BODY', message: 'Anthropic n’a renvoyé aucun corps de réponse en streaming.', fatal: true };
      return;
    }

    interface ToolBlock {
      id: string;
      name: string;
      initialInput: Record<string, unknown>;
      initialInputCharacters: number;
      partialJson: string;
      receivedJsonDelta: boolean;
    }
    const activeBlocks = new Set<number>();
    const seenBlockIndexes = new Set<number>();
    const toolBlocks = new Map<number, ToolBlock>();
    const completedToolCalls: Array<{ index: number; call: ToolCallRequest }> = [];
    const seenToolIds = new Set<string>();
    let totalToolArgumentCharacters = 0;
    let messageStarted = false;
    let messageStopped = false;
    let stopReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    let aborted = false;

    try {
      for await (const event of readAnthropicSseEvents(res.body)) {
        if (messageStopped) throw new ProviderToolProtocolError('Événement reçu après message_stop.');
        if (event.type === 'ping') continue;
        if (event.type === 'error') {
          const detail = isRecord(event.error) && typeof event.error.message === 'string' ? event.error.message : 'erreur API non détaillée';
          throw new ProviderToolProtocolError(`Réponse d’erreur Anthropic : ${detail}`);
        }
        if (event.type === 'message_start') {
          if (messageStarted || !isRecord(event.message)) throw new ProviderToolProtocolError('message_start absent, dupliqué ou invalide.');
          messageStarted = true;
          if (event.message.usage !== undefined) {
            if (!isRecord(event.message.usage)) throw new ProviderToolProtocolError('Usage initial Anthropic invalide.');
            promptTokens = validateTokenCount(event.message.usage.input_tokens, 'input_tokens');
          }
          continue;
        }
        if (!messageStarted) throw new ProviderToolProtocolError(`Événement ${event.type} reçu avant message_start.`);

        if (event.type === 'content_block_start') {
          if (!Number.isSafeInteger(event.index) || event.index < 0 || !isRecord(event.content_block)) {
            throw new ProviderToolProtocolError('content_block_start invalide.');
          }
          const index = event.index as number;
          if (seenBlockIndexes.has(index)) throw new ProviderToolProtocolError(`Index content block dupliqué : ${index}.`);
          seenBlockIndexes.add(index);
          activeBlocks.add(index);
          const block = event.content_block;
          if (typeof block.type !== 'string') throw new ProviderToolProtocolError('Type de content block absent.');
          if (block.type === 'tool_use') {
            const idIssue = providerToolCallIdIssue(block.id);
            if (idIssue) throw new ProviderToolProtocolError(idIssue);
            const nameIssue = providerToolCallNameIssue(block.name);
            if (nameIssue) throw new ProviderToolProtocolError(nameIssue);
            if (!isRecord(block.input)) throw new ProviderToolProtocolError(`Arguments initiaux invalides pour « ${block.name} ».`);
            const callLimitIssue = providerToolCallLimitIssue(toolBlocks.size);
            if (callLimitIssue) throw new ProviderToolProtocolError(callLimitIssue);
            const duplicateIdIssue = providerToolCallIdDuplicateIssue(block.id, seenToolIds);
            if (duplicateIdIssue) throw new ProviderToolProtocolError(duplicateIdIssue);
            seenToolIds.add(block.id);
            const serializedInput = JSON.stringify(block.input);
            if (typeof serializedInput !== 'string') throw new ProviderToolProtocolError(`Arguments initiaux invalides pour « ${block.name} ».`);
            const inputLimitIssue = providerToolCallArgumentsIssue(serializedInput, 0, totalToolArgumentCharacters);
            if (inputLimitIssue) throw new ProviderToolProtocolError(inputLimitIssue);
            totalToolArgumentCharacters += serializedInput.length;
            toolBlocks.set(index, {
              id: block.id,
              name: block.name,
              initialInput: block.input,
              initialInputCharacters: serializedInput.length,
              partialJson: '',
              receivedJsonDelta: false,
            });
          }
          continue;
        }

        if (event.type === 'content_block_delta') {
          if (!Number.isSafeInteger(event.index) || !activeBlocks.has(event.index) || !isRecord(event.delta) || typeof event.delta.type !== 'string') {
            throw new ProviderToolProtocolError('content_block_delta reçu sans bloc actif ou delta valide.');
          }
          const block = toolBlocks.get(event.index);
          if (event.delta.type === 'text_delta') {
            if (typeof event.delta.text !== 'string') throw new ProviderToolProtocolError('text_delta sans texte valide.');
            recorder.onOutputChunk();
            yield { type: 'token', taskId: options.taskId, timestamp: Date.now(), delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            if (!block || typeof event.delta.partial_json !== 'string') throw new ProviderToolProtocolError('input_json_delta invalide ou reçu hors d’un bloc tool_use.');
            if (!block.receivedJsonDelta) {
              if (Object.keys(block.initialInput).length > 0) {
                throw new ProviderToolProtocolError(`Arguments initiaux et fragments JSON mélangés pour « ${block.name} ».`);
              }
              totalToolArgumentCharacters -= block.initialInputCharacters;
            }
            const argsLimitIssue = providerToolCallArgumentsIssue(event.delta.partial_json, block.partialJson.length, totalToolArgumentCharacters);
            if (argsLimitIssue) throw new ProviderToolProtocolError(argsLimitIssue);
            block.receivedJsonDelta = true;
            block.partialJson += event.delta.partial_json;
            totalToolArgumentCharacters += event.delta.partial_json.length;
            recorder.onOutputChunk();
          } else if (event.delta.type === 'thinking_delta') {
            if (typeof event.delta.thinking !== 'string') throw new ProviderToolProtocolError('thinking_delta invalide.');
          } else if (event.delta.type === 'signature_delta') {
            if (typeof event.delta.signature !== 'string') throw new ProviderToolProtocolError('signature_delta invalide.');
          } else if (block) {
            throw new ProviderToolProtocolError(`Delta ${event.delta.type} inattendu dans un bloc tool_use.`);
          }
          continue;
        }

        if (event.type === 'content_block_stop') {
          if (!Number.isSafeInteger(event.index) || !activeBlocks.has(event.index)) {
            throw new ProviderToolProtocolError('content_block_stop sans bloc actif.');
          }
          const index = event.index as number;
          activeBlocks.delete(index);
          const block = toolBlocks.get(index);
          if (block) {
            let args: unknown;
            if (block.receivedJsonDelta) {
              try { args = JSON.parse(block.partialJson); }
              catch { throw new ProviderToolProtocolError(`Arguments JSON incomplets ou invalides pour « ${block.name} ».`); }
            } else {
              args = block.initialInput;
            }
            const canonicalName = resolveToolName(block.name, tools);
            if (!canonicalName) throw new ProviderToolProtocolError(`Outil inconnu ou alias ambigu : « ${block.name} » n’appartient pas aux schémas autorisés.`);
            const definition = tools.find((tool) => tool.name === canonicalName);
            if (!definition) throw new ProviderToolProtocolError(`Outil non autorisé : « ${canonicalName} ».`);
            completedToolCalls.push({
              index,
              call: {
                id: block.id,
                name: canonicalName,
                arguments: validateToolArguments(args, definition.parameters),
              },
            });
          }
          continue;
        }

        if (event.type === 'message_delta') {
          if (!isRecord(event.delta)) throw new ProviderToolProtocolError('message_delta invalide.');
          if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
            if (typeof event.delta.stop_reason !== 'string' || stopReason !== undefined) {
              throw new ProviderToolProtocolError('stop_reason Anthropic absent ou dupliqué de façon ambiguë.');
            }
            stopReason = event.delta.stop_reason;
          }
          if (event.usage !== undefined) {
            if (!isRecord(event.usage)) throw new ProviderToolProtocolError('Usage final Anthropic invalide.');
            completionTokens = validateTokenCount(event.usage.output_tokens, 'output_tokens');
          }
          continue;
        }

        if (event.type === 'message_stop') {
          if (!messageStarted || activeBlocks.size || typeof stopReason !== 'string') {
            throw new ProviderToolProtocolError('message_stop reçu avant la fin des blocs ou sans stop_reason.');
          }
          messageStopped = true;
          continue;
        }

        throw new ProviderToolProtocolError(`Type d’événement Anthropic non pris en charge : ${event.type}.`);
      }

      if (!messageStarted || !messageStopped) throw new ProviderToolProtocolError('Flux Anthropic interrompu avant message_stop.');
      if (completedToolCalls.length > 0 && stopReason !== 'tool_use') {
        throw new ProviderToolProtocolError('Le fournisseur a renvoyé des outils sans stop_reason=tool_use.');
      }
      if (stopReason === 'tool_use' && completedToolCalls.length === 0) {
        throw new ProviderToolProtocolError('stop_reason=tool_use sans appel d’outil complet.');
      }
      for (const { call } of completedToolCalls.sort((a, b) => a.index - b.index)) {
        yield { type: 'tool_start', taskId: options.taskId, timestamp: Date.now(), toolName: call.name, callId: call.id, params: call.arguments };
      }
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
      } else {
        yield {
          type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_PROVIDER_RESPONSE',
          message: sanitizeProviderDiagnostic(err, requestSecrets), fatal: true,
        };
        recorder.setUsage({ promptTokens, completionTokens });
        yield recorder.toUsageEvent(options.taskId, 'error');
        return;
      }
    }

    recorder.setUsage({ promptTokens, completionTokens });
    yield recorder.toUsageEvent(options.taskId, aborted ? 'aborted' : completedToolCalls.length ? 'tool_calls' : 'complete');
  }

  async chatComplete(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCallRequest[]; usage?: any }> {
    let content = '';
    const toolCalls: ToolCallRequest[] = [];
    let usage: any = undefined;

    for await (const ev of this.chatStream(messages, tools, options)) {
      if (ev.type === 'error' && ev.fatal) throw new Error(ev.message);
      if (ev.type === 'token') content += ev.delta;
      if (ev.type === 'tool_start') {
        toolCalls.push({
          id: ev.callId,
          name: ev.toolName,
          arguments: ev.params,
        });
      }
      if (ev.type === 'usage') usage = ev;
    }

    return { content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined, usage };
  }
}
