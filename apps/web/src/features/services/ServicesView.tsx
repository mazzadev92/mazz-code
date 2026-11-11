import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { Badge, Card, ErrorBox, Input, Notice, Page, PageHeader, Segmented, Button } from '../../components/ui';
import { ServiceGuide, type ProviderState } from './ServiceGuide';
import { CATEGORY_LABELS, filterServices, secretTarget, type ServiceEntry } from './services-format';

interface ComputeProviderRow { id: string; state: ProviderState }
interface RouterRow { id: string }

/** Every external service the app knows, with a guided setup for each. Nothing is mandatory. */
export default function ServicesView() {
  const [services, setServices] = useState<ServiceEntry[] | null>(null);
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const [routerIds, setRouterIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [freeNoCard, setFreeNoCard] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    // The catalogue is instant; provider checks may take seconds and must not block the list.
    await Promise.all([
      api.get<{ services: ServiceEntry[] }>('/api/compute/services').then((r) => setServices(r.services), setError),
      api.get<{ providers: ComputeProviderRow[] }>('/api/compute/providers').then((r) => setStates(Object.fromEntries(r.providers.map((p) => [p.id, p.state]))), () => undefined),
      api.get<{ providers: RouterRow[] }>('/api/integrations/status').then((r) => setRouterIds(r.providers.map((p) => p.id)), () => undefined),
    ]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const categories = useMemo(() => ['all', ...Array.from(new Set((services ?? []).map((s) => s.category)))], [services]);
  const shown = useMemo(() => filterServices(services ?? [], { query, category, freeNoCard }), [services, query, category, freeNoCard]);
  const computeIds = Object.keys(states);

  return (
    <Page>
      <PageHeader title="Services" subtitle="Comptes, clés et quotas gratuits des services que MAZZ sait utiliser. Rien n’est obligatoire : ouvrez un service pour voir à quoi il sert, où s’inscrire et où coller la clé." icon="hub" actions={<Button size="sm" variant="ghost" onClick={() => void load()}>Actualiser</Button>} />
      {error != null && <ErrorBox error={error} />}
      <Notice tone="info" title="Comment lire cette liste">
        Les quotas gratuits changent souvent chez les fournisseurs. Chaque fiche indique la date de vérification et renvoie à la page officielle ; « à vérifier » signifie qu’aucune déclaration officielle claire n’a été trouvée.
      </Notice>
      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Input className="max-w-xs" placeholder="Rechercher un service…" aria-label="Rechercher un service" value={query} onChange={(e) => setQuery(e.target.value)} />
            <label className="inline-flex items-center gap-2 text-[12.5px] text-muted cursor-pointer">
              <input type="checkbox" checked={freeNoCard} onChange={(e) => setFreeNoCard(e.target.checked)} /> Gratuit sans carte bancaire seulement
            </label>
            <span className="text-faint text-[12px]">{shown.length} service(s)</span>
          </div>
          <div className="overflow-x-auto max-w-full py-0.5 [scrollbar-width:none]">
            <Segmented label="Catégorie" value={category} onChange={setCategory} size="xs" options={categories.map((c) => ({ value: c, label: c === 'all' ? 'Toutes' : CATEGORY_LABELS[c] ?? c }))} />
          </div>
        </div>
      </Card>
      <ul className="space-y-2">
        {shown.map((s) => {
          const target = secretTarget(s, computeIds, routerIds);
          const state = target.kind === 'compute' ? states[target.id] : undefined;
          const isOpen = open === s.id;
          return (
            <li key={s.id} className="rounded-[var(--radius-lg)] border border-line bg-panel">
              <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : s.id)} className="w-full flex flex-wrap items-center gap-2 px-4 py-3 text-left cursor-pointer">
                <span className="font-medium text-fg text-[13.5px]">{s.name}</span>
                <Badge>{CATEGORY_LABELS[s.category] ?? s.category}</Badge>
                {state?.ok && <Badge tone="good">Prêt</Badge>}
                {s.support === 'full' && <Badge tone="info">Piloté par MAZZ</Badge>}
                <span className="ml-auto text-[12px] text-faint truncate max-w-[55%]">{s.free_tier}</span>
              </button>
              {isOpen && <div className="px-4 pb-4 border-t border-line pt-3"><ServiceGuide service={s} target={target} state={state} onChanged={() => void load()} /></div>}
            </li>
          );
        })}
        {services && shown.length === 0 && <li className="text-[12.5px] text-faint">Aucun service ne correspond. Décochez « sans carte bancaire » ou changez de catégorie.</li>}
        {!services && !error && <li className="text-[12.5px] text-faint">Chargement du catalogue…</li>}
      </ul>
    </Page>
  );
}
