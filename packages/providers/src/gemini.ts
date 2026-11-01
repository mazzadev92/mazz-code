import type {
  AgentEvent,
  ChatMessage,
  ModelCapability,
  ToolCallRequest,
  ToolDefinition,
} from '@mazz/shared';
import { sanitizeProviderDiagnostic, toWireToolName, type ChatOptions, type IModelProvider, type ProviderConfigureOptions } from './base.js';
import { TelemetryRecorder, isAbortError } from './telemetry-recorder.js';
import { assertProviderToolDefinitions, ProviderToolProtocolError, ToolCallAccumulator, isOpenAiSseDoneEvent, readOpenAiSseEvents, toOpenAiMessage, validateCompletionChunk } from './openai.js';

export interface GeminiProviderOptions {
  id: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
}

export class GeminiProvider implements IModelProvider {
  readonly id: string;
  readonly type = 'gemini';
  readonly name: string;
  baseUrl: string;
  readonly locality = 'remote' as const;
  readonly requiresApiKey = true;

  private apiKey?: string;

  constructor(options: GeminiProviderOptions) {
    this.id = options.id;
    this.name = options.name || 'Google Gemini';
    this.baseUrl = (options.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  configure(options: ProviderConfigureOptions): void {
    if (options.apiKey !== undefined) this.apiKey = options.apiKey || undefined;
    if (options.baseUrl) this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const start = Date.now();
    const requestSecrets = [this.apiKey];
    if (!this.apiKey) {
      return { ok: false, message: 'Clé API Gemini non configurée.', latencyMs: 0 };
    }
    try {
      // Key sent as a header, never in the URL (URLs end up in logs and proxies).
      const res = await fetch(`${this.baseUrl}/v1beta/models`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(6000),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        return { ok: false, message: sanitizeProviderDiagnostic(`Erreur HTTP ${res.status}: ${res.statusText}`, requestSecrets), latencyMs };
      }
      return { ok: true, message: 'Connexion Gemini API établie avec succès.', latencyMs };
    } catch (err) {
      return { ok: false, message: sanitizeProviderDiagnostic(`Échec de connexion: ${(err as Error).message}`, requestSecrets), latencyMs: Date.now() - start };
    }
  }

  async listModels(): Promise<ModelCapability[]> {
    if (!this.apiKey) return [];
    try {
      const res = await fetch(`${this.baseUrl}/v1beta/models?pageSize=200`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
      };
      return (data.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => ({
          id: m.name.replace(/^models\//, ''),
          name: m.displayName || m.name,
          providerId: this.id,
          locality: 'remote' as const,
          supportsStreaming: true,
          toolCalling: 'unverified' as const,
          maxContextTokens: m.inputTokenLimit,
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
        message: 'Clé API Google Gemini requise.',
        fatal: true,
      };
      return;
    }

    // Use Gemini's OpenAI-compatible endpoint with Bearer auth or key parameter
    const url = `${this.baseUrl}/v1beta/openai/chat/completions`;
    const recorder = new TelemetryRecorder({
      providerId: this.id,
      modelId: options.modelId,
      locality: 'remote',
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

    const payload: Record<string, unknown> = {
      model: options.modelId,
      messages: messages.map((m) => toOpenAiMessage(m)),
      stream: true,
      stream_options: { include_usage: true },
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens,
    };

    if (formattedTools) {
      payload.tools = formattedTools;
      // Google's OpenAI compatibility endpoint documents this function-call mode.
      payload.tool_choice = options.toolChoice === 'required' ? 'required' : 'auto';
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
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
        message: sanitizeProviderDiagnostic(`Gemini injoignable : ${(err as Error).message}`, requestSecrets),
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
        message: sanitizeProviderDiagnostic(`Erreur Gemini (${res.status}): ${err}`, requestSecrets),
        fatal: true,
      };
      return;
    }

    if (!res.body) {
      yield { type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'NO_RESPONSE_BODY', message: 'Gemini n’a renvoyé aucun corps de réponse en streaming.', fatal: true };
      return;
    }

    const pendingToolCalls = new ToolCallAccumulator();
    let stopReason: 'complete' | 'tool_calls' | 'aborted' | 'error' = 'complete';
    let sawDone = false;
    let finishReason: string | undefined;

    try {
      for await (const rawChunk of readOpenAiSseEvents(res.body)) {
        if (isOpenAiSseDoneEvent(rawChunk)) {
          if (sawDone) throw new ProviderToolProtocolError('Marqueur SSE [DONE] dupliqué.');
          sawDone = true;
          continue;
        }
        if (sawDone) throw new ProviderToolProtocolError('Événement reçu après le marqueur SSE [DONE].');
        const chunk = validateCompletionChunk(rawChunk);
        if (chunk.usage) {
          recorder.setUsage({ promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens });
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        const hasOutput = Boolean(delta.content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length));
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
        if (Array.isArray(delta.tool_calls)) {
          recorder.onOutputChunk();
          pendingToolCalls.addFragments(delta.tool_calls);
        }
      }
      if (!sawDone) throw new ProviderToolProtocolError('Flux SSE interrompu : marqueur terminal [DONE] absent.');
      if (pendingToolCalls.size > 0 && stopReason !== 'tool_calls') {
        throw new ProviderToolProtocolError('Le fournisseur a renvoyé des appels d’outils sans finish_reason=tool_calls.');
      }
      if (stopReason === 'tool_calls') {
        if (pendingToolCalls.size === 0) throw new ProviderToolProtocolError('finish_reason=tool_calls sans appel d’outil complet.');
        const validatedCalls = pendingToolCalls.resolve(tools);
        for (const call of validatedCalls) {
          yield { type: 'tool_start', taskId: options.taskId, timestamp: Date.now(), toolName: call.name, callId: call.id, params: call.arguments };
        }
      }
    } catch (err) {
      if (isAbortError(err)) stopReason = 'aborted';
      else {
        stopReason = 'error';
        yield {
          type: 'error', taskId: options.taskId, timestamp: Date.now(), code: 'INVALID_PROVIDER_RESPONSE',
          message: sanitizeProviderDiagnostic(err, requestSecrets), fatal: true,
        };
      }
    }

    yield recorder.toUsageEvent(options.taskId, stopReason);
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
