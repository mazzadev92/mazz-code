import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitPullRequest, Plus } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { toast } from '../../lib/store';
import { Button, Dialog, ErrorBox, Field, Input, Select, useAsync } from '../../components/ui';

/** Branches, pull/push and GitHub pull requests (gh CLI with the user's own login). */
export function GitRemoteBar({ branch, onChanged }: { branch?: string; onChanged: () => void }) {
  const [nonce, setNonce] = useState(0);
  const branches = useAsync((signal) => api.get<{ current?: string; branches: string[] }>('/api/git/branches', signal), [nonce, branch]);
  const pr = useAsync((signal) => api.get<{ pr: { number: number; title: string; url: string; state: string } | null }>('/api/git/pr', signal), [nonce, branch]);
  const [busy, setBusy] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const [prForm, setPrForm] = useState<{ title: string; body: string } | null>(null);
  const [prError, setPrError] = useState<unknown>(null);

  const run = async (name: string, body: Record<string, unknown> = {}, ok?: string) => {
    setBusy(name);
    try {
      const r = await api.post<{ output: string }>(`/api/git/${name}`, body);
      toast('good', ok ?? 'Terminé', String(r.output ?? '').slice(0, 300));
      setNonce((n) => n + 1);
      onChanged();
      return true;
    } catch (e) {
      toast('bad', `Git : ${name}`, errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line">
      <Select
        value={branches.data?.current ?? ''}
        onChange={(e) => void run('checkout', { branch: e.target.value }, `Branche ${e.target.value}`)}
        aria-label="Changer de branche"
        className="max-w-[150px] font-mono text-[12px]"
      >
        {(branches.data?.branches ?? []).map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </Select>
      <Button size="xs" variant="ghost" icon={<Plus className="w-3 h-3" />} onClick={() => setNewBranch('')} title="Nouvelle branche depuis l’état actuel">
        Branche
      </Button>
      <Button size="xs" variant="ghost" icon={<ArrowDownToLine className="w-3 h-3" />} loading={busy === 'pull'} onClick={() => void run('pull', {}, 'Pull (avance rapide)')}>
        Pull
      </Button>
      <Button size="xs" variant="ghost" icon={<ArrowUpFromLine className="w-3 h-3" />} loading={busy === 'push'} onClick={() => void run('push', {}, 'Push')}>
        Push
      </Button>
      {pr.data?.pr ? (
        <a href={pr.data.pr.url} target="_blank" rel="noreferrer" className="text-[12px] text-brand hover:underline flex items-center gap-1">
          <GitPullRequest className="w-3.5 h-3.5" />#{pr.data.pr.number} {pr.data.pr.state.toLowerCase()}
        </a>
      ) : (
        <Button size="xs" variant="ghost" icon={<GitPullRequest className="w-3 h-3" />} onClick={() => setPrForm({ title: '', body: '' })}>
          Pull request
        </Button>
      )}

      <Dialog
        open={newBranch !== null}
        onClose={() => setNewBranch(null)}
        title="Nouvelle branche"
        footer={
          <Button
            variant="primary"
            disabled={!newBranch?.trim()}
            loading={busy === 'checkout'}
            onClick={async () => {
              if (await run('checkout', { branch: newBranch!.trim(), create: true }, `Branche ${newBranch} créée`)) setNewBranch(null);
            }}
          >
            Créer et basculer
          </Button>
        }
      >
        <Field label="Nom" hint="Créée depuis l’état actuel ; les modifications non commitées suivent.">
          <Input value={newBranch ?? ''} onChange={(e) => setNewBranch(e.target.value)} className="font-mono" placeholder="feature/ma-fonction" autoFocus />
        </Field>
      </Dialog>

      <Dialog
        open={prForm !== null}
        onClose={() => setPrForm(null)}
        title="Créer une pull request"
        description="La branche est poussée puis la pull request est ouverte sur GitHub avec votre compte (gh auth login)."
        width={620}
        footer={
          <Button
            variant="primary"
            disabled={!prForm?.title.trim()}
            loading={busy === 'pr'}
            onClick={async () => {
              setPrError(null);
              setBusy('pr');
              try {
                await api.post('/api/git/push', {});
                const r = await api.post<{ output: string }>('/api/git/pr', prForm);
                toast('good', 'Pull request créée', r.output);
                setPrForm(null);
                setNonce((n) => n + 1);
              } catch (e) {
                setPrError(e);
              } finally {
                setBusy(null);
              }
            }}
          >
            Pousser et créer
          </Button>
        }
      >
        {prForm && (
          <div className="space-y-3">
            <Field label="Titre">
              <Input value={prForm.title} onChange={(e) => setPrForm({ ...prForm, title: e.target.value })} autoFocus />
            </Field>
            <Field label="Description">
              <textarea value={prForm.body} onChange={(e) => setPrForm({ ...prForm, body: e.target.value })} rows={8} className="w-full rounded-[var(--radius-sm)] border border-line bg-sunk p-2 text-[12.5px] text-fg focus:outline-none focus:border-brand" />
            </Field>
            {prError != null && <ErrorBox error={prError} />}
          </div>
        )}
      </Dialog>
    </div>
  );
}
