import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldQuestion } from 'lucide-react';
import type { AgentEvent, ApprovalRequestEvent } from '@mazz/shared';
import { Badge, Button, cx } from '../../components/ui';
import { errorMessage } from '../../lib/api';
import { redactSecrets } from '../../lib/format';
import { toast, useApp } from '../../lib/store';
import { WriteReview } from './WriteReview';
import type { ApprovalScope } from '../../lib/agentRuns';

type ApprovalResult = Extract<AgentEvent, { type: 'approval_result' }>;
export type ApprovalAnswerFn = (id: string, ok: boolean, scope?: ApprovalScope, content?: string) => Promise<void>;

const SCOPE_BUTTONS: Array<{ scope: ApprovalScope; label: string; title: string }> = [
  { scope: 'once', label: 'Autoriser une fois (Entrée)', title: 'Cette action uniquement.' },
  { scope: 'session', label: 'Pour cette session', title: 'Ne plus demander pour cette catégorie (ou ce dossier) dans cette session, jusqu’à l’arrêt du Studio.' },
  { scope: 'always', label: 'Toujours (Maj+Entrée)', title: 'Enregistré dans les Paramètres : permission sur « Autoriser », ou dossier ajouté aux dossiers autorisés.' },
];

/** Renders an approval request and requires a separate, per-action acknowledgement for deletion. */
export function ApprovalCard({ ev, result, pending, onAnswer }: {
  ev: ApprovalRequestEvent;
  result?: ApprovalResult;
  pending: boolean;
  onAnswer?: ApprovalAnswerFn;
}) {
  const [busy, setBusy] = useState(false);
  const [deleteAcknowledged, setDeleteAcknowledged] = useState(false);
  // Hunk review result for a file write: undefined = proposal kept whole.
  const [reviewed, setReviewed] = useState<string | undefined>(undefined);
  const sessionId = useApp((s) => s.activeSessionId);
  const isWrite = ev.toolName === 'fs.write' && typeof ev.params.path === 'string' && typeof ev.params.content === 'string';
  const answer = async (ok: boolean, scope: ApprovalScope = 'once') => {
    if (!onAnswer || busy) return;
    setBusy(true);
    try {
      await onAnswer(ev.callId, ok, scope, ok ? reviewed : undefined);
    } catch (e) {
      toast('bad', 'Réponse non transmise', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pending || !onAnswer) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void answer(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          void answer(true, 'always');
        } else {
          void answer(true, 'once');
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [pending, onAnswer, busy]);
  const isPath = ev.category === 'path';
  const isDestructive = ev.category === 'delete';
  const params = redactSecrets(ev.params);
  const target = typeof ev.params.path === 'string' ? ev.params.path : undefined;
  const decided = result;
  const approvalLabel = isDestructive
    ? `Confirmation requise pour la suppression${target ? ` de ${target}` : ''}`
    : `Autorisation requise pour ${ev.toolName}`;

  return (
    <div role={pending ? 'alertdialog' : undefined} aria-label={pending ? approvalLabel : undefined} className={cx('rounded-[var(--radius-md)] border p-3 space-y-2', pending ? 'border-warn/50 bg-warn/5' : 'border-line bg-sunk')}>
      <div className="flex items-center gap-2 text-[12.5px]">
        {isDestructive
          ? <AlertTriangle className={cx('w-4 h-4', pending ? 'text-bad' : 'text-faint')} />
          : <ShieldQuestion className={cx('w-4 h-4', pending ? 'text-warn' : 'text-faint')} />}
        <span className="font-medium text-fg">{isDestructive
          ? 'Suppression définitive — confirmation requise'
          : isPath ? `Accès hors du projet : ${String(ev.params.path ?? '')}` : `Autorisation « ${ev.category} » : ${ev.toolName}`}</span>
        {decided && <Badge tone={decided.approved ? 'good' : 'bad'}>{decided.approved ? 'Autorisé' : decided.decidedBy === 'timeout' ? 'Expiré' : 'Refusé'}</Badge>}
      </div>

      {isDestructive && (
        <div className="rounded border border-bad/40 bg-bad/5 p-2 text-[12px] text-fg" data-testid="destructive-approval-warning">
          <div><strong>Cible demandée :</strong> <code className="font-mono break-all">{target ?? 'non précisée'}</code></div>
          <p className="mt-1 text-muted">Cette opération supprime la cible. Si elle désigne un dossier, son contenu est supprimé récursivement. Vérifiez le chemin avant de confirmer.</p>
        </div>
      )}

      {isWrite && pending ? (
        <WriteReview path={String(ev.params.path)} proposed={String(ev.params.content)} sessionId={sessionId} disabled={busy} onChange={setReviewed} />
      ) : isWrite ? (
        <div className="text-[12px] text-muted font-mono">{String(ev.params.path)}</div>
      ) : (
        <pre className="text-[11.5px] font-mono bg-code border border-line rounded p-2 overflow-auto max-h-40">{JSON.stringify(params, null, 2)}</pre>
      )}
      {pending && onAnswer && (
        <div className="flex flex-wrap gap-2">
          {isDestructive ? (
            <>
              <label className="w-full flex items-start gap-2 text-[12px] text-fg cursor-pointer">
                <input
                  type="checkbox"
                  aria-label="J’ai vérifié la cible et confirme cette suppression ponctuelle"
                  data-testid="destructive-approval-acknowledgement"
                  checked={deleteAcknowledged}
                  onChange={(event) => setDeleteAcknowledged(event.currentTarget.checked)}
                  disabled={busy}
                  className="mt-0.5 accent-red-600"
                />
                <span>J’ai vérifié la cible et je confirme cette suppression ponctuelle.</span>
              </label>
              <Button size="sm" variant="danger" disabled={busy || !deleteAcknowledged} onClick={() => void answer(true, 'once')}>
                Confirmer cette suppression
              </Button>
            </>
          ) : SCOPE_BUTTONS.map((b) => {
            const cmd = ev.category === 'terminal' && typeof ev.params.command === 'string' ? ev.params.command.trim().split(/\s+/)[0] : '';
            return (
              <Button key={b.scope} size="sm" variant={b.scope === 'once' ? 'primary' : 'secondary'} disabled={busy} title={b.title} onClick={() => void answer(true, b.scope)}>
                {b.scope === 'always' && cmd ? `Toujours pour « ${cmd} … »` : b.label}
              </Button>
            );
          })}
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void answer(false)}>
            Refuser
          </Button>
          <span className="text-[11.5px] text-faint self-center">{ev.reason}</span>
        </div>
      )}
    </div>
  );
}
