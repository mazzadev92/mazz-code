import { useState } from 'react';
import { Plus, Trash2 } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../lib/store';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, Dialog, ErrorBox, Field, Input, Segmented, Select, Skeleton, useAsync } from '../../components/ui';

type MemoryScope = 'global' | 'project';

interface MemoryEntry {
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'episodic' | 'procedural' | 'quality';
  scope: MemoryScope;
  version: number;
  integrity: 'verified' | 'legacy' | 'modified';
  updatedAt: number;
}

const TYPE_LABEL: Record<MemoryEntry['type'], string> = { user: 'Utilisateur', feedback: 'Consigne', project: 'Projet', reference: 'Référence', episodic: 'Épisodique', procedural: 'Procédural', quality: 'Qualité' };

/** Persistent memory of the agent: facts kept between sessions, editable here. */
export function AgentMemoryCard() {
  const [nonce, setNonce] = useState(0);
  const [scope, setScope] = useState<MemoryScope>('project');
  const query = `?scope=${scope}`;
  const list = useAsync((signal) => api.get<{ entries: MemoryEntry[]; dir: string; scope: MemoryScope; workspaceRoot?: string }>(`/api/memory${query}`, signal), [nonce, scope]);
  const [edit, setEdit] = useState<{ name: string; description: string; type: MemoryEntry['type']; content: string; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (name: string) => {
    try {
      const r = await api.get<{ entry: MemoryEntry; content: string }>(`/api/memory/${encodeURIComponent(name)}${query}`);
      setEdit({ name, description: r.entry.description, type: r.entry.type, content: r.content, isNew: false });
    } catch (e) {
      toast('bad', 'Lecture impossible', errorMessage(e));
    }
  };
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      await api.put(`/api/memory/${encodeURIComponent(edit.name)}${query}`, { description: edit.description, type: edit.type, content: edit.content });
      setEdit(null);
      setNonce((n) => n + 1);
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Mémoire de l’agent"
      subtitle={`${scope === 'project' ? `Souvenirs isolés au projet ${list.data?.workspaceRoot ?? ''}` : 'Préférences communes à tous les projets'}. Chaque entrée garde sa version et son empreinte SHA-256. ${list.data ? `Dossier : ${list.data.dir}` : ''}`}
      actions={
        <div className="flex items-center gap-2">
          <Segmented<MemoryScope> label="Portée mémoire" value={scope} onChange={setScope} options={[{ value: 'project', label: 'Projet' }, { value: 'global', label: 'Globale' }]} />
          <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setEdit({ name: '', description: '', type: scope === 'project' ? 'project' : 'user', content: '', isNew: true })}>
            Ajouter
          </Button>
        </div>
      }
    >
      {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.loading && !list.data && <Skeleton />}
      {list.data?.entries.length === 0 && <div className="text-[12.5px] text-faint">Aucun souvenir. L’agent en ajoute quand vous lui demandez de retenir quelque chose.</div>}
      <div className="divide-y divide-line">
        {list.data?.entries.map((e) => (
          <div key={e.name} className="flex items-center gap-3 py-2">
            <button type="button" className="flex-1 min-w-0 text-left cursor-pointer group" onClick={() => void open(e.name)}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12.5px] text-fg group-hover:text-brand">{e.name}</span>
                <Badge>{TYPE_LABEL[e.type]}</Badge>
                <Badge>v{e.version}</Badge>
                {e.integrity === 'modified' && <Badge>Empreinte invalide</Badge>}
                <span className="text-[11px] text-faint">{fmtDate(e.updatedAt)}</span>
              </div>
              <div className="text-[12px] text-muted truncate">{e.description}</div>
            </button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              aria-label={`Supprimer ${e.name}`}
              onClick={async () => {
                await api.del(`/api/memory/${encodeURIComponent(e.name)}${query}`);
                setNonce((n) => n + 1);
              }}
            />
          </div>
        ))}
      </div>
      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit?.isNew ? 'Nouveau souvenir' : `Souvenir : ${edit?.name}`}
        width={620}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Annuler
            </Button>
            <Button variant="primary" loading={busy} disabled={!edit?.name || !edit?.content.trim()} onClick={() => void save()}>
              Enregistrer
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Nom" hint="minuscules-et-tirets">
                <Input value={edit.name} disabled={!edit.isNew} onChange={(ev) => setEdit({ ...edit, name: ev.target.value.toLowerCase() })} className="font-mono" />
              </Field>
              <Field label="Type">
                <Select value={edit.type} onChange={(ev) => setEdit({ ...edit, type: ev.target.value as MemoryEntry['type'] })}>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Description d’une ligne">
              <Input value={edit.description} onChange={(ev) => setEdit({ ...edit, description: ev.target.value })} />
            </Field>
            <Field label="Contenu">
              <textarea value={edit.content} onChange={(ev) => setEdit({ ...edit, content: ev.target.value })} rows={8} className="w-full rounded-[var(--radius-sm)] border border-line bg-sunk p-2 font-mono text-[12px] text-fg focus:outline-none focus:border-brand" />
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}
