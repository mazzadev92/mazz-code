import type { InferenceTelemetry } from '@mazz/shared';

/** Above this share of the window the model starts losing early turns (spec 02). */
export const CONTEXT_ALERT_PCT = 75;

/**
 * Context windows declared by the specification (spec 02 §3.4, spec 05 §2) for models whose server does
 * not report its window to the Studio. These are documented values, not measurements.
 */
const SPEC_CONTEXT_LIMITS: ReadonlyArray<{ pattern: RegExp; limit: number; label: string }> = [
  { pattern: /modal|qwen2\.5-coder-32b/i, limit: 32_768, label: 'Modal 32B' },
  { pattern: /base-4b/i, limit: 16_384, label: 'Base-4B' },
  { pattern: /14b/i, limit: 4_096, label: '14B one-shot' },
];

export type ContextLimit = { limit: number; source: 'runtime' | 'spec'; label: string };

/** Window of the model behind the last call: llama-server's --ctx-size when local, otherwise the spec value if one exists. */
export function contextLimitFor(last: Pick<InferenceTelemetry, 'providerId' | 'modelId'> | undefined, localCtxSize: number | undefined): ContextLimit | undefined {
  if (!last) return undefined;
  if (last.providerId === 'llama-local' && localCtxSize) return { limit: localCtxSize, source: 'runtime', label: 'llama-server (--ctx-size)' };
  const declared = SPEC_CONTEXT_LIMITS.find((entry) => entry.pattern.test(last.modelId));
  return declared ? { limit: declared.limit, source: 'spec', label: declared.label } : undefined;
}
