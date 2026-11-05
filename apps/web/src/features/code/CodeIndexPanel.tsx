import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, FileCode2, GitBranch, LoaderCircle, RefreshCw, Search } from '../../components/icons';
import { Button, Input } from '../../components/ui';
import { api, errorMessage } from '../../lib/api';
import { openFile } from './codeStore';

type IndexStatus = {
  workspace: string;
  indexPath: string;
  updatedAt: string;
  indexedFiles: number;
  errorFiles: Array<{ path: string; error: string }>;
  symbols: number;
  schemaVersion: number;
  parserVersion: string;
};

type IndexSummary = { scanned: number; parsed: number; unchanged: number; removed: number; errors: number; updatedAt: string };
type SearchMatch = {
  path: string;
  language: string;
  sha256: string;
  symbols: Array<{ name: string; signature: string; line?: number; kind?: string }>;
  imports: Array<{ specifier: string; target?: string; line?: number }>;
};
type ContentMatch = {
  path: string;
  line: number;
  column: number;
  excerpt: string;
  sha256: string;
  bytes: number;
  indexedAt: string;
};
type SearchOutput = {
  query: string;
  matches: SearchMatch[];
  contentMatches?: ContentMatch[];
  contentSearchTruncated?: boolean;
  indexedAt: string;
  update: IndexSummary;
};
type ImpactOutput = { target: string; direct: string[]; transitive: string[]; indexedAt: string; update: IndexSummary };
type ToolReply<T> = { success: boolean; output: T | null; error?: string };

async function executeReply<T>(body: Record<string, unknown>): Promise<ToolReply<T>> {
  return api.post<ToolReply<T>>('/api/code/index', body);
}

async function execute<T>(body: Record<string, unknown>): Promise<T> {
  const result = await executeReply<T>(body);
  if (!result.success || result.output === null) throw new Error(result.error || 'L’index du projet a refusé la requête.');
  return result.output;
}

function localTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export interface CodeIndexPanelProps {
  initialExpanded?: boolean;
  initialStatus?: IndexStatus | null;
  initialSummary?: IndexSummary | null;
  initialSearch?: SearchOutput | null;
  initialImpact?: ImpactOutput | null;
  initialError?: string | null;
  initialBusy?: 'status' | 'update' | 'search' | 'impact' | null;
}

export function CodeIndexPanel(props: CodeIndexPanelProps = {}) {
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false);
  const [status, setStatus] = useState<IndexStatus | null>(props.initialStatus ?? null);
  const [summary, setSummary] = useState<IndexSummary | null>(props.initialSummary ?? null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState<SearchOutput | null>(props.initialSearch ?? null);
  const [impactPath, setImpactPath] = useState('');
  const [impact, setImpact] = useState<ImpactOutput | null>(props.initialImpact ?? null);
  const [busy, setBusy] = useState<'status' | 'update' | 'search' | 'impact' | null>(
    props.initialBusy ?? (props.initialStatus !== undefined ? null : 'status'),
  );
  const [error, setError] = useState<string | null>(props.initialError ?? null);

  const refreshStatus = useCallback(async () => {
    setBusy((current) => current === null ? 'status' : current);
    try {
      const next = await execute<IndexStatus>({ action: 'status' });
      setStatus(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy((current) => current === 'status' ? null : current);
    }
  }, []);

  useEffect(() => {
    if (props.initialStatus === undefined) {
      void refreshStatus();
    }
  }, [props.initialStatus, refreshStatus]);

  const updateIndex = async () => {
    setBusy('update');
    setError(null);
    setSearch(null);
    setImpact(null);
    try {
      setSummary(await execute<IndexSummary>({ action: 'update' }));
      setStatus(await execute<IndexStatus>({ action: 'status' }));
    } catch (err) {
      setError(errorMessage(err));
      try { setStatus(await execute<IndexStatus>({ action: 'status' })); } catch { /* Keep the first, actionable error. */ }
    } finally {
      setBusy(null);
    }
  };

  const searchIndex = async (event: React.FormEvent) => {
    event.preventDefault();
    const query = searchText.trim();
    if (!query) return;
    setBusy('search');
    setError(null);
    setImpact(null);
    try {
      const reply = await executeReply<SearchOutput>({ action: 'search', query, limit: 30 });
      if (reply.output === null) throw new Error(reply.error || 'La recherche de contenu a échoué.');
      setSearch(reply.output);
      setSummary(reply.output.update);
      if (!reply.success) setError(reply.error || 'La recherche est partielle; consulte les sources en erreur.');
      try {
        const statusReply = await executeReply<IndexStatus>({ action: 'status' });
        if (statusReply.output !== null) setStatus(statusReply.output);
        if (!statusReply.success) setError((current) => current ?? statusReply.error ?? 'L’index contient des sources en erreur.');
      } catch (statusError) {
        setError((current) => current ?? errorMessage(statusError));
      }
    } catch (err) {
      setError(errorMessage(err));
      setSearch(null);
    } finally {
      setBusy(null);
    }
  };

  const inspectImpact = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = impactPath.trim();
    if (!target) return;
    setBusy('impact');
    setError(null);
    setSearch(null);
    try {
      setImpact(await execute<ImpactOutput>({ action: 'impact', path: target, limit: 100 }));
      setStatus(await execute<IndexStatus>({ action: 'status' }));
    } catch (err) {
      setError(errorMessage(err));
      setImpact(null);
    } finally {
      setBusy(null);
    }
  };

  const work = busy !== null;

  return (
    <section className="shrink-0 border-b border-line bg-panel" aria-label="Index du code du projet">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileCode2 className="w-4 h-4 text-brand shrink-0" aria-hidden />
        <button type="button" className="min-w-0 flex-1 text-left cursor-pointer" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          <span className="text-[12.5px] font-medium text-fg">Index du code du projet</span>
          <span className="ml-2 text-[11.5px] text-muted">
            {status ? `${status.indexedFiles} fichiers · ${status.symbols} symboles` : busy === 'status' ? 'Chargement de l’état réel…' : 'État indisponible'}
          </span>
        </button>
        <Button size="xs" variant="ghost" icon={work ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} disabled={work} onClick={() => void updateIndex()}>
          {busy === 'update' ? 'Indexation…' : 'Indexer / actualiser'}
        </Button>
        <button type="button" className="grid place-items-center w-7 h-7 rounded hover:bg-raised text-muted cursor-pointer" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? 'Réduire l’index du projet' : 'Afficher les outils de recherche de code'}>
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-2.5">
          {status && (
            <div className="text-[11px] text-faint font-mono break-all" data-testid="code-index-status">
              {status.indexPath}{status.updatedAt ? ` · mis à jour ${localTime(status.updatedAt)}` : ' · index non encore créé'}
            </div>
          )}
          {summary && (
            <div className="text-[11.5px] text-muted" role="status">
              Parcours disque : {summary.scanned} sources, {summary.parsed} analysées, {summary.unchanged} inchangées, {summary.removed} retirées, {summary.errors} erreurs.
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
            <form onSubmit={(event) => void searchIndex(event)} className="flex gap-1.5">
              <Input aria-label="Rechercher dans le contenu ou les symboles du code indexé" placeholder="Texte littéral, code ou symbole" value={searchText} onChange={(event) => setSearchText(event.target.value)} />
              <Button type="submit" size="sm" variant="secondary" icon={<Search className="w-3.5 h-3.5" />} disabled={work || !searchText.trim()}>Chercher</Button>
            </form>
            <form onSubmit={(event) => void inspectImpact(event)} className="flex gap-1.5">
              <Input aria-label="Fichier à analyser pour son impact" placeholder="src/fichier.ts" value={impactPath} onChange={(event) => setImpactPath(event.target.value)} />
              <Button type="submit" size="sm" variant="secondary" icon={<GitBranch className="w-3.5 h-3.5" />} disabled={work || !impactPath.trim()}>Impact</Button>
            </form>
          </div>

          {status?.errorFiles.length ? (
            <div className="text-[11.5px] text-warn rounded border border-warn/30 bg-warn/5 p-2" role="status">
              <div className="font-medium">{status.errorFiles.length} source(s) n’ont pas été analysées :</div>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {status.errorFiles.slice(0, 5).map((item) => (
                  <li key={item.path}>
                    <button type="button" className="font-mono text-brand hover:underline cursor-pointer" onClick={() => void openFile(item.path)}>{item.path}</button>
                    <span className="ml-1 text-muted">({item.error})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {search && (
            <div className="max-h-96 overflow-auto rounded border border-line divide-y divide-line" data-testid="code-index-search-results">
              {search.contentMatches?.length ? (
                <div className="border-b border-line" data-testid="code-index-content-results">
                  <div className="px-2.5 py-1.5 text-[10.5px] uppercase tracking-wide text-faint">
                    Correspondances littérales dans les fichiers actuels ({search.contentMatches.length})
                    {search.contentSearchTruncated ? ' · résultats limités' : ''}
                  </div>
                  {search.contentMatches.map((match, idx) => (
                    <div key={`${match.path}:${match.line}:${match.column}:${idx}`} className="px-2.5 py-1.5 border-t border-line/60 text-[11.5px]">
                      <div className="flex items-baseline gap-1.5 min-w-0">
                        <button
                          type="button"
                          className="font-mono text-brand hover:underline cursor-pointer truncate"
                          onClick={() => void openFile(match.path, match.line)}
                          aria-label={`Ouvrir ${match.path} à la ligne ${match.line}`}
                        >
                          {match.path}:L{match.line}
                        </button>
                        <span className="text-faint shrink-0">col. {match.column} · {match.bytes} octets</span>
                      </div>
                      <pre className="mt-1 whitespace-pre-wrap break-all rounded bg-raised/60 px-2 py-1 font-mono text-[10.5px] text-muted" data-testid="code-index-content-excerpt">{match.excerpt}</pre>
                      <div className="mt-1 break-all font-mono text-[9.5px] text-faint" title={`SHA-256 complet du fichier source : ${match.sha256}`}>
                        SHA-256 source : {match.sha256}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {search.matches.length ? search.matches.map((match) => (
                <div key={`${match.path}:${match.sha256}`} className="px-2.5 py-1.5 text-[11.5px]">
                  <button type="button" className="font-mono text-brand hover:underline cursor-pointer" onClick={() => void openFile(match.path)}>{match.path}</button>
                  <span className="ml-2 text-faint">{match.language} · {match.sha256.slice(0, 12)}</span>
                  {match.symbols.length > 0 && (
                    <div className="mt-0.5 space-y-0.5">
                      {match.symbols.slice(0, 5).map((symbol, idx) => (
                        <div key={`${symbol.name}:${symbol.line ?? idx}`} className="text-muted flex items-baseline gap-1.5">
                          {symbol.line && (
                            <button
                              type="button"
                              className="font-mono text-[10.5px] text-brand/80 hover:underline cursor-pointer shrink-0"
                              onClick={() => void openFile(match.path, symbol.line)}
                              aria-label={`Ouvrir ${match.path} à la ligne ${symbol.line}`}
                            >
                              L{symbol.line}
                            </button>
                          )}
                          <span className="font-mono text-[11px] truncate">{symbol.signature || symbol.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {match.imports.length > 0 && (
                    <div className="mt-0.5 text-faint flex flex-wrap gap-1">
                      <span>Importe :</span>
                      {match.imports.slice(0, 5).map((item, idx) => (
                        item.target ? (
                          <button
                            type="button"
                            key={`${item.specifier}:${idx}`}
                            className="font-mono text-brand hover:underline cursor-pointer"
                            onClick={() => void openFile(item.target!)}
                          >
                            {item.target}
                          </button>
                        ) : (
                          <span key={`${item.specifier}:${idx}`} className="font-mono">{item.specifier}</span>
                        )
                      ))}
                    </div>
                  )}
                </div>
              )) : null}
              {!search.matches.length && !search.contentMatches?.length && (
                <div className="px-2.5 py-2 text-[11.5px] text-muted">Aucun contenu, symbole ou fichier correspondant.</div>
              )}
            </div>
          )}
          {impact && (
            <div className="rounded border border-line p-2.5 text-[11.5px]" data-testid="code-index-impact-results">
              <div className="font-mono text-fg font-medium">
                <button type="button" className="hover:underline cursor-pointer text-brand" onClick={() => void openFile(impact.target)}>
                  {impact.target}
                </button>
              </div>
              <div className="mt-1 text-muted">Dépendances directes : {impact.direct.length} · indirectes : {impact.transitive.length}</div>
              {impact.direct.length > 0 && (
                <div className="mt-1.5">
                  <span className="text-faint text-[10.5px] uppercase tracking-wide">Directes :</span>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-0.5">
                    {impact.direct.map((file) => (
                      <button type="button" key={file} className="font-mono text-brand hover:underline cursor-pointer" onClick={() => void openFile(file)}>{file}</button>
                    ))}
                  </div>
                </div>
              )}
              {impact.transitive.length > 0 && (
                <div className="mt-1.5">
                  <span className="text-faint text-[10.5px] uppercase tracking-wide">Transitives :</span>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 mt-0.5">
                    {impact.transitive.map((file) => (
                      <button type="button" key={file} className="font-mono text-brand/80 hover:underline cursor-pointer" onClick={() => void openFile(file)}>{file}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <div className="flex items-start gap-1.5 text-[11.5px] text-bad" role="alert"><CircleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />{error}</div>}
        </div>
      )}
    </section>
  );
}
