import { lazy, Suspense, useEffect, useState } from 'react';
import { Circle, ExternalLink, GitCompare, RotateCcw, Save, Undo2, X, FileCode2 } from '../../components/icons';
import { useApp, toast } from '../../lib/store';
import { api, errorMessage } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { Button, ConfirmDialog, EmptyState, ErrorBox, IconButton, Spinner, cx } from '../../components/ui';
import { DiffView } from '../../components/DiffView';
// CodeMirror (about 270 kB gzip) loads when a file is opened, not with the file tree.
const Editor = lazy(() => import('./Editor').then((m) => ({ default: m.Editor })));
import { CodeIndexPanel } from './CodeIndexPanel';
import { closeFile, isDirty, openFile, reloadFile, saveFile, setActive, updateFile, useCode } from './codeStore';

export default function CodeView() {
  const viewParam = useApp((s) => s.viewParam);
  const editorSettings = useApp((s) => s.settings?.editor);
  const files = useCode((s) => s.files);
  const active = useCode((s) => s.active);
  const [compare, setCompare] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const current = files.find((f) => f.path === active);

  useEffect(() => {
    if (viewParam) void openFile(viewParam);
  }, [viewParam]);

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    const dirty = files.some(isDirty);
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [files]);

  const requestClose = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (f && isDirty(f)) setClosing(path);
    else closeFile(path);
  };

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <CodeIndexPanel />
        <div className="flex-1 grid place-items-center p-8">
          <EmptyState icon={<FileCode2 className="w-8 h-8" />} title="Aucun fichier ouvert">
            Sélectionnez un fichier dans l’explorateur, ou actualisez l’index pour rechercher un symbole dans tout le projet.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <CodeIndexPanel />
      <div role="tablist" aria-label="Fichiers ouverts" className="shrink-0 flex items-stretch h-9 border-b border-line bg-panel overflow-x-auto [scrollbar-width:thin]">
        {files.map((f) => {
          const dirty = isDirty(f);
          const name = f.path.split('/').pop();
          return (
            <div key={f.path} role="tab" aria-selected={f.path === active} className={cx('group flex items-center gap-1.5 pl-3 pr-1 border-r border-line text-[12.5px] whitespace-nowrap cursor-pointer', f.path === active ? 'bg-bg text-fg border-t-2 border-t-brand' : 'text-muted hover:text-fg')} onClick={() => setActive(f.path)} onAuxClick={(e) => e.button === 1 && requestClose(f.path)} title={f.path}>
              <span>{name}</span>
              <button type="button" aria-label={dirty ? `Fermer ${name} (non enregistré)` : `Fermer ${name}`} onClick={(e) => (e.stopPropagation(), requestClose(f.path))} className="w-5 h-5 grid place-items-center rounded hover:bg-raised cursor-pointer">
                {dirty ? <Circle className="w-2.5 h-2.5 fill-current text-brand group-hover:hidden" /> : null}
                <X className={cx('w-3.5 h-3.5', dirty && 'hidden group-hover:block')} />
              </button>
            </div>
          );
        })}
      </div>
      {current && (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-line text-[12px] text-muted">
            <span className="font-mono truncate">{current.path}</span>
            {current.sizeBytes !== undefined && <span className="text-faint">{fmtBytes(current.sizeBytes)}</span>}
            <div className="ml-auto flex items-center gap-1">
              <Button size="xs" variant="ghost" icon={<GitCompare className="w-3 h-3" />} onClick={() => setCompare((c) => !c)} disabled={!isDirty(current)} aria-pressed={compare}>
                Comparer
              </Button>
              <Button size="xs" variant="ghost" icon={<Undo2 className="w-3 h-3" />} disabled={!isDirty(current)} onClick={() => setConfirmRevert(true)}>
                Annuler les modifications
              </Button>
              <IconButton size="sm" label="Recharger depuis le disque" onClick={() => reloadFile(current.path)}>
                <RotateCcw className="w-3.5 h-3.5" />
              </IconButton>
              <IconButton
                size="sm"
                label="Ouvrir dans VS Code"
                onClick={() =>
                  api
                    .post('/api/open-in-editor', { path: current.path })
                    .then(() => toast('info', 'Ouverture demandée à VS Code'))
                    .catch((e) => toast('bad', 'VS Code indisponible', errorMessage(e)))
                }
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </IconButton>
              <Button size="xs" variant="primary" icon={<Save className="w-3 h-3" />} disabled={!isDirty(current)} onClick={() => saveFile(current.path)}>
                Enregistrer
              </Button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {current.loading && (
              <div className="p-4 flex items-center gap-2 text-[12.5px] text-muted">
                <Spinner /> Lecture du fichier
              </div>
            )}
            {current.error && (
              <div className="p-4">
                <ErrorBox error={current.error} onRetry={() => reloadFile(current.path)} />
              </div>
            )}
            {current.binary && <div className="p-6 text-[13px] text-muted">Fichier binaire : non affiché dans l’éditeur.</div>}
            {current.tooLarge && <div className="p-6 text-[13px] text-muted">Fichier supérieur à 2 Mo : ouverture désactivée pour préserver la mémoire.</div>}
            {!current.loading && !current.error && !current.binary && !current.tooLarge &&
              (compare && isDirty(current) ? (
                <div className="h-full overflow-auto p-3">
                  <DiffView oldText={current.original} newText={current.content} defaultMode="split" maxHeight={10000} />
                </div>
              ) : (
                <Suspense fallback={<div className="p-4"><Spinner size={14} /></div>}><Editor key={current.path} path={current.path} value={current.content} onChange={(v) => updateFile(current.path, { content: v })} onSave={() => saveFile(current.path)} tabSize={editorSettings?.tabSize ?? 2} wordWrap={editorSettings?.wordWrap ?? false} /></Suspense>
              ))}
          </div>
        </>
      )}
      <ConfirmDialog
        open={closing !== null}
        title="Fermer sans enregistrer ?"
        confirmLabel="Fermer sans enregistrer"
        danger
        onClose={() => setClosing(null)}
        onConfirm={() => {
          closeFile(closing!);
        }}
      >
        Les modifications de {closing} seront perdues.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmRevert}
        title="Annuler les modifications ?"
        confirmLabel="Annuler les modifications"
        danger
        onClose={() => setConfirmRevert(false)}
        onConfirm={() => {
          if (current) updateFile(current.path, { content: current.original });
        }}
      >
        Le contenu revient à la dernière version enregistrée.
      </ConfirmDialog>
    </div>
  );
}
