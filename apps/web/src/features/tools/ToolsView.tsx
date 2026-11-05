import { useMemo, useState } from 'react';
import { RefreshCw, Search } from '../../components/icons';
import { api, errorMessage } from '../../lib/api';
import type { HermesStatus, ToolInfo } from '../../lib/types';
import { navigate, toast, useApp } from '../../lib/store';
import { Availability, Badge, Button, Card, ErrorBox, Input, Page, PageHeader, Skeleton, Tabs, useAsync } from '../../components/ui';
import { McpPanel } from './McpPanel';
import { SkillsPanel } from './SkillsPanel';

type Tab = 'internal' | 'mcp' | 'specialists' | 'hermes' | 'skills';

const PERM_LABEL: Record<string, string> = { read: 'Lecture', write: 'Écriture', delete: 'Suppression', terminal: 'Exécution', git: 'Git' };

export default function ToolsView() {
  const settings = useApp((s) => s.settings);
  const workspaceRoot = useApp((s) => s.health?.workspace.workspaceRoot);
  const [tab, setTab] = useState<Tab>('internal');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const tools = useAsync((signal) => api.get<{ tools: ToolInfo[] }>('/api/tools', signal), []);
  const [hermesNonce, setHermesNonce] = useState(0);
  const hermes = useAsync((signal) => api.get<HermesStatus>(`/api/hermes/status${hermesNonce ? '?refresh=1' : ''}`, signal), [hermesNonce]);

  const categories = useMemo(() => Array.from(new Set(tools.data?.tools.map((t) => t.category) ?? [])), [tools.data]);
  const list = (tools.data?.tools ?? []).filter((t) => (category === 'all' || t.category === category) && (!query || `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase())));

  return (
    <Page wide>
      <PageHeader title="Outils, MCP et compétences" subtitle="Ce que l’agent peut réellement faire sur cette machine, avec la permission requise pour chaque outil." icon="tools" />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'internal', label: 'Outils internes', count: tools.data?.tools.length },
          { id: 'mcp', label: 'Serveurs MCP' },
          { id: 'specialists', label: 'Spécialistes' },
          { id: 'hermes', label: 'Pont Hermes' },
          { id: 'skills', label: 'Skills' },
        ]}
      />
      {tab === 'internal' && (
        <Card padded={false}>
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un outil" aria-label="Rechercher un outil" className="pl-7 w-64" />
            </div>
            <div className="flex gap-1">
              {['all', ...categories].map((c) => (
                <Button key={c} size="xs" variant={category === c ? 'primary' : 'ghost'} onClick={() => setCategory(c)}>
                  {c === 'all' ? 'Toutes' : c}
                </Button>
              ))}
            </div>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={() => navigate('settings', 'permissions')}>
              Centre de permissions
            </Button>
          </div>
          {tools.error != null && (
            <div className="p-3">
              <ErrorBox error={tools.error} onRetry={tools.reload} />
            </div>
          )}
          {!tools.data && !tools.error && (
            <div className="p-3">
              <Skeleton />
            </div>
          )}
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-faint bg-sunk">
              <tr>
                <th className="px-3 py-2 font-medium">Outil</th>
                <th className="px-3 py-2 font-medium">Rôle</th>
                <th className="px-3 py-2 font-medium">Paramètres</th>
                <th className="px-3 py-2 font-medium">Permission</th>
                <th className="px-3 py-2 font-medium">Politique actuelle</th>
                <th className="px-3 py-2 font-medium">Proposé au modèle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((t) => {
                const policy = t.permissionCategory === 'read' ? 'allow' : settings?.permissions[t.permissionCategory as keyof NonNullable<typeof settings>['permissions']];
                return (
                  <tr key={t.name} className="align-top">
                    <td className="px-3 py-2">
                      <div className="font-mono text-fg">{t.name}</div>
                      <div className="text-[11px] text-faint">{t.category} - intégré</div>
                    </td>
                    <td className="px-3 py-2 text-muted max-w-[360px]">{t.description}</td>
                    <td className="px-3 py-2 font-mono text-[11.5px] text-muted">
                      {Object.keys(t.parameters.properties).map((k) => (
                        <div key={k}>
                          {k}
                          {t.parameters.required?.includes(k) ? '' : '?'}
                        </div>
                      ))}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={t.isDestructive ? 'bad' : t.requiresPermission ? 'warn' : 'neutral'}>{PERM_LABEL[t.permissionCategory] ?? t.permissionCategory}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      {t.permissionCategory === 'read' ? (
                        <span className="text-[12px] text-muted">Toujours (confiné au projet)</span>
                      ) : (
                        <Badge tone={policy === 'allow' ? 'good' : policy === 'deny' ? 'bad' : 'warn'}>{policy === 'allow' ? 'Autorisé' : policy === 'deny' ? 'Refusé' : 'Demander'}</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[12px] text-muted" title={t.keywords?.length ? `Mots-clés : ${t.keywords.join(', ')}` : undefined}>
                      {t.offering === 'always' ? 'Toujours' : t.offering === 'write-modes' ? 'Modes Agent' : t.name.startsWith('mcp.') ? 'Selon la demande (MCP)' : 'Selon la demande'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {tab === 'mcp' && <McpPanel />}
      {tab === 'specialists' && <SpecialistsPanel />}
      {tab === 'hermes' && (
        <Card
          title="Pont Hermes Agent"
          actions={
            <Button size="xs" variant="ghost" icon={<RefreshCw className="w-3 h-3" />} loading={hermes.loading} onClick={() => setHermesNonce((n) => n + 1)}>
              Détecter
            </Button>
          }
        >
          {hermes.error != null && <ErrorBox error={hermes.error} />}
          {hermes.data && (
            <div className="space-y-3 text-[13px]">
              <div className="flex items-center gap-2">
                {hermes.data.isInstalled ? <Availability state="experimental" /> : <Availability state="config" />}
                <span className="text-muted">{hermes.data.isInstalled ? `Hermes détecté ${hermes.data.hermesVersion ?? ''}` : 'Hermes Agent n’est pas installé dans l’environnement Python configuré.'}</span>
              </div>
              <ul className="text-[12px] text-faint list-disc pl-5">
                {hermes.data.diagnostics.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <p className="text-[12.5px] text-muted">
                Adaptateur préliminaire : la délégation lance <code className="font-mono">python -m hermes run</code> dans un sous-processus borné (dossier du projet, durée maximale). Les capacités annoncées par Hermes ne sont pas encore vérifiées par un test automatique. Chemin Python : Paramètres, Outils.
              </p>
              {hermes.data.isInstalled && (
                <Button
                  size="sm"
                  onClick={() =>
                    api
                      .post('/api/hermes/delegate', { taskId: `hermes_${Date.now()}`, objective: 'Liste les fichiers du dossier courant.', workspacePath: workspaceRoot, maxDurationSeconds: 60 })
                      .then(() => toast('good', 'Délégation Hermes réussie'))
                      .catch((e) => toast('bad', 'Délégation échouée', errorMessage(e)))
                  }
                >
                  Tester une délégation
                </Button>
              )}
            </div>
          )}
        </Card>
      )}
      {tab === 'skills' && <SkillsPanel />}
    </Page>
  );
}

function SpecialistsPanel() {
  const list = useAsync((signal) => api.get<{ specialists: Array<{ role: string; label: string; tools: string[]; instructions: string; maxIterations: number }> }>('/api/agent/specialists', signal), []);
  return (
    <Card title="Agents spécialistes (outil agent.delegate)" subtitle="L’orchestrateur reste unique : il confie une sous-tâche à un spécialiste, qui travaille avec ses seuls outils et un budget d’étapes, puis ne renvoie que sa synthèse.">
      {list.error != null && <ErrorBox error={list.error} />}
      <div className="grid md:grid-cols-3 gap-3">
        {list.data?.specialists.map((s) => (
          <div key={s.role} className="rounded-md border border-line bg-sunk p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-fg">{s.label}</span>
              <Badge>{s.role}</Badge>
              <Badge>{s.maxIterations} étapes max</Badge>
            </div>
            <p className="text-[12px] text-muted">{s.instructions}</p>
            <div className="flex flex-wrap gap-1">
              {s.tools.map((t) => (
                <span key={t} className="font-mono text-[11px] px-1.5 py-0.5 rounded border border-line text-muted">
                  {t}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11.5px] text-faint mt-3">Les spécialistes ne peuvent pas déléguer à leur tour. Leurs actions d’écriture ou de commande restent soumises au centre de permissions.</p>
    </Card>
  );
}
