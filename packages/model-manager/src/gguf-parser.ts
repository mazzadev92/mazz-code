import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { estimateRam, type GgufMetadata } from '@mazz/shared';

// GGUF value types (ggml/docs/gguf.md)
const T_UINT8 = 0;
const T_INT8 = 1;
const T_UINT16 = 2;
const T_INT16 = 3;
const T_UINT32 = 4;
const T_INT32 = 5;
const T_FLOAT32 = 6;
const T_BOOL = 7;
const T_STRING = 8;
const T_ARRAY = 9;
const T_UINT64 = 10;
const T_INT64 = 11;
const T_FLOAT64 = 12;

const FIXED_SIZE: Record<number, number> = {
  [T_UINT8]: 1, [T_INT8]: 1, [T_BOOL]: 1,
  [T_UINT16]: 2, [T_INT16]: 2,
  [T_UINT32]: 4, [T_INT32]: 4, [T_FLOAT32]: 4,
  [T_UINT64]: 8, [T_INT64]: 8, [T_FLOAT64]: 8,
};

/** general.file_type (llama_ftype) to label. */
const FILE_TYPE_MAP: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 36: 'TQ1_0', 37: 'TQ2_0',
};

const EMBEDDING_ARCHS = new Set(['bert', 'nomic-bert', 'nomic-bert-moe', 'jina-bert-v2', 't5encoder', 'xlm-roberta', 'modern-bert']);

/** Upper bound read for metadata + tensor table; weights are never loaded. */
const MAX_HEADER_BYTES = 96 * 1024 * 1024;
const CHUNK = 1024 * 1024;

class ChunkedReader {
  private buf = Buffer.alloc(0);
  private bufStart = 0;
  pos = 0;

  constructor(private readonly handle: fs.FileHandle, private readonly fileSize: number) {}

  private async ensure(n: number): Promise<void> {
    const need = this.pos + n;
    const have = this.bufStart + this.buf.length;
    if (need <= have) return;
    if (need > this.fileSize) throw new Error('Fin de fichier atteinte dans l’en-tête GGUF (fichier tronqué).');
    if (need > MAX_HEADER_BYTES) throw new Error('En-tête GGUF supérieur à 96 Mo : lecture interrompue.');
    // Drop consumed bytes, then read at least one chunk.
    const keepFrom = this.pos - this.bufStart;
    const rest = this.buf.subarray(keepFrom);
    const toRead = Math.max(CHUNK, need - (this.pos + rest.length));
    const extra = Buffer.alloc(Math.min(toRead, this.fileSize - (this.pos + rest.length)));
    const { bytesRead } = await this.handle.read(extra, 0, extra.length, this.pos + rest.length);
    this.buf = Buffer.concat([rest, extra.subarray(0, bytesRead)]);
    this.bufStart = this.pos;
    if (this.bufStart + this.buf.length < need) throw new Error('Lecture GGUF incomplète.');
  }

  private at(): number {
    return this.pos - this.bufStart;
  }

  async u32(): Promise<number> {
    await this.ensure(4);
    const v = this.buf.readUInt32LE(this.at());
    this.pos += 4;
    return v;
  }

  async u64(): Promise<number> {
    await this.ensure(8);
    const v = this.buf.readBigUInt64LE(this.at());
    this.pos += 8;
    return Number(v);
  }

  async str(): Promise<string> {
    const len = await this.u64();
    if (len > 64 * 1024 * 1024) throw new Error('Chaîne GGUF invalide (longueur aberrante).');
    await this.ensure(len);
    const s = this.buf.toString('utf-8', this.at(), this.at() + len);
    this.pos += len;
    return s;
  }

  async skip(n: number): Promise<void> {
    await this.ensure(n);
    this.pos += n;
  }

  async scalar(type: number): Promise<number | boolean> {
    const size = FIXED_SIZE[type];
    await this.ensure(size);
    const o = this.at();
    let v: number | boolean;
    switch (type) {
      case T_UINT8: v = this.buf.readUInt8(o); break;
      case T_INT8: v = this.buf.readInt8(o); break;
      case T_BOOL: v = this.buf.readUInt8(o) !== 0; break;
      case T_UINT16: v = this.buf.readUInt16LE(o); break;
      case T_INT16: v = this.buf.readInt16LE(o); break;
      case T_UINT32: v = this.buf.readUInt32LE(o); break;
      case T_INT32: v = this.buf.readInt32LE(o); break;
      case T_FLOAT32: v = this.buf.readFloatLE(o); break;
      case T_UINT64: v = Number(this.buf.readBigUInt64LE(o)); break;
      case T_INT64: v = Number(this.buf.readBigInt64LE(o)); break;
      case T_FLOAT64: v = this.buf.readDoubleLE(o); break;
      default: throw new Error(`Type GGUF inconnu ${type}`);
    }
    this.pos += size;
    return v;
  }
}

type KvValue = number | boolean | string | { arrayLength: number; itemType: number; first?: number | string };

async function readValue(r: ChunkedReader, type: number): Promise<KvValue> {
  if (type === T_STRING) return r.str();
  if (type === T_ARRAY) {
    const itemType = await r.u32();
    const count = await r.u64();
    let first: number | string | undefined;
    if (itemType === T_STRING) {
      for (let i = 0; i < count; i++) {
        const s = await r.str();
        if (i === 0) first = s;
      }
    } else if (FIXED_SIZE[itemType] !== undefined) {
      if (count > 0 && count <= 256) {
        for (let i = 0; i < count; i++) {
          const val = await r.scalar(itemType);
          if (typeof val === 'number' && val > 0 && first === undefined) first = val;
        }
      } else {
        await r.skip(FIXED_SIZE[itemType] * count);
      }
    } else if (itemType === T_ARRAY) {
      for (let i = 0; i < count; i++) await readValue(r, T_ARRAY);
    } else {
      throw new Error(`Type d'élément de tableau GGUF inconnu ${itemType}`);
    }
    return { arrayLength: count, itemType, first };
  }
  if (FIXED_SIZE[type] === undefined) throw new Error(`Type GGUF inconnu ${type}`);
  return r.scalar(type);
}

function invalid(filePath: string, fileSizeBytes: number, error: string, architecture = 'unknown'): GgufMetadata {
  return {
    filePath,
    fileName: path.basename(filePath),
    fileSizeBytes,
    architecture,
    quantization: 'unknown',
    estimatedRamMb: 0,
    isValidGguf: false,
    error,
  };
}

/**
 * Reads the GGUF header (metadata key/values and tensor table) without loading
 * weights. Memory use is bounded by MAX_HEADER_BYTES and is typically a few MB.
 */
export async function parseGgufHeader(filePath: string): Promise<GgufMetadata> {
  let fileSizeBytes = 0;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return invalid(filePath, 0, 'Le chemin ne désigne pas un fichier.');
    fileSizeBytes = stat.size;
  } catch (err) {
    return invalid(filePath, 0, `Fichier introuvable ou inaccessible : ${(err as Error).message}`);
  }

  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const r = new ChunkedReader(handle, fileSizeBytes);

    const magicBuf = Buffer.alloc(4);
    await handle.read(magicBuf, 0, 4, 0);
    const magic = magicBuf.toString('ascii');
    if (magic !== 'GGUF') {
      return invalid(filePath, fileSizeBytes, `Signature magique invalide "${magic}", attendu "GGUF".`, 'non-gguf');
    }
    r.pos = 4;
    const version = await r.u32();
    if (version < 2 || version > 3) {
      return invalid(filePath, fileSizeBytes, `Version GGUF ${version} non prise en charge (2 ou 3 attendue).`);
    }
    const tensorCount = await r.u64();
    const kvCount = await r.u64();
    if (kvCount > 100000 || tensorCount > 1000000) {
      return invalid(filePath, fileSizeBytes, 'En-tête GGUF incohérent (compteurs aberrants).');
    }

    const kv = new Map<string, KvValue>();
    for (let i = 0; i < kvCount; i++) {
      const key = await r.str();
      const type = await r.u32();
      kv.set(key, await readValue(r, type));
    }

    // Tensor table: name, n_dims, dims[], type, offset. Elements summed for an exact parameter count.
    let parameterCount = 0;
    for (let i = 0; i < tensorCount; i++) {
      await r.str();
      const nDims = await r.u32();
      let elements = 1;
      for (let d = 0; d < nDims; d++) elements *= await r.u64();
      await r.u32();
      await r.u64();
      parameterCount += elements;
    }

    const arch = typeof kv.get('general.architecture') === 'string' ? (kv.get('general.architecture') as string) : 'unknown';
    const num = (key: string): number | undefined => {
      const v = kv.get(key);
      if (typeof v === 'number') return v;
      // Some models store per-layer head counts as arrays; take the first value.
      if (v && typeof v === 'object' && typeof v.first === 'number') return v.first;
      return undefined;
    };
    const str = (key: string): string | undefined => {
      const v = kv.get(key);
      return typeof v === 'string' ? v : undefined;
    };

    const fileType = num('general.file_type');
    let quantization = fileType !== undefined ? FILE_TYPE_MAP[fileType] || `Type ${fileType}` : '';
    if (!quantization) {
      const m = path.basename(filePath).match(/(IQ[0-9]_[A-Z0-9_]+|Q[0-9]_[K0-9_A-Z]+|BF16|F16|F32)/i);
      quantization = m ? `${m[1].toUpperCase()} (nom de fichier)` : 'inconnue';
    }

    const tokens = kv.get('tokenizer.ggml.tokens');
    const vocabSize = tokens && typeof tokens === 'object' ? tokens.arrayLength : undefined;

    const meta: GgufMetadata = {
      filePath,
      fileName: path.basename(filePath),
      fileSizeBytes,
      architecture: arch,
      quantization,
      contextLength: num(`${arch}.context_length`),
      tensorCount,
      estimatedRamMb: 0,
      isValidGguf: true,
      ggufVersion: version,
      modelName: str('general.name'),
      sizeLabel: str('general.size_label'),
      parameterCount: tensorCount > 0 ? parameterCount : undefined,
      blockCount: num(`${arch}.block_count`),
      embeddingLength: num(`${arch}.embedding_length`),
      headCount: num(`${arch}.attention.head_count`),
      headCountKv: num(`${arch}.attention.head_count_kv`),
      keyLength: num(`${arch}.attention.key_length`),
      valueLength: num(`${arch}.attention.value_length`),
      vocabSize,
      tokenizerModel: str('tokenizer.ggml.model'),
      hasChatTemplate: typeof kv.get('tokenizer.chat_template') === 'string',
      likelyEmbeddingModel: EMBEDDING_ARCHS.has(arch) || kv.has(`${arch}.pooling_type`),
      vocabOnly: tensorCount === 0,
    };

    const ctx = Math.min(meta.contextLength ?? 4096, 8192);
    meta.estimatedRamMb = estimateRam(meta, ctx).totalMb;
    if (meta.vocabOnly) {
      meta.error = 'Fichier de vocabulaire seul (aucun tenseur) : non chargeable pour l’inférence.';
    }
    return meta;
  } catch (err) {
    return invalid(filePath, fileSizeBytes, (err as Error).message);
  } finally {
    if (handle) await handle.close();
  }
}
