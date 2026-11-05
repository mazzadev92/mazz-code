import { useState } from 'react';
import { Play, Plus, Power, Server, Trash2, Wand2 } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import { toast, useApp, navigate } from '../../lib/store';
import { fmtRelative } from '../../lib/format';
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorBox, Field, IconButton, Input, Notice, Segmented, Select, Spinner, StatusDot, Toggle, useAsync, cx } from '../../components/ui';

interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  secretName?: string;
  secretHint?: string;
  enabled: boolean;
  autoStart: boolean;
  status: {
    state: 'stopped' | 'starting' | 'running' | 'error';
    tools: Array<{ name: string; registeredAs: string; description: string }>;
    error?: string;
    startedAt?: number;
    processId?: number;
    serverInfo?: { name?: string; version?: string };
    stderrTail: string[];
  };
}

/**
 * Ready-made configurations for well-known servers. Nothing is installed in
 * advance: npx downloads the package on first start.
 */
const TEMPLATES = (workspace: string) => [
  { label: 'Fichiers du projet (référence MCP)', cfg: { id: 'filesystem', name: 'Système de fichiers', transport: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', workspace] } },
  { label: 'Navigateur Playwright', cfg: { id: 'playwright', name: 'Playwright', transport: 'stdio' as const, command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless'] } },
  { label: 'Chrome DevTools', cfg: { id: 'devtools', name: 'Chrome DevTools', transport: 'stdio' as const, command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] } },
  { label: 'Mémoire (graphe de connaissances, référence MCP)', cfg: { id: 'memory', name: 'Mémoire MCP', transport: 'stdio' as const, command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } },
  { label: 'Connecteur GitHub (HTTP, jeton personnel)', cfg: { id: 'github', name: 'GitHub', transport: 'http' as const, url: 'https://api.githubcopilot.com/mcp/', secretName: 'Authorization' } },
  { label: 'Connecteur HTTP avec jeton (générique)', cfg: { id: 'connecteur', name: 'Connecteur', transport: 'http' as const, url: 'https://', secretName: 'Authorization' } },
];

function ServerForm({ initial, onClose, onSaved }: { initial: Partial<McpServer> | null; onClose: () => void; onSaved: () => void }) {
  const [id, setId] = useState(initial?.id ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(initial?.transport ?? 'stdio');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [args, setArgs] = useState((initial?.args ?? []).join('\n'));
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [env, setEnv] = useState(Object.entries(initial?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  const [url, setUrl] = useState(initial?.url ?? '');
  const [headers, setHeaders] = useState(Object.entries(initial?.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
  const [secretName, setSecretName] = useState(initial?.secretName ?? '');
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [autoStart, setAutoStart] = useState(initial?.autoStart ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!initial) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/mcp/servers', {
        id,
        name,
        transport,
        command: transport === 'stdio' ? command : undefined,
        args: args.split('\n').map((a) => a.trim()).filter(Boolean),
        cwd: cwd || undefined,
        env: Object.fromEntries(env.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])),
        url: transport === 'http' ? url : undefined,
        headers: transport === 'http' ? Object.fromEntries(headers.split('\n').map((l) => l.trim()).filter((l) => l.includes(':')).map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()])) : undefined,
        secretName: secretName || undefined,
        secret: secret || undefined,
        clearSecret: clearSecret && !secret,
        enabled: true,
        autoStart,
      });
      toast('good', 'Serveur MCP enregistré', name || id);
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial.id ? `Serveur MCP : ${initial.name ?? initial.id}` : 'Ajouter un serveur MCP'}
      description="Le serveur est lancé uniquement à la demande (bouton Démarrer ou début de tâche si « Démarrage automatique » est coché)."
      width={600}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Identifiant" hint="Préfixe des outils : mcp.<id>.<outil>">
            <Input aria-label="Identifiant du serveur MCP" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} disabled={!!initial.status} placeholder="playwright" />
          </Field>
          <Field label="Nom affiché">
            <Input aria-label="Nom affiché du serveur MCP" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Field label="Transport">
          <Segmented label="Transport" value={transport} onChange={setTransport} options={[{ value: 'stdio', label: 'Processus local (stdio)' }, { value: 'http', label: 'HTTP (Streamable)' }]} />
        </Field>
        {transport === 'stdio' ? (
          <>
            <Field label="Commande">
              <Input aria-label="Commande MCP" value={command} onChange={(e) => setCommand(e.target.value)} className="font-mono" placeholder="npx" />
            </Field>
            <Field label="Arguments" hint="Un argument par ligne.">
              <textarea aria-label="Arguments MCP" value={args} onChange={(e) => setArgs(e.target.value)} rows={3} className="w-full rounded-md bg-sunk border border-line px-2.5 py-2 text-[12.5px] font-mono focus:outline-none focus:border-brand/60" />
            </Field>
            <Field label="Dossier de travail (facultatif)">
              <Input aria-label="Dossier de travail MCP" value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Variables d’environnement" hint="CLE=valeur, une par ligne. Stockées en clair dans les paramètres : n’y mettez pas de secret.">
              <textarea aria-label="Variables d’environnement MCP" value={env} onChange={(e) => setEnv(e.target.value)} rows={2} className="w-full rounded-md bg-sunk border border-line px-2.5 py-2 text-[12.5px] font-mono focus:outline-none focus:border-brand/60" />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" placeholder="http://127.0.0.1:8000/mcp" />
            </Field>
            <Field label="En-têtes non secrets (facultatif)" hint="Nom: valeur, un par ligne.">
              <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} className="w-full rounded-md bg-sunk border border-line px-2.5 py-2 text-[12.5px] font-mono focus:outline-none focus:border-brand/60" />
            </Field>
          </>
        )}
        <div className="rounded-md border border-line bg-sunk p-3 space-y-2">
          <div className="text-[12.5px] text-fg">Jeton ou clé du connecteur</div>
          <p className="text-[11.5px] text-muted">Chiffré dans le coffre (DPAPI), jamais écrit dans les paramètres ni renvoyé à l’interface. {transport === 'http' ? 'Envoyé dans l’en-tête indiqué (Authorization par défaut, préfixe Bearer ajouté).' : 'Transmis au processus dans la variable d’environnement indiquée.'}</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label={transport === 'http' ? 'En-tête' : 'Variable d’environnement'}>
              <Input value={secretName} onChange={(e) => setSecretName(e.target.value)} className="font-mono" placeholder={transport === 'http' ? 'Authorization' : 'GITHUB_TOKEN'} />
            </Field>
            <Field label={initial.secretHint ? `Remplacer (actuel : ${initial.secretHint})` : 'Valeur'}>
              <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={initial.secretHint ? 'Laisser vide pour conserver' : ''} />
            </Field>
          </div>
          {initial.secretHint && <Toggle checked={clearSecret} onChange={setClearSecret} label="Supprimer le jeton enregistré" />}
          <p className="text-[11.5px] text-faint">Les connecteurs à connexion OAuth (navigateur) ne sont pas encore pris en charge : utilisez un jeton personnel quand le service en propose.</p>
        </div>
        <Field label="Démarrage automatique au début d’une tâche agent" inline>
          <Toggle checked={autoStart} onChange={setAutoStart} label="Démarrage automatique" />
        </Field>
        {error != null && <ErrorBox error={error} />}
      </div>
    </Dialog>
  );
}

function ToolTester({ server }: { server: McpServer }) {
  const [tool, setTool] = useState(server.status.tools[0]?.name ?? '');
  const [args, setArgs] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ success: boolean; output: { text?: string } | null; error?: string; durationMs: number } | null>(null);
  return (
    <div className="space-y-2 pt-2">
      <div className="flex gap-2">
        <Select value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Outil à tester" className="max-w-xs">
          {server.status.tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </Select>
        <Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono text-[12px]" aria-label="Arguments JSON" />
        <Button
          size="sm"
          icon={<Play className="w-3 h-3" />}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setResult(null);
            try {
              setResult(await api.post(`/api/mcp/servers/${server.id}/call`, { tool, arguments: JSON.parse(args || '{}') }));
            } catch (e) {
              setResult({ success: false, output: null, error: errorMessage(e), durationMs: 0 });
            } finally {
              setBusy(false);
            }
          }}
        >
          Tester
        </Button>
      </div>
      {result && (
        <div role="status" aria-live="polite" className="space-y-1">
          <div className={cx('text-[11.5px]', result.success ? 'text-muted' : 'text-bad')}>
            {result.success ? 'Appel MCP réussi' : 'Appel MCP échoué'} · {result.durationMs} ms
          </div>
          <pre className={cx('rounded-md border p-2 text-[11.5px] font-mono whitespace-pre-wrap max-h-48 overflow-auto', result.success ? 'border-line bg-code' : 'border-bad/40 bg-bad/5 text-bad')}>
            {result.success ? result.output?.text : result.error}
          </pre>
        </div>
      )}
    </div>
  );
}

export function McpPanel() {
  const workspace = useApp((s) => s.health?.workspace.workspaceRoot) ?? '.';
  const policy = useApp((s) => s.settings?.permissions.mcp);
  const [nonce, setNonce] = useState(0);
  const list = useAsync((signal) => api.get<{ servers: McpServer[] }>('/api/mcp/servers', signal), [nonce]);
  const [editing, setEditing] = useState<Partial<McpServer> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [remove, setRemove] = useState<McpServer | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => setNonce((n) => n + 1);

  const act = async (id: string, action: 'start' | 'stop') => {
    setBusy(id);
    try {
      await api.post(`/api/mcp/servers/${id}/${action}`);
      if (action === 'start') setOpen(id);
    } catch (e) {
      toast('bad', action === 'start' ? 'Démarrage MCP impossible' : 'Arrêt impossible', errorMessage(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <div className="space-y-4">
      <Notice tone="info" title="Serveurs MCP">
        Chaque outil d’un serveur démarré devient disponible pour l’agent sous le nom mcp.&lt;serveur&gt;.&lt;outil&gt;, proposé quand la demande le concerne ou sur demande du modèle. Permission actuelle : <Badge tone={policy === 'allow' ? 'good' : policy === 'deny' ? 'bad' : 'warn'}>{policy === 'allow' ? 'autoriser' : policy === 'deny' ? 'refuser' : 'demander'}</Badge>{' '}
        <button type="button" className="text-brand hover:underline cursor-pointer" onClick={() => navigate('settings', 'permissions')}>
          modifier
        </button>
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setEditing({})}>
          Ajouter un serveur
        </Button>
        {TEMPLATES(workspace).map((t) => (
          <Button key={t.cfg.id} size="sm" variant="ghost" icon={<Wand2 className="w-3.5 h-3.5" />} onClick={() => setEditing(t.cfg)}>
            {t.label}
          </Button>
        ))}
      </div>
      {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
      {list.data && list.data.servers.length === 0 && (
        <EmptyState icon={<Server className="w-7 h-7" />} title="Aucun serveur MCP configuré">
          Ajoutez un serveur ou partez d’un modèle. Les modèles utilisent npx : le paquet est téléchargé au premier démarrage, rien n’est installé à l’avance.
        </EmptyState>
      )}
      {list.data?.servers.map((s) => {
        const tone = s.status.state === 'running' ? 'good' : s.status.state === 'error' ? 'bad' : s.status.state === 'starting' ? 'warn' : 'neutral';
        return (
          <Card key={s.id} padded={false}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <StatusDot tone={tone} pulse={s.status.state === 'starting'} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-fg font-medium">
                  {s.name} <span className="text-faint font-mono text-[11.5px]">mcp.{s.id}</span>
                </div>
                <div className="text-[11.5px] text-faint font-mono truncate">{s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</div>
                {s.secretHint && <Badge tone="info">Jeton enregistré {s.secretHint}</Badge>}
              </div>
              {s.autoStart && <Badge>Démarrage automatique</Badge>}
              <Badge tone={tone}>{s.status.state === 'running' ? `${s.status.tools.length} outil(s)` : s.status.state === 'error' ? 'Erreur' : s.status.state === 'starting' ? 'Démarrage' : 'Arrêté'}</Badge>
              {s.status.state === 'running' ? (
                <Button size="xs" variant="ghost" icon={<Power className="w-3 h-3" />} loading={busy === s.id} onClick={() => act(s.id, 'stop')}>
                  Arrêter
                </Button>
              ) : (
                <Button size="xs" icon={busy === s.id ? undefined : <Play className="w-3 h-3" />} loading={busy === s.id} onClick={() => act(s.id, 'start')}>
                  Démarrer
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => setEditing(s)}>
                Modifier
              </Button>
              <IconButton size="sm" label="Supprimer" onClick={() => setRemove(s)}>
                <Trash2 className="w-3.5 h-3.5" />
              </IconButton>
            </div>
            {busy === s.id && (
              <div className="px-4 pb-3 flex items-center gap-2 text-[12px] text-muted">
                <Spinner size={11} /> Connexion au serveur (le premier démarrage via npx peut prendre une minute)
              </div>
            )}
            {s.status.error && <div className="px-4 pb-3 text-[12px] text-bad whitespace-pre-wrap">{s.status.error}</div>}
            {s.status.state === 'running' && (
              <div className="px-4 pb-3 border-t border-line pt-2">
                <div className="mb-1 text-[11.5px] text-muted" role="status" aria-live="polite">
                  Serveur : <span className="font-mono text-fg">{s.status.serverInfo?.name ?? 'identité indisponible'}</span>
                  {s.status.serverInfo?.version ? ` · version ${s.status.serverInfo.version}` : ''}
                  {s.transport === 'stdio' && <> · PID <span className="font-mono text-fg">{s.status.processId ?? 'indisponible'}</span></>}
                </div>
                <button type="button" className="text-[12px] text-muted hover:text-fg cursor-pointer" onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? 'Masquer' : 'Afficher'} les outils ({s.status.tools.length}, démarré {fmtRelative(s.status.startedAt)})
                </button>
                {open === s.id && (
                  <>
                    <ul className="mt-2 space-y-1">
                      {s.status.tools.map((t) => (
                        <li key={t.name} className="text-[12px]">
                          <span className="font-mono text-fg">{t.registeredAs}</span> <span className="text-muted">{t.description}</span>
                        </li>
                      ))}
                    </ul>
                    {s.status.tools.length > 0 && <ToolTester server={s} />}
                  </>
                )}
              </div>
            )}
            {s.status.stderrTail.length > 0 && s.status.state !== 'running' && (
              <pre className="mx-4 mb-3 rounded-md border border-line bg-code p-2 text-[11px] font-mono text-muted max-h-32 overflow-auto">{s.status.stderrTail.join('\n')}</pre>
            )}
          </Card>
        );
      })}
      <ServerForm key={editing ? `editing:${editing.id ?? 'new'}` : 'closed'} initial={editing} onClose={() => setEditing(null)} onSaved={reload} />
      <ConfirmDialog
        open={!!remove}
        title={`Supprimer le serveur ${remove?.name} ?`}
        confirmLabel="Supprimer"
        danger
        onClose={() => setRemove(null)}
        onConfirm={async () => {
          await api.del(`/api/mcp/servers/${remove!.id}`);
          reload();
        }}
      >
        La configuration est retirée et le serveur arrêté s’il tourne.
      </ConfirmDialog>
    </div>
  );
}
