export type FreeKind = 'continuous' | 'daily' | 'weekly' | 'monthly' | 'one_time' | 'trial' | 'none' | 'unknown';

export interface ServiceEntry {
  id: string;
  name: string;
  category: string;
  family: string;
  support: 'full' | 'guide' | 'planned';
  provider_id: string | null;
  website: string;
  signup_url: string;
  free_tier: string;
  free_kind: FreeKind;
  requires_card: boolean | null;
  requires_phone: boolean | null;
  secret_name: string;
  where_to_find: string;
  where_saved: string;
  steps: string[];
  notes: string;
  source_url: string;
  verified_at: string;
}

export const CATEGORY_LABELS: Record<string, string> = {
  gpu_notebook: 'GPU notebook',
  serverless_gpu: 'GPU à la demande',
  gpu_vm: 'GPU machine virtuelle',
  managed_inference: 'IA par API',
  model_hub: 'Bibliothèque de modèles',
  image_api: 'Image',
  video_api: 'Vidéo',
  '3d_api': '3D',
  speech_api: 'Voix et audio',
  search_api: 'Recherche web',
  embedding_api: 'Embeddings',
  vector_db: 'Base vectorielle',
  storage: 'Stockage',
  tunnel: 'Tunnel',
  other: 'Autre',
};

export const FREE_KIND_LABELS: Record<FreeKind, string> = {
  continuous: 'Gratuit en continu',
  daily: 'Quota quotidien',
  weekly: 'Quota hebdomadaire',
  monthly: 'Crédit mensuel',
  one_time: 'Crédit unique',
  trial: 'Essai',
  none: 'Pas de gratuit',
  unknown: 'À vérifier',
};

/** True when the free tier statement could not be verified on the provider's official page. */
export function isUnverified(s: ServiceEntry): boolean {
  return s.free_kind === 'unknown' || /^non verifie/i.test(s.free_tier);
}

export interface ServiceFilter {
  query: string;
  category: string;
  freeNoCard: boolean;
}

/** Free without card = the provider states no card is required and a free tier exists. */
export function filterServices(list: ServiceEntry[], f: ServiceFilter): ServiceEntry[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((s) => {
    if (f.category !== 'all' && s.category !== f.category) return false;
    if (f.freeNoCard && !(s.requires_card === false && s.free_kind !== 'none' && s.free_kind !== 'unknown')) return false;
    return !q || s.name.toLowerCase().includes(q) || s.id.includes(q) || s.free_tier.toLowerCase().includes(q);
  });
}

export type SecretTarget = { kind: 'compute'; id: string } | { kind: 'router'; id: string } | { kind: 'none' };

/**
 * Where a service's secret goes: a compute provider (HF, Kaggle...) has its own validated route; an AI-router provider
 * stores its key through the router; anything else is explained only (the app does not drive it yet).
 */
export function secretTarget(s: ServiceEntry, computeIds: string[], routerIds: string[]): SecretTarget {
  const id = s.provider_id ?? s.id;
  if (computeIds.includes(id)) return { kind: 'compute', id };
  if (s.provider_id && routerIds.includes(s.provider_id)) return { kind: 'router', id: s.provider_id };
  return { kind: 'none' };
}
