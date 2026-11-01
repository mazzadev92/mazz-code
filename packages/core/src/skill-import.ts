import { lookup } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';
import { assertPublicUrl, requestPinnedAddress } from './web-tools.js';
import { parseFrontMatter } from './skills.js';

/** Hard limits for untrusted skill packages. Sizes are checked before and after inflate. */
export const SKILL_IMPORT_LIMITS = {
  downloadBytes: 12 * 1024 * 1024,
  expandedBytes: 16 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  skillMarkdownBytes: 256 * 1024,
  files: 120,
  pathBytes: 512,
  redirects: 4,
  timeoutMs: 20_000,
} as const;

export interface ImportedSkillFile {
  path: string;
  bytes: Buffer;
}

export interface SkillImportBundle {
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: string;
  archiveSha256: string;
  name: string;
  description: string;
  files: ImportedSkillFile[];
}

export interface SkillImportFileInfo {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface SkillImportPreview {
  sourceUrl: string;
  finalUrl: string;
  fetchedAt: string;
  archiveSha256: string;
  downloadedBytes: number;
  name: string;
  description: string;
  files: SkillImportFileInfo[];
}

export class SkillImportError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 502 | 504, message: string) {
    super(message);
    this.name = 'SkillImportError';
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parse and enforce the public HTTPS-only URL policy before any DNS or network work. */
export function parseSkillImportUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new SkillImportError(400, 'URL invalide.'); }
  if (url.protocol !== 'https:') throw new SkillImportError(400, 'L’import de skills exige une URL HTTPS publique.');
  if (url.username || url.password) throw new SkillImportError(400, 'Les URL contenant des identifiants sont refusées.');
  if (url.port && url.port !== '443') throw new SkillImportError(400, 'Seul le port HTTPS standard 443 est accepté.');
  url.hash = '';
  return url;
}

function endpointUrl(url: URL, address: string): string {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return `${url.protocol}//${host}/`;
}

/** Validate all DNS answers, then pin the request to an answer that passes the same policy. */
async function resolvePinned(url: URL): Promise<string> {
  try {
    await assertPublicUrl(url.toString());
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const answers = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!answers.length) throw new Error(`Aucune adresse trouvée pour ${host}.`);
    for (const entry of answers) await assertPublicUrl(endpointUrl(url, entry.address));
    // DNS could have changed between the first public check and lookup. The second
    // check validates every result; using this exact answer prevents rebinding later.
    return answers[0].address;
  } catch (error) {
    if (error instanceof SkillImportError) throw error;
    const message = (error as Error)?.message || 'résolution DNS impossible';
    const denied = /locale|privée|privé|http et https|adresse/i.test(message);
    throw new SkillImportError(denied ? 403 : 502, `Destination réseau refusée ou non vérifiable : ${message}`);
  }
}

async function readLimited(response: Response): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (!Number.isSafeInteger(n) || n < 0) throw new SkillImportError(502, 'Content-Length distant invalide.');
    if (n > SKILL_IMPORT_LIMITS.downloadBytes) throw new SkillImportError(413, 'Le téléchargement dépasse la limite de 12 Mio.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new SkillImportError(422, 'La réponse ne contient aucun fichier.');
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SKILL_IMPORT_LIMITS.downloadBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SkillImportError(413, 'Le téléchargement dépasse la limite de 12 Mio.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof SkillImportError) throw error;
    throw new SkillImportError(502, `Téléchargement interrompu : ${(error as Error).message}`);
  }
  if (!size) throw new SkillImportError(422, 'Le fichier distant est vide.');
  return Buffer.concat(chunks, size);
}

async function fetchBytes(raw: string): Promise<{ finalUrl: string; bytes: Buffer }> {
  let url = parseSkillImportUrl(raw);
  const sourceUrl = url.toString();
  for (let hop = 0; hop <= SKILL_IMPORT_LIMITS.redirects; hop++) {
    const address = await resolvePinned(url);
    let response: Response;
    try {
      response = await requestPinnedAddress(url, address, {
        headers: { Accept: 'application/zip, application/octet-stream, text/markdown, text/plain;q=0.9', 'Accept-Encoding': 'identity' },
        redirect: 'manual',
        signal: AbortSignal.timeout(SKILL_IMPORT_LIMITS.timeoutMs),
      }, SKILL_IMPORT_LIMITS.timeoutMs);
    } catch (error) {
      if ((error as Error)?.name === 'TimeoutError' || /délai|timeout/i.test((error as Error)?.message || '')) {
        throw new SkillImportError(504, 'Délai maximal dépassé pendant le téléchargement du skill.');
      }
      throw new SkillImportError(502, `Connexion HTTPS impossible : ${(error as Error)?.message || 'erreur réseau'}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new SkillImportError(502, `Redirection HTTP ${response.status} sans destination.`);
      if (hop === SKILL_IMPORT_LIMITS.redirects) throw new SkillImportError(502, 'Trop de redirections HTTP.');
      try { url = parseSkillImportUrl(new URL(location, url).toString()); }
      catch (error) {
        if (error instanceof SkillImportError) throw new SkillImportError(403, `Redirection refusée : ${error.message}`);
        throw new SkillImportError(502, 'URL de redirection invalide.');
      }
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new SkillImportError(response.status === 404 ? 404 : 502, `Le serveur source a répondu HTTP ${response.status}.`);
    }
    return { finalUrl: url.toString(), bytes: await readLimited(response) };
  }
  throw new SkillImportError(502, 'Trop de redirections HTTP.');
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SkillImportError(422, `${label} n’est pas un texte UTF-8 valide.`); }
}

function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

function validateSkillDocument(markdown: Buffer): { name: string; description: string } {
  if (markdown.length > SKILL_IMPORT_LIMITS.skillMarkdownBytes) throw new SkillImportError(413, 'SKILL.md dépasse la limite de 256 Kio.');
  const text = decodeUtf8(markdown, 'SKILL.md');
  if (text.includes('\0')) throw new SkillImportError(422, 'SKILL.md contient un octet NUL.');
  const frontMatter = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  if (!frontMatter || frontMatter[0].length > 4096) throw new SkillImportError(422, 'Le front matter YAML doit se terminer dans les 4 Kio initiaux de SKILL.md.');
  const { meta, body } = parseFrontMatter(text);
  const name = meta.name?.trim() ?? '';
  const description = meta.description?.trim() ?? '';
  if (!validName(name)) throw new SkillImportError(422, 'Le front matter de SKILL.md doit déclarer un nom valide (minuscules, chiffres, tirets).');
  if (!description || description.length > 600 || /[\r\n\0]/.test(description)) throw new SkillImportError(422, 'Le front matter doit contenir une description non vide de 600 caractères maximum.');
  if (!body.trim()) throw new SkillImportError(422, 'Le corps Markdown du skill est vide.');
  return { name, description };
}

function safeArchivePath(raw: string, directory: boolean): string {
  if (!raw || raw.length > SKILL_IMPORT_LIMITS.pathBytes || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) {
    throw new SkillImportError(422, `Chemin d’archive non sûr : ${raw.slice(0, 100)}`);
  }
  const withoutTrailing = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const parts = withoutTrailing.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) throw new SkillImportError(422, `Chemin d’archive ambigu ou traversant : ${raw}`);
  for (const part of parts) {
    if (/[<>:"|?*\u0000-\u001f\u007f]/.test(part) || /[ .]$/.test(part)) throw new SkillImportError(422, `Nom de fichier interdit : ${raw}`);
    const deviceBase = part.split('.')[0]!.replace(/[ .]+$/g, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceBase)) throw new SkillImportError(422, `Nom réservé Windows refusé : ${raw}`);
    if (/^(\.git|\.hg|\.svn)$/i.test(part)) throw new SkillImportError(422, `Métadonnées de dépôt refusées : ${raw}`);
  }
  return parts.join('/').normalize('NFC');
}

interface ZipEntry {
  path: string;
  directory: boolean;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  centralOffset: number;
  externalAttributes: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipString(bytes: Buffer, flags: number, label: string): string {
  if (!(flags & 0x800) && bytes.some((b) => b > 0x7f)) throw new SkillImportError(422, `${label} n’est pas encodé en UTF-8.`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new SkillImportError(422, `${label} contient un nom UTF-8 invalide.`); }
}

function centralEntries(zip: Buffer): ZipEntry[] {
  const min = Math.max(0, zip.length - 65_557);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new SkillImportError(422, 'Archive ZIP invalide ou tronquée (EOCD absent).');
  const disk = zip.readUInt16LE(eocd + 4);
  const centralDisk = zip.readUInt16LE(eocd + 6);
  const diskCount = zip.readUInt16LE(eocd + 8);
  const totalCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (disk || centralDisk || diskCount !== totalCount) throw new SkillImportError(422, 'Les archives ZIP multi-volume ne sont pas acceptées.');
  if (totalCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new SkillImportError(422, 'Les extensions ZIP64 ne sont pas acceptées.');
  if (!totalCount || totalCount > SKILL_IMPORT_LIMITS.files || centralOffset + centralSize > eocd) throw new SkillImportError(413, `L’archive dépasse ${SKILL_IMPORT_LIMITS.files} entrées ou possède un répertoire central invalide.`);

  const entries: ZipEntry[] = [];
  const seen = new Map<string, boolean>();
  let cursor = centralOffset;
  for (let i = 0; i < totalCount; i++) {
    if (cursor + 46 > eocd || zip.readUInt32LE(cursor) !== 0x02014b50) throw new SkillImportError(422, 'En-tête ZIP central invalide.');
    const madeBy = zip.readUInt16LE(cursor + 4) >>> 8;
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const startDisk = zip.readUInt16LE(cursor + 34);
    const externalAttributes = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || startDisk !== 0) throw new SkillImportError(422, 'Entrée ZIP multi-volume ou tronquée.');
    if (!nameLength || localOffset >= centralOffset) throw new SkillImportError(422, 'Entrée ZIP sans nom ou avec offset local invalide.');
    const rawName = zipString(zip.subarray(cursor + 46, cursor + 46 + nameLength), flags, 'Nom d’entrée ZIP');
    const directory = rawName.endsWith('/');
    const name = safeArchivePath(rawName, directory);
    if (flags & (0x0001 | 0x0040)) throw new SkillImportError(422, `Entrée chiffrée refusée : ${name}`);
    if (method !== 0 && method !== 8) throw new SkillImportError(415, `Méthode de compression ZIP non prise en charge pour ${name}.`);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new SkillImportError(422, 'Entrée ZIP64 refusée.');
    if (compressedSize > SKILL_IMPORT_LIMITS.downloadBytes || size > SKILL_IMPORT_LIMITS.fileBytes || size > compressedSize * 200 + 1024) throw new SkillImportError(413, `Entrée ZIP trop volumineuse ou ratio de compression excessif : ${name}`);
    if (directory && (compressedSize !== 0 || size !== 0)) throw new SkillImportError(422, `Entrée de dossier contenant des données : ${name}`);
    const unixMode = externalAttributes >>> 16;
    const kind = unixMode & 0xf000;
    if ((externalAttributes & 0x400) !== 0 || kind === 0xa000 || (kind !== 0 && kind !== (directory ? 0x4000 : 0x8000))) {
      throw new SkillImportError(422, `Lien symbolique, point de réanalyse ou fichier spécial refusé : ${name}`);
    }
    if (madeBy !== 3 && kind !== 0 && kind !== (directory ? 0x4000 : 0x8000)) throw new SkillImportError(422, `Type d’entrée ZIP incohérent : ${name}`);
    const canonical = name.toLocaleLowerCase('en-US');
    if (seen.has(canonical)) throw new SkillImportError(422, `Collision de noms dans l’archive : ${name}`);
    seen.set(canonical, directory);
    entries.push({ path: name, directory, method, flags, crc, compressedSize, size, localOffset, centralOffset, externalAttributes });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new SkillImportError(422, 'Taille du répertoire central ZIP incohérente.');

  // Reject file/directory prefix conflicts regardless of entry order.
  for (const entry of entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/').toLocaleLowerCase('en-US');
      if (seen.get(parent) === false) throw new SkillImportError(422, `Un fichier est utilisé comme dossier dans l’archive : ${entry.path}`);
    }
    if (!entry.directory) {
      const prefix = `${entry.path}/`.toLocaleLowerCase('en-US');
      if ([...seen.keys()].some((key) => key.startsWith(prefix))) throw new SkillImportError(422, `Collision fichier/dossier dans l’archive : ${entry.path}`);
    }
  }
  return entries;
}

function unpackZip(zip: Buffer): Map<string, Buffer> {
  const entries = centralEntries(zip);
  const files = new Map<string, Buffer>();
  const dataRanges: Array<[number, number]> = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.directory) continue;
    const offset = entry.localOffset;
    if (offset + 30 > entry.centralOffset || zip.readUInt32LE(offset) !== 0x04034b50) throw new SkillImportError(422, `En-tête ZIP local invalide : ${entry.path}`);
    const flags = zip.readUInt16LE(offset + 6);
    const method = zip.readUInt16LE(offset + 8);
    const localCrc = zip.readUInt32LE(offset + 14);
    const localCompressedSize = zip.readUInt32LE(offset + 18);
    const localSize = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const localName = zipString(zip.subarray(offset + 30, offset + 30 + nameLength), flags, 'Nom local ZIP');
    if (localName !== entry.path && safeArchivePath(localName, false) !== entry.path) throw new SkillImportError(422, `Les en-têtes ZIP local et central divergent : ${entry.path}`);
    if (flags !== entry.flags || method !== entry.method) throw new SkillImportError(422, `Les indicateurs ZIP locaux divergent : ${entry.path}`);
    const dataStart = offset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart > entry.centralOffset || dataEnd > entry.centralOffset) throw new SkillImportError(422, `Données ZIP tronquées ou chevauchant le répertoire central : ${entry.path}`);
    if (!(entry.flags & 0x0008) && (localCrc !== entry.crc || localCompressedSize !== entry.compressedSize || localSize !== entry.size)) {
      throw new SkillImportError(422, `Taille ou CRC des en-têtes ZIP locaux incohérents : ${entry.path}`);
    }
    let localEnd = dataEnd;
    if (entry.flags & 0x0008) {
      const hasSignature = dataEnd + 4 <= entry.centralOffset && zip.readUInt32LE(dataEnd) === 0x08074b50;
      const descriptor = dataEnd + (hasSignature ? 4 : 0);
      if (descriptor + 12 > entry.centralOffset || zip.readUInt32LE(descriptor) !== entry.crc
        || zip.readUInt32LE(descriptor + 4) !== entry.compressedSize || zip.readUInt32LE(descriptor + 8) !== entry.size) {
        throw new SkillImportError(422, `Descripteur ZIP invalide : ${entry.path}`);
      }
      localEnd = descriptor + 12;
    }
    dataRanges.push([offset, localEnd]);
    const compressed = zip.subarray(dataStart, dataEnd);
    let contents: Buffer;
    try {
      contents = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: SKILL_IMPORT_LIMITS.fileBytes });
    } catch (error) {
      throw new SkillImportError(422, `Décompression ZIP refusée ou invalide (${entry.path}) : ${(error as Error).message}`);
    }
    if (contents.length !== entry.size || crc32(contents) !== entry.crc) throw new SkillImportError(422, `Taille ou CRC ZIP invalide : ${entry.path}`);
    total += contents.length;
    if (total > SKILL_IMPORT_LIMITS.expandedBytes) throw new SkillImportError(413, 'Le contenu décompressé dépasse la limite de 16 Mio.');
    files.set(entry.path, contents);
  }
  dataRanges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < dataRanges.length; i++) if (dataRanges[i]![0] < dataRanges[i - 1]![1]) throw new SkillImportError(422, 'Les entrées ZIP partagent des plages de données superposées.');
  return files;
}

function packageFiles(downloaded: Buffer): Map<string, Buffer> {
  const looksZip = downloaded.length >= 4 && downloaded[0] === 0x50 && downloaded[1] === 0x4b
    && (downloaded[2] === 0x03 || downloaded[2] === 0x05 || downloaded[2] === 0x07);
  if (looksZip) return unpackZip(downloaded);
  if (downloaded.length > SKILL_IMPORT_LIMITS.skillMarkdownBytes) throw new SkillImportError(415, 'La source directe doit être un SKILL.md de 256 Kio maximum ou une archive ZIP.');
  return new Map([['SKILL.md', downloaded]]);
}

function extractSingleSkill(allFiles: Map<string, Buffer>): { name: string; description: string; files: ImportedSkillFile[] } {
  const candidates = [...allFiles.keys()].filter((file) => pathBasename(file) === 'SKILL.md');
  if (candidates.length !== 1) throw new SkillImportError(422, `L’archive doit contenir exactement un SKILL.md ; ${candidates.length} trouvé(s).`);
  const skillPath = candidates[0]!;
  const prefix = skillPath.slice(0, skillPath.length - 'SKILL.md'.length);
  const source = allFiles.get(skillPath)!;
  const metadata = validateSkillDocument(source);
  const selected: ImportedSkillFile[] = [];
  for (const [fullPath, bytes] of allFiles) {
    if (!fullPath.startsWith(prefix)) continue;
    const relative = fullPath.slice(prefix.length);
    if (!relative) continue;
    if (relative.toLocaleLowerCase('en-US') === 'mazz_provenance.json') throw new SkillImportError(422, 'Le nom MAZZ_PROVENANCE.json est réservé au registre de provenance.');
    if (bytes.length > SKILL_IMPORT_LIMITS.fileBytes) throw new SkillImportError(413, `Fichier de référence trop volumineux : ${relative}`);
    if (bytes.includes(0)) throw new SkillImportError(415, `Les fichiers de référence doivent être textuels UTF-8 : ${relative}`);
    decodeUtf8(bytes, relative);
    selected.push({ path: safeArchivePath(relative, false), bytes: Buffer.from(bytes) });
  }
  if (selected.length > SKILL_IMPORT_LIMITS.files) throw new SkillImportError(413, 'Trop de fichiers de référence pour un skill.');
  if (!selected.some((f) => f.path === 'SKILL.md')) selected.push({ path: 'SKILL.md', bytes: Buffer.from(source) });
  selected.sort((a, b) => a.path.localeCompare(b.path));
  return { ...metadata, files: selected };
}

function pathBasename(value: string): string { return value.slice(value.lastIndexOf('/') + 1); }

export function toSkillImportPreview(bundle: SkillImportBundle, downloadedBytes: number): SkillImportPreview {
  return {
    sourceUrl: bundle.sourceUrl,
    finalUrl: bundle.finalUrl,
    fetchedAt: bundle.fetchedAt,
    archiveSha256: bundle.archiveSha256,
    downloadedBytes,
    name: bundle.name,
    description: bundle.description,
    files: bundle.files.map((file) => ({ path: file.path, sizeBytes: file.bytes.length, sha256: sha256Hex(file.bytes) })),
  };
}

export async function fetchSkillImport(rawUrl: string): Promise<{ bundle: SkillImportBundle; preview: SkillImportPreview }> {
  const source = parseSkillImportUrl(rawUrl).toString();
  const fetched = await fetchBytes(source);
  const bundle = parseSkillPackage(fetched.bytes, source, fetched.finalUrl);
  return { bundle, preview: toSkillImportPreview(bundle, fetched.bytes.length) };
}

/** Parse downloaded bytes without touching the network; also used by archive-security tests. */
export function parseSkillPackage(downloaded: Buffer, sourceUrl: string, finalUrl: string, fetchedAt = new Date().toISOString()): SkillImportBundle {
  const source = parseSkillImportUrl(sourceUrl).toString();
  const final = parseSkillImportUrl(finalUrl).toString();
  if (!downloaded.length || downloaded.length > SKILL_IMPORT_LIMITS.downloadBytes) throw new SkillImportError(413, 'Taille de paquet invalide.');
  const parsed = extractSingleSkill(packageFiles(downloaded));
  const bundle: SkillImportBundle = {
    sourceUrl: source,
    finalUrl: final,
    fetchedAt,
    archiveSha256: sha256Hex(downloaded),
    ...parsed,
  };
  validateImportedSkillBundle(bundle);
  return bundle;
}

export function createImportToken(): string { return randomBytes(32).toString('base64url'); }

/** Public for deterministic filesystem tests; never called with user-controlled paths in production. */
export function validateImportedSkillBundle(bundle: SkillImportBundle): void {
  if (!validName(bundle.name) || !/^[a-f0-9]{64}$/.test(bundle.archiveSha256)) throw new SkillImportError(422, 'Métadonnées d’import invalides.');
  try { parseSkillImportUrl(bundle.sourceUrl); parseSkillImportUrl(bundle.finalUrl); }
  catch (error) { throw new SkillImportError(422, `Provenance URL invalide : ${(error as Error).message}`); }
  if (!Number.isFinite(Date.parse(bundle.fetchedAt))) throw new SkillImportError(422, 'Date de récupération invalide.');
  if (bundle.files.length < 1 || bundle.files.length > SKILL_IMPORT_LIMITS.files) throw new SkillImportError(413, 'Nombre de fichiers invalide.');
  const seen = new Map<string, string>();
  let total = 0;
  let document: Buffer | undefined;
  for (const file of bundle.files) {
    const safe = safeArchivePath(file.path, false);
    const canonical = safe.toLocaleLowerCase('en-US');
    if (safe !== file.path) throw new SkillImportError(422, `Chemin de fichier non canonique : ${file.path}`);
    if (seen.has(canonical)) throw new SkillImportError(422, `Collision de fichiers : ${safe}`);
    seen.set(canonical, safe);
    if (safe.toLocaleLowerCase('en-US') === 'mazz_provenance.json') throw new SkillImportError(422, 'Le nom MAZZ_PROVENANCE.json est réservé.');
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length > SKILL_IMPORT_LIMITS.fileBytes) throw new SkillImportError(413, `Taille de fichier invalide : ${safe}`);
    total += file.bytes.length;
    if (total > SKILL_IMPORT_LIMITS.expandedBytes) throw new SkillImportError(413, 'Le skill dépasse la limite de 16 Mio décompressés.');
    if (safe === 'SKILL.md') document = file.bytes;
    else {
      if (file.bytes.includes(0)) throw new SkillImportError(415, `Le fichier de référence n’est pas du texte UTF-8 : ${safe}`);
      decodeUtf8(file.bytes, safe);
    }
  }
  if (!document) throw new SkillImportError(422, 'Le paquet ne contient pas SKILL.md à la racine du skill.');
  const metadata = validateSkillDocument(document);
  if (metadata.name !== bundle.name || metadata.description !== bundle.description) throw new SkillImportError(422, 'Les métadonnées du paquet divergent du SKILL.md.');
  for (const file of bundle.files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/').toLocaleLowerCase('en-US');
      if (seen.has(parent)) throw new SkillImportError(422, `Un fichier est utilisé comme dossier : ${file.path}`);
    }
    const prefix = `${file.path}/`.toLocaleLowerCase('en-US');
    if ([...seen.keys()].some((existing) => existing.startsWith(prefix))) throw new SkillImportError(422, `Collision fichier/dossier : ${file.path}`);
  }
}

