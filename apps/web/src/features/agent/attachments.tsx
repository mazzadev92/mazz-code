import { useState, useEffect } from 'react';
import { Eye, FileCode2, FileImage, FileText, File as FileIcon, X } from '../../components/icons';
import { api, ApiError, errorMessage } from '../../lib/api';
import type { AttachmentMeta } from '../../lib/types';
import { Button, Dialog, Spinner, cx } from '../../components/ui';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_KINDS = new Set<AttachmentMeta['kind']>(['text', 'code', 'pdf', 'docx', 'image', 'binary']);
const EXTRACTION_STATUSES = new Set<AttachmentMeta['extractionStatus']>(['complete', 'partial', 'unavailable', 'failed', 'unknown']);

export interface PendingAttachment {
  key: string;
  name: string;
  sizeBytes: number;
  status: 'uploading' | 'ready' | 'error';
  meta?: AttachmentMeta;
  error?: string;
}

/** Validate the server contract at the UI boundary before an attachment enters a turn. */
export function validateAttachmentMeta(value: unknown, expectedSizeBytes?: number): AttachmentMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Le serveur n’a pas renvoyé les métadonnées de la pièce jointe.');
  const meta = value as Partial<AttachmentMeta>;
  if (typeof meta.id !== 'string' || !/^att_[a-z0-9]+$/u.test(meta.id)
    || typeof meta.name !== 'string' || !meta.name
    || !Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes! < 0 || meta.sizeBytes! > MAX_UPLOAD_BYTES
    || (expectedSizeBytes !== undefined && meta.sizeBytes !== expectedSizeBytes)
    || typeof meta.kind !== 'string' || !ATTACHMENT_KINDS.has(meta.kind as AttachmentMeta['kind'])
    || typeof meta.mime !== 'string' || !meta.mime
    || !Number.isSafeInteger(meta.chars) || meta.chars! < 0
    || typeof meta.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(meta.sourceSha256)
    || (meta.chars! > 0 && (typeof meta.textSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(meta.textSha256)))
    || (meta.textSha256 !== undefined && !/^[0-9a-f]{64}$/iu.test(meta.textSha256))
    || typeof meta.extractionStatus !== 'string' || !EXTRACTION_STATUSES.has(meta.extractionStatus as AttachmentMeta['extractionStatus'])
    || meta.offsetUnit !== 'utf16-code-unit') {
    throw new Error('Le serveur a renvoyé des métadonnées de pièce jointe invalides ou incomplètes; la pièce n’a pas été ajoutée à la tâche.');
  }
  return meta as AttachmentMeta;
}

/** Never let a failed upload disappear when Composer builds the submitted list. */
export function assertAttachmentUploadsReady(items: readonly PendingAttachment[]): void {
  const failed = items.filter((item) => item.status === 'error');
  if (failed.length) {
    const names = failed.slice(0, 5).map((item) => item.name).join(', ');
    const extra = failed.length > 5 ? ` et ${failed.length - 5} autre(s)` : '';
    throw new Error(`Les pièces jointes suivantes n’ont pas été envoyées : ${names}${extra}. Retirez-les ou joignez-les à nouveau avant d’envoyer la tâche.`);
  }
  if (items.some((item) => item.status !== 'ready' || !item.meta)) {
    throw new Error('Une ou plusieurs pièces jointes ne sont pas prêtes. Attendez leur envoi ou retirez-les avant d’envoyer la tâche.');
  }
  for (const item of items) {
    if (!item.meta) throw new Error('Une pièce jointe prête ne contient pas ses métadonnées vérifiées.');
    validateAttachmentMeta(item.meta, item.sizeBytes);
  }
}

/** Sends the raw file to the Studio, which stores it and extracts its text. */
export async function uploadAttachment(file: File): Promise<AttachmentMeta> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('Fichier trop volumineux (50 Mo maximum).');
  const data = await api.upload<{ attachment?: AttachmentMeta; error?: string }>(
    `/api/attachments?name=${encodeURIComponent(file.name || 'fichier')}`,
    file
  );
  if (!data?.attachment) throw new ApiError(500, data?.error || 'Réponse invalide lors de l’envoi de la pièce jointe');
  return validateAttachmentMeta(data.attachment, file.size);
}

/** Confirm deletion on disk before allowing Composer to forget the attachment. */
export async function deleteAttachment(id: string): Promise<void> {
  if (!/^att_[a-z0-9]+$/u.test(id)) throw new Error('Identifiant de pièce jointe invalide.');
  const result = await api.del<{ ok?: boolean }>(`/api/attachments/${encodeURIComponent(id)}`);
  if (result?.ok !== true) throw new Error('Le serveur n’a pas confirmé la suppression de la pièce jointe.');
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} Ko`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} Mo`;
}

function KindIcon({ kind }: { kind?: AttachmentMeta['kind'] }) {
  const cls = 'w-3.5 h-3.5 shrink-0';
  if (kind === 'code') return <FileCode2 className={cx(cls, 'text-leaf')} />;
  if (kind === 'image') return <FileImage className={cx(cls, 'text-info')} />;
  if (kind === 'text' || kind === 'pdf' || kind === 'docx') return <FileText className={cx(cls, 'text-brand')} />;
  return <FileIcon className={cx(cls, 'text-faint')} />;
}

export function detail(m: AttachmentMeta): string {
  const parts = [fmtSize(m.sizeBytes)];
  if (m.pages) parts.push(`${m.pages} page(s)`);
  if (m.chars) parts.push(`${m.chars.toLocaleString('fr-FR')} caractères lus`);
  parts.push(`extraction ${m.extractionStatus}`);
  return parts.join(' · ');
}

/** Chip of an attachment, in the composer (removable) or on a sent message (link to the original). */
export function AttachmentChip({
  item,
  onRemove,
  onPreviewText,
  removeDisabled = false,
  removing = false,
}: {
  item: PendingAttachment | AttachmentMeta;
  onRemove?: () => void;
  onPreviewText?: () => void;
  removeDisabled?: boolean;
  removing?: boolean;
}) {
  const pending = 'status' in item ? item : undefined;
  const meta = pending ? pending.meta : (item as AttachmentMeta);
  const note = pending?.error ?? meta?.note;
  const title = [
    item.name,
    meta ? detail(meta) : fmtSize(item.sizeBytes),
    meta ? `SHA-256 source ${meta.sourceSha256}` : '',
    meta?.textSha256 ? `SHA-256 texte extrait ${meta.textSha256}` : '',
    note,
  ].filter(Boolean).join('\n');

  const body = (
    <>
      {pending?.status === 'uploading' ? <Spinner /> : <KindIcon kind={meta?.kind} />}
      <span className="truncate max-w-[180px]">{item.name}</span>
      <span className="text-faint">
        {pending?.status === 'uploading'
          ? 'envoi'
          : pending?.status === 'error'
          ? 'échec'
          : meta?.kind === 'image'
          ? `image ${fmtSize(item.sizeBytes)}`
          : meta?.chars
          ? fmtSize(item.sizeBytes)
          : 'sans texte'}
      </span>
    </>
  );

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-[var(--radius-sm)] border text-[11.5px] max-w-full',
        pending?.status === 'error' ? 'border-bad/50 bg-bad/5 text-bad' : note ? 'border-warn/40 bg-warn/5 text-fg' : 'border-line bg-sunk text-fg'
      )}
      title={title}
    >
      {meta && !pending ? (
        <a href={`/api/attachments/${meta.id}/raw`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:underline min-w-0">
          {body}
        </a>
      ) : (
        body
      )}
      {meta && !pending && meta.chars > 0 && onPreviewText && (
        <button
          type="button"
          aria-label={`Voir le texte extrait de ${item.name}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPreviewText();
          }}
          className="ml-0.5 px-1 py-0.5 rounded text-[10.5px] text-brand/80 hover:text-brand hover:bg-raised cursor-pointer inline-flex items-center gap-0.5"
          title="Consulter le texte extrait et ses empreintes SHA-256"
        >
          <Eye className="w-3 h-3" />
          <span>Texte</span>
        </button>
      )}
      {onRemove ? (
        <button
          type="button"
          aria-label={`Retirer ${item.name}`}
          onClick={onRemove}
          disabled={removeDisabled}
          aria-busy={removing || undefined}
          title={removeDisabled && pending?.status === 'uploading' ? 'Attendez la fin de l’envoi avant de retirer ce fichier.' : undefined}
          className="ml-0.5 w-5 h-5 grid place-items-center rounded hover:bg-raised cursor-pointer text-faint hover:text-fg disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {removing ? <Spinner /> : <X className="w-3 h-3" />}
        </button>
      ) : (
        <span className="w-1" />
      )}
    </span>
  );
}

export function AttachmentTextDialog({
  open,
  meta,
  onClose,
}: {
  open: boolean;
  meta: AttachmentMeta | null;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !meta) {
      setText('');
      setError(null);
      return;
    }
    if (meta.chars === 0) {
      setText('(Aucun texte extractible pour cette pièce jointe)');
      return;
    }
    setLoading(true);
    setError(null);
    api.get<{ text: string }>(`/api/attachments/${encodeURIComponent(meta.id)}/text?offset=0`)
      .then((res) => {
        setText(res.text);
      })
      .catch((err) => {
        setError(errorMessage(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, meta]);

  if (!open || !meta) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Texte extrait : ${meta.name}`}
      width={680}
      description={
        <div className="space-y-1 text-[11.5px] text-muted">
          <div>{detail(meta)}</div>
          <div className="font-mono text-[10.5px] break-all">Source SHA-256 : {meta.sourceSha256}</div>
          {meta.textSha256 && <div className="font-mono text-[10.5px] break-all">Texte SHA-256 : {meta.textSha256}</div>}
          {meta.sourceUrl && <div className="break-all">Source : {meta.sourceUrl}</div>}
        </div>
      }
      footer={
        <div className="flex justify-between items-center w-full">
          <a
            href={`/api/attachments/${encodeURIComponent(meta.id)}/raw`}
            target="_blank"
            rel="noreferrer"
            className="text-[12px] text-brand hover:underline"
          >
            Télécharger l’original ({fmtSize(meta.sizeBytes)})
          </a>
          <Button size="sm" variant="secondary" onClick={onClose}>
            Fermer
          </Button>
        </div>
      }
    >
      <div className="mt-3">
        {loading ? (
          <div className="flex items-center justify-center p-8 gap-2 text-muted text-[13px]">
            <Spinner />
            <span>Chargement du texte extrait…</span>
          </div>
        ) : error ? (
          <div className="p-3 text-[12px] text-bad bg-bad/5 border border-bad/20 rounded">
            {error}
          </div>
        ) : (
          <pre className="max-h-[50vh] overflow-auto p-3 bg-sunk rounded border border-line text-[11.5px] font-mono whitespace-pre-wrap break-words select-text">
            {text}
          </pre>
        )}
      </div>
    </Dialog>
  );
}
