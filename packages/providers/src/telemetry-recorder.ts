import {
  estimateDecodeRate,
  MIN_RATE_WINDOW_MS,
  ratesFromLlamaTimings,
  tokensPerSecond,
  type InferenceTelemetry,
  type LlamaTimings,
  type MetricSource,
  type RunStopReason,
  type UsageEvent,
} from '@mazz/shared';

/**
 * Records one streamed model call and produces an InferenceTelemetry record.
 * Priority of sources: runtime timings > provider usage > client estimate.
 */
export class TelemetryRecorder {
  private readonly startedAt = Date.now();
  private firstTokenAt?: number;
  private lastTokenAt?: number;
  private chunks = 0;
  private usage?: { promptTokens?: number; completionTokens?: number; cachedTokens?: number };
  private timings?: LlamaTimings;
  private readonly notes: string[] = [];

  constructor(
    private readonly meta: {
      providerId: string;
      modelId: string;
      locality: 'local' | 'remote';
      backend: string;
      synthetic?: boolean;
    }
  ) {}

  /** Call for every streamed output chunk (content or tool-call delta). */
  onOutputChunk(now = Date.now()): void {
    if (this.firstTokenAt === undefined) this.firstTokenAt = now;
    this.lastTokenAt = now;
    this.chunks++;
  }

  setUsage(usage: { promptTokens?: number; completionTokens?: number; cachedTokens?: number }): void {
    this.usage = { ...this.usage, ...usage };
  }

  setTimings(timings: LlamaTimings): void {
    this.timings = timings;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  finish(stopReason: RunStopReason): InferenceTelemetry {
    const endedAt = Date.now();
    const base = {
      ...this.meta,
      startedAt: this.startedAt,
      firstTokenAt: this.firstTokenAt,
      lastTokenAt: this.lastTokenAt,
      endedAt,
      ttftMs: this.firstTokenAt !== undefined ? this.firstTokenAt - this.startedAt : undefined,
      e2eMs: endedAt - this.startedAt,
      streamedChunks: this.chunks,
      stopReason,
      partial: stopReason === 'aborted' || stopReason === 'error',
      notes: [...this.notes],
    };
    delete (base as { synthetic?: boolean }).synthetic;

    if (this.meta.synthetic) {
      return {
        ...base,
        tokenSource: 'synthetic',
        speedSource: 'synthetic',
        notes: [...base.notes, 'Moteur de test déterministe : aucune mesure de performance.'],
      };
    }

    // Runtime timings are trusted only if they fit inside the wall-clock time observed here
    // (llama.cpp has been seen reporting prompt_ms in the tens of millions after a cache eviction).
    const runtimeMs = (this.timings?.prompt_ms ?? 0) + (this.timings?.predicted_ms ?? 0);
    const wallMs = endedAt - this.startedAt;
    if (this.timings && runtimeMs > wallMs * 1.2 + 500) {
      this.notes.push(
        `Timings du runtime incohérents (${Math.round(runtimeMs)} ms déclarés pour ${wallMs} ms mesurés) : ignorés.`
      );
      this.timings = undefined;
      base.notes = [...this.notes];
    }

    if (this.timings && (this.timings.predicted_n !== undefined || this.timings.prompt_n !== undefined)) {
      const r = ratesFromLlamaTimings(this.timings);
      return {
        ...base,
        ...r,
        tokenSource: 'runtime_timings',
        speedSource: 'runtime_timings',
      };
    }

    if (this.usage && (this.usage.completionTokens !== undefined || this.usage.promptTokens !== undefined)) {
      const tg = estimateDecodeRate(this.usage.completionTokens, this.firstTokenAt, this.lastTokenAt);
      return {
        ...base,
        promptTokens: this.usage.promptTokens,
        completionTokens: this.usage.completionTokens,
        cachedTokens: this.usage.cachedTokens,
        generationMs:
          this.firstTokenAt !== undefined && this.lastTokenAt !== undefined
            ? this.lastTokenAt - this.firstTokenAt
            : undefined,
        tgTokS: tg,
        tokenSource: 'provider_usage',
        speedSource: tg !== undefined ? 'client_estimate' : 'unavailable',
        notes: [
          ...base.notes,
          tg !== undefined
            ? 'Débit calculé côté client : jetons déclarés par le fournisseur / durée de réception (inclut le réseau).'
            : 'Débit non mesurable : réponse reçue en trop peu de temps ou en trop peu de fragments pour une estimation fiable.',
        ],
      };
    }

    // Neither runtime nor provider counts: only chunks are known, which are not tokens.
    const chunkRate =
      this.firstTokenAt !== undefined && this.lastTokenAt !== undefined
        && this.lastTokenAt - this.firstTokenAt >= MIN_RATE_WINDOW_MS
        ? tokensPerSecond(this.chunks - 1, this.lastTokenAt - this.firstTokenAt)
        : undefined;
    const source: MetricSource = chunkRate !== undefined ? 'client_estimate' : 'unavailable';
    return {
      ...base,
      tgTokS: chunkRate,
      tokenSource: 'unavailable',
      speedSource: source,
      notes: [
        ...base.notes,
        'Aucun compteur de jetons fourni : débit estimé en fragments de flux par seconde (un fragment peut contenir plusieurs jetons).',
      ],
    };
  }

  toUsageEvent(taskId: string, stopReason: RunStopReason): UsageEvent {
    const t = this.finish(stopReason);
    const prompt = t.promptTokens ?? 0;
    const completion = t.completionTokens ?? 0;
    return {
      type: 'usage',
      taskId,
      timestamp: t.endedAt,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
      tokensPerSecond: t.speedSource === 'runtime_timings' || t.speedSource === 'client_estimate' ? t.tgTokS : undefined,
      timeToFirstTokenMs: t.ttftMs,
      telemetry: t,
    };
  }
}

export function isAbortError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}
