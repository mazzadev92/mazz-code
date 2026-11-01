import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowDown, Copy, Download, FolderOpen, MoreHorizontal, Pin, PinOff, Trash2, Boxes, KeyRound, Cpu, ShieldCheck, X } from 'lucide-react';
import { LiveStatusLine } from './LiveStatusLine';
import { AccessDialog, PERMISSION_MODES } from './AccessDialog';
import { navigate, refreshSessions, saveSettings, setActiveSession, toast, useApp } from '../../lib/store';
import { answerApproval, cancelRun, getRun, markRunSeen, startRun, useRunsVersion } from '../../lib/agentRuns';
import { api, errorMessage } from '../../lib/api';
import { basename, fmtDate } from '../../lib/format';
import { Badge, Button, ConfirmDialog, Dialog, ErrorBox, IconButton, Input, Segmented, Spinner, cx } from '../../components/ui';
import { MazzEmblem } from '../../components/brand';
import { Composer, type AgentMode, type ComposerHandle } from './Composer';
import type { ModelChoice } from './ModelPicker';
import { PlanList, TurnView, type TurnLike } from './TurnView';
import { useSession } from './useSession';
import { SESSION_STATUS } from '../sessions/SessionsSidebar';
import { isAgentMode, type AttachmentMeta, type SessionRecord } from '../../lib/types';
import type { AgentEvent } from '@mazz/shared';

function exportMarkdown(s: SessionRecord): string {
  const lines = [`# ${s.title}`, '', `Projet : ${s.projectRoot}`, `Créée : ${fmtDate(s.createdAt)}`, ''];
  for (const t of s.turns) {
    lines.push(`## Demande (${t.mode}, ${t.modelId})`, '', t.prompt, '', '### Réponse', '', t.finalText || '(aucune réponse)', '');
  }
  return lines.join('\n');
}

function download(name: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AgentView() {
  useRunsVersion();
  const viewParam = useApp((s) => s.viewParam);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const settings = useApp((s) => s.settings);
  const llama = useApp((s) => s.llama);
  const workspace = useApp((s) => s.health?.workspace);
  const providers = useApp((s) => s.providers);
  const sessionId = viewParam || activeSessionId;
  const { session, setSession, error, loading } = useSession(sessionId);
  const run = getRun(sessionId);
  const livePlan = run ? (run.events.filter((e) => e.type === 'plan').pop() as Extract<AgentEvent, { type: 'plan' }> | undefined) : undefined;
  const live = !!run && (run.status === 'running' || run.status === 'connecting' || run.status === 'reconnecting');

  const [mode, setMode] = useState<AgentMode>('agent');
  // Conversation/Exécution switch: returning to Exécution restores the last execution mode.
  const lastExecMode = useRef<AgentMode>('agent');
  if (mode !== 'ask') lastExecMode.current = mode;
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [confirmRemote, setConfirmRemote] = useState<{ text: string; attachments?: AttachmentMeta[]; requiredPromptAttachmentId?: string } | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveAs, setSaveAs] = useState<{ code: string; path: string } | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    if (viewParam && viewParam !== activeSessionId) setActiveSession(viewParam);
  }, [viewParam, activeSessionId]);

  // Default mode and model: the session's, else settings, else the loaded local model.
  useEffect(() => {
    if (session) {
      setMode(isAgentMode(session.mode) ? session.mode : 'agent');
      const p = providers.find((x) => x.id === session.providerId);
      if (session.modelId && p) setModel({ providerId: p.id, modelId: session.modelId, locality: p.locality, label: p.id === 'llama-local' ? basename(session.modelId) : session.modelId, synthetic: p.synthetic });
      return;
    }
    if (!settings) return;
    setMode(settings.agent.defaultMode);
    if (settings.ai.defaultProviderId === 'mazz-cloud') {
      const p = providers.find((x) => x.id === 'mazz-cloud');
      if (p) {
        setModel({
          providerId: p.id,
          modelId: settings.ai.defaultModelId || 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M',
          locality: p.locality,
          label: settings.ai.defaultModelId || 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M',
          synthetic: p.synthetic,
        });
        return;
      }
    }
    if (llama?.state === 'ready' && llama.modelPath) {
      setModel({ providerId: 'llama-local', modelId: llama.modelPath, locality: 'local', label: basename(llama.modelPath) });
    } else if (settings.ai.defaultModelId) {
      const p = providers.find((x) => x.id === settings.ai.defaultProviderId);
      if (p) setModel({ providerId: p.id, modelId: settings.ai.defaultModelId, locality: p.locality, label: settings.ai.defaultModelId, synthetic: p.synthetic });
    } else setModel(null);
  }, [session?.id, settings?.agent.defaultMode, llama?.state, llama?.modelPath, providers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const turns: Array<{ turn: TurnLike; live: boolean; key: string }> = useMemo(() => {
    const list: Array<{ turn: TurnLike; live: boolean; key: string }> = (session?.turns ?? [])
      .filter((t) => !(run && t.taskId === run.taskId))
      .map((t) => ({ turn: t, live: false, key: t.id }));
    if (run) {
      list.push({
        key: `live_${run.taskId ?? run.key}`,
        live,
        turn: { prompt: run.prompt, attachments: run.attachments, mode: run.mode, modelId: run.modelId, providerId: run.providerId, startedAt: run.startedAt, status: run.status, events: run.events },
      });
    }
    return list;
    // run.version drives re-computation while streaming
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, run, run?.version, live]);

  // Conditional auto-scroll: follow the stream only while the reader is at the bottom.
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = atBottom;
    setShowJump(!atBottom);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  // Stable props: TurnView is memoised, so history turns skip the 20 Hz streaming re-renders.
  const approvals = run?.approvals;
  const pendingApprovals = useMemo(() => new Set(approvals?.map((a) => a.callId) ?? []), [approvals]);
  const onAnswer = useCallback((id: string, ok: boolean, scope?: Parameters<typeof answerApproval>[3], content?: string) => answerApproval(sessionId!, id, ok, scope, content), [sessionId]);
  const onSaveCode = useCallback((code: string, lang: string) => setSaveAs({ code, path: `nouveau-fichier.${lang || 'txt'}` }), []);
  const onOpenFile = useCallback((p: string) => navigate('code', p), []);
  const onEditPrompt = useCallback((p: string) => composer.current?.setText(p), []);

  const history = useMemo(() => (session?.turns ?? []).map((t) => t.prompt), [session]);
  const sessionChars = useMemo(
    () => (session?.turns ?? []).slice(-4).reduce((acc, t) => acc + (t.prompt?.length ?? 0) + (t.finalText?.length ?? 0), 0),
    [session]
  );

  const disabledReason = !model
    ? llama?.state !== 'ready'
      ? 'Aucun modèle prêt : chargez un GGUF dans le Model Hub ou choisissez un fournisseur.'
      : 'Choisissez un modèle.'
    : undefined;

  const needsRemoteAck = (m: ModelChoice) => m.locality === 'remote' && !!settings?.ai.confirmRemoteSend && !settings.ai.remoteAcknowledged?.includes(m.providerId);

  const send = useCallback(
    async (text: string, skipRemoteCheck = false, attachments?: AttachmentMeta[], requiredPromptAttachmentId?: string, modeOverride?: AgentMode) => {
      // Session commands, as in Claude Code.
      const cmd = text.trim().toLowerCase();
      if (cmd === '/clear' || cmd === '/new') {
        setActiveSession(undefined);
        navigate('agent');
        return;
      }
      if (cmd === '/compact') {
        if (!session) return;
        try {
          const r = await api.post<{ session: SessionRecord }>(`/api/sessions/${session.id}/compact`);
          setSession(r.session);
          toast('good', 'Conversation résumée', `${r.session.summarizedTurns ?? 0} échange(s) remplacés par un résumé.`);
        } catch (e) {
          toast('bad', 'Résumé impossible', errorMessage(e));
        }
        return;
      }
      if (!model) return;
      if (!skipRemoteCheck && needsRemoteAck(model)) {
        setConfirmRemote({ text, attachments, ...(requiredPromptAttachmentId ? { requiredPromptAttachmentId } : {}) });
        return;
      }
      stick.current = true;
      const newId = await startRun({
        sessionId: session?.id,
        goal: text,
        attachments,
        ...(requiredPromptAttachmentId ? { requiredPromptAttachmentId } : {}),
        mode: modeOverride ?? mode,
        providerId: model.providerId,
        modelId: model.modelId,
        topP: settings?.ai.topP,
        topK: settings?.ai.topK,
        presencePenalty: settings?.ai.presencePenalty,
      });
      if (newId && newId !== sessionId) {
        setActiveSession(newId);
        navigate('agent', newId);
        void refreshSessions();
      }
    },
    [model, settings?.ai.confirmRemoteSend, settings?.ai.remoteAcknowledged, settings?.ai.topP, settings?.ai.topK, settings?.ai.presencePenalty, session?.id, mode, sessionId]
  );
  // Viewing a session whose run finished in the background clears its unread mark.
  useEffect(() => {
    if (!live && run && !run.seen && !document.hidden) markRunSeen(sessionId);
  }, [live, run, run?.status, sessionId]);

  const sendRef = useRef(send);
  sendRef.current = send;
  const onRetry = useCallback((p: string) => void sendRef.current(p), []);
  // Plan mode: an accepted plan switches the session to Agent and runs the plan as written.
  const patchRef = useRef<(patch: Record<string, unknown>) => Promise<void>>(async () => undefined);
  const onExecutePlan = useCallback((planText: string) => {
    setMode('agent');
    void patchRef.current({ mode: 'agent' });
    void sendRef.current(`Exécute ce plan validé, étape par étape, et vérifie chaque étape :\n\n${planText}`, false, undefined, undefined, 'agent');
  }, []);

  const stop = useCallback(() => {
    if (sessionId) cancelRun(sessionId).catch((e) => toast('bad', 'Annulation impossible', errorMessage(e)));
  }, [sessionId]);

  // Escape stops the running task, unless a dialog, menu or composer popup handled it first.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      e.preventDefault();
      stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live, stop]);

  // Messages typed while the agent works are sent, in order, when the turn ends.
  // A stopped turn gives them back to the composer instead: the user interrupted on purpose.
  const [queued, setQueued] = useState<string[]>([]);
  // A new session gets its id mid-run: keep the queue then, drop it only when leaving a real session.
  const queueSession = useRef(sessionId);
  useEffect(() => {
    if (queueSession.current && queueSession.current !== sessionId) setQueued([]);
    queueSession.current = sessionId;
  }, [sessionId]);
  const wasLive = useRef(live);
  useEffect(() => {
    const ended = wasLive.current && !live;
    wasLive.current = live;
    if (!ended || queued.length === 0) return;
    if (run?.status === 'aborted') {
      composer.current?.setText(queued.join('\n\n'));
      setQueued([]);
      return;
    }
    const [next, ...rest] = queued;
    setQueued(rest);
    void sendRef.current(next);
  }, [live, run?.status, queued]);

  // Remote providers are confirmed once, when first selected; the answer is kept in Settings.
  useEffect(() => {
    if (model && needsRemoteAck(model)) setConfirmRemote({ text: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model?.providerId]);

  const patchSession = async (patch: Record<string, unknown>) => {
    if (!session) return;
    try {
      const r = await api.patch<{ session: SessionRecord }>(`/api/sessions/${session.id}`, patch);
      setSession(r.session);
      void refreshSessions();
    } catch (err) {
      toast('bad', 'Mise à jour impossible', errorMessage(err));
    }
  };

  patchRef.current = patchSession;
  const changeMode = (m: AgentMode) => {
    setMode(m);
    if (session) void patchSession({ mode: m });
  };

  const status = live ? SESSION_STATUS.running : session ? SESSION_STATUS[session.status] : null;
  const projectRoot = session?.projectRoot ?? workspace?.workspaceRoot;

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Session header */}
      <div className="shrink-0 flex items-center gap-3 px-5 h-11 border-b border-line">
        {renaming && session ? (
          <form
            className="flex-1 max-w-md"
            onSubmit={(e) => {
              e.preventDefault();
              const v = new FormData(e.currentTarget).get('title');
              setRenaming(false);
              if (typeof v === 'string' && v.trim()) void patchSession({ title: v });
            }}
          >
            <Input name="title" defaultValue={session.title} autoFocus onBlur={() => setRenaming(false)} aria-label="Nom de la session" />
          </form>
        ) : (
          <button type="button" className="min-w-0 text-left cursor-text" onDoubleClick={() => session && setRenaming(true)} title={session ? 'Double clic pour renommer' : undefined}>
            <h1 className="text-[14px] font-medium text-fg truncate">{session?.title ?? 'Nouvelle session'}</h1>
          </button>
        )}
        <Segmented<'conversation' | 'execution'>
          label="Surface"
          size="xs"
          value={mode === 'ask' ? 'conversation' : 'execution'}
          onChange={(v) => changeMode(v === 'conversation' ? 'ask' : lastExecMode.current)}
          options={[
            { value: 'conversation', label: 'Conversation', title: 'Discussion et lecture du projet, aucune modification (mode Ask)' },
            { value: 'execution', label: 'Exécution', title: 'L’agent agit : lecture, écriture, terminal selon vos permissions (Agent, Auto, Plan, Review, Forge)' },
          ]}
        />
        {status && <Badge tone={status.tone}>{status.label}</Badge>}
        {model && <Badge tone={model.synthetic ? 'warn' : model.locality === 'local' ? 'good' : 'info'}>{model.synthetic ? 'Moteur de test' : model.locality === 'local' ? 'Local' : 'API'}</Badge>}
        {run?.status === 'reconnecting' && <Badge tone="warn">Reconnexion au flux</Badge>}
        {run && run.approvals.length > 0 && <Badge tone="warn">En attente d’approbation</Badge>}
        <button type="button" onClick={() => navigate('projects')} className="ml-auto flex items-center gap-1.5 text-[12px] text-muted hover:text-fg cursor-pointer min-w-0" title={projectRoot}>
          <FolderOpen className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate max-w-[220px] font-mono">{projectRoot ? basename(projectRoot) : 'Aucun projet'}</span>
        </button>
        {session && settings && (
          <Button
            size="sm"
            variant="ghost"
            icon={<ShieldCheck className={cx('w-3.5 h-3.5', session.permissionMode === 'bypass' ? 'text-warn' : '')} />}
            onClick={() => setAccessOpen(true)}
            title="Accès et autorisations de la session"
          >
            {PERMISSION_MODES.find((m) => m.value === (session.permissionMode ?? 'default'))!.label}
            {session.extraRoots?.length ? ` · ${session.extraRoots.length} dossier(s)` : ''}
          </Button>
        )}
        {session && settings && <AccessDialog open={accessOpen} onClose={() => setAccessOpen(false)} session={session} settings={settings} onPatch={patchSession} />}
        {session && (
          <div className="relative">
            <IconButton label="Actions de la session" active={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <MoreHorizontal className="w-4 h-4" />
            </IconButton>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-8 z-[var(--z-overlay)] w-56 rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] py-1" onMouseLeave={() => setMenuOpen(false)}>
                {[
                  { label: 'Renommer', icon: null, run: () => setRenaming(true) },
                  { label: session.pinned ? 'Désépingler' : 'Épingler', icon: session.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />, run: () => patchSession({ pinned: !session.pinned }) },
                  {
                    label: 'Dupliquer',
                    icon: <Copy className="w-3.5 h-3.5" />,
                    run: async () => {
                      const r = await api.post<{ session: SessionRecord }>(`/api/sessions/${session.id}/duplicate`);
                      await refreshSessions();
                      setActiveSession(r.session.id);
                      navigate('agent', r.session.id);
                    },
                  },
                  {
                    label: 'Résumer la conversation (/compact)',
                    icon: null,
                    run: async () => {
                      const r = await api.post<{ session: SessionRecord }>(`/api/sessions/${session.id}/compact`);
                      setSession(r.session);
                      toast('good', 'Conversation résumée', `${r.session.summarizedTurns ?? 0} échange(s) remplacés par un résumé.`);
                    },
                  },
                  { label: 'Exporter en Markdown', icon: <Download className="w-3.5 h-3.5" />, run: () => download(`${session.title}.md`, exportMarkdown(session), 'text/markdown') },
                  { label: 'Exporter en JSON', icon: <Download className="w-3.5 h-3.5" />, run: () => download(`${session.title}.json`, JSON.stringify(session, null, 2), 'application/json') },
                  { label: session.archived ? 'Désarchiver' : 'Archiver', icon: <Archive className="w-3.5 h-3.5" />, run: () => patchSession({ archived: !session.archived }) },
                  { label: 'Supprimer', icon: <Trash2 className="w-3.5 h-3.5 text-bad" />, run: () => setConfirmDelete(true) },
                ].map((m) => (
                  <button
                    key={m.label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void Promise.resolve(m.run()).catch((e) => toast('bad', 'Action impossible', errorMessage(e)));
                    }}
                    className="w-full flex items-center gap-2 px-3 h-8 text-left text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer"
                  >
                    <span className="w-3.5">{m.icon}</span>
                    {m.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Conversation */}
      <div className="relative flex-1 min-h-0 center-canvas">
        <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto chat-scrollable-stream" aria-live="off">
          <div className="chat-reading-column px-5 py-6 space-y-7">
            {error != null && <ErrorBox error={error} title="Session introuvable" />}
            {loading && !session && sessionId && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Spinner /> Chargement de la session
              </div>
            )}
            {turns.length === 0 && !loading && <AgentEmptyState onPick={(t) => composer.current?.setText(t)} />}
            {turns.map(({ turn, live: isLive, key }) => (
              <TurnView
                key={key}
                turn={turn}
                live={isLive}
                showStatus={isLive}
                pendingApprovals={pendingApprovals}
                onAnswer={onAnswer}
                onSaveCode={onSaveCode}
                onOpenFile={onOpenFile}
                onEditPrompt={onEditPrompt}
                onRetry={live ? undefined : onRetry}
                onExecutePlan={live ? undefined : onExecutePlan}
              />
            ))}
          </div>
        </div>
        {showJump && (
          <button type="button" onClick={() => { stick.current = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }} className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 h-7 px-3 rounded-full border border-line bg-panel text-[12px] text-muted hover:text-fg shadow-[var(--shadow-2)] cursor-pointer">
            <ArrowDown className="w-3.5 h-3.5" /> Aller à la fin
          </button>
        )}
      </div>

      {/* Live status line (announced politely, not per token) */}
      <div className="sr-only" aria-live="polite">
        {live ? `Agent en cours : ${run?.stage}` : run?.status === 'done' ? 'Tâche terminée' : run?.status === 'failed' ? 'Tâche en échec' : ''}
      </div>

      <div className="shrink-0 px-5 pb-4 pt-1">
        <div className="composer-dock-container">
          {live && livePlan && (
            <div className="mb-2">
              <PlanList items={livePlan.items} compact />
            </div>
          )}
          {live && run && <LiveStatusLine run={run} />}
          {queued.length > 0 && (
            <ul className="mb-2 space-y-1" aria-label="Messages en attente">
              {queued.map((q, i) => (
                <li key={i} className="flex items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-line bg-sunk px-2.5 py-1 text-[12px] text-muted">
                  <span className="text-faint shrink-0">En attente</span>
                  <span className="truncate text-fg">{q}</span>
                  <IconButton size="sm" label="Retirer ce message de la file" className="ml-auto" onClick={() => setQueued((cur) => cur.filter((_, j) => j !== i))}>
                    <X className="w-3 h-3" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <Composer
            ref={composer}
            draftKey={sessionId ?? 'new'}
            sessionId={session?.id}
            mode={mode}
            onModeChange={changeMode}
            model={model}
            onModelChange={setModel}
            running={live}
            disabledReason={disabledReason}
            onSubmit={(t, att, requiredPromptAttachmentId) => void send(t, false, att, requiredPromptAttachmentId)}
            onStop={stop}
            onQueue={(t) => setQueued((cur) => [...cur, t])}
            history={history}
            sessionChars={sessionChars}
            sessionTurnsCount={session?.turns?.length ?? 0}
            onCompactSession={session ? () => void send('/compact') : undefined}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmRemote !== null}
        title="Utiliser un fournisseur distant ?"
        confirmLabel={confirmRemote?.text ? 'Autoriser et envoyer' : 'Autoriser ce fournisseur'}
        onClose={() => setConfirmRemote(null)}
        onConfirm={async () => {
          const t = confirmRemote!;
          setConfirmRemote(null);
          if (model && settings) await saveSettings({ ai: { remoteAcknowledged: [...(settings.ai.remoteAcknowledged ?? []), model.providerId] } });
          if (t.text) await send(t.text, true, t.attachments, t.requiredPromptAttachmentId);
        }}
      >
        Vos demandes, et le contenu des fichiers que l’agent lira, seront transmis à <strong className="text-fg">{model?.providerId}</strong> hors de cette machine. Cette confirmation n’est demandée qu’une fois par fournisseur (révocable dans Paramètres, IA).
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer cette session ?"
        danger
        confirmLabel="Supprimer définitivement"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api.del(`/api/sessions/${session!.id}`);
          setActiveSession(undefined);
          await refreshSessions();
          navigate('agent');
        }}
      >
        L’historique de « {session?.title} » sera effacé. Les fichiers du projet ne sont pas modifiés.
      </ConfirmDialog>
      <SaveCodeDialog value={saveAs} onClose={() => setSaveAs(null)} />
    </div>
  );
}

function SaveCodeDialog({ value, onClose }: { value: { code: string; path: string } | null; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (value) {
      setPath(value.path);
      setError(null);
    }
  }, [value]);
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title="Enregistrer le bloc de code"
      description="Chemin relatif au projet. Un point de restauration est créé avant l’écriture."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.put('/api/files/write', { path, content: value!.code });
                toast('good', 'Fichier enregistré', path);
                onClose();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono" aria-label="Chemin du fichier" />
        {error != null && <ErrorBox error={error} />}
      </div>
    </Dialog>
  );
}

function AgentEmptyState({ onPick }: { onPick: (t: string) => void }) {
  const llama = useApp((s) => s.llama);
  const providers = useApp((s) => s.providers);
  const workspace = useApp((s) => s.health?.workspace);
  const hasRemote = providers.some((p) => p.locality === 'remote' && p.hasApiKey);
  const ready = llama?.state === 'ready';
  return (
    <div className="flex flex-col items-center text-center pt-8 pb-4">
      <MazzEmblem size={92} />
      <h2 className="font-display text-[20px] text-fg mt-4">Que construisons-nous ?</h2>
      <p className="text-[13px] text-muted mt-1.5 max-w-lg">
        L’agent lit, modifie, compile et teste dans <span className="font-mono text-fg">{workspace?.name ?? 'le projet actif'}</span>. Chaque modification est précédée d’un point de restauration.
      </p>
      <div className={cx('mt-5 w-full max-w-lg grid gap-2', !ready && 'opacity-100')}>
        {!ready && !hasRemote && (
          <div className="flex items-center gap-3 p-3 rounded-[var(--radius-md)] border border-warn/35 bg-warn/5 text-left">
            <Cpu className="w-4 h-4 text-warn shrink-0" />
            <div className="flex-1 text-[12.5px] text-muted">Aucun moteur prêt. Chargez un modèle GGUF local ou ajoutez une clé API.</div>
            <Button size="sm" icon={<Boxes className="w-3.5 h-3.5" />} onClick={() => navigate('models')}>
              Modèles
            </Button>
            <Button size="sm" variant="ghost" icon={<KeyRound className="w-3.5 h-3.5" />} onClick={() => navigate('providers')}>
              Clés
            </Button>
          </div>
        )}
        {[
          'Explique la structure de ce projet et ses commandes de build.',
          'Crée main.c qui affiche les 10 premiers nombres de Fibonacci, compile-le avec GCC et exécute-le.',
          'Cherche les TODO du projet et propose un plan pour les traiter.',
        ].map((s) => (
          <button key={s} type="button" onClick={() => onPick(s)} className="text-left px-3.5 py-2.5 rounded-[var(--radius-md)] border border-line bg-panel hover:border-line-strong hover:bg-raised text-[12.5px] text-muted hover:text-fg cursor-pointer transition-colors">
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
