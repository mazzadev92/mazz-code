import { useCallback, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Copy, Download, Pin, PinOff, Pencil, Square, Trash2 } from '../../components/icons';
import { navigate, refreshSessions, refreshTasks, setActiveSession, toast, useApp } from '../../lib/store';
import { api, errorMessage } from '../../lib/api';
import { basename, fmtDate, fmtMs, fmtRate, fmtRelative } from '../../lib/format';
import type { SessionRecord, SessionSummary } from '../../lib/types';
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, IconButton, Input, Page, PageHeader, Select, Spinner } from '../../components/ui';
import { SESSION_STATUS } from './SessionsSidebar';

export function normalizeSessionTitle(value: string): string {
  return value.trim().slice(0, 120);
}

export function sessionExportFilename(title: string): string {
  const safeTitle = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  const base = (safeTitle || 'session').replace(/\.json$/i, '') || 'session';
  const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(base);
  return `${windowsReserved ? `_${base}` : base}.json`;
}

export type SessionMetadataPatch = Partial<Pick<SessionRecord, 'title' | 'archived' | 'pinned'>>;

export async function patchSessionMetadata(id: string, patch: SessionMetadataPatch): Promise<SessionRecord> {
  const response = await api.patch<{ session?: unknown }>(`/api/sessions/${encodeURIComponent(id)}`, patch);
  const session = response?.session;
  if (!session || typeof session !== 'object') throw new Error('Le serveur n’a pas renvoyé la session mise à jour.');
  const record = session as Partial<SessionRecord>;
  if (record.id !== id || typeof record.title !== 'string' || !Array.isArray(record.turns)) {
    throw new Error('La réponse du serveur ne contient pas une session mise à jour valide.');
  }
  return record as SessionRecord;
}

export async function fetchSessionForExport(id: string): Promise<SessionRecord> {
  const response = await api.get<{ session?: unknown }>(`/api/sessions/${encodeURIComponent(id)}`);
  const session = response?.session;
  if (!session || typeof session !== 'object') throw new Error('Le serveur n’a pas renvoyé la session complète.');
  const record = session as Partial<SessionRecord>;
  if (record.id !== id || typeof record.title !== 'string' || !Array.isArray(record.turns)) throw new Error('La réponse du serveur ne contient pas un historique de session valide.');
  return record as SessionRecord;
}

export function serializeSessionExport(session: SessionRecord): string {
  return JSON.stringify(session, null, 2);
}

function downloadSessionJson(session: SessionRecord): void {
  const blobUrl = URL.createObjectURL(new Blob([serializeSessionExport(session)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = sessionExportFilename(session.title);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export default function SessionsView() {
  const sessions = useApp((s) => s.sessions);
  const tasks = useApp((s) => s.tasks);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | SessionSummary['status']>('all');
  const [project, setProject] = useState('all');
  const [archived, setArchived] = useState(false);
  const [engine, setEngine] = useState('all');
  const [toDelete, setToDelete] = useState<SessionSummary | null>(null);
  const [toRename, setToRename] = useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const running = tasks.filter((t) => !t.done);
  const projects = useMemo(() => Array.from(new Set(sessions.map((s) => s.projectRoot))), [sessions]);
  const engines = useMemo(() => Array.from(new Set(sessions.map((s) => s.providerId))), [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => s.archived === archived)
      .filter((s) => status === 'all' || s.status === status)
      .filter((s) => project === 'all' || s.projectRoot === project)
      .filter((s) => engine === 'all' || s.providerId === engine)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || (s.lastPrompt ?? '').toLowerCase().includes(q));
  }, [sessions, query, status, project, archived, engine]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await refreshSessions();
      toast('good', ok);
    } catch (e) {
      toast('bad', 'Action impossible', errorMessage(e));
    }
  };

  const saveRename = async () => {
    if (!toRename) return;
    const title = normalizeSessionTitle(renameValue);
    if (!title) {
      toast('bad', 'Nom invalide', 'Saisissez un nom de session non vide.');
      return;
    }
    setRenameBusy(true);
    try {
      await patchSessionMetadata(toRename.id, { title });
      await refreshSessions();
      setToRename(null);
      toast('good', 'Session renommée');
    } catch (e) {
      toast('bad', 'Renommage impossible', errorMessage(e));
    } finally {
      setRenameBusy(false);
    }
  };

  const closeRename = useCallback(() => {
    if (!renameBusy) setToRename(null);
  }, [renameBusy]);

  const exportSession = async (summary: SessionSummary) => {
    const session = await fetchSessionForExport(summary.id);
    downloadSessionJson(session);
    toast('good', 'Export JSON téléchargé');
  };

  return (
    <Page wide>
      <PageHeader title="Sessions" subtitle="Toutes les conversations agent, leur état et les tâches en cours. Les sessions sont enregistrées localement et reprennent après un redémarrage." icon="agents" />

      <section aria-labelledby="running-title" className="space-y-2">
        <h2 id="running-title" className="text-[13px] font-semibold text-fg">
          Tâches en cours ({running.length})
        </h2>
        {running.length === 0 ? (
          <p className="text-[12.5px] text-faint">Aucune tâche active.</p>
        ) : (
          <div className="grid md:grid-cols-2 gap-2">
            {running.map((t) => (
              <div key={t.taskId} className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-line bg-panel">
                <Spinner />
                <button type="button" onClick={() => t.sessionId && (setActiveSession(t.sessionId), navigate('agent', t.sessionId))} className="min-w-0 flex-1 text-left cursor-pointer">
                  <div className="text-[13px] text-fg truncate">{sessions.find((s) => s.id === t.sessionId)?.title ?? t.taskId}</div>
                  <div className="text-[11.5px] text-faint truncate">
                    {t.stage} - {t.mode} - {basename(t.modelId)} - depuis {fmtMs(Date.now() - t.startedAt)}
                  </div>
                </button>
                {t.pendingApprovals > 0 && <Badge tone="warn">Approbation</Badge>}
                <Button
                  size="xs"
                  variant="danger"
                  icon={<Square className="w-3 h-3" />}
                  onClick={() =>
                    api
                      .post('/api/agent/cancel', { taskId: t.taskId })
                      .then(() => refreshTasks())
                      .catch((e) => toast('bad', 'Annulation impossible', errorMessage(e)))
                  }
                >
                  Arrêter
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher dans les titres et les demandes" aria-label="Rechercher" className="max-w-xs" />
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filtrer par état">
            <option value="all">Tous les états</option>
            {Object.entries(SESSION_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
          <Select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Filtrer par projet">
            <option value="all">Tous les projets</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {basename(p)}
              </option>
            ))}
          </Select>
          <Select value={engine} onChange={(e) => setEngine(e.target.value)} aria-label="Filtrer par moteur">
            <option value="all">Tous les moteurs</option>
            {engines.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <Button size="sm" variant={archived ? 'primary' : 'secondary'} icon={<Archive className="w-3.5 h-3.5" />} onClick={() => setArchived((a) => !a)}>
            {archived ? 'Archives' : 'Actives'}
          </Button>
          <span className="ml-auto text-[12px] text-faint">{filtered.length} résultat(s)</span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState title={sessions.length ? 'Aucune session ne correspond' : 'Aucune session'}>{sessions.length ? 'Modifiez les filtres.' : 'Créez une session depuis l’agent.'}</EmptyState>
        ) : (
          <div className="rounded-[var(--radius-lg)] border border-line overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="bg-sunk text-faint text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Session</th>
                  <th className="px-3 py-2 font-medium">Projet</th>
                  <th className="px-3 py-2 font-medium">Moteur</th>
                  <th className="px-3 py-2 font-medium">État</th>
                  <th className="px-3 py-2 font-medium">Dernier débit</th>
                  <th className="px-3 py-2 font-medium">Activité</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-raised/50">
                    <td className="px-3 py-2 max-w-[320px]">
                      <button type="button" onClick={() => (setActiveSession(s.id), navigate('agent', s.id))} className="text-left cursor-pointer">
                        <div className="flex items-center gap-1.5 text-fg truncate">
                          {s.pinned && <Pin className="w-3 h-3 text-brand shrink-0" aria-label="Épinglée" />}
                          <span className="truncate">{s.title}</span>
                        </div>
                        <div className="text-[11.5px] text-faint truncate">{s.turnCount} échange(s) - créée {fmtDate(s.createdAt)}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11.5px] text-muted" title={s.projectRoot}>
                      {basename(s.projectRoot)}
                    </td>
                    <td className="px-3 py-2 text-muted truncate max-w-[180px]">{s.modelId ? basename(s.modelId) : s.providerId}</td>
                    <td className="px-3 py-2">
                      <Badge tone={SESSION_STATUS[s.status].tone}>{SESSION_STATUS[s.status].label}</Badge>
                    </td>
                    <td className="px-3 py-2 tabular text-muted">{s.lastTelemetry?.speedSource === 'synthetic' ? 'test' : fmtRate(s.lastTelemetry?.tgTokS)}</td>
                    <td className="px-3 py-2 text-faint">{fmtRelative(s.updatedAt)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5">
                        <IconButton
                          size="sm"
                          label="Renommer"
                          onClick={() => {
                            setRenameValue(s.title);
                            setToRename(s);
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton size="sm" label={s.pinned ? 'Désépingler' : 'Épingler'} onClick={() => act(() => patchSessionMetadata(s.id, { pinned: !s.pinned }), s.pinned ? 'Session désépinglée' : 'Session épinglée')}>
                          {s.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                        </IconButton>
                        <IconButton
                          size="sm"
                          label="Exporter la session en JSON"
                          onClick={() => void exportSession(s).catch((e) => toast('bad', 'Export impossible', errorMessage(e)))}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton size="sm" label="Dupliquer" onClick={() => act(() => api.post(`/api/sessions/${s.id}/duplicate`), 'Session dupliquée')}>
                          <Copy className="w-3.5 h-3.5" />
                        </IconButton>
                        <IconButton size="sm" label={s.archived ? 'Désarchiver' : 'Archiver'} onClick={() => act(() => patchSessionMetadata(s.id, { archived: !s.archived }), s.archived ? 'Session restaurée' : 'Session archivée')}>
                          {s.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                        </IconButton>
                        <IconButton size="sm" label="Supprimer" onClick={() => setToDelete(s)} disabled={s.status === 'running'}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Dialog
        open={!!toRename}
        title="Renommer la session"
        description="Le nouveau nom sera enregistré dans la session locale."
        onClose={closeRename}
        footer={
          <>
            <Button variant="ghost" onClick={closeRename} disabled={renameBusy}>
              Annuler
            </Button>
            <Button variant="primary" loading={renameBusy} onClick={() => void saveRename()}>
              Enregistrer
            </Button>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
          className="space-y-2"
        >
          <Input
            autoFocus
            maxLength={120}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            aria-label="Nom de la session"
            placeholder="Nom de la session"
          />
          <p className="text-[11.5px] text-faint">120 caractères maximum.</p>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!toDelete}
        danger
        title="Supprimer la session ?"
        confirmLabel="Supprimer"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await api.del(`/api/sessions/${toDelete!.id}`);
          await refreshSessions();
        }}
      >
        « {toDelete?.title} » et son historique seront effacés. Les fichiers du projet ne sont pas touchés.
      </ConfirmDialog>
    </Page>
  );
}
