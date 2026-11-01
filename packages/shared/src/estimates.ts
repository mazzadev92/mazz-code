/**
 * MAZZ ÆNGENIUM — Memory estimates for GGUF models.
 *
 * These are ESTIMATES derived from the file header, labelled as such in the UI.
 * The measured working set of llama-server is reported separately.
 */

import type { GgufMetadata } from './models.js';

const MB = 1024 * 1024;
/** Runtime buffers, compute graph and tokenizer: conservative flat allowance. */
export const RUNTIME_OVERHEAD_MB = 300;

/**
 * Bytes of KV cache per context token with an f16 cache:
 * 2 tensors (K and V) x layers x kv_heads x head_dim x 2 bytes.
 */
export function kvBytesPerToken(meta: Pick<GgufMetadata, 'blockCount' | 'headCount' | 'headCountKv' | 'embeddingLength' | 'keyLength' | 'valueLength'>): number | undefined {
  const layers = meta.blockCount;
  const heads = meta.headCount;
  const kvHeads = meta.headCountKv ?? heads;
  if (!layers || !kvHeads) return undefined;
  const keyDim = meta.keyLength ?? (meta.embeddingLength && heads ? meta.embeddingLength / heads : undefined);
  const valueDim = meta.valueLength ?? keyDim;
  if (!keyDim || !valueDim) return undefined;
  return layers * kvHeads * (keyDim + valueDim) * 2;
}

export interface RamEstimate {
  contextTokens: number;
  weightsMb: number;
  kvCacheMb?: number;
  overheadMb: number;
  totalMb: number;
  /** false when the KV cache could not be derived from the header. */
  kvKnown: boolean;
}

export function estimateRam(meta: GgufMetadata, contextTokens: number): RamEstimate {
  const weightsMb = Math.round(meta.fileSizeBytes / MB);
  const perToken = kvBytesPerToken(meta);
  const kvCacheMb = perToken !== undefined ? Math.round((perToken * contextTokens) / MB) : undefined;
  return {
    contextTokens,
    weightsMb,
    kvCacheMb,
    overheadMb: RUNTIME_OVERHEAD_MB,
    totalMb: weightsMb + (kvCacheMb ?? 0) + RUNTIME_OVERHEAD_MB,
    kvKnown: kvCacheMb !== undefined,
  };
}
