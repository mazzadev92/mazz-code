import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestEvent } from '@mazz/shared';
import { ApprovalCard } from './ApprovalCard';

const deletion: ApprovalRequestEvent = {
  type: 'approval_request',
  taskId: 'task-security-test',
  timestamp: 1_798_008_000_000,
  callId: 'approval-delete-test',
  toolName: 'fs.delete',
  category: 'delete',
  params: { path: 'generated/build-output' },
  reason: 'Suppression demandée par l’agent.',
};

describe('destructive action approval UI', () => {
  it('shows the exact target and requires a per-action acknowledgement before enabling delete', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard ev={deletion} pending onAnswer={vi.fn(async () => undefined)} />,
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('Confirmation requise pour la suppression de generated/build-output');
    expect(html).toContain('Cible demandée :');
    expect(html).toContain('generated/build-output');
    expect(html).toContain('son contenu est supprimé récursivement');
    expect(html).toContain('J’ai vérifié la cible et je confirme cette suppression ponctuelle.');
    expect(html).toContain('aria-label="J’ai vérifié la cible et confirme cette suppression ponctuelle"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirmer cette suppression<\/button>/);
    expect(html).toContain('Refuser');
    expect(html).not.toContain('Pour cette session');
    expect(html).not.toContain('Toujours');
  });

  it('keeps ordinary permission approvals unchanged and does not present delete messaging', () => {
    const ordinary: ApprovalRequestEvent = {
      ...deletion,
      callId: 'approval-write-test',
      toolName: 'fs.write',
      category: 'write',
      params: { path: 'src/app.ts', content: 'example' },
    };
    const html = renderToStaticMarkup(
      <ApprovalCard ev={ordinary} pending onAnswer={vi.fn(async () => undefined)} />,
    );

    expect(html).toContain('Autorisation « write » : fs.write');
    expect(html).toContain('Autoriser une fois');
    expect(html).toContain('Pour cette session');
    expect(html).toContain('Toujours');
    expect(html).not.toContain('destructive-approval-acknowledgement');
    expect(html).not.toContain('Suppression définitive');
  });
});
