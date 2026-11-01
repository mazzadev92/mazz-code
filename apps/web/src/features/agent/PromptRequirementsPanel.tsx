import { useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, FileSearch, RefreshCw } from 'lucide-react';
import { api, errorMessage, qs } from '../../lib/api';
import { Badge, Button, Select } from '../../components/ui';

type Status = 'Candidate' | 'Extracted' | 'Needs review' | 'Confirmed' | 'Planned' | 'In progress' | 'Implemented' | 'Tested' | 'Verified' | 'Blocked' | 'Rejected' | 'Superseded';
type EvidenceKind = 'implementation' | 'test_result' | 'verification';

interface Requirement {
  id: string;
  sourceAttachmentName: string;
  sourceAttachmentSha256: string;
  sourceStartLine: number;
  sourceEndLine: number;
  text: string;
  qualification: { category: string; evidence?: string[] };
  status: Status;
  version: number;
  evidence: Array<{ kind: EvidenceKind; path: string; sha256: string }>;
}

interface RequirementPage {
  offset: number;
  limit: number;
  total: number;
  nextOffset: number;
  done: boolean;
  items: Requirement[];
}

export const PROMPT_STATUS_TRANSITIONS: Record<Status, Status[]> = {
  Candidate: ['Extracted', 'Needs review', 'Rejected', 'Superseded'],
  Extracted: ['Needs review', 'Confirmed', 'Rejected', 'Superseded'],
  'Needs review': ['Extracted', 'Confirmed', 'Rejected', 'Superseded'],
  Confirmed: ['Planned', 'Needs review', 'Rejected', 'Superseded'],
  Planned: ['In progress', 'Blocked', 'Needs review', 'Superseded'],
  'In progress': ['Implemented', 'Blocked', 'Planned', 'Needs review', 'Superseded'],
  Implemented: ['Tested', 'In progress', 'Blocked', 'Needs review', 'Superseded'],
  Tested: ['Verified', 'In progress', 'Blocked', 'Needs review', 'Superseded'],
  Verified: ['In progress', 'Needs review', 'Superseded'],
  Blocked: ['Planned', 'In progress', 'Needs review', 'Rejected', 'Superseded'],
  Rejected: ['Needs review', 'Superseded'],
  Superseded: [],
};

export function promptEvidenceKindFor(status: Status): EvidenceKind {
  return status === 'Tested' ? 'test_result' : status === 'Verified' ? 'verification' : 'implementation';
}

export function promptRequirementTransitionPayload(
  sessionId: string,
  item: Pick<Requirement, 'id' | 'status' | 'version'>,
  nextStatus: Status,
  evidencePath: string,
) {
  if (!PROMPT_STATUS_TRANSITIONS[item.status].includes(nextStatus)) throw new Error(`Transition UI refusée : ${item.status} → ${nextStatus}.`);
  const physicalPath = evidencePath.trim();
  if ((nextStatus === 'Tested' || nextStatus === 'Verified') && !physicalPath) {
    throw new Error(`Choisissez un fichier du workspace comme preuve pour « ${nextStatus} ».`);
  }
  const evidence = physicalPath
    ? [{ kind: promptEvidenceKindFor(nextStatus), path: physicalPath, description: `Preuve associée à ${nextStatus} depuis l’inspecteur MAZZ.` }]
    : [];
  return { sessionId, status: nextStatus, expectedVersion: item.version, actor: 'studio-ui', evidence };
}

function RequirementRow({ item, sessionId, workspaceRoot, onChanged }: { item: Requirement; sessionId: string; workspaceRoot?: string; onChanged: () => void }) {
  const [nextStatus, setNextStatus] = useState<Status | ''>('');
  const [evidencePath, setEvidencePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const possible = PROMPT_STATUS_TRANSITIONS[item.status];
  const requiresFile = nextStatus === 'Tested' || nextStatus === 'Verified';

  const chooseEvidence = async () => {
    setError('');
    try {
      const result = await api.post<{ path: string | null }>('/api/dialog/file', { filter: 'any', initial: workspaceRoot });
      if (result.path) setEvidencePath(result.path);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const apply = async () => {
    if (!nextStatus) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/api/prompt-ledger/requirements/${encodeURIComponent(item.id)}`, {
        ...promptRequirementTransitionPayload(sessionId, item, nextStatus, evidencePath),
      });
      setNextStatus('');
      setEvidencePath('');
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="rounded-md border border-line bg-sunk p-2.5 space-y-2" data-requirement-id={item.id}>
      <div className="flex items-start gap-2">
        <Badge tone={item.status === 'Verified' ? 'good' : item.status === 'Blocked' ? 'bad' : item.status === 'Candidate' ? 'warn' : 'info'}>{item.status}</Badge>
        <Badge title="Qualification lexicale, à vérifier dans la source intégrale">{item.qualification.category}</Badge>
        <span className="ml-auto text-[10.5px] text-faint tabular">v{item.version}</span>
      </div>
      <p className="text-[12px] leading-relaxed text-fg whitespace-pre-wrap break-words max-h-36 overflow-auto">{item.text}</p>
      <div className="text-[10.5px] text-faint break-all">
        {item.sourceAttachmentName} · lignes {item.sourceStartLine}–{item.sourceEndLine} · SHA-256 {item.sourceAttachmentSha256.slice(0, 12)}
      </div>
      {item.evidence.length > 0 && (
        <details className="text-[10.5px] text-faint">
          <summary className="cursor-pointer">{item.evidence.length} preuve(s) hashée(s)</summary>
          {item.evidence.map((proof) => <div key={`${proof.kind}:${proof.sha256}`} className="mt-1 break-all">{proof.kind} · {proof.path} · SHA-256 {proof.sha256}</div>)}
        </details>
      )}
      {possible.length > 0 && (
        <div className="border-t border-line pt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <Select aria-label={`Nouveau statut pour ${item.id}`} value={nextStatus} onChange={(event) => { setNextStatus(event.target.value as Status | ''); setError(''); }} className="min-w-0 flex-1">
              <option value="">Changer le statut…</option>
              {possible.map((status) => <option key={status} value={status}>{status}</option>)}
            </Select>
            <Button size="xs" variant="primary" icon={<Check className="w-3 h-3" />} loading={busy} disabled={!nextStatus} onClick={() => void apply()}>
              Appliquer
            </Button>
          </div>
          {!!nextStatus && (
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  aria-label={`Fichier de preuve pour ${item.id}`}
                  value={evidencePath}
                  onChange={(event) => setEvidencePath(event.target.value)}
                  placeholder="Chemin absolu d’un fichier du workspace"
                  className="h-7 min-w-0 flex-1 px-2 rounded border border-line bg-panel text-[11px] text-fg font-mono"
                />
                <Button size="xs" icon={<FileSearch className="w-3 h-3" />} onClick={() => void chooseEvidence()}>Parcourir</Button>
              </div>
              <p className="text-[10.5px] text-faint">
                {requiresFile ? 'Un fichier existant du workspace sera relu et hashé par le serveur avant la transition.' : 'Une preuve est facultative ici; toute preuve fournie doit être un fichier existant du workspace.'}
              </p>
            </div>
          )}
          {error && <p role="alert" className="text-[11px] text-bad break-words">{error}</p>}
        </div>
      )}
    </article>
  );
}

export function PromptRequirementsPanel({ sessionId, workspaceRoot }: { sessionId: string; workspaceRoot?: string }) {
  const [page, setPage] = useState<RequirementPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api.get<RequirementPage>(`/api/prompt-ledger${qs({ sessionId, offset, limit: 50 })}`, controller.signal)
      .then((result) => { setPage(result); setLoading(false); })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, offset, reload]);

  const refresh = () => setReload((version) => version + 1);
  if (loading && !page) return <p className="text-[12px] text-muted">Chargement des exigences persistées…</p>;
  if (error && !page) return <div role="alert" className="text-[12px] text-bad break-words">{error}</div>;
  if (!page || page.total === 0) {
    return <div className="space-y-2"><p className="text-[12px] text-faint">Aucune exigence de prompt enregistrée pour le workspace de cette session.</p><Button size="xs" icon={<RefreshCw className="w-3 h-3" />} onClick={refresh}>Actualiser</Button></div>;
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <span>{page.total} exigence(s) enregistrée(s) dans ce workspace.</span>
        <Button size="xs" variant="ghost" className="ml-auto" icon={<RefreshCw className="w-3 h-3" />} onClick={refresh}>Actualiser</Button>
      </div>
      <p className="text-[10.5px] leading-relaxed text-warn">Les candidats viennent d’un repérage lexical non exhaustif. Le texte source intégral reste la référence; un statut ne remplace pas la revue de ce texte.</p>
      {error && <p role="alert" className="text-[11px] text-bad break-words">{error}</p>}
      {page.items.map((item) => <RequirementRow key={item.id} item={item} sessionId={sessionId} workspaceRoot={workspaceRoot} onChanged={refresh} />)}
      <div className="flex items-center justify-between border-t border-line pt-2 text-[10.5px] text-faint">
        <span>{page.total === 0 ? 0 : page.offset + 1}–{page.nextOffset} / {page.total}</span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" icon={<ChevronLeft className="w-3 h-3" />} disabled={page.offset === 0 || loading} onClick={() => setOffset(Math.max(0, page.offset - page.limit))}>Précédent</Button>
          <Button size="xs" variant="ghost" icon={<ChevronRight className="w-3 h-3" />} disabled={page.done || loading} onClick={() => setOffset(page.nextOffset)}>Suivant</Button>
        </div>
      </div>
    </div>
  );
}

