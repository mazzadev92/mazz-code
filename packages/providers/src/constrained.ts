import type { ToolDefinition } from '@mazz/shared';
import { toWireToolName } from './base.js';

export type ConstrainedToolCallsSetting = 'auto' | 'on' | 'off';

/** Models strictly below this many billions of parameters get constrained tool calls in 'auto'. */
export const CONSTRAINED_AUTO_MAX_BILLIONS = 8;

/** Parameter count in billions from GGUF metadata (exact count, then size label) or the model name; undefined if unknown. */
export function modelSizeBillions(modelId: string, meta?: { parameterCount?: number; sizeLabel?: string }): number | undefined {
  if (meta?.parameterCount && meta.parameterCount > 0) return meta.parameterCount / 1e9;
  const label = /^(\d+(?:\.\d+)?)\s*([bm])$/i.exec(meta?.sizeLabel?.trim() ?? '');
  if (label) return Number(label[1]) / (label[2].toLowerCase() === 'm' ? 1000 : 1);
  const named = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(modelId.replace(/a\d+(?:\.\d+)?b/gi, ''));
  return named ? Number(named[1]) : undefined;
}

/** Whether tool calls must be grammar-constrained: only a local llama.cpp server, small model in 'auto'. */
export function shouldConstrainToolCalls(
  setting: ConstrainedToolCallsSetting | undefined,
  ctx: { local: boolean; llamaCpp: boolean; modelId: string; meta?: { parameterCount?: number; sizeLabel?: string } },
): boolean {
  if (!ctx.local || !ctx.llamaCpp || setting === 'off') return false;
  if (setting === 'on') return true;
  const size = modelSizeBillions(ctx.modelId, ctx.meta);
  return size !== undefined && size < CONSTRAINED_AUTO_MAX_BILLIONS;
}

/**
 * JSON Schema accepted by llama.cpp (response_format json_schema): exactly one offered call
 * `{name: <const>, arguments: <that tool's parameters>}` or a final `{answer: string}`.
 */
export function buildToolCallSchema(tools: readonly ToolDefinition[]): Record<string, unknown> {
  const calls = tools.map((tool) => {
    const { $schema: _ignored, ...parameters } = tool.parameters as unknown as Record<string, unknown>;
    return {
      type: 'object',
      properties: { name: { const: toWireToolName(tool.name) }, arguments: parameters },
      required: ['name', 'arguments'],
      additionalProperties: false,
    };
  });
  const answer = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  return { oneOf: [...calls, answer] };
}

/** Reads a constrained reply: a call (real tool name), a final answer, or undefined when it is not valid JSON of that shape. */
export function parseConstrainedReply(
  text: string,
  tools: readonly ToolDefinition[],
): { call: { name: string; arguments: Record<string, unknown> } } | { answer: string } | undefined {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { return undefined; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.answer === 'string') return { answer: record.answer };
  const tool = typeof record.name === 'string' ? tools.find((t) => toWireToolName(t.name) === record.name) : undefined;
  const args = record.arguments;
  if (!tool || typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  return { call: { name: tool.name, arguments: args as Record<string, unknown> } };
}
