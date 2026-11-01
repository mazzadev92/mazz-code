import { useState, useEffect } from 'react';
import { CheckCircle2, Cloud, Cpu, FlaskConical, KeyRound, Plus, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import type { ProviderInfo, ProviderHealthRecord } from '../../lib/types';
import { refreshProviders, saveSettings, toast, useApp } from '../../lib/store';
import { fmtMs, fmtTime } from '../../lib/format';
import { Badge, Button, Card, ConfirmDialog, Dialog, ErrorBox, Field, Input, Notice, Page, PageHeader, Segmented, Select } from '../../components/ui';

interface TestResult {
  ok: boolean;
  message: string;
  latencyMs: number;
  testedAt: number;
}

const KEY_HINT: Record<string, string> = {
  'google-gemini': 'AIza...',
  'anthropic-claude': 'sk-ant-...',
  'openai-api': 'sk-...',
  'groq-api': 'gsk_...',
  'deepseek-api': 'sk-...',
};

function ProviderRow({ p, protection }: { p: ProviderInfo; protection?: string }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const saveKey = async () => {
    setBusy('save');
    try {
      const r = await api.put<{ hint: string }>(`/api/providers/${p.id}/key`, { key });
      setKey('');
      setHint(r.hint);
      toast('good', 'Clé enregistrée', `${p.name} : ${r.hint}`);
      await refreshProviders();
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy('test');
    try {
      setResult(await api.post<TestResult>('/api/providers/test', { providerId: p.id }));
    } catch (e) {
      setResult({ ok: false, message: errorMessage(e), latencyMs: 0, testedAt: Date.now() });
    } finally {
      setBusy(null);
    }
  };

  const Icon = p.synthetic ? FlaskConical : p.locality === 'local' ? Cpu : Cloud;

  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="w-4 h-4 text-faint" />
        <span className="text-[13px] text-fg font-medium">{p.name}</span>
        {p.synthetic ? <Badge tone="warn">Test, non génératif</Badge> : p.locality === 'local' ? <Badge tone="good">Local</Badge> : <Badge tone="info">API distante</Badge>}
        {p.custom && <Badge>Personnalisé</Badge>}
        {p.requiresApiKey ? (
          p.hasApiKey ? (
            <Badge tone="good" icon={<KeyRound className="w-3 h-3" />}>Clé configurée {hint ?? ''}</Badge>
          ) : (
            <Badge tone="neutral">Clé requise</Badge>
          )
        ) : p.locality === 'remote' ? (
          <Badge tone="brand">Anonyme (Sans clé)</Badge>
        ) : null}
        <span className="text-[11.5px] text-faint font-mono truncate">{p.baseUrl}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" onClick={test} loading={busy === 'test'} disabled={p.requiresApiKey && !p.hasApiKey}>
            Tester la connexion
          </Button>
          {p.hasApiKey && (
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(true)}>
              Retirer la clé
            </Button>
          )}
          {p.custom && (
            <Button size="xs" variant="danger" icon={<Trash2 className="w-3 h-3" />} onClick={() => setConfirmDelete(true)}>
              Supprimer
            </Button>
          )}
        </div>
      </div>
      {!p.requiresApiKey && p.locality === 'remote' && (
        <div className="text-[11.5px] text-faint">
          {p.id === 'ovh-ai' && 'Quota indicatif : 2 requêtes / min / IP / modèle (non garanti, service public expérimental OVHcloud).'}
          {p.id === 'llmfaucet' && 'Quota indicatif : 20 requêtes / jour / IP (non garanti, faucet gratuit communautaire pouvant être indisponible).'}
        </div>
      )}
      {p.requiresApiKey && (
        <form
          className="flex gap-2 max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void saveKey();
          }}
        >
          <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={p.hasApiKey ? 'Remplacer la clé (jamais réaffichée)' : `Clé API ${KEY_HINT[p.id] ?? ''}`} aria-label={`Clé API ${p.name}`} autoComplete="off" spellCheck={false} />
          <Button type="submit" variant="primary" disabled={!key.trim()} loading={busy === 'save'}>
            {p.hasApiKey ? 'Remplacer' : 'Enregistrer'}
          </Button>
        </form>
      )}
      {result && (
        <div className={`flex items-center gap-2 text-[12px] ${result.ok ? 'text-good' : 'text-bad'}`} role="status">
          {result.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          <span className="break-all">{result.message}</span>
          <span className="text-faint ml-auto shrink-0">
            {fmtMs(result.latencyMs)} - {fmtTime(result.testedAt)}
          </span>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove}
        title={`Retirer la clé ${p.name} ?`}
        confirmLabel="Retirer"
        danger
        onClose={() => setConfirmRemove(false)}
        onConfirm={async () => {
          await api.del(`/api/providers/${p.id}/key`);
          setHint(null);
          setResult(null);
          await refreshProviders();
        }}
      >
        La clé est effacée du coffre {protection === 'dpapi' ? 'DPAPI' : 'local'}. Le fournisseur devient indisponible jusqu’à une nouvelle clé.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDelete}
        title={`Supprimer ${p.name} ?`}
        confirmLabel="Supprimer"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await api.del(`/api/providers/${p.id}`);
          await refreshProviders();
        }}
      >
        Le point de terminaison et sa clé éventuelle sont supprimés.
      </ConfirmDialog>
    </li>
  );
}

function AddProviderDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8000/v1');
  const [locality, setLocality] = useState<'local' | 'remote'>('local');
  const [defaultModel, setDefaultModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ajouter un point de terminaison compatible OpenAI"
      description="vLLM, LocalAI, Jan, text-generation-webui, OpenRouter... Toute API exposant /v1/chat/completions."
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
              setError(null);
              try {
                await api.post('/api/providers', { id, name, baseUrl, locality, defaultModel: defaultModel || undefined });
                await refreshProviders();
                toast('good', 'Fournisseur ajouté', name);
                onClose();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Ajouter
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Identifiant" hint="Minuscules, chiffres, tirets.">
          <Input value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="mon-vllm" />
        </Field>
        <Field label="Nom affiché">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="vLLM atelier" />
        </Field>
        <Field label="URL de base" hint="Doit se terminer par /v1 pour la plupart des serveurs.">
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono" />
        </Field>
        <Field label="Lieu de calcul">
          <Segmented label="Lieu de calcul" value={locality} onChange={setLocality} options={[{ value: 'local', label: 'Local (cette machine ou réseau local)' }, { value: 'remote', label: 'Distant' }]} />
        </Field>
        <Field label="Modèle par défaut (facultatif)">
          <Input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
        </Field>
        {error != null && <ErrorBox error={error} />}
      </div>
    </Dialog>
  );
}

function CascadeCard() {
  const [data, setData] = useState<{
    enabled: boolean;
    steps: Array<{ providerId: string; modelId: string; priority: number; enabled: boolean; label?: string }>;
    maxFallbacks: number;
    cooldownSec: number;
    health: ProviderHealthRecord[];
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; durationMs: number } | null>(null);

  const load = async () => {
    try {
      setData(await api.get('/api/cascade'));
    } catch {}
  };

  useEffect(() => {
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.post<{ success: boolean; durationMs: number }>('/api/cascade/test', {});
      setTestResult(res);
      await load();
      toast('good', 'Test de cascade terminé', `Cascade opérationnelle en ${res.durationMs}ms`);
    } catch (e) {
      toast('bad', 'Échec du test', errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  if (!data) return null;

  return (
    <Card title="Cascade et Résilience (Fallback Automatique)">
      <div className="space-y-4">
        <p className="text-[12.5px] text-muted">
          En cas d’erreur récupérable (panne, indisponibilité, timeout, HTTP 429 ou modèle absent), le système bascule automatiquement vers le fournisseur suivant dans l’ordre de priorité sans interrompre votre tâche.
        </p>

        <div className="space-y-2">
          <div className="text-[12px] font-medium text-fg">Séquence de cascade active :</div>
          <div className="space-y-1.5">
            {data.steps.map((step, idx) => {
              const h = data.health.find((x) => x.providerId === step.providerId);
              const tone = h?.status === 'healthy' ? 'good' : h?.status === 'cooling_down' ? 'warn' : 'bad';
              return (
                <div key={step.providerId} className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-sunk/60 border border-line text-[12px]">
                  <span className="font-mono font-semibold text-brand w-5">{idx + 1}.</span>
                  <span className="font-medium text-fg">{h?.name ?? step.providerId}</span>
                  {step.modelId && <span className="font-mono text-faint text-[11px]">({step.modelId})</span>}
                  <Badge tone={tone}>
                    {h?.status === 'healthy' ? 'Opérationnel' : h?.status === 'cooling_down' ? `Cooldown (${h.cooldownRemainingSec}s)` : 'Indisponible'}
                  </Badge>
                  {h?.knownQuota && (
                    <span className="text-[11px] text-faint ml-auto">
                      {h.knownQuota}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <Button size="xs" onClick={runTest} loading={testing}>
            Tester la cascade en direct
          </Button>
          {testResult && (
            <span className={`text-[12px] flex items-center gap-1.5 ${testResult.success ? 'text-good' : 'text-bad'}`}>
              {testResult.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
              {testResult.success ? `Test réussi en ${testResult.durationMs}ms` : 'Échec du test de cascade'}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

export default function ProvidersView() {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const [adding, setAdding] = useState(false);
  const local = providers.filter((p) => p.locality === 'local');
  const remote = providers.filter((p) => p.locality === 'remote');
  const mode = settings?.ai.executionMode ?? 'local_strict';

  return (
    <Page>
      <PageHeader
        title="Fournisseurs et routage"
        subtitle="Moteurs locaux et API distantes. Les clés sont envoyées une seule fois au serveur local, chiffrées, et ne sont jamais renvoyées au navigateur."
        icon="security"
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setAdding(true)}>
            Point de terminaison personnalisé
          </Button>
        }
      />
      <Card title="Mode d’exécution">
        <div className="space-y-3">
          <Segmented
            label="Mode d’exécution"
            value={mode}
            onChange={(v) => saveSettings({ ai: { executionMode: v } }).then(() => toast('good', 'Mode enregistré')).catch((e) => toast('bad', 'Refusé', errorMessage(e)))}
            options={[
              { value: 'local_strict', label: 'Local strict', title: 'Aucune requête vers un fournisseur distant' },
              { value: 'hybrid_opt_in', label: 'Hybride', title: 'Distant autorisé, avec confirmation avant envoi' },
              { value: 'cloud', label: 'API', title: 'Distant autorisé' },
            ]}
          />
          <p className="text-[12.5px] text-muted">
            {mode === 'local_strict'
              ? 'Le backend refuse toute exécution sur un fournisseur distant, même si l’interface le demande.'
              : 'Le sélecteur de modèle propose les API configurées. Le Studio ne bascule jamais automatiquement d’un moteur local vers une API : chaque choix est explicite.'}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <ShieldCheck className="w-4 h-4 text-good" />
            Protection des clés : {health?.secretProtection === 'dpapi' ? 'chiffrement Windows DPAPI (compte utilisateur)' : 'fichier utilisateur non chiffré (hors Windows)'}
            {health?.secretLoadFailures.length ? <Badge tone="bad">Clés illisibles : {health.secretLoadFailures.join(', ')}</Badge> : null}
          </div>
          <Field label="Fournisseur par défaut des nouvelles sessions" inline>
            <Select value={settings?.ai.defaultProviderId} onChange={(e) => saveSettings({ ai: { defaultProviderId: e.target.value, defaultModelId: '' } })}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>
      <Card title="Moteurs locaux">
        <ul className="divide-y divide-line">
          {local.map((p) => (
            <ProviderRow key={p.id} p={p} protection={health?.secretProtection} />
          ))}
        </ul>
        <p className="text-[11.5px] text-faint mt-2">llama.cpp Server est piloté par le Model Hub. LM Studio et Ollama sont détectés s’ils tournent sur leurs ports par défaut.</p>
      </Card>
      <CascadeCard />
      <Card title="API distantes">
        {mode === 'local_strict' && (
          <div className="mb-3">
            <Notice tone="info" title="Mode local strict actif">
              Vous pouvez enregistrer et tester des clés ; l’exécution distante restera bloquée tant que ce mode est actif.
            </Notice>
          </div>
        )}
        <ul className="divide-y divide-line">
          {remote.map((p) => (
            <ProviderRow key={p.id} p={p} protection={health?.secretProtection} />
          ))}
        </ul>
        <p className="text-[11.5px] text-faint mt-2">Coûts : les tarifs ne sont pas affichés tant qu’ils ne sont pas vérifiés ; le coût facturé réel n’est connu que du fournisseur.</p>
      </Card>
      <AddProviderDialog open={adding} onClose={() => setAdding(false)} />
    </Page>
  );
}
