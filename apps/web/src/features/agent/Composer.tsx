import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { CONTEXT_ALERT_PCT, contextLimitFor } from '../../lib/context-window';
import { ArrowUp, AtSign, BookText, Database, File as FileIcon, Layers, Link2, Minimize2, Paperclip, Square } from '../../components/icons';
import type { AttachmentMeta } from '../../lib/types';
import { api, errorMessage } from '../../lib/api';
import { assertAttachmentUploadsReady, AttachmentChip, deleteAttachment, uploadAttachment, validateAttachmentMeta, type PendingAttachment } from './attachments';
import { prepareAgentSubmission, requiresDiskBackedPrompt, textForAgentSubmission } from './prompt-intake';
import { qs } from '../../lib/api';
import { prefs } from '../../lib/prefs';
import { AGENT_MODE_OPTIONS, type AgentMode } from '../../lib/types';
import { Button, IconButton, Kbd, Segmented, cx } from '../../components/ui';
import { ModelPicker, type ModelChoice } from './ModelPicker';

export type { AgentMode } from '../../lib/types';
export type ContextWindowProfile = 'FAST_4K' | 'BALANCED_8K' | 'EXTENDED_16K';

export const MODES = AGENT_MODE_OPTIONS;

const TEMPLATES = [
  { label: 'Expliquer la structure du projet', text: 'Explique la structure de ce projet : dossiers principaux, points d’entrée et commandes de build.' },
  { label: 'Écrire des tests', text: 'Écris des tests unitaires pour @' },
  { label: 'Corriger une erreur de compilation', text: 'Compile le projet, analyse les erreurs et corrige-les. Vérifie ensuite que la compilation passe.' },
  { label: 'Revue de sécurité', text: 'Fais une revue de sécurité des fichiers modifiés : injections, chemins, secrets, entrées non validées.' },
  { label: 'Programme C compilé et testé', text: 'Crée main.c qui affiche les 10 premiers nombres de Fibonacci, compile-le avec GCC et exécute-le pour vérifier la sortie.' },
];

export interface ComposerHandle {
  setText: (t: string) => void;
  focus: () => void;
}

export const Composer = forwardRef<ComposerHandle, {
  draftKey: string;
  sessionId?: string;
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  model: ModelChoice | null;
  onModelChange: (m: ModelChoice) => void;
  running: boolean;
  disabledReason?: string;
  onSubmit: (text: string, attachments?: AttachmentMeta[], requiredPromptAttachmentId?: string) => void;
  onStop: () => void;
  /** While running: a plain text message is queued for the end of the turn. */
  onQueue?: (text: string) => void;
  history: string[];
  sessionChars?: number;
  sessionTurnsCount?: number;
  onCompactSession?: () => void;
}>(function Composer({ draftKey, sessionId, mode, onModeChange, model, onModelChange, running, disabledReason, onSubmit, onStop, onQueue, history, sessionTurnsCount = 0, onCompactSession }, ref) {
  const [text, setText] = useState(() => prefs.get(`draft.${draftKey}`, ''));
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [nativeContext, setNativeContext] = useState<number | null>(null);
  const [lastPrompt, setLastPrompt] = useState<number | null>(null);
  const [contextError, setContextError] = useState('');
  const [counting, setCounting] = useState(false);
  const [virtualTokens, setVirtualTokens] = useState<number | null>(null);
  const [virtualChunks, setVirtualChunks] = useState<number | null>(null);
  // "/name" at the start of the message loads a skill (as in Claude Code).
  const [slash, setSlash] = useState<string | null>(null);
  const [skills, setSkills] = useState<Array<{ name: string; description: string; kind: string }> | null>(null);
  const [slashActive, setSlashActive] = useState(0);
  const slashResults = slash === null || !skills ? [] : skills.filter((k) => k.name.toLowerCase().includes(slash.toLowerCase())).slice(0, 8);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [removingFileKeys, setRemovingFileKeys] = useState<Set<string>>(() => new Set());
  const [attachmentRemovalError, setAttachmentRemovalError] = useState('');
  const [fileLimitError, setFileLimitError] = useState('');
  const [urlFormOpen, setUrlFormOpen] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlImportError, setUrlImportError] = useState('');
  const [urlImporting, setUrlImporting] = useState(false);
  const [promptSubmitError, setPromptSubmitError] = useState('');
  const [preparingLongPrompt, setPreparingLongPrompt] = useState(false);
  const preparingLongPromptRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const uploading = urlImporting || files.some((f) => f.status === 'uploading');

  const addFiles = (list: FileList | File[]) => {
    const selected = Array.from(list);
    const available = Math.max(0, 50 - files.length);
    setFileLimitError(selected.length > available ? `Vous pouvez joindre au maximum 50 fichiers par demande. ${selected.length - available} fichier(s) non ajouté(s).` : '');
    for (const file of selected.slice(0, available)) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setFiles((cur) => [...cur, { key, name: file.name || 'fichier', sizeBytes: file.size, status: 'uploading' }]);
      uploadAttachment(file)
        .then((meta) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, status: 'ready', meta } : f))))
        .catch((e) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, status: 'error', error: errorMessage(e) } : f))));
    }
  };

  const removeFile = async (file: PendingAttachment) => {
    if (file.status === 'uploading') {
      setAttachmentRemovalError(`Attendez la fin de l’envoi de « ${file.name} » avant de le retirer.`);
      return;
    }
    setAttachmentRemovalError('');
    if (!file.meta) {
      setFiles((cur) => cur.filter((item) => item.key !== file.key));
      return;
    }

    setRemovingFileKeys((current) => new Set(current).add(file.key));
    try {
      await deleteAttachment(file.meta.id);
      setFiles((current) => current.filter((item) => item.key !== file.key));
    } catch (error) {
      setAttachmentRemovalError(`Impossible de retirer « ${file.name} » : ${errorMessage(error)}`);
    } finally {
      setRemovingFileKeys((current) => {
        const next = new Set(current);
        next.delete(file.key);
        return next;
      });
    }
  };

  const importUrl = async () => {
    const candidate = urlInput.trim();
    if (!candidate || urlImporting || running) return;
    if (files.length >= 50) {
      setFileLimitError('Vous pouvez joindre au maximum 50 éléments par demande.');
      return;
    }
    setUrlImportError('');
    setUrlImporting(true);
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Seules les adresses HTTP et HTTPS sont acceptées.');
      }
      const { attachment: rawMeta } = await api.post<{ attachment: AttachmentMeta }>('/api/attachments/url', { url: parsed.toString() });
      const meta = validateAttachmentMeta(rawMeta);
      setFiles((cur) => [...cur, {
        key: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: meta.name,
        sizeBytes: meta.sizeBytes,
        status: 'ready',
        meta,
      }]);
      setUrlInput('');
      setUrlFormOpen(false);
    } catch (error) {
      setUrlImportError(errorMessage(error));
    } finally {
      setUrlImporting(false);
    }
  };

  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => area.current?.focus());
    },
    focus: () => area.current?.focus(),
  }));

  useEffect(() => {
    setText(prefs.get(`draft.${draftKey}`, ''));
  }, [draftKey]);

  // Draft saved locally (convenience only), debounced.
  useEffect(() => {
    const id = setTimeout(() => prefs.set(`draft.${draftKey}`, text || undefined), 400);
    return () => clearTimeout(id);
  }, [text, draftKey]);

  async function refreshContext() {
    const [memory, runtime] = await Promise.all([
      api.get<{virtualMemory?: {virtual_memory_total_tokens?: number | null; levels?: {L4_archive_and_external?: {indexed_chunks?: number}}}}>('/api/infinite-context/status'),
      api.get<{state: string; config?: {contextSize?: number}}>('/api/models/server/status'),
    ]);
    setVirtualTokens(memory.virtualMemory?.virtual_memory_total_tokens ?? null);
    setVirtualChunks(memory.virtualMemory?.levels?.L4_archive_and_external?.indexed_chunks ?? null);
    setNativeContext(runtime.state === 'ready' ? runtime.config?.contextSize ?? null : null);
    if (draftKey !== 'new') {
      const s = await api.get<{session: {turns: Array<{telemetry?: Array<{promptTokens?: number; tokenSource?: string}>}>}}>(`/api/sessions/${encodeURIComponent(draftKey)}`);
      const samples = s.session.turns.flatMap(turn => turn.telemetry ?? []).filter(sample => sample.tokenSource === 'runtime_timings' || sample.tokenSource === 'provider_usage');
      setLastPrompt(samples.at(-1)?.promptTokens ?? null);
    } else setLastPrompt(null);
  }
  useEffect(() => { if (!running) void refreshContext().catch(() => undefined); }, [running, draftKey, contextOpen]);
  // One window for every gauge: the runtime --ctx-size when local, else the specification's value for the model (never invented).
  const windowLimit = nativeContext !== null ? { limit: nativeContext, source: 'runtime' as const } : model ? contextLimitFor({ providerId: model.providerId, modelId: model.modelId }, undefined) : undefined;
  const usagePct = windowLimit && lastPrompt !== null ? Math.min(100, Math.round(1000 * lastPrompt / windowLimit.limit) / 10) : null;
  const needsCompaction = usagePct !== null && usagePct >= CONTEXT_ALERT_PCT;
  async function measureProjectTokens() {
    setCounting(true); setContextError('');
    try {
      const ws = await api.get<{workspaceRoot: string}>('/api/workspace/status');
      const counted = await api.post<{result: {status: string; warnings?: string[]}}>('/api/knowledge/measure-tokens', {vaultPath: ws.workspaceRoot});
      if (counted.result.status !== 'ok') throw new Error(counted.result.warnings?.join('; ') || 'Comptage interrompu');
      await refreshContext();
    } catch (error) { setContextError(errorMessage(error)); }
    finally { setCounting(false); }
  }

  // Auto-grow up to 40% of the viewport.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (!mention || mention.query.length < 1) {
      setMentionResults([]);
      return;
    }
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      api
        .get<{ files: string[] }>(`/api/files/search${qs({ q: mention.query, names: 1, max: 12 })}`, ctrl.signal)
        .then((r) => {
          setMentionResults(r.files);
          setMentionActive(0);
        })
        .catch(() => setMentionResults([]));
    }, 140);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [mention]);

  const submit = async () => {
    // Keep every character of a disk-backed prompt exactly as entered. Short
    // prompts retain the existing whitespace cleanup used by the direct API.
    const value = textForAgentSubmission(text);
    // Queue only plain short text: attachments and disk-backed prompts need the idle path.
    if (running && onQueue && value.trim() && !files.length && !requiresDiskBackedPrompt(value)) {
      onQueue(value);
      setText('');
      setHistoryIdx(-1);
      prefs.set(`draft.${draftKey}`, undefined);
      return;
    }
    if (!value.trim() || running || disabledReason || uploading || preparingLongPromptRef.current) return;
    const ready = files.filter((f) => f.status === 'ready' && f.meta).map((f) => f.meta!);
    setPromptSubmitError('');
    if (requiresDiskBackedPrompt(value)) {
      preparingLongPromptRef.current = true;
      setPreparingLongPrompt(true);
    }
    try {
      assertAttachmentUploadsReady(files);
      const prepared = await prepareAgentSubmission(value, ready, sessionId);
      const submittedAttachments = prepared.attachments.length ? prepared.attachments : undefined;
      if (prepared.requiredPromptAttachmentId) {
        onSubmit(prepared.goal, submittedAttachments, prepared.requiredPromptAttachmentId);
      } else {
        onSubmit(prepared.goal, submittedAttachments);
      }
    } catch (error) {
      setPromptSubmitError(errorMessage(error));
      return;
    } finally {
      preparingLongPromptRef.current = false;
      setPreparingLongPrompt(false);
    }
    setFiles([]);
    setText('');
    setHistoryIdx(-1);
    prefs.set(`draft.${draftKey}`, undefined);
  };

  const insertMention = (file: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.start + 1 + mention.query.length);
    setText(`${before}@${file} ${after}`);
    setMention(null);
    requestAnimationFrame(() => area.current?.focus());
  };

  const onChange = (value: string, caret: number) => {
    setText(value);
    const m = value.slice(0, caret).match(/@([\w./\\-]*)$/);
    setMention(m ? { query: m[1], start: caret - m[0].length } : null);
    const sl = /^\/([\w:-]*)$/.exec(value.slice(0, caret));
    setSlash(sl ? sl[1] : null);
    setSlashActive(0);
    if (sl && !skills) {
      // Built-in commands, then project/user commands, then skills (same order as the server).
      Promise.all([
        api.get<{ commands: Array<{ name: string; description: string }> }>('/api/commands').catch(() => ({ commands: [] })),
        api.get<{ skills: Array<{ name: string; description: string }> }>('/api/skills').catch(() => ({ skills: [] })),
      ]).then(([c, sk]) =>
        setSkills([
          { name: 'compact', description: 'Résume les anciens échanges pour libérer le contexte', kind: 'Studio' },
          { name: 'clear', description: 'Nouvelle session', kind: 'Studio' },
          ...c.commands.map((x) => ({ ...x, kind: 'Commande' })),
          ...sk.skills.map((x) => ({ ...x, kind: 'Skill' })),
        ])
      );
    }
  };

  const pickSkill = (name: string) => {
    setText(`/${name} ${text.replace(/^\/[\w:-]*\s?/, '')}`);
    setSlash(null);
    requestAnimationFrame(() => area.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashResults.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActive((a) => Math.max(0, Math.min(slashResults.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSkill(slashResults[slashActive].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (mention && mentionResults.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActive((a) => Math.min(a + 1, mentionResults.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActive((a) => Math.max(a - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionResults[mentionActive]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    // Prompt history when the composer is empty or already browsing it.
    if (e.key === 'ArrowUp' && (text === '' || historyIdx >= 0) && history.length) {
      e.preventDefault();
      const next = Math.min(historyIdx + 1, history.length - 1);
      setHistoryIdx(next);
      setText(history[history.length - 1 - next]);
    } else if (e.key === 'ArrowDown' && historyIdx >= 0) {
      e.preventDefault();
      const next = historyIdx - 1;
      setHistoryIdx(next);
      setText(next < 0 ? '' : history[history.length - 1 - next]);
    }
  };

  return (
    <div
      className={cx(
        'composer composer-input-card relative rounded-2xl border bg-panel shadow-[var(--shadow-2)] transition-all duration-[var(--dur-base)]',
        dragging ? 'border-brand' : 'border-line-strong'
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && <div className="absolute inset-0 z-[1] grid place-items-center rounded-[var(--radius-lg)] bg-panel/85 text-[13px] text-brand pointer-events-none">Déposez les fichiers à joindre</div>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-2.5" aria-label="Pièces jointes">
          <span className="w-full text-[10px] text-faint">{files.length}/50 fichiers joints</span>
          {fileLimitError && <span role="alert" className="w-full text-[11px] text-warn">{fileLimitError}</span>}
          {attachmentRemovalError && <span role="alert" className="w-full text-[11px] text-bad">{attachmentRemovalError}</span>}
          {files.map((f) => (
            <span key={f.key} data-attachment-id={f.meta?.id} className="inline-flex min-w-0 max-w-full flex-col items-start gap-1">
              <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                <AttachmentChip
                  item={f}
                  onRemove={() => void removeFile(f)}
                  removeDisabled={running || f.status === 'uploading' || removingFileKeys.has(f.key)}
                  removing={removingFileKeys.has(f.key)}
                />
                {f.meta?.sourceUrl && <span className="max-w-[220px] truncate text-[10px] text-faint" title={`URL source : ${f.meta.sourceUrl}`} aria-label={`Source URL : ${f.meta.sourceUrl}`}>Source : {f.meta.sourceUrl}</span>}
              </span>
              {f.meta?.sourceUrl && (
                <span className="flex max-w-full flex-col pl-2 text-[10px] leading-relaxed text-faint">
                  {f.meta.finalUrl && <span className="max-w-full truncate" title={`URL finale : ${f.meta.finalUrl}`}>URL finale : {f.meta.finalUrl}</span>}
                  {f.meta.fetchedAt && <time dateTime={new Date(f.meta.fetchedAt).toISOString()}>Récupérée le {new Date(f.meta.fetchedAt).toLocaleString('fr-FR')}</time>}
                  <span>{f.meta.mime ?? 'Type inconnu'} · {f.meta.chars.toLocaleString('fr-FR')} caractères extraits · extraction {f.meta.extractionStatus}</span>
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      {urlFormOpen && (
        <form
          className="flex flex-wrap items-center gap-2 px-3 pt-2.5"
          aria-label="Joindre une page Web"
          onSubmit={(event) => { event.preventDefault(); void importUrl(); }}
        >
          <input
            type="url"
            value={urlInput}
            onChange={(event) => { setUrlInput(event.target.value); setUrlImportError(''); }}
            placeholder="https://exemple.org/documentation"
            aria-label="Adresse de la page Web à joindre"
            autoFocus
            maxLength={2048}
            className="min-w-[220px] flex-1 rounded-[var(--radius-sm)] border border-line bg-sunk px-2.5 py-1.5 text-[12px] text-fg placeholder:text-faint focus:border-brand focus:outline-none"
          />
          <Button type="submit" size="xs" disabled={!urlInput.trim() || urlImporting || running}>
            {urlImporting ? 'Récupération…' : 'Joindre la page'}
          </Button>
          <button type="button" className="px-2 py-1 text-[11px] text-muted hover:text-fg" disabled={urlImporting} onClick={() => { setUrlFormOpen(false); setUrlImportError(''); }}>
            Annuler
          </button>
          {urlImportError && <p role="alert" className="w-full text-[11px] text-warn">{urlImportError}</p>}
        </form>
      )}
      {mention && mentionResults.length > 0 && (
        <div role="listbox" aria-label="Fichiers du projet" className="absolute bottom-full mb-1 left-2 w-[420px] max-w-[90%] rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] py-1 z-[var(--z-overlay)]">
          {mentionResults.map((f, i) => (
            <button key={f} type="button" role="option" aria-selected={i === mentionActive} onMouseDown={(e) => (e.preventDefault(), insertMention(f))} className={cx('w-full flex items-center gap-2 px-3 h-7 text-left text-[12px] font-mono cursor-pointer', i === mentionActive ? 'bg-raised text-fg' : 'text-muted')}>
              <FileIcon className="w-3.5 h-3.5 text-leaf shrink-0" />
              <span className="truncate">{f}</span>
            </button>
          ))}
        </div>
      )}
      {slashResults.length > 0 && (
        <div role="listbox" aria-label="Commandes et skills" className="absolute bottom-full mb-1 left-2 w-[520px] max-w-[95%] rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] py-1 z-[var(--z-overlay)]">
          {slashResults.map((k, i) => (
            <button key={k.name} type="button" role="option" aria-selected={i === slashActive} onMouseDown={(e) => (e.preventDefault(), pickSkill(k.name))} className={cx('w-full flex items-baseline gap-2 px-3 py-1.5 text-left cursor-pointer', i === slashActive ? 'bg-raised' : '')}>
              <span className="font-mono text-[12px] text-fg shrink-0">/{k.name}</span>
              <span className="text-[10.5px] text-faint shrink-0 uppercase tracking-wide">{k.kind}</span>
              <span className="text-[11.5px] text-muted truncate">{k.description}</span>
            </button>
          ))}
        </div>
      )}
      {templatesOpen && (
        <div role="menu" aria-label="Modèles de demande" className="absolute bottom-full mb-1 left-2 w-[360px] rounded-[var(--radius-md)] border border-line bg-panel shadow-[var(--shadow-2)] py-1 z-[var(--z-overlay)]">
          {TEMPLATES.map((tp) => (
            <button
              key={tp.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setText(tp.text);
                setTemplatesOpen(false);
                requestAnimationFrame(() => area.current?.focus());
              }}
              className="w-full text-left px-3 py-1.5 text-[12.5px] text-muted hover:text-fg hover:bg-raised cursor-pointer"
            >
              {tp.label}
            </button>
          ))}
        </div>
      )}
      {contextOpen && (
        <div role="dialog" aria-label="Fenêtre de contexte et mémoire virtuelle MAZZ" className="absolute bottom-full mb-1.5 right-2 w-[450px] max-w-[96vw] rounded-[var(--radius-lg)] border border-line bg-panel shadow-[var(--shadow-2)] p-3.5 space-y-3 z-[var(--z-overlay)]">
          <div className="flex items-center gap-2 text-fg"><Layers className="w-4 h-4" />Contexte réellement observé</div>
          <p className="text-[12px] text-muted">Fenêtre native active : {nativeContext === null ? 'runtime local arrêté ou non mesuré' : `${nativeContext.toLocaleString('fr-FR')} tokens`}. Le réglage se modifie dans le Model Hub et s’applique au lancement du modèle.</p>
          <p className="text-[12px] text-muted">Dernière entrée mesurée de cette session : {lastPrompt === null ? 'aucun compteur runtime disponible' : `${lastPrompt.toLocaleString('fr-FR')} tokens`}. Le brouillon et les prochains documents ne sont pas encore inclus.</p>
          <div className="border-t border-line pt-2 space-y-2">
            <div className="flex gap-2 items-center text-[12px]"><Database className="w-4 h-4" />Mémoire externe sur disque</div>
            <p className="text-[12px] text-muted">Corpus compté par tokenizer GGUF : {virtualTokens === null ? 'non mesuré' : `${virtualTokens.toLocaleString('fr-FR')} tokens`}. Ce corpus externe reste distinct de la fenêtre native.</p>
            <p className="text-[11px] text-faint">{virtualChunks === null ? 'Nombre de passages non disponible' : `${virtualChunks.toLocaleString('fr-FR')} passages externes/canoniques indexés`}. Le comptage porte sur les documents dont l’empreinte correspond encore à l’index.</p>
            <Button size="xs" disabled={running || counting || nativeContext === null} onClick={() => void measureProjectTokens()}>{counting ? 'Comptage du projet en cours…' : 'Indexer et compter ce projet au tokenizer GGUF'}</Button>
            {contextError && <p role="alert" className="text-warn text-[12px]">{contextError}</p>}
          </div>
          {onCompactSession && sessionTurnsCount > 1 && <Button size="xs" variant="secondary" icon={<Minimize2 className="w-3 h-3" />} onClick={() => {setContextOpen(false); onCompactSession();}}>Compacter (/compact)</Button>}
        </div>
      )}
      <textarea
        ref={area}
        value={text}
        onChange={(e) => {
          setPromptSubmitError('');
          onChange(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        rows={2}
        placeholder={disabledReason ? disabledReason : running && onQueue ? 'L’agent travaille : votre message partira à la fin de l’échange.' : 'Décrivez la tâche. @ cite un fichier, / charge un skill, glissez des fichiers pour les joindre.'}
        aria-label="Message pour l’agent"
        className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] text-fg placeholder:text-faint focus:outline-none leading-relaxed"
      />
      {requiresDiskBackedPrompt(text.trim()) && (
        <p role="status" className="px-3.5 pb-1 text-[11px] text-muted">
          Demande longue ({text.trim().length.toLocaleString('fr-FR')} caractères) : elle sera conservée dans une pièce jointe texte et lue par pages, sans troncature.
        </p>
      )}
      {promptSubmitError && <p role="alert" className="px-3.5 pb-1 text-[11px] text-warn">{promptSubmitError}</p>}
      <div className="flex items-center gap-2 px-2 pb-2 pt-1 flex-wrap">
        <Segmented<AgentMode> label="Mode de l’agent" value={mode} onChange={onModeChange} options={[...MODES]} />
        <ModelPicker value={model} onChange={onModelChange} />
        <IconButton label="Joindre des fichiers (texte, code, PDF, DOCX, images, tout type)" onClick={() => fileInput.current?.click()}>
          <Paperclip className="w-4 h-4" />
        </IconButton>
        <IconButton label="Joindre une page Web publique" active={urlFormOpen} disabled={running} onClick={() => { setUrlFormOpen((open) => !open); setUrlImportError(''); }}>
          <Link2 className="w-4 h-4" />
        </IconButton>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <IconButton label="Citer un fichier (@)" onClick={() => onChange(text + '@', text.length + 1)}>
          <AtSign className="w-4 h-4" />
        </IconButton>
        <IconButton label="Modèles de demande" active={templatesOpen} onClick={() => setTemplatesOpen((o) => !o)}>
          <BookText className="w-4 h-4" />
        </IconButton>
        <button
          type="button"
          onClick={() => setContextOpen((o) => !o)}
          aria-expanded={contextOpen}
          title="Afficher les compteurs réellement mesurés du contexte et de la mémoire externe"
          className={cx(
            'inline-flex items-center gap-2 h-7 px-2.5 rounded-[var(--radius-md)] border text-[11.5px] cursor-pointer transition-colors',
            contextOpen
              ? 'border-brand bg-raised text-fg'
              : needsCompaction
              ? 'border-warn/50 bg-warn/5 text-warn'
              : 'border-line bg-sunk text-muted hover:text-fg hover:border-line-strong'
          )}
        >
          <Layers className="w-3.5 h-3.5 text-brand shrink-0" />
          <span className="font-mono tabular">{windowLimit ? `${windowLimit.limit.toLocaleString('fr-FR')} ${windowLimit.source === 'runtime' ? 'nat.' : 'spéc.'}` : 'Contexte N/D'}</span>
          <span className="w-12 h-1.5 rounded-full bg-code overflow-hidden border border-line shrink-0">
            <span
              className={cx('block h-full', needsCompaction ? 'bg-warn' : 'bg-brand')}
              style={{ width: `${Math.min(100, Math.max(0, usagePct ?? 0))}%` }}
            />
          </span>
          <span className="font-mono text-[11px] tabular">{usagePct === null ? 'N/D' : `${usagePct}%`} </span>
          <span className="hidden sm:inline text-[10.5px] text-leaf font-mono border-l border-line pl-1.5">
            {virtualTokens === null ? 'virt. non mesuré' : `${(virtualTokens / 1_000_000).toFixed(2)}M virt.`}
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {preparingLongPrompt && <span className="text-[11px] text-faint">Préparation…</span>}
          <span className="hidden lg:inline text-[11px] text-faint">
            <Kbd>Entrée</Kbd> {running && onQueue ? 'mettre en file' : 'envoyer'}
          </span>
          <button
            id="composer-primary"
            type="button"
            data-action={running ? 'session.stop' : 'session.send'}
            className={running ? 'btn-stop-message' : 'btn-send-message'}
            aria-label={running ? 'Arrêter' : 'Envoyer'}
            title={
              running
                ? 'Arrêter l’exécution'
                : uploading
                ? 'Envoi des pièces jointes en cours'
                : disabledReason || 'Envoyer (Entrée)'
            }
            disabled={!running && (!text.trim() || !!disabledReason || uploading || preparingLongPrompt)}
            onClick={() => {
              if (running) {
                onStop();
              } else {
                void submit();
              }
            }}
          >
            {running ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <ArrowUp className="w-4 h-4 stroke-[2.5]" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
