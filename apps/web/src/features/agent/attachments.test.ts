import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentMeta } from '../../lib/types';
import {
  assertAttachmentUploadsReady,
  deleteAttachment,
  fmtSize,
  validateAttachmentMeta,
  type PendingAttachment,
} from './attachments';

afterEach(() => vi.unstubAllGlobals());

const meta: AttachmentMeta = {
  id: 'att_ready01',
  name: 'spec.txt',
  sizeBytes: 12,
  kind: 'text',
  mime: 'text/plain',
  chars: 12,
  sourceSha256: 'a'.repeat(64),
  textSha256: 'b'.repeat(64),
  extractionStatus: 'complete',
  offsetUnit: 'utf16-code-unit',
};

describe('Composer attachment submission contract', () => {
  it('accepts an empty selection or attachments whose real uploads completed', () => {
    expect(() => assertAttachmentUploadsReady([])).not.toThrow();
    expect(() => assertAttachmentUploadsReady([{ key: 'ready', name: meta.name, sizeBytes: meta.sizeBytes, status: 'ready', meta }])).not.toThrow();
  });

  it('blocks task submission instead of silently dropping a failed upload', () => {
    const pending: PendingAttachment[] = [
      { key: 'ready', name: meta.name, sizeBytes: meta.sizeBytes, status: 'ready', meta },
      { key: 'failed', name: 'missing.pdf', sizeBytes: 400, status: 'error', error: 'upload failed' },
    ];
    expect(() => assertAttachmentUploadsReady(pending)).toThrow(/missing\.pdf.*Retirez-les ou joignez-les à nouveau/u);
  });

  it('blocks a pending or inconsistent upload record', () => {
    expect(() => assertAttachmentUploadsReady([{ key: 'pending', name: 'pending.txt', sizeBytes: 1, status: 'uploading' }]))
      .toThrow(/ne sont pas prêtes/u);
    expect(() => assertAttachmentUploadsReady([{ key: 'missing-meta', name: 'lost.txt', sizeBytes: 1, status: 'ready' }]))
      .toThrow(/ne sont pas prêtes/u);
    expect(() => assertAttachmentUploadsReady([{
      key: 'tampered-meta', name: meta.name, sizeBytes: meta.sizeBytes, status: 'ready', meta: { ...meta, sourceSha256: 'broken' },
    }])).toThrow(/métadonnées.*invalides/u);
  });

  it('accepts complete metadata from the attachment service at the UI boundary', () => {
    expect(validateAttachmentMeta(meta, 12)).toEqual(meta);
    expect(validateAttachmentMeta({ ...meta, chars: 0, textSha256: undefined })).toMatchObject({ chars: 0 });
  });

  it('rejects malformed metadata or source bytes that differ from the uploaded file', () => {
    expect(() => validateAttachmentMeta({ ...meta, sourceSha256: 'not-a-hash' })).toThrow(/métadonnées.*invalides/u);
    expect(() => validateAttachmentMeta({ ...meta, offsetUnit: 'bytes' })).toThrow(/métadonnées.*invalides/u);
    expect(() => validateAttachmentMeta({ ...meta, chars: 1.5 })).toThrow(/métadonnées.*invalides/u);
    expect(() => validateAttachmentMeta(meta, 13)).toThrow(/métadonnées.*invalides/u);
    expect(() => validateAttachmentMeta({ ...meta, sizeBytes: 50 * 1024 * 1024 + 1 })).toThrow(/métadonnées.*invalides/u);
  });

  it('waits for the backend deletion contract before considering an attachment removed', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"ok":true}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', request);

    await expect(deleteAttachment(meta.id)).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(`/api/attachments/${meta.id}`);
    expect(request.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('preserves the Composer attachment when backend deletion fails or is not confirmed', async () => {
    const request = vi.fn(async () => new Response('{"error":"disk unavailable"}', {
      status: 500, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', request);
    await expect(deleteAttachment(meta.id)).rejects.toThrow('disk unavailable');

    request.mockImplementationOnce(async () => new Response('{"ok":false}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(deleteAttachment(meta.id)).rejects.toThrow(/n’a pas confirmé/u);
  });

  it('rejects malformed attachment identifiers before issuing a delete request', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    await expect(deleteAttachment('../outside')).rejects.toThrow(/Identifiant.*invalide/u);
    expect(request).not.toHaveBeenCalled();
  });

  it('formats byte sizes cleanly into units', () => {
    expect(fmtSize(500)).toBe('500 o');
    expect(fmtSize(2048)).toBe('2,0 Ko');
    expect(fmtSize(10485760)).toBe('10,0 Mo');
  });
});
