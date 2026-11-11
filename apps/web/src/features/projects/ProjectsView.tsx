import { useEffect, useState } from 'react';
import { FolderOpen, GitBranch, Plus, X } from '../../components/icons';
import { navigate, openFullInterface, refreshHealth, saveSettings, setActiveSession, toast, useApp } from '../../lib/store';
import { api, errorMessage } from '../../lib/api';
import { fmtRelative, fmtInt } from '../../lib/format';
import { Badge, Button, Card, IconButton, Page, PageHeader, StatusDot } from '../../components/ui';
import { PathPicker } from '../../components/overlays';

export default function ProjectsView() {
  const settings = useApp((s) => s.settings);
  const health = useApp((s) => s.health);
  const sessions = useApp((s) => s.sessions);
  const viewParam = useApp((s) => s.viewParam);
  const [picker, setPicker] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const ws = health?.workspace;

  useEffect(() => {
    if (viewParam === 'open') setPicker(true);
  }, [viewParam]);

  const open = async (path: string) => {
    setOpening(path);
    try {
      await api.post('/api/workspace/open', { path });
      await Promise.all([refreshHealth(), saveSettings({})]);
      toast('good', 'Projet ouvert', path);
    } catch (e) {
      toast('bad', 'Ouverture impossible', errorMessage(e));
    } finally {
      setOpening(null);
    }
  };

  const recent = settings?.projects.recent ?? [];

  return (
    <Page>
      <PageHeader
        title="Projets"
        subtitle="Le projet actif est le dossier dans lequel l’agent, l’explorateur, le terminal et Git travaillent. Les outils ne peuvent pas sortir de ce dossier."
        icon="files"
        actions={
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setPicker(true)}>
            Ouvrir un dossier
          </Button>
        }
      />
      {ws && (
        <Card title="Projet actif">
          <div className="flex flex-wrap items-start gap-6">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] text-fg font-medium">{ws.name}</div>
              <div className="text-[12px] font-mono text-muted break-all">{ws.workspaceRoot}</div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {ws.isGitRepo ? (
                  <Badge tone="info" icon={<GitBranch className="w-3 h-3" />}>
                    {ws.gitBranch} {ws.gitDirtyCount ? `(${ws.gitDirtyCount} modif.)` : ''}
                  </Badge>
                ) : (
                  <Badge>Pas de dépôt Git</Badge>
                )}
                {ws.detectedLanguages.map((l) => (
                  <Badge key={l}>{l}</Badge>
                ))}
                <Badge>{fmtInt(ws.fileCount)} fichiers (3 niveaux)</Badge>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void (settings?.general.uiMode === 'guided' ? openFullInterface('code') : Promise.resolve(navigate('code')))}>Explorer</Button>
              <Button onClick={() => (setActiveSession(undefined), navigate('agent'))}>Nouvelle session</Button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-4">
            {ws.toolchains.map((t) => (
              <div key={t.name} className="flex items-center gap-2 text-[12px] px-2.5 py-1.5 rounded-md border border-line bg-sunk" title={t.path}>
                <StatusDot tone={t.isAvailable ? 'good' : 'neutral'} />
                <span className="font-mono">{t.name}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
      <Card title="Projets récents">
        {recent.length === 0 ? (
          <p className="text-[12.5px] text-faint">Aucun projet ouvert depuis le Studio.</p>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((p) => {
              const count = sessions.filter((s) => s.projectRoot === p.path).length;
              const active = ws?.workspaceRoot === p.path;
              return (
                <li key={p.path} className="flex items-center gap-3 py-2">
                  <FolderOpen className="w-4 h-4 text-brand shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-fg">
                      {p.name} {active && <Badge tone="good">Actif</Badge>}
                    </div>
                    <div className="text-[11.5px] font-mono text-faint truncate">{p.path}</div>
                  </div>
                  <span className="text-[11.5px] text-faint">
                    {count} session(s) - {fmtRelative(p.openedAt)}
                  </span>
                  <Button size="sm" disabled={active} loading={opening === p.path} onClick={() => open(p.path)}>
                    Ouvrir
                  </Button>
                  <IconButton size="sm" label="Retirer de la liste" onClick={() => saveSettings({ projects: { recent: recent.filter((r) => r.path !== p.path) } })}>
                    <X className="w-3.5 h-3.5" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="Isolation des sessions">
        <p className="text-[12.5px] text-muted leading-relaxed">
          Chaque session garde le dossier de projet de sa création : changer de projet n’affecte pas les sessions existantes. Une seule tâche à la fois par session ; le nombre de tâches simultanées est limité dans Paramètres, Agents. Les worktrees Git ne sont pas encore gérés par le backend : <Badge>Non disponible</Badge>
        </p>
      </Card>
      <PathPicker open={picker} mode="folder" title="Ouvrir un dossier de projet" initial={ws?.workspaceRoot} onClose={() => setPicker(false)} onPick={(p) => void open(p)} />
    </Page>
  );
}
