import { SemanticIndexCard } from './SemanticIndexCard';
import { AgentMemoryCard } from './AgentMemoryCard';
import { Bib1KnowledgeCard } from './Bib1KnowledgeCard';
import { useState } from 'react';
import { Database, Trash2 } from '../../components/icons';
import { api } from '../../lib/api';
import { refreshSessions, toast, useApp } from '../../lib/store';
import { fmtBytes, fmtDate, fmtInt } from '../../lib/format';
import { Button, Card, ConfirmDialog, ErrorBox, Notice, Page, PageHeader, Skeleton, useAsync } from '../../components/ui';

interface InventoryItem {
  kind: string;
  label: string;
  count: number;
  archived?: number;
  bytes: number;
  files?: number;
  modifiedAt?: number;
}

const DELETABLE: Record<string, { action: string; label: string; detail: string }> = {
  telemetry: { action: 'telemetry', label: 'Effacer les mesures', detail: 'Les mesures de performance enregistrées seront supprimées.' },
  benchmarks: { action: 'benchmarks', label: 'Effacer les benchmarks', detail: 'Tous les résultats de benchmark seront supprimés.' },
  checkpoints: { action: 'checkpoints', label: 'Effacer les points de restauration', detail: 'Les retours arrière ne seront plus possibles pour les tâches passées. Les fichiers du projet ne changent pas.' },
  audit: { action: 'audit', label: 'Effacer le journal d’audit', detail: 'L’historique des approbations et actions sera supprimé.' },
  sessions: { action: 'sessions-archived', label: 'Supprimer les sessions archivées', detail: 'Les sessions archivées et leur historique seront supprimés. Les sessions actives sont conservées.' },
};

export default function MemoryView() {
  const sessions = useApp((s) => s.sessions);
  const [nonce, setNonce] = useState(0);
  const inv = useAsync((signal) => api.get<{ dataDir: string; items: InventoryItem[] }>('/api/data/inventory', signal), [nonce]);
  const [confirm, setConfirm] = useState<InventoryItem | null>(null);
  const totalTurns = sessions.reduce((a, s) => a + s.turnCount, 0);

  return (
    <Page>
      <PageHeader title="Mémoire et données" subtitle="Ce que le Studio enregistre réellement sur cette machine, où, et comment l’effacer." icon="memory" />
      <AgentMemoryCard />
      <Bib1KnowledgeCard />
      <SemanticIndexCard />
      <Card title="Données enregistrées" subtitle={inv.data ? `Dossier : ${inv.data.dataDir}` : undefined}>
        {inv.error != null && <ErrorBox error={inv.error} onRetry={inv.reload} />}
        {!inv.data && !inv.error && <Skeleton />}
        {inv.data && (
          <table className="w-full text-[12.5px]">
            <thead className="text-left text-faint">
              <tr>
                <th className="py-1.5 font-medium">Type</th>
                <th className="py-1.5 font-medium">Éléments</th>
                <th className="py-1.5 font-medium">Taille</th>
                <th className="py-1.5 font-medium">Dernière écriture</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {inv.data.items.map((i) => (
                <tr key={i.kind}>
                  <td className="py-2 text-fg">
                    <Database className="w-3.5 h-3.5 inline mr-2 text-faint" />
                    {i.label}
                  </td>
                  <td className="py-2 tabular text-muted">
                    {fmtInt(i.count)}
                    {i.archived ? ` (${i.archived} archivées)` : ''}
                  </td>
                  <td className="py-2 tabular text-muted">{fmtBytes(i.bytes)}</td>
                  <td className="py-2 text-faint">{i.modifiedAt ? fmtDate(i.modifiedAt) : '-'}</td>
                  <td className="py-2 text-right">
                    {DELETABLE[i.kind] && (
                      <Button size="xs" variant="ghost" icon={<Trash2 className="w-3 h-3" />} onClick={() => setConfirm(i)} disabled={i.kind === 'sessions' ? !i.archived : i.count === 0}>
                        {DELETABLE[i.kind].label}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Contexte des conversations">
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            {sessions.length} session(s), {totalTurns} échange(s). À chaque demande, le modèle reçoit le message système, les 8 derniers échanges de la session (demandes et réponses finales) et la nouvelle demande. Les résultats d’outils d’une tâche ne sont pas réinjectés dans les tâches suivantes.
          </p>
          <p>L’utilisation de la fenêtre de contexte de chaque appel est affichée dans l’inspecteur de la session (onglet Contexte).</p>
        </div>
      </Card>
      <Card title="Bibliothèque et souvenirs de l’agent">
        <div className="space-y-2 text-[13px] text-muted">
          <p>La bibliothèque Bib1 fournit les connaissances documentaires. L’index sémantique recherche dans les dossiers configurés avec son modèle d’embeddings local.</p>
          <p>Les souvenirs durables de l’agent restent distincts de ces documents ; leurs entrées sont consultables et modifiables dans la carte Mémoire de l’agent.</p>
        </div>
      </Card>
      <Notice tone="info" title="Préférences locales du navigateur">
        Tailles de panneaux, brouillons et dernier onglet sont conservés dans le stockage local de ce navigateur uniquement. Les clés API n’y sont jamais écrites.
      </Notice>
      <ConfirmDialog
        open={!!confirm}
        danger
        title={confirm ? DELETABLE[confirm.kind].label : ''}
        confirmLabel="Effacer"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          await api.del(`/api/data/${DELETABLE[confirm!.kind].action}`);
          toast('good', 'Données effacées');
          setNonce((n) => n + 1);
          void refreshSessions();
        }}
      >
        {confirm ? DELETABLE[confirm.kind].detail : ''}
      </ConfirmDialog>
    </Page>
  );
}
