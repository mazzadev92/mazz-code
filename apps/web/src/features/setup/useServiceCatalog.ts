import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { ProviderState } from '../services/ServiceGuide';
import { secretTarget, type SecretTarget, type ServiceEntry } from '../services/services-format';

export interface ServiceCatalog {
  services: ServiceEntry[] | null;
  error: boolean;
  states: Record<string, ProviderState>;
  targetOf: (s: ServiceEntry) => SecretTarget;
  reload: () => void;
}

/** Même chargement que la page Services : catalogue immédiat, états des fournisseurs sans bloquer. */
export function useServiceCatalog(): ServiceCatalog {
  const [services, setServices] = useState<ServiceEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const [routerIds, setRouterIds] = useState<string[]>([]);

  const reload = useCallback(() => {
    setError(false);
    api.get<{ services: ServiceEntry[] }>('/api/compute/services').then((r) => setServices(r.services), () => setError(true));
    api.get<{ providers: Array<{ id: string; state: ProviderState }> }>('/api/compute/providers').then((r) => setStates(Object.fromEntries(r.providers.map((p) => [p.id, p.state]))), () => undefined);
    api.get<{ providers: Array<{ id: string }> }>('/api/integrations/status').then((r) => setRouterIds(r.providers.map((p) => p.id)), () => undefined);
  }, []);
  useEffect(reload, [reload]);

  const targetOf = (s: ServiceEntry) => secretTarget(s, Object.keys(states), routerIds);
  return { services, error, states, targetOf, reload };
}
