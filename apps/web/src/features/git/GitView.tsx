import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitCommitHorizontal, Minus, Plus, RefreshCw, Sparkles, Undo2 } from '../../components/icons';
import { api, errorMessage, qs } from '../../lib/api';
import type { GitFileStatus, GitStatus } from '../../lib/types';
import { refreshHealth, toast, useApp } from '../../lib/store';
import { fmtRelative } from '../../lib/format';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorBox, IconButton, Spinner, Tabs, useAsync, cx } from '../../components/ui';
import { DiffView } from '../../components/DiffView';
import { GitRemoteBar } from './GitRemoteBar';

const LABEL: Record<string, string> = { M: 'modifié', A: 'ajouté', D: 'supprimé', R: 'renommé', C: 'copié', U: 'conflit', '?': 'non suivi' };

function Row({ f, staged, selected, onSelect, onStage, onUnstage, onDiscard }: { f: GitFileStatus; staged: boolean; selected: boolean; onSelect: () => void; onStage?: () => void; onUnstage?: () => void; onDiscard?: () => void }) {
  const code = staged ? f.index : f.worktree === ' ' ? f.index : f.worktree;
  return (
    <li className={cx('group flex items-center gap-2 px-2 h-7 rounded cursor-pointer text-[12.5px]', selected ? 'bg-raised text-fg' : 'text-muted hover:bg-raised/60')} onClick={onSelect}>
      <span className={cx('w-4 text-center font-mono text-[11px]', code === 'D' ? 'text-bad' : code === '?' || code === 'A' ? 'text-good' : 'text-warn')} title={LABEL[code] ?? code}>
        {code === '?' ? 'U' : code}
      </span>
      <span className="truncate flex-1 font-mono text-[12px]">{f.path}</span>
      <span className="hidden group-hover:flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        {onDiscard && (
          <IconButton size="sm" label="Annuler les modifications" onClick={onDiscard}>
            <Undo2 className="w-3.5 h-3.5" />
          </IconButton>
        )}
        {onStage && (
          <IconButton size="sm" label="Indexer (stage)" onClick={onStage}>
            <Plus className="w-3.5 h-3.5" />
          </IconButton>
        )}
        {onUnstage && (
          <IconButton size="sm" label="Retirer de l’index" onClick={onUnstage}>
            <Minus className="w-3.5 h-3.5" />
          </IconButton>
        )}
      </span>
    </li>
  );
}

export default function GitView() {
  const viewParam = useApp((s) => s.viewParam);
  const workspace = useApp((s) => s.health?.workspace.workspaceRoot);
  const [nonce, setNonce] = useState(0);
  const status = useAsync((signal) => api.get<GitStatus>('/api/git/status', signal), [nonce, workspace]);
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [discard, setDiscard] = useState<string | null>(null);
  const [tab, setTab] = useState<'changes' | 'log'>('changes');
  const log = useAsync((signal) => (tab === 'log' ? api.get<Array<{ hash: string; author: string; date: number; subject: string }>>('/api/git/log?limit=80', signal) : Promise.resolve([])), [tab, nonce]);

  const staged = useMemo(() => status.data?.files.filter((f) => f.index !== ' ' && f.index !== '?') ?? [], [status.data]);
  const unstaged = useMemo(() => status.data?.files.filter((f) => f.worktree !== ' ' || f.index === '?') ?? [], [status.data]);

  useEffect(() => {
    if (viewParam) setSelected({ path: viewParam, staged: false });
  }, [viewParam]);

  const diff = useAsync(
    (signal) => (selected ? api.get<{ patch: string; untrackedContent?: string; binary: boolean }>(`/api/git/diff${qs({ path: selected.path, staged: selected.staged ? 1 : undefined })}`, signal) : Promise.resolve(null)),
    [selected?.path, selected?.staged, nonce]
  );

  const run = async (name: string, body: object, ok: string) => {
    setBusy(true);
    try {
      await api.post(`/api/git/${name}`, body);
      toast('good', ok);
      setNonce((n) => n + 1);
      void refreshHealth();
    } catch (e) {
      toast('bad', 'Opération Git refusée', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (status.data && !status.data.isRepo) {
    return (
      <div className="h-full grid place-items-center p-8">
        <EmptyState icon={<GitBranch className="w-8 h-8" />} title="Ce projet n’est pas un dépôt Git">
          {status.data.error ?? 'Initialisez un dépôt depuis le terminal (git init) pour suivre les modifications ici.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="h-full flex min-h-0">
      <div className="w-[340px] shrink-0 border-r border-line flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 h-10 border-b border-line">
          <GitBranch className="w-4 h-4 text-brand" />
          <span className="font-mono text-[12.5px] text-fg truncate">{status.data?.branch ?? '...'}</span>
          {status.data?.upstream && (
            <span className="text-[11px] text-faint">
              {status.data.ahead ? `+${status.data.ahead}` : ''} {status.data.behind ? `-${status.data.behind}` : ''}
            </span>
          )}
          <IconButton size="sm" label="Actualiser" className="ml-auto" onClick={() => setNonce((n) => n + 1)}>
            {status.loading ? <Spinner size={12} /> : <RefreshCw className="w-3.5 h-3.5" />}
          </IconButton>
        </div>
        {status.data?.isRepo && <GitRemoteBar branch={status.data.branch} onChanged={() => setNonce((n) => n + 1)} />}
        <Tabs<'changes' | 'log'> className="px-2" value={tab} onChange={setTab} tabs={[{ id: 'changes', label: 'Modifications', count: status.data?.files.length }, { id: 'log', label: 'Historique' }]} />
        {status.error != null && (
          <div className="p-3">
            <ErrorBox error={status.error} onRetry={status.reload} />
          </div>
        )}
        {tab === 'changes' ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-3">
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Indexés ({staged.length})</span>
                {staged.length > 0 && (
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => run('unstage', { paths: staged.map((f) => f.path) }, 'Fichiers retirés de l’index')}>
                    Tout retirer
                  </Button>
                )}
              </div>
              <ul>
                {staged.map((f) => (
                  <Row key={`s${f.path}`} f={f} staged selected={selected?.path === f.path && selected.staged} onSelect={() => setSelected({ path: f.path, staged: true })} onUnstage={() => run('unstage', { paths: [f.path] }, 'Retiré de l’index')} />
                ))}
              </ul>
            </div>
            <div>
              <div className="flex items-center justify-between px-2 mb-1">
                <span className="text-[11px] uppercase tracking-[0.1em] text-faint">Modifications ({unstaged.length})</span>
                {unstaged.length > 0 && (
                  <Button size="xs" variant="ghost" disabled={busy} onClick={() => run('stage', { paths: unstaged.map((f) => f.path) }, 'Fichiers indexés')}>
                    Tout indexer
                  </Button>
                )}
              </div>
              <ul>
                {unstaged.map((f) => (
                  <Row
                    key={`u${f.path}`}
                    f={f}
                    staged={false}
                    selected={selected?.path === f.path && !selected.staged}
                    onSelect={() => setSelected({ path: f.path, staged: false })}
                    onStage={() => run('stage', { paths: [f.path] }, 'Fichier indexé')}
                    onDiscard={f.index === '?' ? undefined : () => setDiscard(f.path)}
                  />
                ))}
              </ul>
              {status.data && status.data.files.length === 0 && <p className="px-2 text-[12px] text-faint">Arbre de travail propre.</p>}
            </div>
          </div>
        ) : (
          <ul className="flex-1 overflow-y-auto p-2 space-y-1">
            {log.loading && <Spinner />}
            {log.data?.map((c) => (
              <li key={c.hash} className="px-2 py-1.5 rounded hover:bg-raised/60">
                <div className="text-[12.5px] text-fg truncate">{c.subject}</div>
                <div className="text-[11px] text-faint">
                  <span className="font-mono">{c.hash.slice(0, 8)}</span> - {c.author} - {fmtRelative(c.date)}
                </div>
              </li>
            ))}
            {log.data?.length === 0 && !log.loading && <p className="text-[12px] text-faint">Aucun commit.</p>}
          </ul>
        )}
        <form
          className="p-2 border-t border-line space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!message.trim() || !staged.length) return;
            void run('commit', { message }, 'Commit créé').then(() => setMessage(''));
          }}
        >
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Message de commit" aria-label="Message de commit" className="w-full resize-none rounded-md bg-sunk border border-line px-2.5 py-2 text-[12.5px] placeholder:text-faint focus:outline-none focus:border-brand/60" />
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            icon={<Sparkles className="w-3.5 h-3.5" />}
            disabled={!staged.length}
            loading={suggesting}
            title="Rédigé par le modèle des tâches auxiliaires (Paramètres, IA) à partir du diff indexé"
            onClick={async () => {
              setSuggesting(true);
              try {
                const r = await api.post<{ message: string; modelId: string; durationMs: number }>('/api/git/suggest-message', {});
                setMessage(r.message);
                toast('info', 'Message proposé', `${r.modelId} en ${(r.durationMs / 1000).toFixed(1)} s : relisez-le avant de valider.`);
              } catch (e) {
                toast('bad', 'Proposition impossible', errorMessage(e));
              } finally {
                setSuggesting(false);
              }
            }}
          >
            Proposer un message
          </Button>
          <Button type="submit" variant="primary" size="sm" className="w-full" icon={<GitCommitHorizontal className="w-3.5 h-3.5" />} disabled={!message.trim() || !staged.length} loading={busy}>
            Valider {staged.length} fichier(s)
          </Button>
        </form>
      </div>
      <div className="flex-1 min-w-0 overflow-auto p-4">
        {!selected && (
          <EmptyState title="Sélectionnez un fichier" decorative={false}>
            Le diff s’affiche ici, en mode unifié ou côte à côte. Les opérations Git respectent le centre de permissions.
          </EmptyState>
        )}
        {selected && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-fg">{selected.path}</span>
              <Badge tone={selected.staged ? 'info' : 'warn'}>{selected.staged ? 'Indexé' : 'Non indexé'}</Badge>
            </div>
            {diff.loading && <Spinner />}
            {diff.error != null && <ErrorBox error={diff.error} />}
            {diff.data?.binary && <p className="text-[12.5px] text-muted">Fichier binaire.</p>}
            {diff.data?.untrackedContent !== undefined && <DiffView oldText={null} newText={diff.data.untrackedContent} maxHeight={2000} />}
            {diff.data?.patch !== undefined && diff.data.untrackedContent === undefined && !diff.data.binary && <DiffView patch={diff.data.patch} maxHeight={2000} />}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={!!discard}
        danger
        title="Annuler les modifications locales ?"
        confirmLabel="Annuler les modifications"
        onClose={() => setDiscard(null)}
        onConfirm={async () => {
          await api.post('/api/git/discard', { paths: [discard] });
          setNonce((n) => n + 1);
          toast('good', 'Modifications annulées', discard!);
        }}
      >
        {discard} revient à sa version indexée (git restore). Cette action ne peut pas être annulée depuis le Studio.
      </ConfirmDialog>
    </div>
  );
}
