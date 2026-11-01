import { useEffect, useState } from 'react';
import { Play, Search } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { saveSettings, toast, useApp } from '../../lib/store';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, ErrorBox, Input, Spinner } from '../../components/ui';
import { PathPicker } from '../../components/overlays';
import { FolderListEditor } from '../agent/AccessDialog';

interface SemanticStatus {
  folders: string[];
  model?: string;
  retrievalMode?: 'hybrid' | 'lexical';
  files: number;
  chunks: number;
  builtAt?: number;
  building: boolean;
  progress?: { done: number; total: number; file?: string };
  error?: string;
  embeddingModel: string;
  server: string;
}

interface Hit {
  file: string;
  line: number;
  text: string;
  score: number;
  retrievalDepth?: number;
  matchedAnchor?: string;
  retrieval?: 'hybrid' | 'semantic' | 'lexical';
}

/** Persistent hybrid or explicit lexical index, used by the agent through index.search. */
export function SemanticIndexCard() {
  const settings = useApp((s) => s.settings);
  const [st, setSt] = useState<SemanticStatus | null>(null);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.get<SemanticStatus>('/api/semantic').then((r) => alive && setSt(r)).catch(() => undefined);
    void load();
    const id = setInterval(load, st?.building ? 1500 : 6000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [st?.building]);

  const save = async (patch: Record<string, unknown>) => {
    try {
      await saveSettings({ semantic: patch });
      setSt((s) => (s ? { ...s, ...('folders' in patch ? { folders: patch.folders as string[] } : {}), ...('embeddingModel' in patch ? { embeddingModel: String(patch.embeddingModel) } : {}) } : s));
    } catch (e) {
      toast('bad', 'Enregistrement impossible', errorMessage(e));
    }
  };

  const search = async () => {
    setSearching(true);
    setError(null);
    try {
      const result = await api.post<{ retrievalMode?: 'hybrid' | 'lexical'; results: Hit[] }>('/api/semantic/search', { query, k: 8 });
      setHits(result.results);
      if (result.retrievalMode) setSt((s) => (s ? { ...s, retrievalMode: result.retrievalMode } : s));
    } catch (e) {
      setError(e);
    } finally {
      setSearching(false);
    }
  };

  const build = async (mode: 'hybrid' | 'lexical') => {
    try {
      const result = await api.post<{ started: boolean; retrievalMode: 'hybrid' | 'lexical' }>('/api/semantic/build', { mode });
      setSt((s) => (s ? { ...s, building: true, retrievalMode: result.retrievalMode } : s));
    } catch (e) {
      toast('bad', 'Indexation impossible', errorMessage(e));
    }
  };

  const folders = settings?.semantic?.folders ?? st?.folders ?? [];
  return (
    <Card
      title="Index de mémoire documentaire"
      subtitle="Index persistant des dossiers locaux. Choisissez explicitement la recherche hybride avec embeddings locaux ou BM25 lexical sans modèle. L’agent l’utilise via index.search ; rien ne quitte la machine."
      actions={
        st?.building ? (
          <Button size="sm" variant="ghost" onClick={() => void api.post('/api/semantic/stop').catch(() => undefined)} title="S’arrête après le fichier en cours ; la progression est gardée et reprise au prochain lancement">
            Arrêter (reprise possible)
          </Button>
        ) : (
        <div className="flex gap-1.5">
          <Button size="sm" icon={st?.building ? <Spinner size={12} /> : <Play className="w-3.5 h-3.5" />} disabled={!!st?.building || !folders.length || !st?.embeddingModel} onClick={() => void build('hybrid')}>
            {st?.building && st.retrievalMode === 'hybrid' ? 'Indexation hybride…' : 'Indexer avec embeddings'}
          </Button>
          <Button size="sm" variant="ghost" disabled={!!st?.building || !folders.length} onClick={() => void build('lexical')} title="Stockage persistant et recherche BM25 ; n’utilise aucun modèle d’embeddings.">
            {st?.building && st.retrievalMode === 'lexical' ? 'Indexation lexicale…' : 'Indexer en lexical'}
          </Button>
        </div>
        )
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="text-muted">Modèle d’embeddings :</span>
          <span className="font-mono text-fg truncate">{st?.embeddingModel || 'aucun'}</span>
          <Button size="xs" variant="ghost" onClick={() => setPicker(true)}>
            Choisir
          </Button>
          {st?.server === 'ready' && <Badge tone="good">serveur prêt</Badge>}
          {st?.retrievalMode === 'lexical' && <Badge tone="warn">BM25 lexical · sans embeddings</Badge>}
          {st?.retrievalMode === 'hybrid' && <Badge tone="good">hybride · index embeddings</Badge>}
        </div>
        <PathPicker open={picker} mode="file" ext=".gguf" title="Modèle d’embeddings (GGUF)" onClose={() => setPicker(false)} onPick={(p) => void save({ embeddingModel: p })} />
        <FolderListEditor folders={folders} onChange={(next) => save({ folders: next })} empty="Aucun dossier indexé." addLabel="Ajouter un dossier à indexer" />
        <div className="text-[12px] text-muted">
          {st?.building && st.progress
            ? `Indexation : ${st.progress.done}/${st.progress.total} fichier(s) à traiter${st.progress.file ? ` (${st.progress.file.split(/[\\/]/).pop()})` : ''}`
            : st?.chunks
              ? `${st.files} fichier(s), ${st.chunks} passage(s), indexé le ${fmtDate(st.builtAt)} · ${st.retrievalMode === 'lexical' ? 'BM25 lexical (sans embeddings)' : `recherche hybride · ${st.model ?? 'modèle inconnu'}`}.`
              : 'Index vide.'}
          {st?.error && <span className="text-bad"> Erreur : {st.error}</span>}
        </div>
        <p className="text-[11.5px] text-faint">L’index conserve des passages locaux sur disque et peut suivre des identifiants explicitement cités pour retrouver des documents liés. BM25 lexical classe les termes et identifiants, sans compréhension sémantique. Cette mémoire externe ne modifie pas la fenêtre native du GGUF.</p>
        {st?.chunks ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) void search();
            }}
          >
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={st?.retrievalMode === 'lexical' ? 'Recherche BM25, ex. « Qadron bancs »' : 'Tester une recherche, ex. « outil pour profiler du code C »'} aria-label={st?.retrievalMode === 'lexical' ? 'Recherche lexicale BM25' : 'Recherche hybride'} className="flex-1" />
            <Button size="sm" type="submit" icon={<Search className="w-3.5 h-3.5" />} loading={searching}>
              Chercher
            </Button>
          </form>
        ) : null}
        {error != null && <ErrorBox error={error} />}
        {hits && (
          <ol className="space-y-2">
            {hits.map((h, i) => (
              <li key={i} className="rounded-md border border-line bg-sunk p-2">
                <div className="flex items-center gap-2 text-[11.5px]">
                  <span className="font-mono text-fg truncate">{h.file}</span>
                  <span className="text-faint">ligne {h.line}</span>
                  {!!h.retrievalDepth && <Badge tone="neutral">Étape {h.retrievalDepth}{h.matchedAnchor ? ` · ${h.matchedAnchor}` : ''}</Badge>}
                  {h.retrieval === 'lexical' && <Badge tone="warn">termes exacts</Badge>}
                  <Badge className="ml-auto">{h.score.toFixed(3)}</Badge>
                </div>
                <div className="text-[12px] text-muted line-clamp-3 whitespace-pre-wrap">{h.text}</div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
