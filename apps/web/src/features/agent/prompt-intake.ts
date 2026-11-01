import type { AttachmentMeta } from '../../lib/types';
import { api } from '../../lib/api';
import { MAX_UPLOAD_BYTES, uploadAttachment } from './attachments';

/** /api/agent/run accepts at most 100,000 UTF-16 code units in `goal`. */
export const MAX_DIRECT_AGENT_GOAL_CHARS = 100_000;
export const MAX_AGENT_TURN_ATTACHMENTS = 50;

export function requiresDiskBackedPrompt(text: string): boolean {
  return text.length > MAX_DIRECT_AGENT_GOAL_CHARS;
}

/** Preserve the complete payload for disk-backed prompts; keep short-prompt cleanup. */
export function textForAgentSubmission(text: string): string {
  return requiresDiskBackedPrompt(text) ? text : text.trim();
}

export function createPromptFile(text: string): File {
  if (!requiresDiskBackedPrompt(text)) throw new RangeError('Le prompt tient dans la limite directe du Studio.');
  return new File([text], 'demande-utilisateur.txt', { type: 'text/plain;charset=utf-8' });
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
}

async function sha256Utf8(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('La vérification d’intégrité du prompt exige Web Crypto dans le navigateur.');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function verifyUploadedPrompt(meta: AttachmentMeta, text: string, bytes: number, expectedSha256: string): void {
  if (!/^att_[a-z0-9]+$/u.test(meta.id)
    || meta.kind !== 'text'
    || meta.extractionStatus !== 'complete'
    || meta.offsetUnit !== 'utf16-code-unit'
    || meta.chars !== text.length
    || meta.sizeBytes !== bytes
    || !isSha256(meta.sourceSha256)
    || !isSha256(meta.textSha256)
    || meta.sourceSha256.toLowerCase() !== expectedSha256
    || meta.textSha256.toLowerCase() !== expectedSha256) {
    throw new Error('Le stockage du prompt long n’a pas confirmé les octets, le texte UTF-16 et les empreintes SHA-256 exacts. Aucune tâche ne sera envoyée.');
  }
}

export interface PromptLedgerCompileReceipt {
  source: {
    id: string;
    sourceId: string;
    version: number;
    sourceTextSha256: string;
    sourceUtf16Length: number;
    sourceLineCount: number;
    attachmentId: string;
  };
  analysis: {
    method: 'deterministic_lexical';
    llmUsed: false;
    sourceRetainedCompletely: true;
    extractionCompleteness: 'not_semantically_exhaustive';
    semanticUnderstandingClaimed: false;
    blocksExamined: number;
    candidateCount: number;
    nonCandidateBlockCount: number;
    qualificationCounts: { firm: number; ambition: number; optional: number; unclear: number };
  };
  revision: number;
}

export function promptFileInstruction(meta: AttachmentMeta, ledger: PromptLedgerCompileReceipt): string {
  const integrity = meta.textSha256 ? ` SHA-256 du texte extrait : ${meta.textSha256}.` : '';
  return `Le texte intégral de la demande utilisateur est conservé dans la pièce jointe « ${meta.name} » (id=${meta.id}, ${meta.chars} caractères).${integrity} Lis-le intégralement avec attachments.read, par pages successives jusqu'à done=true, avant de planifier ou de modifier le projet. Le texte de cette pièce jointe constitue la demande utilisateur complète. Un inventaire lexical persistant est disponible sous sourceId=${ledger.source.sourceId}, version=${ledger.source.version} (${ledger.analysis.candidateCount} candidats, tous au statut Candidate) avec prompt.requirements.read et pagination. Cet inventaire est explicitement non exhaustif et ne remplace jamais la lecture ni l’interprétation du texte intégral.`;
}

export async function prepareAgentSubmission(
  text: string,
  attachments: AttachmentMeta[],
  sessionId?: string,
): Promise<{ goal: string; attachments: AttachmentMeta[]; requiredPromptAttachmentId?: string }> {
  if (!requiresDiskBackedPrompt(text)) return { goal: text, attachments };
  if (attachments.length >= MAX_AGENT_TURN_ATTACHMENTS) {
    throw new Error(`Une demande longue doit être ajoutée comme pièce jointe texte, mais cette requête contient déjà ${attachments.length} fichiers (maximum ${MAX_AGENT_TURN_ATTACHMENTS}). Retirez un fichier puis réessayez.`);
  }

  // The original UTF-8 text is uploaded to the real attachment store; it is never
  // truncated to fit the JSON goal limit. Check the bytes and both backend hashes
  // against the user's actual input before creating a ledger or submitting work.
  const file = createPromptFile(text);
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Cette demande encode ${file.size.toLocaleString('fr-FR')} octets; une pièce jointe est limitée à ${MAX_UPLOAD_BYTES.toLocaleString('fr-FR')} octets. Le prompt n’a pas été envoyé.`);
  }
  const expectedSha256 = await sha256Utf8(text);
  const meta = await uploadAttachment(file);
  verifyUploadedPrompt(meta, text, file.size, expectedSha256);
  const ledger = await api.post<PromptLedgerCompileReceipt>('/api/prompt-ledger/compile', { attachmentId: meta.id, sessionId });
  if (!ledger || !ledger.source || !ledger.analysis
    || ledger.source.attachmentId !== meta.id
    || ledger.source.sourceId !== `prompt-${meta.id}`
    || !Number.isSafeInteger(ledger.source.version) || ledger.source.version < 1
    || ledger.source.sourceTextSha256?.toLowerCase() !== expectedSha256
    || ledger.source.sourceUtf16Length !== text.length
    || !Number.isSafeInteger(ledger.source.sourceLineCount) || ledger.source.sourceLineCount < 1
    || ledger.analysis.method !== 'deterministic_lexical'
    || ledger.analysis.llmUsed !== false
    || ledger.analysis.sourceRetainedCompletely !== true
    || ledger.analysis.extractionCompleteness !== 'not_semantically_exhaustive'
    || ledger.analysis.semanticUnderstandingClaimed !== false
    || !Number.isSafeInteger(ledger.analysis.blocksExamined) || ledger.analysis.blocksExamined < 1
    || !Number.isSafeInteger(ledger.analysis.candidateCount) || ledger.analysis.candidateCount < 0
    || !Number.isSafeInteger(ledger.revision) || ledger.revision < 1) {
    throw new Error('Le registre de prompts n’a pas confirmé le texte intégral exact de la pièce jointe.');
  }
  return {
    goal: promptFileInstruction(meta, ledger),
    attachments: [...attachments, meta],
    requiredPromptAttachmentId: meta.id,
  };
}
