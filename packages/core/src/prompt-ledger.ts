import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { AttachmentStore, type AttachmentMeta } from './attachments.js';
import type {
  CompiledPrompt,
  PromptRequirementCandidate,
  RequirementQualification,
} from './prompt-compiler.js';

export const PROMPT_REQUIREMENT_STATUSES = [
  'Candidate', 'Extracted', 'Needs review', 'Confirmed', 'Planned', 'In progress',
  'Implemented', 'Tested', 'Verified', 'Blocked', 'Rejected', 'Superseded',
] as const;

export type PromptRequirementStatus = typeof PROMPT_REQUIREMENT_STATUSES[number];
export type PromptLedgerEvidenceKind = 'implementation' | 'test_result' | 'verification';

export interface PromptLedgerEvidenceInput {
  kind: PromptLedgerEvidenceKind;
  /** Absolute path to a real evidence file. Bytes are hashed before the transition commits. */
  path: string;
  description: string;
}

export interface PromptLedgerEvidence extends PromptLedgerEvidenceInput {
  id: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  recordedAt: string;
  integrity: 'file_bytes_hashed';
}

export interface PromptLedgerAttachmentReference {
  attachmentId: string;
  name: string;
  kind: AttachmentMeta['kind'];
  mime: string;
  sizeBytes: number;
  sourceSha256: string;
  textSha256?: string;
  extractionStatus: AttachmentMeta['extractionStatus'];
  offsetUnit: 'utf16-code-unit';
}

export interface PromptLedgerSourceVersion {
  id: string;
  sourceId: string;
  /** Stable, one-way project identifier. The workspace path itself is never stored. */
  workspaceId?: string;
  version: number;
  attachments: PromptLedgerAttachmentReference[];
  sourceTextSha256: string;
  sourceUtf16Length: number;
  sourceLineCount: number;
  candidateCount: number;
  blocksExamined: number;
  nonCandidateBlockCount: number;
  qualificationCounts: Record<RequirementQualification, number>;
  extractionCompleteness: 'not_semantically_exhaustive';
  semanticReview: 'not_performed';
  registeredAt: string;
}

export interface PromptLedgerRequirement {
  id: string;
  sourceId: string;
  workspaceId?: string;
  sourceVersion: number;
  sourceVersionId: string;
  sourceAttachmentId: string;
  sourceAttachmentName: string;
  sourceAttachmentSha256: string;
  sourceTextSha256: string;
  sourceStart: number;
  sourceEnd: number;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceOffsetUnit: 'utf16-code-unit';
  /** Exact candidate passage from the verified attachment text. */
  text: string;
  qualification: PromptRequirementCandidate['qualification'];
  sectionIds: string[];
  sectionPath: string[];
  dependencies: PromptRequirementCandidate['dependencies'];
  references: PromptRequirementCandidate['references'];
  status: PromptRequirementStatus;
  version: number;
  evidence: PromptLedgerEvidence[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptLedgerEvent {
  id: string;
  revision: number;
  at: string;
  kind: 'registered' | 'status_transition' | 'source_attachment_added';
  requirementId?: string;
  sourceVersionId?: string;
  recordVersion?: number;
  fromStatus?: PromptRequirementStatus;
  toStatus?: PromptRequirementStatus;
  actor: string;
  evidenceIds: string[];
}

export interface PromptLedgerRegistration {
  source: PromptLedgerSourceVersion;
  requirements: PromptLedgerRequirement[];
  revision: number;
}

export interface PromptLedgerRegisterOptions {
  /** Hashed before persistence; raw path is never written to the ledger. */
  workspaceRoot?: string;
}

export interface PromptLedgerTransitionOptions {
  /** Optimistic concurrency token; stale status/evidence updates are rejected. */
  expectedVersion: number;
  /** Optional workspace guard for callers that expose transitions per session. Never persisted. */
  workspaceRoot?: string;
  evidence?: PromptLedgerEvidenceInput[];
  actor?: string;
}

export interface PromptLedgerStats {
  revision: number;
  sourceDocuments: number;
  sourceVersions: number;
  requirements: number;
  requirementsByStatus: Record<PromptRequirementStatus, number>;
  requirementsByQualification: Record<RequirementQualification, number>;
  extractionCompleteness: 'not_semantically_exhaustive';
  semanticReview: 'not_performed_by_ledger';
}

export interface PromptLedgerPageOptions {
  sourceId?: string;
  offset?: number;
  limit?: number;
}

export interface PromptLedgerPage {
  sourceId?: string;
  offset: number;
  limit: number;
  total: number;
  nextOffset: number;
  done: boolean;
  items: PromptLedgerRequirement[];
}

interface LedgerPayload {
  schemaVersion: '1.0.0';
  revision: number;
  sources: PromptLedgerSourceVersion[];
  requirements: PromptLedgerRequirement[];
  events: PromptLedgerEvent[];
}

interface PersistedLedger {
  payload: LedgerPayload;
  integrity: { algorithm: 'sha256-json-v1'; digest: string };
}

const writeQueues = new Map<string, Promise<unknown>>();
const SHA256 = /^[a-f0-9]{64}$/u;
const VALID_STATUSES = new Set<string>(PROMPT_REQUIREMENT_STATUSES);
const VALID_QUALIFICATIONS = new Set<string>(['firm', 'ambition', 'optional', 'unclear']);
const VALID_EVIDENCE_KINDS = new Set<string>(['implementation', 'test_result', 'verification']);

const ALLOWED_TRANSITIONS: Record<PromptRequirementStatus, ReadonlySet<PromptRequirementStatus>> = {
  Candidate: new Set(['Extracted', 'Needs review', 'Rejected', 'Superseded']),
  Extracted: new Set(['Needs review', 'Confirmed', 'Rejected', 'Superseded']),
  'Needs review': new Set(['Extracted', 'Confirmed', 'Rejected', 'Superseded']),
  Confirmed: new Set(['Planned', 'Needs review', 'Rejected', 'Superseded']),
  Planned: new Set(['In progress', 'Blocked', 'Needs review', 'Superseded']),
  'In progress': new Set(['Implemented', 'Blocked', 'Planned', 'Needs review', 'Superseded']),
  Implemented: new Set(['Tested', 'In progress', 'Blocked', 'Needs review', 'Superseded']),
  Tested: new Set(['Verified', 'In progress', 'Blocked', 'Needs review', 'Superseded']),
  Verified: new Set(['In progress', 'Needs review', 'Superseded']),
  Blocked: new Set(['Planned', 'In progress', 'Needs review', 'Rejected', 'Superseded']),
  Rejected: new Set(['Needs review', 'Superseded']),
  Superseded: new Set(),
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspaceIdentifier(workspaceRoot?: string): string | undefined {
  if (workspaceRoot === undefined) return undefined;
  if (!workspaceRoot.trim()) throw new TypeError('workspaceRoot ne peut pas être vide.');
  const resolved = path.resolve(workspaceRoot).normalize('NFC');
  const pathIdentity = process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  return sha256(`mazz-workspace-v1\0${pathIdentity}`).slice(0, 32);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function emptyPayload(): LedgerPayload {
  return { schemaVersion: '1.0.0', revision: 0, sources: [], requirements: [], events: [] };
}

function envelopeFor(payload: LedgerPayload): PersistedLedger {
  return {
    payload,
    integrity: { algorithm: 'sha256-json-v1', digest: sha256(JSON.stringify(payload)) },
  };
}

function integrityError(message: string, cause?: unknown): PromptLedgerIntegrityError {
  return new PromptLedgerIntegrityError(message, { cause });
}

function assertPayloadShape(value: unknown): asserts value is LedgerPayload {
  if (!isObject(value) || value.schemaVersion !== '1.0.0' || !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 0 || !Array.isArray(value.sources) || !Array.isArray(value.requirements) || !Array.isArray(value.events)) {
    throw integrityError('Le contenu du registre de prompts ne respecte pas le schéma attendu.');
  }
  const sourceVersionIds = new Set<string>();
  for (const source of value.sources) {
    if (!isObject(source) || typeof source.id !== 'string' || typeof source.sourceId !== 'string' ||
        !isSafeInteger(source.version) || source.version < 1 || !Array.isArray(source.attachments) ||
        typeof source.sourceTextSha256 !== 'string' || !SHA256.test(source.sourceTextSha256) ||
        !isSafeInteger(source.sourceUtf16Length) || source.sourceUtf16Length < 0 ||
        !isSafeInteger(source.sourceLineCount) || source.sourceLineCount < 1 ||
        source.extractionCompleteness !== 'not_semantically_exhaustive' || source.semanticReview !== 'not_performed') {
      throw integrityError('Une version source du registre est invalide.');
    }
    if (sourceVersionIds.has(source.id)) throw integrityError('Le registre contient une version source dupliquée.');
    sourceVersionIds.add(source.id);
    if (source.workspaceId !== undefined && (typeof source.workspaceId !== 'string' || !/^[a-f0-9]{32}$/u.test(source.workspaceId))) {
      throw integrityError('L’identifiant de workspace hashé est invalide.');
    }
    if (!isObject(source.qualificationCounts) || !['firm', 'ambition', 'optional', 'unclear'].every((key) => Number.isSafeInteger((source.qualificationCounts as Record<string, unknown>)[key]))) {
      throw integrityError('Les compteurs de qualification d’une source sont invalides.');
    }
    if (!isSafeInteger(source.candidateCount) || source.candidateCount < 0 ||
        !isSafeInteger(source.blocksExamined) || source.blocksExamined < source.candidateCount ||
        !isSafeInteger(source.nonCandidateBlockCount) || source.nonCandidateBlockCount !== source.blocksExamined - source.candidateCount ||
        ['firm', 'ambition', 'optional', 'unclear'].reduce((sum, key) => sum + Number((source.qualificationCounts as Record<string, unknown>)[key]), 0) !== source.candidateCount) {
      throw integrityError('Les compteurs d’extraction de la source sont incohérents.');
    }
    if (!source.attachments.length) throw integrityError('Une version source ne référence aucune pièce jointe réelle.');
    const attachmentIds = new Set<string>();
    for (const attachment of source.attachments) {
      if (!isObject(attachment) || typeof attachment.attachmentId !== 'string' || !attachment.attachmentId ||
          typeof attachment.name !== 'string' || typeof attachment.sourceSha256 !== 'string' || !SHA256.test(attachment.sourceSha256) ||
          (attachment.textSha256 !== undefined && (typeof attachment.textSha256 !== 'string' || !SHA256.test(attachment.textSha256))) ||
          attachment.offsetUnit !== 'utf16-code-unit') throw integrityError('Une référence de pièce jointe est invalide.');
      if (attachmentIds.has(attachment.attachmentId)) throw integrityError('Une pièce jointe est référencée deux fois dans la même version source.');
      attachmentIds.add(attachment.attachmentId);
    }
  }
  const requirementIds = new Set<string>();
  for (const requirement of value.requirements) {
    if (!isObject(requirement) || typeof requirement.id !== 'string' || !requirement.id ||
        !sourceVersionIds.has(String(requirement.sourceVersionId)) || typeof requirement.sourceId !== 'string' ||
        !isSafeInteger(requirement.sourceVersion) || !isSafeInteger(requirement.sourceStart) ||
        !isSafeInteger(requirement.sourceEnd) || !isSafeInteger(requirement.sourceStartLine) ||
        !isSafeInteger(requirement.sourceEndLine) || typeof requirement.text !== 'string' ||
        !VALID_STATUSES.has(String(requirement.status)) || !Number.isSafeInteger(requirement.version) ||
        (requirement.version as number) < 1 || !Array.isArray(requirement.evidence) ||
        !isObject(requirement.qualification) || !VALID_QUALIFICATIONS.has(String(requirement.qualification.category))) {
      throw integrityError('Une exigence persistée est invalide ou sans source.');
    }
    const source = value.sources.find((item) => item.id === requirement.sourceVersionId)!;
    if (requirement.sourceId !== source.sourceId || requirement.sourceVersion !== source.version ||
        requirement.sourceStart < 0 || requirement.sourceEnd <= requirement.sourceStart ||
        requirement.sourceEnd > source.sourceUtf16Length || requirement.sourceEnd - requirement.sourceStart !== requirement.text.length ||
        requirement.sourceStartLine < 1 || requirement.sourceEndLine < requirement.sourceStartLine ||
        requirement.sourceTextSha256 !== source.sourceTextSha256 || requirement.sourceOffsetUnit !== 'utf16-code-unit' ||
        !Array.isArray(requirement.sectionIds) || !Array.isArray(requirement.sectionPath) ||
        !Array.isArray(requirement.dependencies) || !Array.isArray(requirement.references)) {
      throw integrityError('Les positions ou la référence source d’une exigence sont invalides.');
    }
    if (source.workspaceId !== requirement.workspaceId ||
        !source.attachments.some((item: unknown) => isObject(item) && item.attachmentId === requirement.sourceAttachmentId && item.sourceSha256 === requirement.sourceAttachmentSha256)) {
      throw integrityError('Une exigence ne référence pas la pièce jointe exacte de sa version source.');
    }
    if (requirementIds.has(requirement.id)) throw integrityError('Le registre contient un identifiant d’exigence dupliqué.');
    requirementIds.add(requirement.id);
    for (const item of requirement.evidence) {
      if (!isObject(item) || typeof item.id !== 'string' || !VALID_EVIDENCE_KINDS.has(String(item.kind)) ||
          typeof item.path !== 'string' || !path.isAbsolute(item.path) || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256) ||
          !isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || item.integrity !== 'file_bytes_hashed') {
        throw integrityError('Une entrée de preuve persistée est invalide.');
      }
    }
  }
  for (const event of value.events) {
    if (!isObject(event) || typeof event.id !== 'string' || !isSafeInteger(event.revision) ||
        event.revision < 1 || event.revision > (value.revision as number) ||
        !['registered', 'status_transition', 'source_attachment_added'].includes(String(event.kind)) ||
        typeof event.actor !== 'string' || !Array.isArray(event.evidenceIds)) {
      throw integrityError('Un événement d’historique du registre est invalide.');
    }
    if (event.requirementId !== undefined && !requirementIds.has(String(event.requirementId))) {
      throw integrityError('Un événement référence une exigence absente du registre.');
    }
    if (event.sourceVersionId !== undefined && !sourceVersionIds.has(String(event.sourceVersionId))) {
      throw integrityError('Un événement référence une version source absente du registre.');
    }
  }
}

async function withPathQueue<T>(file: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined /* best effort: the previous write reported its own failure to its caller */).then(action);
  writeQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  }
}

export class PromptLedgerIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PromptLedgerIntegrityError';
  }
}

export class PromptLedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptLedgerConflictError';
  }
}

/**
 * Durable, source-linked requirement ledger. Every candidate remains a candidate
 * until an explicit status transition; lexical extraction is never represented
 * as semantic review or exhaustive coverage.
 */
export class PromptLedgerStore {
  private readonly file: string;

  constructor(filePath: string, private readonly attachments: AttachmentStore) {
    if (!filePath.trim()) throw new TypeError('Le chemin du registre est obligatoire.');
    this.file = path.resolve(filePath);
  }

  static workspaceId(workspaceRoot: string): string {
    const id = workspaceIdentifier(workspaceRoot);
    if (!id) throw new TypeError('Le workspace est obligatoire.');
    return id;
  }

  private async readPayload(): Promise<LedgerPayload> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyPayload();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw integrityError(`Le registre de prompts est un JSON illisible (${this.file}).`, cause);
    }
    if (!isObject(parsed) || !isObject(parsed.integrity) || parsed.integrity.algorithm !== 'sha256-json-v1' ||
        typeof parsed.integrity.digest !== 'string' || !SHA256.test(parsed.integrity.digest) || !isObject(parsed.payload)) {
      throw integrityError(`Le registre de prompts a une enveloppe ou un checksum invalide (${this.file}).`);
    }
    const payload = parsed.payload;
    const digest = sha256(JSON.stringify(payload));
    if (digest !== parsed.integrity.digest) throw integrityError(`Le checksum du registre de prompts ne correspond pas (${this.file}).`);
    assertPayloadShape(payload);
    return payload;
  }

  private async writePayload(payload: LedgerPayload): Promise<void> {
    assertPayloadShape(payload);
    const contents = JSON.stringify(envelopeFor(payload), null, 2);
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (await fs.readFile(temp, 'utf8') !== contents) throw new Error('La relecture du fichier temporaire du registre diffère des octets écrits.');
      await fs.rename(temp, this.file);
      if (await fs.readFile(this.file, 'utf8') !== contents) throw new Error('La relecture du registre publié diffère des octets validés.');
      // Read through the same integrity checks before the caller observes success.
      await this.readPayload();
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined); // best effort: cleanup of a temp/stale file
      throw error;
    }
  }

  private async attachmentReference(attachmentId: string, compiled: CompiledPrompt): Promise<PromptLedgerAttachmentReference> {
    const { meta, data } = await this.attachments.original(attachmentId);
    if (meta.id !== attachmentId || sha256(data) !== meta.sourceSha256) {
      throw new PromptLedgerIntegrityError(`Les octets originaux de la pièce jointe ${attachmentId} ne correspondent pas à son hash.`);
    }
    if (!['text', 'code', 'pdf', 'docx'].includes(meta.kind) || ['unavailable', 'failed'].includes(meta.extractionStatus)) {
      throw new PromptLedgerIntegrityError(`La pièce jointe ${attachmentId} ne possède pas de texte extrait utilisable.`);
    }
    const extracted = await this.attachments.text(attachmentId);
    const extractedHash = sha256(extracted);
    if (extracted !== compiled.sourceText || extracted.length !== meta.chars ||
        (meta.textSha256 !== undefined && meta.textSha256 !== extractedHash) || extractedHash !== compiled.sha256 ||
        compiled.source.utf16Length !== extracted.length) {
      throw new PromptLedgerIntegrityError(`Le texte compilé ne correspond pas exactement au texte extrait et vérifié de la pièce jointe ${attachmentId}.`);
    }
    return {
      attachmentId: meta.id,
      name: meta.name,
      kind: meta.kind,
      mime: meta.mime,
      sizeBytes: meta.sizeBytes,
      sourceSha256: meta.sourceSha256,
      ...(meta.textSha256 ? { textSha256: meta.textSha256 } : {}),
      extractionStatus: meta.extractionStatus,
      offsetUnit: 'utf16-code-unit',
    };
  }

  private validateCompiledPrompt(compiled: CompiledPrompt): void {
    if (!compiled || typeof compiled !== 'object' || typeof compiled.id !== 'string' || !compiled.id ||
        typeof compiled.sourceText !== 'string' || !SHA256.test(compiled.sha256) ||
        sha256(compiled.sourceText) !== compiled.sha256 || compiled.source.utf16Length !== compiled.sourceText.length ||
        compiled.analysis.sourceRetainedCompletely !== true || compiled.analysis.llmUsed !== false ||
        compiled.analysis.extractionCompleteness !== 'not_semantically_exhaustive' || !Array.isArray(compiled.candidates)) {
      throw new PromptLedgerIntegrityError('Le compilateur fourni ne conserve pas une source complète et hashée selon le schéma attendu.');
    }
    const hashPrefix = compiled.sha256.slice(0, 16);
    const seen = new Set<string>();
    for (const candidate of compiled.candidates) {
      const expectedId = `${compiled.id}:${hashPrefix}:candidate:${candidate.startOffset}-${candidate.endOffset}`;
      if (!candidate || candidate.id !== expectedId || candidate.startOffset < 0 || candidate.endOffset <= candidate.startOffset ||
          candidate.endOffset > compiled.sourceText.length || candidate.endOffset - candidate.startOffset !== candidate.text.length ||
          compiled.sourceText.slice(candidate.startOffset, candidate.endOffset) !== candidate.text ||
          candidate.qualification.method !== 'deterministic_lexical' || !VALID_QUALIFICATIONS.has(candidate.qualification.category) ||
          candidate.startLine < 1 || candidate.endLine < candidate.startLine || seen.has(candidate.id)) {
        throw new PromptLedgerIntegrityError('Un candidat ne correspond pas à un passage exact de la source compilée.');
      }
      seen.add(candidate.id);
    }
  }

  /**
   * Registers only after verifying both the original attached bytes and the
   * attachment store's extracted-text hash against the compiled prompt.
   */
  async register(
    compiled: CompiledPrompt,
    attachmentId: string,
    options: PromptLedgerRegisterOptions = {},
  ): Promise<PromptLedgerRegistration> {
    this.validateCompiledPrompt(compiled);
    const attachment = await this.attachmentReference(attachmentId, compiled);
    const workspaceId = workspaceIdentifier(options.workspaceRoot);
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      const priorVersions = payload.sources.filter((source) => source.sourceId === compiled.id);
      const sameVersion = priorVersions.find((source) => source.sourceTextSha256 === compiled.sha256);
      if (sameVersion) {
        if (workspaceId !== undefined && sameVersion.workspaceId !== undefined && sameVersion.workspaceId !== workspaceId) {
          throw new PromptLedgerConflictError('Cette source est déjà liée à un autre workspace; utilisez un sourceId distinct pour préserver les deux références.');
        }
        if (sameVersion.attachments.some((entry) => entry.attachmentId === attachmentId)) {
          return {
            source: clone(sameVersion),
            requirements: clone(payload.requirements.filter((item) => item.sourceVersionId === sameVersion.id)),
            revision: payload.revision,
          };
        }
        sameVersion.attachments.push(attachment);
        payload.revision += 1;
        const now = new Date().toISOString();
        payload.events.push({
          id: `source-attachment:${sameVersion.id}:${attachmentId}:${payload.revision}`,
          revision: payload.revision,
          at: now,
          kind: 'source_attachment_added',
          sourceVersionId: sameVersion.id,
          actor: 'system',
          evidenceIds: [],
        });
        await this.writePayload(payload);
        return {
          source: clone(sameVersion),
          requirements: clone(payload.requirements.filter((item) => item.sourceVersionId === sameVersion.id)),
          revision: payload.revision,
        };
      }

      const version = priorVersions.reduce((max, source) => Math.max(max, source.version), 0) + 1;
      const sourceVersionId = `${compiled.id}@${version}`;
      const now = new Date().toISOString();
      const source: PromptLedgerSourceVersion = {
        id: sourceVersionId,
        sourceId: compiled.id,
        ...(workspaceId ? { workspaceId } : {}),
        version,
        attachments: [attachment],
        sourceTextSha256: compiled.sha256,
        sourceUtf16Length: compiled.source.utf16Length,
        sourceLineCount: compiled.source.lineCount,
        candidateCount: compiled.analysis.candidateCount,
        blocksExamined: compiled.analysis.blocksExamined,
        nonCandidateBlockCount: compiled.analysis.nonCandidateBlockCount,
        qualificationCounts: clone(compiled.analysis.qualificationCounts),
        extractionCompleteness: 'not_semantically_exhaustive',
        semanticReview: 'not_performed',
        registeredAt: now,
      };
      if (payload.requirements.some((item) => compiled.candidates.some((candidate) => candidate.id === item.id))) {
        throw new PromptLedgerIntegrityError('Un identifiant candidat existe déjà sous une autre version source.');
      }
      payload.revision += 1;
      const revision = payload.revision;
      const newRequirements = compiled.candidates.map((candidate): PromptLedgerRequirement => ({
        id: candidate.id,
        sourceId: compiled.id,
        ...(workspaceId ? { workspaceId } : {}),
        sourceVersion: version,
        sourceVersionId,
        sourceAttachmentId: attachment.attachmentId,
        sourceAttachmentName: attachment.name,
        sourceAttachmentSha256: attachment.sourceSha256,
        sourceTextSha256: compiled.sha256,
        sourceStart: candidate.startOffset,
        sourceEnd: candidate.endOffset,
        sourceStartLine: candidate.startLine,
        sourceEndLine: candidate.endLine,
        sourceOffsetUnit: 'utf16-code-unit',
        text: candidate.text,
        qualification: clone(candidate.qualification),
        sectionIds: [...candidate.sectionIds],
        sectionPath: [...candidate.sectionPath],
        dependencies: clone(candidate.dependencies),
        references: clone(candidate.references),
        status: 'Candidate',
        version: 1,
        evidence: [],
        createdAt: now,
        updatedAt: now,
      }));
      payload.sources.push(source);
      payload.requirements.push(...newRequirements);
      for (const requirement of newRequirements) {
        payload.events.push({
          id: `registered:${requirement.id}:v1`,
          revision,
          at: now,
          kind: 'registered',
          requirementId: requirement.id,
          sourceVersionId,
          recordVersion: 1,
          toStatus: 'Candidate',
          actor: 'system',
          evidenceIds: [],
        });
      }
      await this.writePayload(payload);
      return { source: clone(source), requirements: clone(newRequirements), revision };
    });
  }

  async listRequirements(): Promise<PromptLedgerRequirement[]> {
    return withPathQueue(this.file, async () => clone((await this.readPayload()).requirements));
  }

  async listForWorkspace(workspaceRoot: string, options: PromptLedgerPageOptions = {}): Promise<PromptLedgerPage> {
    const workspaceId = PromptLedgerStore.workspaceId(workspaceRoot);
    const sourceId = options.sourceId?.trim() || undefined;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset doit être un entier positif ou nul.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('limit doit être compris entre 1 et 200.');
    return withPathQueue(this.file, async () => {
      const matches = (await this.readPayload()).requirements.filter((item) =>
        item.workspaceId === workspaceId && (sourceId === undefined || item.sourceId === sourceId));
      const items = matches.slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return { ...(sourceId ? { sourceId } : {}), offset, limit, total: matches.length, nextOffset, done: nextOffset >= matches.length, items: clone(items) };
    });
  }

  async getRequirement(id: string): Promise<PromptLedgerRequirement | undefined> {
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      const found = payload.requirements.find((item) => item.id === id);
      return found ? clone(found) : undefined;
    });
  }

  async getRequirementForWorkspace(id: string, workspaceRoot: string): Promise<PromptLedgerRequirement | undefined> {
    const workspaceId = PromptLedgerStore.workspaceId(workspaceRoot);
    return withPathQueue(this.file, async () => {
      const found = (await this.readPayload()).requirements.find((item) => item.id === id && item.workspaceId === workspaceId);
      return found ? clone(found) : undefined;
    });
  }

  async getSourceForWorkspace(sourceId: string, workspaceRoot: string): Promise<PromptLedgerSourceVersion | undefined> {
    const workspaceId = PromptLedgerStore.workspaceId(workspaceRoot);
    return withPathQueue(this.file, async () => {
      const sources = (await this.readPayload()).sources.filter((item) => item.sourceId === sourceId && item.workspaceId === workspaceId);
      const latest = sources.reduce<PromptLedgerSourceVersion | undefined>((current, item) => !current || item.version > current.version ? item : current, undefined);
      return latest ? clone(latest) : undefined;
    });
  }

  async getHistory(requirementId?: string): Promise<PromptLedgerEvent[]> {
    return withPathQueue(this.file, async () => {
      const events = (await this.readPayload()).events;
      return clone(requirementId ? events.filter((event) => event.requirementId === requirementId) : events);
    });
  }

  async transition(
    id: string,
    nextStatus: PromptRequirementStatus,
    options: PromptLedgerTransitionOptions,
  ): Promise<PromptLedgerRequirement> {
    if (!VALID_STATUSES.has(nextStatus)) throw new TypeError(`État de registre invalide : ${String(nextStatus)}`);
    if (!Number.isSafeInteger(options.expectedVersion) || options.expectedVersion < 1) {
      throw new TypeError('expectedVersion doit être un entier positif.');
    }
    const workspaceId = options.workspaceRoot === undefined ? undefined : workspaceIdentifier(options.workspaceRoot);
    const actor = options.actor?.trim() || 'user';
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      const requirement = payload.requirements.find((item) => item.id === id && (workspaceId === undefined || item.workspaceId === workspaceId));
      if (!requirement) throw new Error(`Exigence absente du registre : ${id}`);
      if (requirement.version !== options.expectedVersion) {
        throw new PromptLedgerConflictError(`Version périmée pour ${id} : attendue ${options.expectedVersion}, actuelle ${requirement.version}.`);
      }
      if (!ALLOWED_TRANSITIONS[requirement.status].has(nextStatus)) {
        throw new Error(`Transition interdite pour ${id} : ${requirement.status} → ${nextStatus}.`);
      }
      if (nextStatus === 'Tested' && !(options.evidence ?? []).some((item) => item.kind === 'test_result')) {
        throw new Error('Le statut Tested exige une preuve test_result liée à un fichier réel.');
      }
      if (nextStatus === 'Verified' && !(options.evidence ?? []).some((item) => item.kind === 'verification')) {
        throw new Error('Le statut Verified exige une preuve verification liée à un fichier réel.');
      }

      const evidence: PromptLedgerEvidence[] = [];
      for (const [index, input] of (options.evidence ?? []).entries()) {
        if (!input || !VALID_EVIDENCE_KINDS.has(input.kind) || !path.isAbsolute(input.path) || !input.description.trim()) {
          throw new Error('Chaque preuve doit préciser un type, une description et le chemin absolu d’un fichier réel.');
        }
        const absolutePath = path.resolve(input.path);
        const [stat, bytes] = await Promise.all([fs.stat(absolutePath), fs.readFile(absolutePath)]);
        if (!stat.isFile() || stat.size !== bytes.length) throw new Error(`La preuve n’est pas un fichier stable : ${absolutePath}`);
        const digest = sha256(bytes);
        evidence.push({
          id: `evidence:${id}:v${requirement.version + 1}:${index}:${digest.slice(0, 16)}`,
          kind: input.kind,
          path: absolutePath,
          description: input.description.trim(),
          sha256: digest,
          sizeBytes: bytes.length,
          recordedAt: new Date().toISOString(),
          integrity: 'file_bytes_hashed',
        });
      }

      const fromStatus = requirement.status;
      const nextVersion = requirement.version + 1;
      const now = new Date().toISOString();
      const evidenceIds = evidence.map((item) => item.id);
      requirement.status = nextStatus;
      requirement.version = nextVersion;
      requirement.evidence.push(...evidence);
      requirement.updatedAt = now;
      payload.revision += 1;
      payload.events.push({
        id: `transition:${id}:v${nextVersion}`,
        revision: payload.revision,
        at: now,
        kind: 'status_transition',
        requirementId: id,
        sourceVersionId: requirement.sourceVersionId,
        recordVersion: nextVersion,
        fromStatus,
        toStatus: nextStatus,
        actor,
        evidenceIds,
      });
      await this.writePayload(payload);
      return clone(requirement);
    });
  }

  async stats(): Promise<PromptLedgerStats> {
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      const requirementsByStatus = Object.fromEntries(PROMPT_REQUIREMENT_STATUSES.map((status) => [status, 0])) as Record<PromptRequirementStatus, number>;
      const requirementsByQualification: Record<RequirementQualification, number> = { firm: 0, ambition: 0, optional: 0, unclear: 0 };
      for (const item of payload.requirements) {
        requirementsByStatus[item.status] += 1;
        requirementsByQualification[item.qualification.category] += 1;
      }
      return {
        revision: payload.revision,
        sourceDocuments: new Set(payload.sources.map((item) => item.sourceId)).size,
        sourceVersions: payload.sources.length,
        requirements: payload.requirements.length,
        requirementsByStatus,
        requirementsByQualification,
        extractionCompleteness: 'not_semantically_exhaustive',
        semanticReview: 'not_performed_by_ledger',
      };
    });
  }

  /** Re-reads each on-disk attachment and confirms original bytes, extracted text and spans. */
  async verifySources(): Promise<{ sourcesChecked: number; requirementsChecked: number }> {
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      for (const source of payload.sources) {
        let matchedAttachment = false;
        for (const ref of source.attachments) {
          const { meta, data } = await this.attachments.original(ref.attachmentId);
          const text = await this.attachments.text(ref.attachmentId);
          if (meta.id !== ref.attachmentId || meta.sourceSha256 !== ref.sourceSha256 || sha256(data) !== ref.sourceSha256 ||
              sha256(text) !== source.sourceTextSha256 || text.length !== source.sourceUtf16Length ||
              (ref.textSha256 !== undefined && meta.textSha256 !== ref.textSha256)) {
            throw new PromptLedgerIntegrityError(`La pièce jointe liée à ${source.id} ne correspond plus aux hashes persistés.`);
          }
          matchedAttachment = true;
        }
        if (!matchedAttachment) throw new PromptLedgerIntegrityError(`La version source ${source.id} n’a plus de pièce jointe vérifiable.`);
        for (const requirement of payload.requirements.filter((item) => item.sourceVersionId === source.id)) {
          const text = await this.attachments.text(requirement.sourceAttachmentId);
          if (text.slice(requirement.sourceStart, requirement.sourceEnd) !== requirement.text) {
            throw new PromptLedgerIntegrityError(`Le passage ${requirement.id} ne correspond plus à son intervalle source.`);
          }
        }
      }
      return { sourcesChecked: payload.sources.length, requirementsChecked: payload.requirements.length };
    });
  }

  /** Re-hashes recorded evidence files; a missing or changed report fails closed. */
  async verifyEvidence(requirementId?: string): Promise<{ evidenceChecked: number }> {
    return withPathQueue(this.file, async () => {
      const payload = await this.readPayload();
      const evidence = payload.requirements
        .filter((item) => requirementId === undefined || item.id === requirementId)
        .flatMap((item) => item.evidence);
      for (const item of evidence) {
        const bytes = await fs.readFile(item.path);
        if (bytes.length !== item.sizeBytes || sha256(bytes) !== item.sha256) {
          throw new PromptLedgerIntegrityError(`Le fichier de preuve ${item.path} ne correspond plus au hash enregistré.`);
        }
      }
      return { evidenceChecked: evidence.length };
    });
  }
}

/** Workspace-scoped, bounded access to the lexical candidates from a real source attachment. */
export class PromptRequirementsReadTool implements ITool {
  readonly definition: ToolDefinition = {
    name: 'prompt.requirements.read',
    description: 'Lit par pages les exigences candidates extraites lexicalement d’un prompt joint au projet actif. La liste n’est pas exhaustive; la pièce jointe intégrale reste la source de vérité.',
    category: 'analysis',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'Identifiant de source communiqué avec la pièce jointe du prompt.' },
        offset: { type: 'number', description: 'Décalage dans la liste, à partir de 0.' },
        limit: { type: 'number', description: 'Nombre de candidats à lire, entre 1 et 200 (défaut 50).' },
      },
      required: ['sourceId'],
    },
    requiresPermission: false,
  };

  constructor(private readonly store: PromptLedgerStore) {}

  async execute(params: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const startedAt = Date.now();
    try {
      const sourceId = typeof params.sourceId === 'string' ? params.sourceId.trim() : '';
      if (!sourceId) throw new TypeError('sourceId est obligatoire.');
      const offset = params.offset === undefined ? 0 : Number(params.offset);
      const limit = params.limit === undefined ? 50 : Number(params.limit);
      const page = await this.store.listForWorkspace(context.workspaceRoot, { sourceId, offset, limit });
      return { success: true, output: page, durationMs: Date.now() - startedAt };
    } catch (error) {
      return { success: false, output: null, error: (error as Error).message, durationMs: Date.now() - startedAt };
    }
  }
}
