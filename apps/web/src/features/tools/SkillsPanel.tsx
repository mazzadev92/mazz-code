import { useState } from 'react';
import { Plus, RefreshCw, Search, Trash2 } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { saveSettings, toast, useApp } from '../../lib/store';
import { Badge, Button, Card, ConfirmDialog, Dialog, ErrorBox, Field, Input, Skeleton, Toggle, useAsync } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { FolderListEditor } from '../agent/AccessDialog';
import { RemoteSkillImport } from './RemoteSkillImport';

interface SkillProvenance {
  sourceUrl: string;
  finalUrl: string;
  importedAt: string;
  fetchedAt: string;
  archiveSha256: string;
}

export interface SkillItem {
  name: string;
  description: string;
  source: string;
  sourceLabel: string;
  dir: string;
  provenance?: SkillProvenance;
}

/** Skills (SKILL.md format of Claude Code, Codex, Antigravity): sources, list, reading, creation. */
export function SkillsPanel() {
  const settings = useApp((s) => s.settings);
  const [rescan, setRescan] = useState(0);
  const list = useAsync((signal) => api.get<{ skills: SkillItem[] }>(`/api/skills${rescan ? '?rescan=1' : ''}`, signal), [rescan]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const detail = useAsync((signal) => (open ? api.get<{ skill: SkillItem; body: string; files: string[] }>(`/api/skills/${encodeURIComponent(open)}`, signal) : Promise.resolve(undefined)), [open]);

  const q = query.toLowerCase();
  const items = (list.data?.skills ?? []).filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
  const sk = settings?.skills;
  const saveSk = async (patch: Record<string, unknown>) => {
    try {
      await saveSettings({ skills: patch });
      setRescan((n) => n + 1);
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Sources des skills" subtitle="Un skill est un dossier contenant un SKILL.md (nom, description, instructions) et ses fichiers de référence. Format commun à Claude Code, Codex et Antigravity.">
        {sk && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-6">
              <Toggle checked={sk.includeClaude} onChange={(v) => void saveSk({ includeClaude: v })} label="Lire les skills de Claude Code (~/.claude/skills et .claude/skills du projet)" />
              <Toggle checked={sk.autoSuggest} onChange={(v) => void saveSk({ autoSuggest: v })} label="Proposer automatiquement les skills pertinents à l’agent" />
            </div>
            <p className="text-[12px] text-muted">Toujours lus : le dossier skills du Studio et .mazz/skills du projet. Dans la conversation, « /nom-du-skill demande » charge un skill explicitement.</p>
            <FolderListEditor folders={sk.folders} onChange={(next) => saveSk({ folders: next })} empty="Aucun dossier supplémentaire." addLabel="Ajouter un dossier de skills" />
          </div>
        )}
      </Card>
      <RemoteSkillImport onInstalled={() => setRescan((n) => n + 1)} />
      <Card
        title={`Skills disponibles${list.data ? ` (${list.data.skills.length})` : ''}`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => setRescan((n) => n + 1)}>
              Relire
            </Button>
            <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreating(true)}>
              Nouveau skill
            </Button>
          </div>
        }
      >
        <div className="relative mb-3 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filtrer les skills" className="pl-8" aria-label="Filtrer les skills" />
        </div>
        {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.loading && !list.data && <Skeleton />}
        {list.data && items.length === 0 && <div className="text-[12.5px] text-faint">Aucun skill trouvé.</div>}
        <div className="divide-y divide-line max-h-[520px] overflow-auto">
          {items.map((s) => (
            <div key={s.name} className="flex items-start gap-3 py-2">
              <button type="button" className="flex-1 min-w-0 text-left cursor-pointer group" onClick={() => setOpen(s.name)}>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] text-fg group-hover:text-brand">{s.name}</span>
                  <Badge>{s.sourceLabel}</Badge>
                  {s.provenance && <Badge tone="info">Importé · SHA-256 vérifié</Badge>}
                </div>
                <div className="text-[12px] text-muted line-clamp-2">{s.description || 'Pas de description.'}</div>
              </button>
              {s.source === 'studio' && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} onClick={() => setRemoving(s.name)} aria-label={`Supprimer ${s.name}`} />
              )}
            </div>
          ))}
        </div>
      </Card>

      <Dialog open={open !== null} onClose={() => setOpen(null)} title={open ?? ''} width={760} description={detail.data?.skill.dir}>
        {detail.error != null && <ErrorBox error={detail.error} />}
        {detail.loading && <Skeleton lines={6} />}
        {detail.data && (
          <div className="space-y-3 max-h-[60vh] overflow-auto">
            <Markdown text={detail.data.body} />
            {detail.data.skill.provenance && (
              <div className="space-y-1 rounded border border-line bg-sunk p-2 text-[11px] text-muted">
                <div>Source : <span className="break-all font-mono text-fg">{detail.data.skill.provenance.sourceUrl}</span></div>
                {detail.data.skill.provenance.finalUrl !== detail.data.skill.provenance.sourceUrl && <div>Destination finale : <span className="break-all font-mono text-fg">{detail.data.skill.provenance.finalUrl}</span></div>}
                <div>Empreinte SHA-256 du paquet : <span className="break-all font-mono text-fg">{detail.data.skill.provenance.archiveSha256}</span></div>
                <div>Installé le : <span className="font-mono text-fg">{new Date(detail.data.skill.provenance.importedAt).toLocaleString()}</span></div>
              </div>
            )}
            {detail.data.files.length > 0 && (
              <div className="text-[12px] text-muted">
                Fichiers de référence : <span className="font-mono">{detail.data.files.join(', ')}</span>
              </div>
            )}
          </div>
        )}
      </Dialog>

      <CreateSkillDialog open={creating} onClose={() => setCreating(false)} onCreated={() => setRescan((n) => n + 1)} />

      <ConfirmDialog
        open={removing !== null}
        danger
        title={`Supprimer le skill ${removing ?? ''} ?`}
        confirmLabel="Supprimer"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          await api.del(`/api/skills/${encodeURIComponent(removing!)}`);
          setRemoving(null);
          setRescan((n) => n + 1);
        }}
      >
        Le dossier du skill est supprimé du dossier skills du Studio.
      </ConfirmDialog>
    </div>
  );
}

function CreateSkillDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/skills', { name, description, body });
      toast('good', 'Skill créé', name);
      setName('');
      setDescription('');
      setBody('');
      onCreated();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nouveau skill"
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} disabled={!name || !description || !body} onClick={() => void submit()}>
            Créer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Nom" hint="Minuscules, chiffres et tirets. Utilisable avec /nom dans la conversation.">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="revue-securite-c" className="font-mono" />
        </Field>
        <Field label="Description" hint="Quand utiliser ce skill : c’est ce texte qui permet à l’agent de le choisir.">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Instructions (Markdown)">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="w-full rounded-[var(--radius-sm)] border border-line bg-sunk p-2 font-mono text-[12px] text-fg focus:outline-none focus:border-brand" />
        </Field>
        {error != null && <ErrorBox error={error} />}
      </div>
    </Dialog>
  );
}
