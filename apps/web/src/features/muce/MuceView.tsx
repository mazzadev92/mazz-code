import { useState } from 'react';
import { FolderOpen, Play } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { MuceStatus } from '../../lib/types';
import { refreshHealth, refreshSettings, toast } from '../../lib/store';
import { fmtMs } from '../../lib/format';
import { Badge, Button, Card, ErrorBox, Notice, Page, PageHeader, Skeleton, cx, useAsync } from '../../components/ui';
import { Markdown } from '../../components/Markdown';
import { PathPicker } from '../../components/overlays';
import { MuceServiceCard } from './MuceServiceCard';

/**
 * Modules added to MUCE 0.3.5 ("Paroxysm"), checked on 2026-10-22: what each
 * one actually does for generation in the Studio (docs/MUCE_INTEGRATION.md).
 */
const PAROXYSM: Record<string, { label: string; tone: 'good' | 'warn' | 'neutral'; status: string; detail: string }> = {
  radix_tree_prefix_cache: {
    label: 'RadixTreeCache (pont 8098)',
    tone: 'neutral',
    status: 'Suivi seulement',
    detail: 'Compte les préfixes répétés côté Python. La réutilisation réelle est faite par le cache de prompt de llama.cpp : mesuré 10,9 s ramenés à 0,93 s pour 1 922 jetons repris (pas moins de 10 ms).',
  },
  code_trie_speculation: {
    label: 'Code Trie (spéculation sur le projet)',
    tone: 'warn',
    status: 'Projection, non branché',
    detail: 'Les 372 tok/s annoncés sont calculés (18 tok/s fixés multipliés par un gain simulé sur des mots), sans modèle. Le module n’est pas utilisé par llama-server ni par le pont.',
  },
  powerinfer_activation_sparsity: {
    label: 'TurboSparse / PowerInfer',
    tone: 'warn',
    status: 'Simulation',
    detail: 'Le gain x3 compare deux boucles Python vides ; aucun modèle à activations dReLU n’est exécuté.',
  },
  d3d11_heterogeneous_pipeline: {
    label: 'Pipeline CPU + iGPU HD 530 (D3D11)',
    tone: 'neutral',
    status: 'Hors génération',
    detail: 'Calcul matriciel validé numériquement sur l’iGPU ; llama.cpp ne décharge rien vers l’iGPU (offload LLM non pris en charge).',
  },
};

function ParoxysmModules({ gguf }: { gguf: string[] }) {
  const present = Object.entries(PAROXYSM).filter(([k]) => gguf.includes(k));
  if (!present.length) return null;
  return (
    <Card title="Modules « Paroxysm » déclarés" subtitle="Vérifiés le 22/10/2026. Ce qui accélère réellement la génération : le profil MUCE de llama-server (Paramètres, Accélération MUCE).">
      <div className="space-y-2.5">
        {present.map(([k, m]) => (
          <div key={k} className="text-[12.5px]">
            <div className="flex items-center gap-2">
              <span className="text-fg">{m.label}</span>
              <Badge tone={m.tone}>{m.status}</Badge>
            </div>
            <div className="text-muted text-[12px]">{m.detail}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

const STATES: Array<{ id: string; label: string }> = [
  { id: 'absent', label: 'Absent' },
  { id: 'detected', label: 'Détecté' },
  { id: 'incompatible', label: 'Incompatible' },
  { id: 'ready', label: 'Prêt' },
  { id: 'active', label: 'Actif (génération)' },
  { id: 'error', label: 'Erreur' },
];

export default function MuceView() {
  const [nonce, setNonce] = useState(0);
  const status = useAsync((signal) => api.get<MuceStatus>('/api/muce/status', signal), [nonce]);
  const doc = useAsync((signal) => (status.data?.integrationDocPath ? api.get<{ content: string }>('/api/muce/document', signal) : Promise.resolve(null)), [status.data?.integrationDocPath]);
  const [picker, setPicker] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<{ command: string; success: boolean; data?: unknown; raw?: string; error?: string; durationMs: number } | null>(null);
  const s = status.data;
  const current = s ? (s.state === 'ready' && s.generativeAcceleration === 'declared' && !s.generationUsesLlamaCpp ? 'active' : s.state) : undefined;

  const run = async (command: string) => {
    setRunning(command);
    try {
      const r = await api.post<{ success: boolean; data?: unknown; raw?: string; error?: string; durationMs: number }>('/api/muce/run', { command });
      setOutput({ command, ...r });
    } catch (e) {
      toast('bad', 'Commande MUCE échouée', errorMessage(e));
    } finally {
      setRunning(null);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="MUCE"
        subtitle="Mazz Universal Compute Engine. Le profil d’accélération MUCE (spéculation n-gram, attente active, priorité) s’applique aux modèles locaux chargés par le Studio ; le service MUCE 8098 est disponible comme fournisseur local."
        icon="engineering"
        actions={
          <Button icon={<FolderOpen className="w-4 h-4" />} onClick={() => setPicker(true)}>
            Choisir le dossier MUCE
          </Button>
        }
      />
      <MuceServiceCard />
      <Card title="Cycle d’intégration">
        <ol className="flex flex-wrap gap-2" aria-label="États MUCE">
          {STATES.map((st) => (
            <li key={st.id} aria-current={current === st.id ? 'step' : undefined} className={cx('px-3 py-1.5 rounded-md border text-[12px]', current === st.id ? 'border-brand bg-brand/10 text-fg font-medium' : 'border-line text-faint')}>
              {st.label}
            </li>
          ))}
        </ol>
      </Card>
      {status.error != null && <ErrorBox error={status.error} onRetry={status.reload} />}
      {!s && !status.error && <Skeleton />}
      {s && (
        <div className="grid lg:grid-cols-2 gap-4">
          <Card title="État du pont">
            <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-[12.5px]">
              <dt className="text-faint">Dossier</dt>
              <dd className="font-mono break-all">{s.muceHome ?? 'non configuré'}</dd>
              <dt className="text-faint">Manifeste</dt>
              <dd>{s.isManifestValid ? <Badge tone="good">Valide</Badge> : <Badge tone={s.isConfigured ? 'bad' : 'neutral'}>{s.isConfigured ? 'Invalide' : 'Absent'}</Badge>}</dd>
              <dt className="text-faint">Produit</dt>
              <dd>{s.manifest ? `${s.manifest.name} ${s.manifest.version}` : 'N/D'}</dd>
              <dt className="text-faint">CLI</dt>
              <dd className="font-mono break-all">{s.cliAbsolutePath ?? 'non trouvée'}</dd>
              <dt className="text-faint">Génération GGUF</dt>
              <dd>
                {s.generativeAcceleration === 'declared' ? <Badge tone="warn">Déclarée, non validée</Badge> : s.generativeAcceleration === 'unsupported' ? <Badge>Noyaux llama.cpp officiels (pas de remplacement MUCE)</Badge> : <Badge>Inconnue</Badge>}
              </dd>
              <dt className="text-faint">Décodage spéculatif</dt>
              <dd>{s.speculativeMethods?.length ? s.speculativeMethods.map((m) => m.replace('speculative_', '')).join(', ') : 'Non déclaré'}</dd>
              <dt className="text-faint">Moteur de génération</dt>
              <dd>
                <Badge tone="good">llama.cpp</Badge>
              </dd>
            </dl>
            <ul className="mt-3 text-[12px] text-muted list-disc pl-5 space-y-0.5">
              {s.diagnostics.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </Card>
          <ParoxysmModules gguf={Array.isArray(s.capabilities?.gguf) ? (s.capabilities!.gguf as string[]) : []} />
          <Card title="Capacités déclarées">
            {s.capabilities ? (
              <div className="space-y-2 text-[12.5px]">
                {Object.entries(s.capabilities)
                  .filter(([k]) => k !== 'unsupported')
                  .map(([k, v]) => (
                    <div key={k}>
                      <span className="text-faint">{k} : </span>
                      <span className="font-mono text-fg">{Array.isArray(v) ? v.join(', ') : String(v)}</span>
                    </div>
                  ))}
                {s.unsupported?.length ? (
                  <div>
                    <div className="text-faint mb-1">Non pris en charge :</div>
                    <div className="flex flex-wrap gap-1">
                      {s.unsupported.map((u) => (
                        <Badge key={u}>{u}</Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
                <p className="text-[11.5px] text-faint pt-1">Ces capacités sont lues du manifeste ; seules les commandes ci-dessous les vérifient réellement.</p>
              </div>
            ) : (
              <p className="text-[12.5px] text-faint">Aucun manifeste chargé.</p>
            )}
          </Card>
        </div>
      )}
      {s?.isCliAvailable && (
        <Card title="Vérifications réelles" subtitle="Exécute les commandes déclarées par le manifeste (sans shell, dans le dossier MUCE).">
          <div className="flex flex-wrap gap-2">
            {['hardware', 'backends', 'benchmark'].map((c) => (
              <Button key={c} size="sm" icon={<Play className="w-3 h-3" />} loading={running === c} disabled={!!running} onClick={() => run(c)}>
                {c}
              </Button>
            ))}
          </div>
          {output && (
            <div className="mt-3 space-y-1">
              <div className="flex items-center gap-2 text-[12px]">
                <Badge tone={output.success ? 'good' : 'bad'}>{output.success ? 'Succès' : 'Échec'}</Badge>
                <span className="font-mono">{output.command}</span>
                <span className="text-faint">{fmtMs(output.durationMs)}</span>
              </div>
              {output.error && <ErrorBox error={output.error} />}
              <pre className="rounded-md border border-line bg-code p-3 text-[11.5px] font-mono overflow-auto max-h-80">{output.data !== undefined ? JSON.stringify(output.data, null, 2) : output.raw}</pre>
              {output.command === 'benchmark' && <p className="text-[11.5px] text-faint">Benchmark de calcul matriciel (GEMM/GEMV) : il ne mesure pas la génération de jetons et n’est pas comparable aux tok/s de llama.cpp.</p>}
            </div>
          )}
        </Card>
      )}
      {doc.data && (
        <Card title="INTEGRATE_WITH_MUCE.md">
          <div className="max-h-[520px] overflow-y-auto pr-2">
            <Markdown text={doc.data.content} />
          </div>
        </Card>
      )}
      <Notice tone="info" title="Activation future">
        L’état « Actif » ne sera atteint que si le manifeste déclare la génération GGUF et qu’un test réel à paramètres identiques confirme le gain par rapport à llama.cpp. Aucune amélioration n’est présumée.
      </Notice>
      <PathPicker
        open={picker}
        mode="folder"
        title="Dossier MUCE (contenant INTEGRATION_MANIFEST.json)"
        initial={s?.muceHome}
        onClose={() => setPicker(false)}
        onPick={async (p) => {
          try {
            await api.post('/api/muce/configure', { path: p });
            await Promise.all([refreshSettings(), refreshHealth()]);
            setNonce((n) => n + 1);
          } catch (e) {
            toast('bad', 'Configuration refusée', errorMessage(e));
          }
        }}
      />
    </Page>
  );
}
