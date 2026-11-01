import { useState } from 'react';
import { FolderPlus, X } from 'lucide-react';
import type { SessionRecord, StudioSettings } from '../../lib/types';
import { navigate } from '../../lib/store';
import { Button, Dialog, IconButton, Segmented } from '../../components/ui';
import { PathPicker } from '../../components/overlays';

export type SessionPermissionMode = NonNullable<SessionRecord['permissionMode']>;

export const PERMISSION_MODES: Array<{ value: SessionPermissionMode; label: string; hint: string }> = [
  { value: 'default', label: 'Standard', hint: 'Les permissions des Paramètres s’appliquent : l’agent demande avant d’écrire, d’exécuter ou de sortir du projet.' },
  { value: 'acceptEdits', label: 'Accepter les modifications', hint: 'Création, modification et suppression de fichiers sans confirmation. Commandes, Git, MCP et accès hors projet restent soumis aux permissions.' },
  { value: 'bypass', label: 'Sans confirmation', hint: 'Aucune demande dans cette session, y compris pour les dossiers hors projet. Les permissions réglées sur « Refuser » et les dossiers protégés restent bloqués. Les points de restauration permettent d’annuler les fichiers modifiés.' },
];

/** Editable list of absolute folders (trusted folders, session folders, protected folders). */
export function FolderListEditor({ folders, onChange, empty, addLabel = 'Ajouter un dossier' }: { folders: string[]; onChange: (next: string[]) => Promise<void> | void; empty: string; addLabel?: string }) {
  const [picker, setPicker] = useState(false);
  return (
    <div className="space-y-1.5">
      {folders.length === 0 && <div className="text-[12px] text-faint">{empty}</div>}
      {folders.map((f) => (
        <div key={f} className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-sunk px-2 h-8">
          <span className="flex-1 truncate font-mono text-[12px]" title={f}>
            {f}
          </span>
          <IconButton label={`Retirer ${f}`} onClick={() => void onChange(folders.filter((x) => x !== f))}>
            <X className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" icon={<FolderPlus className="w-3.5 h-3.5" />} onClick={() => setPicker(true)}>
        {addLabel}
      </Button>
      <PathPicker open={picker} mode="folder" title={addLabel} onClose={() => setPicker(false)} onPick={(p) => void (folders.includes(p) ? undefined : onChange([...folders, p]))} />
    </div>
  );
}

/** Per-session access: permission mode and folders added to the session. */
export function AccessDialog({ open, onClose, session, settings, onPatch }: { open: boolean; onClose: () => void; session: SessionRecord; settings: StudioSettings; onPatch: (patch: Record<string, unknown>) => Promise<void> }) {
  const mode = session.permissionMode ?? 'default';
  const access = settings.access;
  return (
    <Dialog open={open} onClose={onClose} title="Accès et autorisations de la session" width={600} description="Ces réglages s’appliquent à tous les modèles, locaux ou API : le contrôle est fait par le Studio avant chaque outil.">
      <div className="space-y-5">
        <section className="space-y-2">
          <h3 className="text-[12.5px] font-medium text-fg">Mode d’autorisation</h3>
          <Segmented label="Mode d’autorisation" value={mode} onChange={(v) => void onPatch({ permissionMode: v })} options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <p className="text-[12px] text-muted">{PERMISSION_MODES.find((m) => m.value === mode)?.hint}</p>
        </section>
        <section className="space-y-2">
          <h3 className="text-[12.5px] font-medium text-fg">Dossiers de la session</h3>
          <p className="text-[12px] text-muted">
            Projet : <span className="font-mono">{session.projectRoot}</span>. Les dossiers ajoutés ici sont accessibles sans demande dans cette session (lecture, écriture selon les permissions, commandes).
          </p>
          {access.mode === 'project' && <p className="text-[12px] text-warn">Accès au PC réglé sur « Projet uniquement » : ces dossiers sont ignorés tant que ce réglage n’est pas changé.</p>}
          <FolderListEditor folders={session.extraRoots ?? []} onChange={(next) => onPatch({ extraRoots: next })} empty="Aucun dossier ajouté." />
        </section>
        <section className="text-[12px] text-muted">
          Accès au PC : <strong className="text-fg">{access.mode === 'full' ? 'complet' : access.mode === 'ask' ? 'sur demande' : 'projet uniquement'}</strong>, {access.extraRoots.length} dossier(s) de confiance.{' '}
          <button
            type="button"
            className="text-brand hover:underline cursor-pointer"
            onClick={() => {
              onClose();
              navigate('settings', 'access');
            }}
          >
            Modifier dans les Paramètres
          </button>
        </section>
      </div>
    </Dialog>
  );
}
