import { api } from './api';

export interface KnowledgeStatus {
  available: boolean;
  running: boolean;
  enginesRunning?: boolean;
  home: string;
  port: number;
  autoContext: boolean;
  capabilities?: Record<string, unknown>;
  error?: string;
}

export interface KnowledgePassage {
  id: string;
  title: string;
  path: string;
  absolute_path?: string;
  line?: number;
  heading?: string;
  body: string;
  status?: string;
  trust?: string;
  sources?: string[];
}

export interface KnowledgeMethod {
  id: string;
  title: string;
  tier?: string;
  text: string;
}

export interface KnowledgeContext {
  schema_version: string;
  status: 'ok' | 'no_evidence' | 'awaiting_permission' | 'error';
  data: {
    context?: { text: string; document_token_upper_bound?: number };
    knowledge?: KnowledgePassage[];
    methods?: KnowledgeMethod[];
  } | null;
  warnings?: string[];
  timings?: { total_ms: number };
}

export interface KnowledgeBridgeResponse {
  result?: {
    query?: string;
    context?: string | { text: string };
    characters?: number;
    citations?: Array<Omit<KnowledgePassage, 'body' | 'title'> & { title?: string; label?: string; body?: string }>;
    methods?: KnowledgeMethod[];
    engine_status?: string;
    warnings?: string[];
  };
}

/** Accept both the Studio bridge envelope and the standalone engines envelope. */
export function normalizeKnowledgeContext(response: KnowledgeContext | KnowledgeBridgeResponse): KnowledgeContext {
  if ('schema_version' in response) return response;
  const result = response.result;
  const text = typeof result?.context === 'string' ? result.context : result?.context?.text ?? '';
  const citations = result?.citations ?? [];
  const methods = result?.methods ?? [];
  return {
    schema_version: '1.0',
    status: citations.length || methods.length || text ? 'ok' : 'no_evidence',
    data: {
      context: { text },
      knowledge: citations.map((citation) => ({ ...citation, title: citation.title ?? citation.label ?? citation.id, body: citation.body ?? '' })),
      methods,
    },
    warnings: result?.warnings ?? [],
  };
}

export const knowledgeApi = {
  status: (signal?: AbortSignal) => api.get<KnowledgeStatus>('/api/knowledge', signal),
  context: async (query: string, signal?: AbortSignal) => normalizeKnowledgeContext(await api.post<KnowledgeContext | KnowledgeBridgeResponse>('/api/knowledge/context', { query: query.trim() }, signal)),
};

export function knowledgeTrust(status?: string): { label: string; verified: boolean } {
  if (status === 'verified') return { label: 'Fiche vérifiée', verified: true };
  if (status === 'source_imported') return { label: 'Source importée, non revue', verified: false };
  if (status === 'external_unreviewed') return { label: 'Document externe, non revu', verified: false };
  return { label: 'Contenu non validé', verified: false };
}
