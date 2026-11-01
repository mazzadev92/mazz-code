import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttachmentMeta } from '../../lib/types';
import { AttachmentChip, AttachmentTextDialog } from './attachments';
import { TurnView } from './TurnView';

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

describe('Attachment UI components rendering', () => {
  it('renders AttachmentChip in uploading state with spinner and label', () => {
    const html = renderToStaticMarkup(
      <AttachmentChip item={{ key: 'uploading-key', name: 'document.pdf', sizeBytes: 2048, status: 'uploading' }} />,
    );
    expect(html).toContain('document.pdf');
    expect(html).toContain('envoi');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Chargement"');
  });

  it('renders AttachmentChip in error state with failure notice', () => {
    const html = renderToStaticMarkup(
      <AttachmentChip item={{ key: 'error-key', name: 'corrupted.zip', sizeBytes: 500, status: 'error', error: 'Upload timeout' }} />,
    );
    expect(html).toContain('corrupted.zip');
    expect(html).toContain('échec');
    expect(html).toContain('border-bad');
  });

  it('renders AttachmentChip in image ready state with dimensions and size', () => {
    const imageMeta: AttachmentMeta = {
      ...meta,
      id: 'att_img01',
      name: 'diagram.png',
      kind: 'image',
      mime: 'image/png',
      chars: 0,
      sizeBytes: 4096,
    };
    const html = renderToStaticMarkup(
      <AttachmentChip item={imageMeta} />,
    );
    expect(html).toContain('diagram.png');
    expect(html).toContain('image 4,0 Ko');
    expect(html).toContain('href="/api/attachments/att_img01/raw"');
  });

  it('renders AttachmentChip with text preview action button when text is available', () => {
    const html = renderToStaticMarkup(
      <AttachmentChip item={meta} onPreviewText={() => undefined} onRemove={() => undefined} />,
    );
    expect(html).toContain('spec.txt');
    expect(html).toContain('aria-label="Voir le texte extrait de spec.txt"');
    expect(html).toContain('Texte');
    expect(html).toContain('aria-label="Retirer spec.txt"');
  });

  it('renders AttachmentTextDialog with metadata digests and raw download link', () => {
    const html = renderToStaticMarkup(
      <AttachmentTextDialog open={true} meta={meta} onClose={() => undefined} />,
    );
    expect(html).toContain('Texte extrait : spec.txt');
    expect(html).toContain('Source SHA-256 :');
    expect(html).toContain(meta.sourceSha256);
    expect(html).toContain('Texte SHA-256 :');
    expect(html).toContain(meta.textSha256!);
    expect(html).toContain('Télécharger l’original');
    expect(html).toContain('href="/api/attachments/att_ready01/raw"');
  });

  it('renders TurnRecap including attachments.read pages and progress in TurnView', () => {
    const html = renderToStaticMarkup(
      <TurnView
        turn={{
          prompt: 'Analyser la spécification jointe',
          mode: 'agent',
          modelId: 'test-model',
          providerId: 'local',
          status: 'completed',
          startedAt: 1700000000000,
          attachments: [meta],
          events: [
            {
              type: 'tool_start',
              taskId: 'task_01',
              timestamp: 1700000001000,
              toolName: 'attachments.read',
              callId: 'call_read_1',
              params: { id: meta.id, offset: 0, length: 12 },
            },
            {
              type: 'tool_result',
              taskId: 'task_01',
              timestamp: 1700000002000,
              toolName: 'attachments.read',
              callId: 'call_read_1',
              success: true,
              output: { id: meta.id, name: meta.name, offset: 0, length: 12, total: 12, done: true },
              durationMs: 5,
            },
            {
              type: 'complete',
              taskId: 'task_01',
              timestamp: 1700000003000,
              success: true,
              durationMs: 2000,
              summary: 'Exécution terminée',
            },
          ],
        }}
        live={false}
        showStatus={false}
      />,
    );

    expect(html).toContain('spec.txt');
    expect(html).toContain('Bilan');
    expect(html).toContain('1 lecture(s) de pièce(s) jointe(s)');
    expect(html).toContain('12 car. lus');
    expect(html).toContain('100%');
    expect(html).toContain('complet');
  });
});
