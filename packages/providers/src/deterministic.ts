import type {
  AgentEvent,
  ChatMessage,
  ModelCapability,
  ToolCallRequest,
  ToolDefinition,
} from '@mazz/shared';
import type { ChatOptions, IModelProvider } from './base.js';
import { TelemetryRecorder } from './telemetry-recorder.js';

export interface DeterministicPlanStep {
  thought?: string;
  toolCall?: ToolCallRequest;
  toolCalls?: ToolCallRequest[];
  message?: string;
}

export class DeterministicTestProvider implements IModelProvider {
  readonly id = 'deterministic-test';
  readonly type = 'openai_compatible';
  readonly name = 'Moteur de test déterministe';
  readonly baseUrl = 'local://deterministic';
  readonly locality = 'local' as const;

  private script: DeterministicPlanStep[] = [];
  private stepIndex = 0;

  constructor(script?: DeterministicPlanStep[]) {
    if (script) {
      this.script = script;
    }
  }

  setScript(script: DeterministicPlanStep[]): void {
    this.script = script;
    this.stepIndex = 0;
  }

  reset(): void {
    this.stepIndex = 0;
  }

  async testConnection(): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    return { ok: true, message: 'Deterministic engine prêt.', latencyMs: 1 };
  }

  async listModels(): Promise<ModelCapability[]> {
    return [
      {
        id: 'mazz-deterministic-v1',
        name: 'Moteur de test déterministe (non génératif)',
        providerId: this.id,
        locality: 'local',
        supportsStreaming: true,
        toolCalling: 'verified',
        maxContextTokens: 32768,
        isAvailable: true,
      },
    ];
  }

  async *chatStream(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    options: ChatOptions
  ): AsyncIterable<AgentEvent> {
    const step = this.script[this.stepIndex] || {
      message: 'Tâche accomplie selon les règles déterministes.',
    };
    this.stepIndex++;
    const toolCalls = step.toolCalls?.length ? step.toolCalls : step.toolCall ? [step.toolCall] : [];
    const recorder = new TelemetryRecorder({
      providerId: this.id,
      modelId: options.modelId,
      locality: 'local',
      backend: 'deterministic',
      synthetic: true,
    });

    if (step.thought) {
      yield {
        type: 'thought',
        taskId: options.taskId,
        timestamp: Date.now(),
        delta: step.thought,
      };
    }

    for (const toolCall of toolCalls) {
      yield {
        type: 'tool_start',
        taskId: options.taskId,
        timestamp: Date.now(),
        toolName: toolCall.name,
        callId: toolCall.id,
        params: toolCall.arguments,
      };
    }

    if (step.message) {
      const tokens = step.message.split(' ');
      for (const t of tokens) {
        yield {
          type: 'token',
          taskId: options.taskId,
          timestamp: Date.now(),
          delta: t + ' ',
        };
      }
    }

    // Scripted engine: no token counts nor speeds exist, the record says so.
    yield recorder.toUsageEvent(options.taskId, toolCalls.length ? 'tool_calls' : 'complete');
  }

  async chatComplete(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ChatOptions
  ): Promise<{ content: string; toolCalls?: ToolCallRequest[]; usage?: any }> {
    const step = this.script[this.stepIndex] || {
      message: 'Tâche accomplie.',
    };
    this.stepIndex++;
    const toolCalls = step.toolCalls?.length ? step.toolCalls : step.toolCall ? [step.toolCall] : [];

    return {
      content: step.message || '',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: undefined,
    };
  }
}
