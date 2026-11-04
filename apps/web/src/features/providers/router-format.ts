/** Display text for the MAZZ Control router section: French labels, no raw status codes, N/D when unknown. */
export const ROUTER_STATUS_LABELS: Record<string, string> = {
  missing_key: 'Clé absente',
  missing_url: 'URL à configurer',
  untested: 'Non testé',
  active: 'Actif',
  cooldown: 'En pause',
  exhausted: 'Quota épuisé',
  disabled: 'Désactivé',
};

export const ROUTER_CAPABILITY_LABELS: Record<string, string> = {
  chat: 'chat', vision: 'vision', embedding: 'embeddings', rerank: 'rerank', tts: 'voix', stt: 'transcription',
  image: 'image', '3d': '3D', search: 'recherche', scrape: 'extraction web',
};

const LIMIT_LABELS: Record<string, string> = { requests: 'requêtes', tokens: 'jetons', rpm: 'req/min' };

type Limit = { used: number; limit: number; remaining: number };

/** "14 400 requêtes restantes sur 14 400 · 30 req/min", or N/D when the provider declares no cap. */
export function routerQuotaText(limits: Record<string, Limit> | undefined): string {
  const entries = Object.entries(limits ?? {});
  if (!entries.length) return 'N/D';
  const n = (value: number) => value.toLocaleString('fr-FR');
  return entries.map(([name, l]) => (name === 'rpm' ? `${n(l.limit)} req/min` : `${n(l.remaining)} ${LIMIT_LABELS[name] ?? name} restants sur ${n(l.limit)}`)).join(' · ');
}

export function routerResetText(seconds: number | null | undefined): string {
  if (seconds == null) return 'N/D';
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}
