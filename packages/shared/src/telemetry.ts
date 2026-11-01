/**
 * MAZZ ÆNGENIUM — Inference telemetry contracts and pure formulas.
 *
 * Definitions (see docs/TELEMETRY_SPEC.md):
 *   tg_tok_s  output tokens actually generated per second (decode phase only)
 *   pp_tok_s  input (prompt) tokens processed per second (prefill phase only)
 *   ttft_ms   delay between request emission and first streamed output token
 *
 * Every value carries its provenance. A value that cannot be measured is
 * `undefined` and must be displayed as "N/D", never replaced by a guess.
 */

export type MetricSource =
  /** Counters and timings reported by the local runtime (llama.cpp `timings`). */
  | 'runtime_timings'
  /** Token counts declared by a remote provider (`usage` field). */
  | 'provider_usage'
  /** Derived from client-side clock and streamed chunks: an estimate. */
  | 'client_estimate'
  /** Deterministic test engine: values are not measurements. */
  | 'synthetic'
  | 'unavailable';

export type RunStopReason = 'complete' | 'tool_calls' | 'aborted' | 'error';

export interface InferenceTelemetry {
  providerId: string;
  modelId: string;
  locality: 'local' | 'remote';
  /** Provider type, e.g. llama_cpp, groq, anthropic. */
  backend: string;
  startedAt: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  endedAt: number;
  ttftMs?: number;
  e2eMs: number;
  promptMs?: number;
  generationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Speculative decoding (llama.cpp timings draft_n / draft_n_accepted). */
  draftTokens?: number;
  draftAccepted?: number;
  /** Prompt (input) processing speed. */
  ppTokS?: number;
  /** Generation (output) speed. */
  tgTokS?: number;
  tokenSource: MetricSource;
  speedSource: MetricSource;
  /** Number of streamed content chunks (not tokens). */
  streamedChunks: number;
  stopReason: RunStopReason;
  partial: boolean;
  notes: string[];
}

/** Subset of the `timings` object returned by llama.cpp server. */
export interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
  cache_n?: number;
  draft_n?: number;
  draft_n_accepted?: number;
}

function finitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** tokens / (ms / 1000), or undefined when inputs are not measurable. */
export function tokensPerSecond(tokens: number | undefined, ms: number | undefined): number | undefined {
  if (!finitePositive(tokens) || !finitePositive(ms)) return undefined;
  return tokens / (ms / 1000);
}

/**
 * Rates from llama.cpp runtime timings. The runtime's own `*_per_second` values
 * are authoritative: for generation llama.cpp divides by the decode steps that
 * were actually timed (the first token is sampled from the prefill logits, so
 * `predicted_n / predicted_ms` would overstate the decode speed on short runs).
 * The count/duration ratio is only a fallback for runtimes without these fields.
 */
export function ratesFromLlamaTimings(t: LlamaTimings): {
  ppTokS?: number;
  tgTokS?: number;
  promptTokens?: number;
  completionTokens?: number;
  promptMs?: number;
  generationMs?: number;
  cachedTokens?: number;
  draftTokens?: number;
  draftAccepted?: number;
} {
  return {
    ppTokS: finitePositive(t.prompt_per_second) ? t.prompt_per_second : tokensPerSecond(t.prompt_n, t.prompt_ms),
    tgTokS: finitePositive(t.predicted_per_second) ? t.predicted_per_second : tokensPerSecond(t.predicted_n, t.predicted_ms),
    promptTokens: typeof t.prompt_n === 'number' ? t.prompt_n : undefined,
    completionTokens: typeof t.predicted_n === 'number' ? t.predicted_n : undefined,
    promptMs: typeof t.prompt_ms === 'number' ? t.prompt_ms : undefined,
    generationMs: typeof t.predicted_ms === 'number' ? t.predicted_ms : undefined,
    cachedTokens: typeof t.cache_n === 'number' ? t.cache_n : undefined,
    draftTokens: typeof t.draft_n === 'number' && t.draft_n > 0 ? t.draft_n : undefined,
    draftAccepted: typeof t.draft_n === 'number' && t.draft_n > 0 && typeof t.draft_n_accepted === 'number' ? t.draft_n_accepted : undefined,
  };
}

/**
 * Client-side decode-speed estimate: the first token arrives at TTFT and closes
 * the prefill phase, so only the (n - 1) following tokens are spread over
 * [firstTokenAt, lastTokenAt].
 */
export function estimateDecodeRate(
  completionTokens: number | undefined,
  firstTokenAt: number | undefined,
  lastTokenAt: number | undefined
): number | undefined {
  if (!finitePositive(completionTokens) || completionTokens < 2) return undefined;
  if (firstTokenAt === undefined || lastTokenAt === undefined) return undefined;
  // Fast APIs deliver a short answer in a few network packets: a window of a few
  // milliseconds yields absurd rates (5 000 tok/s seen with Groq). Too short = unmeasurable.
  if (lastTokenAt - firstTokenAt < MIN_RATE_WINDOW_MS) return undefined;
  return tokensPerSecond(completionTokens - 1, lastTokenAt - firstTokenAt);
}

/** Minimum reception window for a client-side throughput estimate. */
export const MIN_RATE_WINDOW_MS = 250;

/**
 * Sliding-window rate of streamed events: events within (now - windowMs, now]
 * divided by the span they actually cover. Returns undefined below 2 events.
 */
export function rollingRate(timestamps: readonly number[], windowMs: number, now: number): number | undefined {
  let first: number | undefined;
  let count = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const ts = timestamps[i];
    if (ts > now) continue;
    if (now - ts > windowMs) break;
    first = ts;
    count++;
  }
  if (count < 2 || first === undefined) return undefined;
  const last = Math.min(now, timestamps[timestamps.length - 1]);
  return tokensPerSecond(count - 1, last - first);
}

/** Percentage of the context window used, or undefined when the limit is unknown. */
export function contextUsage(usedTokens: number | undefined, limit: number | undefined): number | undefined {
  if (!finitePositive(limit) || typeof usedTokens !== 'number' || usedTokens < 0) return undefined;
  return Math.min(100, (usedTokens / limit) * 100);
}
