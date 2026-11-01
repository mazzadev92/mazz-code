import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';

/**
 * Local, persistent index of user-selected folders. Hybrid mode combines local
 * embeddings with BM25; explicit lexical mode stores only source passages and
 * uses BM25 without loading or calling an embedding model.
 * Vectors are normalised Float32 rows in one binary file;
 * a brute-force scan of tens of thousands of rows takes milliseconds.
 * ponytail: linear scan, switch to an ANN index (sqlite-vec, HNSW) past ~500k chunks.
 */

const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.rst', '.adoc', '.csv', '.json', '.yaml', '.yml', '.toml', '.ini', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.java', '.kt', '.go', '.rs', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.php', '.rb', '.swift', '.lua', '.gd', '.sql', '.sh', '.ps1', '.html', '.css', '.scss', '.vue', '.svelte', '.tex']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', '.cache', 'bin', 'obj']);
const MAX_FILE = 1024 * 1024;
const CHUNK = 1200;
const OVERLAP = 200;

export interface Chunk {
  file: string;
  line: number;
  text: string;
}

interface FileStamp {
  size: number;
  mtime: number;
  /** SHA-256 of the exact bytes used to produce this file's chunks. */
  contentHash: string;
  /** Indices of this file's chunks in the chunk table. */
  first: number;
  count: number;
}

interface IndexMeta {
  formatVersion?: 2 | 3;
  retrievalMode?: 'hybrid' | 'lexical';
  generation?: string;
  chunkFile?: string;
  vectorFile?: string;
  chunkSha256?: string;
  vectorSha256?: string;
  vectorBytes?: number;
  chunkCount?: number;
  complete?: boolean;
  model: string;
  dims: number;
  folders: string[];
  files: Record<string, FileStamp>;
  builtAt: number;
}

export interface IndexStatus {
  folders: string[];
  model?: string;
  retrievalMode?: 'hybrid' | 'lexical';
  files: number;
  chunks: number;
  builtAt?: number;
  building: boolean;
  progress?: { done: number; total: number; file?: string };
  error?: string;
}

/** Splits text into overlapping chunks, preferring paragraph and line boundaries. */
export function chunkText(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let pos = 0;
  let line = 1;
  let counted = 0;
  const lineAt = (p: number) => {
    for (let i = counted; i < p; i++) if (text.charCodeAt(i) === 10) line++;
    counted = p;
    return line;
  };
  while (pos < text.length) {
    let end = Math.min(text.length, pos + CHUNK);
    if (end < text.length) {
      const para = text.lastIndexOf('\n\n', end);
      const nl = text.lastIndexOf('\n', end);
      if (para > pos + CHUNK / 2) end = para;
      else if (nl > pos + CHUNK / 2) end = nl;
    }
    const piece = text.slice(pos, end).trim();
    if (piece.length > 20) out.push({ line: lineAt(pos), text: piece });
    if (end >= text.length) break;
    // The overlap starts at a line boundary so that every chunk begins on a whole line.
    const nl = text.indexOf('\n', Math.max(end - OVERLAP, pos + 1));
    pos = nl >= 0 && nl < end ? nl + 1 : end;
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) yield* walk(p);
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) yield p;
  }
}

function belongsToFolders(file: string, folders: string[]): boolean {
  const target = path.resolve(file);
  return folders.some((folder) => {
    const relative = path.relative(path.resolve(folder), target);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
}

export type EmbedFn = (texts: string[], kind: 'document' | 'query') => Promise<number[][]>;

/** Keep programming identifiers intact; also index their components for natural queries. */
function lexicalTerms(text: string): string[] {
  const full = text.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}_]+(?:[.:/\-][\p{L}\p{N}_]+)*/gu) ?? [];
  return full.flatMap((term) => [term, ...(/[.:/\-]/.test(term) ? term.split(/[.:/\-]+/).filter((part) => part.length > 1) : [])]);
}

export interface SearchHit extends Chunk {
  /** Normalised reciprocal-rank score; a ranking signal, not a confidence probability. */
  score: number;
  semanticScore?: number;
  lexicalScore?: number;
  retrieval: 'hybrid' | 'semantic' | 'lexical';
  embeddingWarning?: string;
  /** Zero is the direct query; positive values are identifier-following retrieval steps. */
  retrievalDepth?: number;
  /** Exact identifier in the source passage that led to this additional retrieval. */
  matchedAnchor?: string;
}

function normalise(v: number[]): Float32Array {
  const out = new Float32Array(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export class SemanticIndex {
  private meta: IndexMeta | null = null;
  private chunks: Chunk[] = [];
  // Persisted vectors may be backed by either an ArrayBuffer or a shared buffer
  // view loaded from a Node Buffer. Keep the field's backing type broad enough
  // for both while retaining Float32Array operations.
  private vectors: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private building = false;
  private progress?: IndexStatus['progress'];
  private lastError?: string;
  private unreadable = false;
  private stopRequested = false;
  private postings = new Map<string, Map<number, number>>();
  private lengths: number[] = [];
  private averageLength = 1;

  constructor(private readonly dir: string) {}

  private resetIndex(): void {
    this.meta = null;
    this.chunks = [];
    this.vectors = new Float32Array(0);
    this.rebuildLexical();
  }

  private async writeGenerationFile(file: string, data: string | Buffer): Promise<void> {
    await fs.writeFile(path.join(this.dir, file), data, { flag: 'wx' });
  }

  /** Derived from the existing persisted chunk table: no second database or embedding pass. */
  private rebuildLexical(): void {
    this.postings.clear();
    this.lengths = this.chunks.map((chunk, id) => {
      const body = lexicalTerms(chunk.text);
      const title = lexicalTerms(path.basename(chunk.file));
      for (const term of [...body, ...title, ...title]) {
        let rows = this.postings.get(term);
        if (!rows) this.postings.set(term, rows = new Map());
        rows.set(id, (rows.get(id) ?? 0) + 1);
      }
      return body.length + 2 * title.length;
    });
    this.averageLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length) || 1;
  }

  private lexicalScores(query: string): Map<number, number> {
    const scores = new Map<number, number>();
    for (const term of new Set(lexicalTerms(query))) {
      const rows = this.postings.get(term);
      if (!rows) continue;
      const idf = Math.log(1 + (this.chunks.length - rows.size + 0.5) / (rows.size + 0.5));
      for (const [id, tf] of rows) {
        const norm = 1.2 * (0.25 + 0.75 * this.lengths[id] / this.averageLength);
        scores.set(id, (scores.get(id) ?? 0) + idf * (tf * 2.2) / (tf + norm));
      }
    }
    return scores;
  }

  /** Stops the running build after the current file; what is done is kept. */
  stop(): void {
    this.stopRequested = true;
  }

  private async commitSnapshot(nextMeta: IndexMeta, chunks: Chunk[], vectors?: Float32Array): Promise<void> {
    const chunkData = Buffer.from(chunks.map((c) => JSON.stringify(c)).join('\n'), 'utf8');
    const vectorData = vectors
      ? Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength)
      : undefined;
    nextMeta.chunkSha256 = createHash('sha256').update(chunkData).digest('hex');
    nextMeta.chunkCount = chunks.length;
    nextMeta.vectorSha256 = vectorData ? createHash('sha256').update(vectorData).digest('hex') : undefined;
    nextMeta.vectorBytes = vectorData?.byteLength ?? 0;
    const chunkFile = nextMeta.chunkFile!;
    const vectorFile = nextMeta.vectorFile;
    const metaTemp = path.join(this.dir, `meta.${nextMeta.generation}.tmp`);
    let committed = false;
    try {
      await this.writeGenerationFile(chunkFile, chunkData);
      if (vectorFile && vectorData) await this.writeGenerationFile(vectorFile, vectorData);
      await fs.writeFile(metaTemp, JSON.stringify(nextMeta), { encoding: 'utf8', flag: 'wx' });
      // The metadata rename is the commit point. Until it succeeds, the previous
      // generation remains a complete, loadable index after a crash.
      await fs.rename(metaTemp, path.join(this.dir, 'meta.json'));
      committed = true;
      const previous = this.meta;
      this.meta = nextMeta;
      this.chunks = chunks;
      this.vectors = vectors ?? new Float32Array(0);
      this.rebuildLexical();
      this.lastError = undefined;
      this.unreadable = false;
      if (previous?.generation && previous.chunkFile) {
        await fs.rm(path.join(this.dir, previous.chunkFile), { force: true }).catch(() => undefined);
        if (previous.vectorFile) await fs.rm(path.join(this.dir, previous.vectorFile), { force: true }).catch(() => undefined);
      }
    } finally {
      await fs.rm(metaTemp, { force: true }).catch(() => undefined);
      if (!committed) {
        await fs.rm(path.join(this.dir, chunkFile), { force: true }).catch(() => undefined);
        if (vectorFile) await fs.rm(path.join(this.dir, vectorFile), { force: true }).catch(() => undefined);
      }
    }
  }

  private async save(model: string, dims: number, folders: string[], files: Record<string, FileStamp>, chunks: Chunk[], rows: Float32Array[], complete = true): Promise<void> {
    if (!Number.isInteger(dims) || dims < 1 || rows.length !== chunks.length || rows.some((row) => row.length !== dims)) {
      throw new Error('Index sémantique incohérent : nombre de vecteurs ou dimensions invalides.');
    }
    const vectors = new Float32Array(rows.length * dims);
    rows.forEach((r, i) => vectors.set(r, i * dims));
    await fs.mkdir(this.dir, { recursive: true });
    const generation = randomUUID().replace(/-/g, '');
    const chunkFile = `chunks.${generation}.jsonl`;
    const vectorFile = `vectors.${generation}.f32`;
    const nextMeta: IndexMeta = {
      formatVersion: 2,
      retrievalMode: 'hybrid',
      generation,
      chunkFile,
      vectorFile,
      complete,
      model,
      dims,
      folders,
      files,
      builtAt: Date.now(),
    };
    await this.commitSnapshot(nextMeta, chunks, vectors);
  }

  private async saveLexical(folders: string[], files: Record<string, FileStamp>, chunks: Chunk[], complete = true): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const generation = randomUUID().replace(/-/g, '');
    const nextMeta: IndexMeta = {
      formatVersion: 3,
      retrievalMode: 'lexical',
      generation,
      chunkFile: `chunks.${generation}.jsonl`,
      vectorBytes: 0,
      chunkCount: chunks.length,
      complete,
      model: 'BM25 lexical (no embeddings)',
      dims: 0,
      folders,
      files,
      builtAt: Date.now(),
    };
    await this.commitSnapshot(nextMeta, chunks);
  }

  async load(): Promise<void> {
    this.lastError = undefined;
    this.unreadable = false;
    try {
      let metaText: string;
      try {
        metaText = await fs.readFile(path.join(this.dir, 'meta.json'), 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.resetIndex();
          return;
        }
        throw err;
      }
      const parsed: unknown = JSON.parse(metaText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('métadonnées illisibles');
      const meta = parsed as IndexMeta;
      const generationV2 = meta.formatVersion === 2;
      const generationV3Lexical = meta.formatVersion === 3 && meta.retrievalMode === 'lexical';
      if (typeof meta.model !== 'string' || !meta.model || !Number.isInteger(meta.dims)
        || (generationV3Lexical ? meta.dims !== 0 : meta.dims < 1)
        || !Array.isArray(meta.folders) || !meta.folders.every((folder) => typeof folder === 'string')
        || !meta.files || typeof meta.files !== 'object' || Array.isArray(meta.files)) {
        throw new Error('schéma des métadonnées invalide');
      }
      if ((meta.formatVersion != null && meta.formatVersion !== 2 && meta.formatVersion !== 3)
        || (meta.generation != null && meta.formatVersion !== 2 && meta.formatVersion !== 3)
        || (meta.formatVersion === 3 && !generationV3Lexical)) throw new Error('version de format non prise en charge');
      if (generationV2 && (!/^[a-f0-9]{32}$/.test(meta.generation ?? '')
        || meta.chunkFile !== `chunks.${meta.generation}.jsonl`
        || meta.vectorFile !== `vectors.${meta.generation}.f32`
        || !/^[a-f0-9]{64}$/.test(meta.chunkSha256 ?? '')
        || !/^[a-f0-9]{64}$/.test(meta.vectorSha256 ?? '')
        || !Number.isSafeInteger(meta.vectorBytes) || !Number.isSafeInteger(meta.chunkCount)
        || typeof meta.complete !== 'boolean')) {
        throw new Error('métadonnées de génération invalides');
      }
      if (generationV3Lexical && (!/^[a-f0-9]{32}$/.test(meta.generation ?? '')
        || meta.chunkFile !== `chunks.${meta.generation}.jsonl`
        || meta.vectorFile != null || meta.vectorSha256 != null || meta.vectorBytes !== 0
        || !/^[a-f0-9]{64}$/.test(meta.chunkSha256 ?? '')
        || !Number.isSafeInteger(meta.chunkCount) || typeof meta.complete !== 'boolean')) {
        throw new Error('métadonnées de génération lexicale invalides');
      }
      const chunkFile = generationV2 || generationV3Lexical ? meta.chunkFile! : 'chunks.jsonl';
      const vectorFile = generationV3Lexical ? undefined : generationV2 ? meta.vectorFile! : 'vectors.f32';
      const chunkBytes = await fs.readFile(path.join(this.dir, chunkFile));
      const vectorBytes = vectorFile ? await fs.readFile(path.join(this.dir, vectorFile)) : Buffer.alloc(0);
      if ((generationV2 || generationV3Lexical) && createHash('sha256').update(chunkBytes).digest('hex') !== meta.chunkSha256) {
        throw new Error('empreinte ou taille des données persistées incorrecte');
      }
      if (generationV2 && (createHash('sha256').update(vectorBytes).digest('hex') !== meta.vectorSha256
        || vectorBytes.byteLength !== meta.vectorBytes)) throw new Error('empreinte ou taille des données vectorielles persistées incorrecte');
      if (vectorBytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) throw new Error('taille du fichier de vecteurs invalide');
      const text = chunkBytes.toString('utf8');
      const chunks: Chunk[] = text ? text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Chunk) : [];
      if (chunks.some((chunk) => !chunk || typeof chunk.file !== 'string' || !chunk.file
        || !Number.isSafeInteger(chunk.line) || chunk.line < 1 || typeof chunk.text !== 'string')) {
        throw new Error('une entrée de passage est invalide');
      }
      if ((generationV2 || generationV3Lexical) && chunks.length !== meta.chunkCount) throw new Error('nombre de passages différent des métadonnées');
      const vectorCount = vectorBytes.byteLength / Float32Array.BYTES_PER_ELEMENT;
      if (generationV3Lexical ? vectorCount !== 0 : vectorCount !== chunks.length * meta.dims) throw new Error('nombre de valeurs vectorielles différent des passages');
      for (const [file, stamp] of Object.entries(meta.files)) {
        if (!stamp || !Number.isSafeInteger(stamp.first) || !Number.isSafeInteger(stamp.count)
          || stamp.first < 0 || stamp.count < 0 || stamp.first + stamp.count > chunks.length
          || !Number.isSafeInteger(stamp.size) || stamp.size < 0 || !Number.isFinite(stamp.mtime)
          || !/^[a-f0-9]{64}$/.test(stamp.contentHash)
          || chunks.slice(stamp.first, stamp.first + stamp.count).some((chunk) => chunk.file !== file)) {
          throw new Error(`métadonnées de fichier invalides : ${file}`);
        }
      }
      const vectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, vectorCount);
      if (vectors.some((value) => !Number.isFinite(value))) throw new Error('le fichier de vecteurs contient une valeur non finie');
      this.meta = generationV3Lexical ? meta : { ...meta, retrievalMode: 'hybrid' };
      this.chunks = chunks;
      this.vectors = vectors;
      this.rebuildLexical();
      if ((generationV2 || generationV3Lexical) && meta.complete === false) {
        this.lastError = 'Indexation interrompue. Le point de reprise est enregistré sur disque ; relancez l’indexation pour traiter les autres fichiers.';
      }
    } catch (err) {
      this.resetIndex();
      this.lastError = `Index sémantique illisible (${(err as Error).message}). Réindexez les dossiers configurés.`;
      this.unreadable = true;
    }
  }

  status(folders: string[]): IndexStatus {
    return {
      folders,
      model: this.meta?.model,
      retrievalMode: this.meta?.retrievalMode,
      files: this.meta ? Object.keys(this.meta.files).length : 0,
      chunks: this.chunks.length,
      builtAt: this.meta?.builtAt,
      building: this.building,
      progress: this.progress,
      error: this.lastError,
    };
  }

  /**
   * Incremental build: a file is reused only when its size, mtime, content hash,
   * and embedding model all match. Each source file is read once per build; the
   * bytes read for hashing are also used directly if the file needs embedding.
   * New and modified files are embedded; removed ones are dropped.
   */
  async build(folders: string[], model: string, embed: EmbedFn): Promise<void> {
    if (this.building) throw new Error('Indexation déjà en cours.');
    this.building = true;
    this.stopRequested = false;
    this.lastError = undefined;
    try {
      const files: Array<{ file: string }> = [];
      for (const f of folders) {
        for await (const p of walk(f)) {
          files.push({ file: p });
        }
      }
      const sameModel = !this.meta || this.meta.model === model;
      const newChunks: Chunk[] = [];
      const rows: Float32Array[] = [];
      const newFiles: Record<string, FileStamp> = {};
      this.progress = { done: 0, total: files.length };
      let dims = this.meta?.dims ?? 0;
      let sinceSave = 0;
      let done = 0;
      const appendPreviousFile = (
        file: string,
        stamp: FileStamp,
        oldChunks: Chunk[],
        oldVectors: Float32Array,
        oldMeta: IndexMeta,
        targetChunks: Chunk[],
        targetRows: Float32Array[],
        targetFiles: Record<string, FileStamp>,
      ): void => {
        if (targetFiles[file]) return;
        const valid = Number.isSafeInteger(stamp.first) && Number.isSafeInteger(stamp.count)
          && stamp.first >= 0 && stamp.count >= 0 && stamp.first + stamp.count <= oldChunks.length
          && stamp.first + stamp.count <= oldVectors.length / oldMeta.dims;
        if (!valid) throw new Error(`Index de passages incohérent pour ${file}.`);
        const first = targetChunks.length;
        for (let i = 0; i < stamp.count; i++) {
          const chunk = oldChunks[stamp.first + i];
          if (!chunk) throw new Error(`Passage absent de l’index pour ${file}.`);
          targetChunks.push(chunk);
          targetRows.push(oldVectors.slice((stamp.first + i) * oldMeta.dims, (stamp.first + i + 1) * oldMeta.dims));
        }
        targetFiles[file] = { ...stamp, first, count: stamp.count };
      };
      const checkpoint = async (): Promise<void> => {
        if (!sameModel) return;
        const checkpointChunks = [...newChunks];
        const checkpointRows = [...rows];
        const checkpointFiles = { ...newFiles };
        if (this.meta) {
          const oldChunks = this.chunks;
          const oldVectors = this.vectors;
          const oldMeta = this.meta;
          // A checkpoint is a complete searchable snapshot. Keep not-yet-processed
          // old sources so stopping or crashing cannot turn a prefix into the corpus.
          for (const [file, stamp] of Object.entries(oldMeta.files)) {
            if (belongsToFolders(file, folders)) appendPreviousFile(file, stamp, oldChunks, oldVectors, oldMeta, checkpointChunks, checkpointRows, checkpointFiles);
          }
        }
        await this.save(model, dims, folders, checkpointFiles, checkpointChunks, checkpointRows, false);
      };
      const preserveCurrentFile = (file: string): void => {
        if (!sameModel || !this.meta || newFiles[file]) return;
        const stamp = this.meta.files[file];
        if (stamp) appendPreviousFile(file, stamp, this.chunks, this.vectors, this.meta, newChunks, rows, newFiles);
      };
      for (const entry of files) {
        if (this.stopRequested) break;
        const handle = await fs.open(entry.file, 'r').catch(() => null);
        if (!handle) {
          preserveCurrentFile(entry.file);
          done++;
          this.progress = { done, total: files.length };
          continue;
        }
        let bytes: Buffer;
        let size: number;
        let mtime: number;
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > MAX_FILE) {
            done++;
            this.progress = { done, total: files.length };
            continue;
          }
          bytes = await handle.readFile();
          const after = await handle.stat();
          // Avoid stamping bytes read during a concurrent write as if they were
          // a stable file version. A later build will pick up the settled file.
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
            preserveCurrentFile(entry.file);
            done++;
            this.progress = { done, total: files.length };
            continue;
          }
          size = after.size;
          mtime = after.mtimeMs;
        } finally {
          await handle.close();
        }
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const old = sameModel ? this.meta?.files[entry.file] : undefined;
        const oldRangeValid = !!old && Number.isInteger(old.first) && Number.isInteger(old.count)
          && old.first >= 0 && old.count >= 0 && old.first + old.count <= this.chunks.length
          && old.first + old.count <= (this.meta?.dims ? this.vectors.length / this.meta.dims : 0);
        if (oldRangeValid && old!.size === size && old!.mtime === mtime && old!.contentHash === contentHash) {
          newFiles[entry.file] = { ...old!, first: newChunks.length };
          for (let i = 0; i < old!.count; i++) {
            const chunk = this.chunks[old!.first + i];
            if (!chunk) throw new Error(`Index de chunks incohérent pour ${entry.file}.`);
            newChunks.push(chunk);
            rows.push(this.vectors.slice((old!.first + i) * this.meta!.dims, (old!.first + i + 1) * this.meta!.dims));
          }
          done++;
          this.progress = { done, total: files.length };
          continue;
        }
        // Saved every 50 files: a stopped or interrupted build resumes where it was.
        if (++sinceSave > 50 && dims && sameModel) {
          sinceSave = 0;
          await checkpoint();
        }
        this.progress = { done, total: files.length, file: entry.file };
        const text = bytes.toString('utf-8');
        const pieces = text.includes('\u0000') ? [] : chunkText(text);
        const first = newChunks.length;
        for (let i = 0; i < pieces.length; i += 16) {
          const batch = pieces.slice(i, i + 16);
          const vecs = await embed(
            batch.map((p) => `title: ${path.basename(entry.file)} | text: ${p.text}`),
            'document'
          );
          if (vecs.length !== batch.length) throw new Error(`Le service d’embeddings a retourné ${vecs.length} vecteur(s) pour ${batch.length} passage(s).`);
          vecs.forEach((v, j) => {
            if (!v.length || v.some((value) => !Number.isFinite(value)) || (dims && v.length !== dims)) {
              throw new Error(`Vecteur d’embedding invalide ou de dimension différente pour ${entry.file}.`);
            }
            dims = v.length;
            rows.push(normalise(v));
            newChunks.push({ file: entry.file, line: batch[j].line, text: batch[j].text });
          });
        }
        newFiles[entry.file] = { size, mtime, contentHash, first, count: newChunks.length - first };
        done++;
        this.progress = { done, total: files.length };
      }
      const interrupted = this.stopRequested && done < files.length;
      if (interrupted) {
        if (sameModel && dims) await checkpoint();
        else if (this.meta) this.lastError = 'Indexation interrompue pendant le changement de modèle ; la génération précédente est conservée. Relancez l’indexation pour terminer le changement.';
        else this.lastError = 'Indexation interrompue avant son premier point de sauvegarde.';
        if (sameModel && dims) this.lastError = 'Indexation interrompue. Le point de reprise est enregistré sur disque ; relancez l’indexation pour traiter les autres fichiers.';
      } else if (dims) {
        // Complete builds drop sources genuinely absent from all configured folders,
        // while normalizing reused vector rows to the new compact chunk order.
        await this.save(model, dims, folders, newFiles, newChunks, rows);
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.building = false;
      this.progress = undefined;
    }
  }

  /**
   * Build a durable BM25 index without an embedding model. This is an explicit
   * retrieval mode, not an embedding fallback: its metadata contains no vector
   * file and queries never invoke an EmbedFn.
   */
  async buildLexical(folders: string[]): Promise<void> {
    if (this.building) throw new Error('Indexation déjà en cours.');
    this.building = true;
    this.stopRequested = false;
    this.lastError = undefined;
    try {
      const files: string[] = [];
      for (const folder of folders) {
        for await (const file of walk(folder)) files.push(file);
      }
      const previousIsLexical = this.meta?.retrievalMode === 'lexical';
      const newChunks: Chunk[] = [];
      const newFiles: Record<string, FileStamp> = {};
      let done = 0;
      let sinceSave = 0;
      const errors: string[] = [];
      this.progress = { done: 0, total: files.length };

      const appendPreviousFile = (file: string): void => {
        const stamp = this.meta?.files[file];
        if (!previousIsLexical || !stamp || newFiles[file]) return;
        if (!Number.isSafeInteger(stamp.first) || !Number.isSafeInteger(stamp.count)
          || stamp.first < 0 || stamp.count < 0 || stamp.first + stamp.count > this.chunks.length
          || this.chunks.slice(stamp.first, stamp.first + stamp.count).some((chunk) => chunk.file !== file)) {
          throw new Error(`Index lexical incohérent pour ${file}.`);
        }
        const first = newChunks.length;
        for (let i = 0; i < stamp.count; i++) newChunks.push(this.chunks[stamp.first + i]!);
        newFiles[file] = { ...stamp, first, count: stamp.count };
      };

      const checkpoint = async (): Promise<void> => {
        const checkpointChunks = [...newChunks];
        const checkpointFiles = { ...newFiles };
        // Keep old, not-yet-visited sources searchable until a complete scan can
        // safely remove files that are genuinely absent from the configured roots.
        if (previousIsLexical && this.meta) {
          for (const file of Object.keys(this.meta.files)) {
            if (belongsToFolders(file, folders) && !checkpointFiles[file]) {
              const stamp = this.meta.files[file]!;
              if (!Number.isSafeInteger(stamp.first) || !Number.isSafeInteger(stamp.count)
                || stamp.first < 0 || stamp.count < 0 || stamp.first + stamp.count > this.chunks.length
                || this.chunks.slice(stamp.first, stamp.first + stamp.count).some((chunk) => chunk.file !== file)) {
                throw new Error(`Index lexical incohérent pour ${file}.`);
              }
              const first = checkpointChunks.length;
              checkpointChunks.push(...this.chunks.slice(stamp.first, stamp.first + stamp.count));
              checkpointFiles[file] = { ...stamp, first, count: stamp.count };
            }
          }
        }
        await this.saveLexical(folders, checkpointFiles, checkpointChunks, false);
      };

      for (const file of files) {
        if (this.stopRequested) break;
        const handle = await fs.open(file, 'r').catch(() => null);
        if (!handle) {
          errors.push(`lecture impossible: ${file}`);
          appendPreviousFile(file);
          done++;
          this.progress = { done, total: files.length };
          continue;
        }
        let bytes: Buffer;
        let size: number;
        let mtime: number;
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > MAX_FILE) {
            done++;
            this.progress = { done, total: files.length };
            continue;
          }
          bytes = await handle.readFile();
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
            errors.push(`fichier modifié pendant la lecture: ${file}`);
            appendPreviousFile(file);
            done++;
            this.progress = { done, total: files.length };
            continue;
          }
          size = after.size;
          mtime = after.mtimeMs;
        } finally {
          await handle.close();
        }

        const contentHash = createHash('sha256').update(bytes).digest('hex');
        const old = previousIsLexical ? this.meta?.files[file] : undefined;
        if (old && old.size === size && old.mtime === mtime && old.contentHash === contentHash) {
          appendPreviousFile(file);
          done++;
          this.progress = { done, total: files.length };
          continue;
        }
        if (++sinceSave > 50) {
          sinceSave = 0;
          await checkpoint();
        }
        this.progress = { done, total: files.length, file };
        const text = bytes.toString('utf-8');
        const pieces = text.includes('\u0000') ? [] : chunkText(text);
        const first = newChunks.length;
        for (const piece of pieces) newChunks.push({ file, line: piece.line, text: piece.text });
        newFiles[file] = { size, mtime, contentHash, first, count: newChunks.length - first };
        done++;
        this.progress = { done, total: files.length };
      }

      const interrupted = this.stopRequested && done < files.length;
      if (interrupted) {
        await checkpoint();
        this.lastError = 'Index lexical interrompu. Les passages présents sont enregistrés sur disque ; relancez la mise à jour pour terminer le scan.';
      } else {
        await this.saveLexical(folders, newFiles, newChunks, errors.length === 0);
        if (errors.length) this.lastError = `Index lexical incomplet : ${errors.length} fichier(s) n’ont pas pu être lus de façon stable. Corrigez leur accès puis relancez la mise à jour.`;
      }
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    } finally {
      this.building = false;
      this.progress = undefined;
    }
  }

  private async searchSingle(query: string, k: number, embed?: EmbedFn): Promise<SearchHit[]> {
    if (this.unreadable) throw new Error(this.lastError ?? 'Index sémantique illisible. Réindexez les dossiers configurés.');
    if (!this.meta || !this.chunks.length) throw new Error('Index sémantique vide : ajoutez des dossiers et lancez l’indexation (page Mémoire et données).');
    if (!query.trim()) return [];
    k = Number.isFinite(k) ? Math.min(30, Math.max(1, Math.floor(k))) : 6;
    const lexical = this.lexicalScores(query);
    let q: Float32Array | undefined;
    let embeddingWarning: string | undefined;
    const dims = this.meta.dims;
    const lexicalOnly = this.meta.retrievalMode === 'lexical';
    if (!lexicalOnly) {
      if (!embed) throw new Error('La recherche hybride exige le modèle d’embeddings de l’index.');
      try {
        const [qv] = await embed([`task: search result | query: ${query}`], 'query');
        if (!qv || qv.length !== dims || qv.some((x) => !Number.isFinite(x))) throw new Error('Embeddings invalides ou modèle changé : relancez l’indexation.');
        q = normalise(qv);
      } catch (err) {
        if (!lexical.size) throw err;
        embeddingWarning = (err as Error).message;
      }
    }
    const scores = new Float32Array(this.chunks.length);
    for (let i = 0; q && i < this.chunks.length; i++) {
      let s = 0;
      const off = i * dims;
      for (let d = 0; d < dims; d++) s += this.vectors[off + d] * q[d];
      scores[i] = s;
    }
    const denseOrder = [...scores.keys()].filter((i) => scores[i] > 0).sort((a, b) => scores[b] - scores[a]);
    const lexicalOrder = [...lexical.keys()].sort((a, b) => lexical.get(b)! - lexical.get(a)!);
    const fused = new Map<number, number>();
    const candidates = Math.max(60, k * 8);
    for (const ranking of [denseOrder, lexicalOrder]) ranking.slice(0, candidates).forEach((id, rank) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1));
    });
    const order = [...fused.keys()].sort((a, b) => fused.get(b)! - fused.get(a)! || (lexical.get(b) ?? 0) - (lexical.get(a) ?? 0) || a - b);
    const out: SearchHit[] = [];
    const perFile = new Map<string, number>();
    for (const i of order) {
      const c = this.chunks[i];
      // At most 2 chunks per file so one long document does not fill the results.
      if ((perFile.get(c.file) ?? 0) >= 2) continue;
      perFile.set(c.file, (perFile.get(c.file) ?? 0) + 1);
      out.push({ ...c, score: Math.round(fused.get(i)! * 30.5 * 1000) / 1000,
        semanticScore: q ? Math.round(scores[i] * 1000) / 1000 : undefined,
        lexicalScore: lexical.get(i), retrieval: lexicalOnly || !q ? 'lexical' : (lexical.has(i) ? 'hybrid' : 'semantic'),
        ...(embeddingWarning ? { embeddingWarning } : {}) });
      if (out.length >= k) break;
    }
    return out;
  }

  /**
   * Hybrid retrieval with bounded, source-grounded identifier following. A
   * follow-up query is issued only for an explicit identifier found in a
   * retrieved passage, and returned passages must contain that exact anchor.
   * This lets the real index gather linked evidence across documents without
   * claiming that the model natively attends to the whole corpus.
   */
  async search(query: string, k: number, embed?: EmbedFn): Promise<SearchHit[]> {
    k = Number.isFinite(k) ? Math.min(30, Math.max(1, Math.floor(k))) : 6;
    const initial = await this.searchSingle(query, k, embed);
    if (!initial.length || !/[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]{2,16})+/.test(query)) {
      return initial.map((hit) => ({ ...hit, retrievalDepth: 0 }));
    }
    const results: SearchHit[] = initial.map((hit) => ({ ...hit, retrievalDepth: 0 }));
    const seenChunks = new Set(results.map((hit) => `${hit.file}\0${hit.line}`));
    const seenAnchors = new Set(lexicalTerms(query));
    let frontier = initial;
    const identifier = /\b[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]{2,16})+\b/g;
    for (let depth = 1; depth <= 4 && results.length < k && frontier.length; depth++) {
      const anchors: string[] = [];
      for (const hit of frontier) {
        for (const match of hit.text.matchAll(identifier)) {
          const anchor = match[0];
          const key = anchor.toLocaleLowerCase('en');
          if (seenAnchors.has(key)) continue;
          seenAnchors.add(key);
          anchors.push(anchor);
          if (anchors.length >= 4) break;
        }
        if (anchors.length >= 4) break;
      }
      const discovered: SearchHit[] = [];
      for (const anchor of anchors) {
        if (results.length >= k) break;
        const anchorKey = anchor.toLocaleLowerCase('en');
        const candidates = await this.searchSingle(anchor, Math.min(k, 8), embed);
        for (const candidate of candidates) {
          if (!lexicalTerms(`${path.basename(candidate.file)} ${candidate.text}`).includes(anchorKey)) continue;
          const key = `${candidate.file}\0${candidate.line}`;
          if (seenChunks.has(key)) continue;
          seenChunks.add(key);
          const hit: SearchHit = {
            ...candidate,
            score: Math.round(candidate.score * (0.75 ** depth) * 1000) / 1000,
            retrievalDepth: depth,
            matchedAnchor: anchor,
          };
          results.push(hit);
          discovered.push(hit);
          if (results.length >= k) break;
        }
      }
      frontier = discovered;
    }
    return results;
  }
}

/** Agent tool: semantic search in the user's indexed folders. */
export class IndexSearchTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'index.search',
    description: 'Recherche hybride par sens et termes exacts dans les dossiers indexés ; suit aussi jusqu’à quatre niveaux de références explicites présentes dans les passages récupérés, avec chemin et ligne de chaque source.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Ce qui est cherché, en langage naturel' },
        k: { type: 'number', description: 'Nombre de passages (défaut 6)' },
      },
      required: ['query'],
    },
    requiresPermission: false,
  };

  constructor(private readonly search: (q: string, k: number) => Promise<Array<Chunk & {
    score: number;
    retrievalDepth?: number;
    matchedAnchor?: string;
    retrieval?: SearchHit['retrieval'];
  }>>) {}

  async execute(p: Record<string, unknown>, _c: ToolExecutionContext): Promise<ToolExecutionResult> {
    const t0 = Date.now();
    try {
      const k = Math.min(12, Math.max(1, Math.floor(Number(p.k ?? 6))));
      const hits = await this.search(String(p.query ?? ''), k);
      return { success: true, output: { results: hits.map((h) => ({
        path: h.file,
        line: h.line,
        score: h.score,
        text: h.text.slice(0, 900),
        retrievalDepth: h.retrievalDepth ?? 0,
        ...(h.matchedAnchor ? { matchedAnchor: h.matchedAnchor } : {}),
        retrieval: h.retrieval,
      })) }, durationMs: Date.now() - t0 };
    } catch (err) {
      return { success: false, output: null, error: (err as Error).message, durationMs: Date.now() - t0 };
    }
  }
}
