import { useRef, useState } from 'react';
import { errorMessage } from '../../lib/api';
import { streamSse } from '../../lib/sse';
import { navigate, useApp } from '../../lib/store';
import type { PermissionDecision } from '../../lib/types';
import { Button, Notice } from '../../components/ui';
import { Legal } from './Legal';
import { Term } from './Term';

const WORDS: Record<PermissionDecision, string> = { ask: 'demande votre accord', allow: 'autorisé sans demander', deny: 'refusé' };
const LABELS: Array<['write' | 'delete' | 'terminal' | 'git' | 'network' | 'web', string]> = [['write', 'Écrire des fichiers'], ['delete', 'Supprimer des fichiers'], ['terminal', 'Lancer des commandes'], ['git', 'Git'], ['network', 'Accès réseau'], ['web', 'Recherche web']];

export function StepSecurity() {
  const perms = useApp((s) => s.settings?.permissions);
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted">En mode « demander avant d’agir » (par défaut), l’<Term id="agent" /> vous demande l’autorisation avant chaque action sensible. Vos messages ne sont envoyés qu’aux fournisseurs que vous avez configurés.</p>
      {perms ? (
        <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
          {LABELS.map(([k, label]) => <li key={k} className="flex justify-between gap-2"><span className="text-fg">{label}</span><span className="text-muted">{WORDS[perms[k]] ?? 'N/D'}</span></li>)}
        </ul>
      ) : <p className="text-faint">Permissions non chargées.</p>}
      <Button size="sm" variant="secondary" onClick={() => navigate('settings')}>Modifier les permissions et dossiers autorisés</Button>
      <Legal />
    </div>
  );
}

type Outcome = { ok: boolean; text: string } | null;

export function StepFinalTest({ recap }: { recap: string[] }) {
  const ai = useApp((s) => s.settings?.ai);
  const llama = useApp((s) => s.llama);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<Outcome>(null);
  const ctrl = useRef<AbortController | null>(null);

  const run = async () => {
    if (!ai) return;
    setBusy(true); setOut(null);
    ctrl.current = new AbortController();
    let text = '', err = '';
    try {
      await streamSse('/api/inference/test', {
        body: { providerId: ai.defaultProviderId, modelId: ai.defaultModelId || undefined, prompt: 'Réponds en une courte phrase : bonjour.', maxTokens: 64, temperature: 0.2 },
        signal: ctrl.current.signal,
        onMessage: (m) => {
          const ev = JSON.parse(m.data) as { type?: string; delta?: string; message?: string };
          if (ev.type === 'token') text += ev.delta ?? '';
          else if (ev.type === 'error') err = ev.message ?? 'Erreur du fournisseur.';
        },
      });
      setOut(err || !text.trim() ? { ok: false, text: err || 'Réponse vide.' } : { ok: true, text: text.trim() });
    } catch (e) {
      setOut({ ok: false, text: errorMessage(e) });
    } finally { setBusy(false); }
  };

  const local = ai?.defaultProviderId === 'llama-local';
  const notReady = local && llama?.state !== 'ready';
  return (
    <div className="space-y-3 text-[12.5px]">
      <p className="text-muted">Envoie une courte question au modèle sélectionné ({ai ? `${ai.defaultProviderId}${ai.defaultModelId ? ` / ${ai.defaultModelId}` : ''}` : 'N/D'}). Cette étape est facultative.</p>
      {notReady && <Notice tone="warn" title="Modèle local non chargé">Chargez un modèle depuis la page Modèles, ou choisissez un fournisseur en ligne, puis relancez le test.</Notice>}
      <Button size="sm" loading={busy} disabled={!ai || notReady} onClick={() => void run()}>Envoyer un message de test</Button>
      {out && (out.ok
        ? <Notice tone="good" title="Réponse reçue">{out.text}</Notice>
        : <Notice tone="bad" title="Le test a échoué">{out.text} Vérifiez la clé du fournisseur, le mode d’exécution (local strict refuse les fournisseurs distants) ou le modèle chargé.</Notice>)}
      <div>
        <div className="font-medium text-fg mb-1">Résumé</div>
        <ul className="list-disc pl-5 text-muted">{recap.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
    </div>
  );
}
