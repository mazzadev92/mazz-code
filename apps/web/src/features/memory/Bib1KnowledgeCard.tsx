import { useEffect, useRef, useState } from 'react';
import { BookOpen, RefreshCw, Search } from 'lucide-react';
import { Badge, Button, Card, ErrorBox, Input, Skeleton, useAsync } from '../../components/ui';
import { knowledgeApi, knowledgeTrust, type KnowledgeContext } from '../../lib/knowledge';

/** Citations expand only already-retrieved data. No browser file URL or arbitrary filesystem access. */
export function KnowledgeResults({ result }: { result: KnowledgeContext }) {
  const passages = result.data?.knowledge ?? [];
  const methods = result.data?.methods ?? [];
  if (result.status === 'error' || result.status === 'awaiting_permission') {
    return <div role="alert" className="text-[12.5px] text-warn">{result.warnings?.join(' ') || 'La recherche n’a pas abouti.'}</div>;
  }
  return (
    <div className="space-y-3" aria-live="polite">
      {passages.length === 0 && methods.length === 0 && !result.data?.context?.text && <p className="text-[12.5px] text-muted">Aucun passage pertinent trouvé. La bibliothèque ne permet pas de confirmer une réponse à cette question.</p>}
      {passages.length === 0 && result.data?.context?.text && <pre className="whitespace-pre-wrap text-[12px] text-muted max-h-64 overflow-auto">{result.data.context.text}</pre>}
      <ol className="space-y-2">
        {passages.map((passage, index) => {
          const trust = knowledgeTrust(passage.status ?? passage.trust);
          return (
            <li key={`${passage.id}:${passage.line ?? index}`} className="rounded-md border border-line bg-sunk p-2.5">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-[12.5px] text-fg font-medium">[{index + 1}] {passage.title}</span>
                <Badge tone={trust.verified ? 'good' : 'warn'}>{trust.label}</Badge>
              </div>
              {passage.body && <p className="text-[12px] text-muted whitespace-pre-wrap line-clamp-4">{passage.body}</p>}
              <details className="mt-2 text-[11.5px]">
                <summary className="cursor-pointer text-brand break-all" title="Afficher la référence et le passage récupéré en lecture seule">
                  {passage.absolute_path ?? passage.path}{passage.line ? `:${passage.line}` : ''}
                </summary>
                <div className="mt-2 space-y-1 text-muted">
                  <p className="font-mono break-all">{passage.id}{passage.heading ? ` · ${passage.heading}` : ''}</p>
                  {!passage.body && <p>Contexte commun aux références récupérées :</p>}
                  <pre className="whitespace-pre-wrap font-sans text-[12px] max-h-64 overflow-auto">{passage.body || result.data?.context?.text || 'Aucun texte récupéré.'}</pre>
                  <p>Références : {passage.sources?.length ? passage.sources.join(', ') : 'aucune référence documentaire associée'}.</p>
                  <p className="text-faint">Extrait déjà récupéré ; cette vue n’ouvre ni n’exécute un fichier du système.</p>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {methods.length > 0 && <div className="space-y-2">
        <p className="text-[12px] font-medium text-fg">Méthodes de résolution</p>
        {methods.map((method) => <details key={method.id} className="text-[12px] text-muted rounded-md border border-line p-2">
          <summary className="cursor-pointer text-fg">{method.title}{method.tier ? ` · ${method.tier}` : ''}</summary>
          <p className="mt-2 whitespace-pre-wrap">{method.text}</p>
        </details>)}
      </div>}
      {!!result.warnings?.length && <p className="text-[12px] text-warn">{result.warnings.join(' ')}</p>}
      {result.timings && <p className="text-[11.5px] text-faint">Récupération : {Math.round(result.timings.total_ms)} ms. Les extraits documentaires ne sont pas des instructions à exécuter.</p>}
    </div>
  );
}

export function Bib1KnowledgeCard() {
  const status = useAsync((signal) => knowledgeApi.status(signal), []);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeContext | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function search() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setSearching(true); setError(null); setResult(null);
    try {
      const response = await knowledgeApi.context(query, controller.signal);
      if (!controller.signal.aborted) setResult(response);
    } catch (err) {
      if (!controller.signal.aborted) setError(err);
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  return <Card title="Bibliothèque universelle · Bib1" subtitle="Connaissances et méthodes locales partagées entre les modèles GGUF. Seuls quelques extraits pertinents sont récupérés."
    actions={<Button size="sm" variant="ghost" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={status.reload}>Actualiser</Button>}>
    <div className="space-y-3">
      {status.error != null && <ErrorBox error={status.error} onRetry={status.reload} />}
      {!status.data && !status.error && <Skeleton />}
      {status.data && <>
        <div className="flex flex-wrap gap-2 items-center text-[12px]">
          <BookOpen className="w-4 h-4 text-faint" />
          <Badge tone={status.data.available ? 'good' : 'warn'}>{status.data.available ? 'Bibliothèque configurée' : 'Bibliothèque introuvable'}</Badge>
          <Badge tone={status.data.enginesRunning ? 'good' : 'neutral'}>{status.data.enginesRunning ? 'MCP connecté' : 'MCP à la demande'}</Badge>
          <Badge tone={status.data.running ? 'good' : 'neutral'}>{status.data.running ? 'API HTTP active' : 'API HTTP arrêtée'}</Badge>
          <Badge tone={status.data.autoContext ? 'good' : 'neutral'}>Recherche automatique {status.data.autoContext ? 'activée' : 'désactivée'}</Badge>
        </div>
        <p className="text-[12px] text-muted font-mono break-all">{status.data.home}{status.data.port ? ` · port ${status.data.port}` : ''}</p>
        {status.data.error && <p className="text-[12px] text-warn">{status.data.error}</p>}
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (query.trim() && !searching) void search(); }}>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ex. addition de fractions, loi d’Ohm, transaction SQLite…" aria-label="Rechercher dans Bib1" maxLength={2000} className="flex-1" />
          <Button type="submit" size="sm" loading={searching} disabled={!query.trim() || !status.data.available} icon={<Search className="w-3.5 h-3.5" />}>Chercher</Button>
        </form>
        <p className="text-[11.5px] text-faint">Recherche documentaire seule : aucune génération du modèle, aucun script ni accès Web déclenché par cette action.</p>
      </>}
      {error != null && <ErrorBox error={error} />}
      {result && <KnowledgeResults result={result} />}
    </div>
  </Card>;
}
