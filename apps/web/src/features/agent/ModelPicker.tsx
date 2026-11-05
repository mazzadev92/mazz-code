import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Cloud, Cpu, FlaskConical, RefreshCw } from '../../components/icons';
import { api } from '../../lib/api';
import type { CatalogEntry } from '../../lib/types';
import { navigate, useApp } from '../../lib/store';
import { basename } from '../../lib/format';
import { Badge, Spinner, cx } from '../../components/ui';

export interface ModelChoice {
  providerId: string;
  modelId: string;
  locality: 'local' | 'remote';
  label: string;
  synthetic?: boolean;
}

export function useCatalog(open: boolean) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const llamaState = useApp((s) => s.llama?.state);
  const providersVersion = useApp((s) => s.providers.map((p) => `${p.id}:${p.hasApiKey}`).join(','));
  useEffect(() => {
    if (!open && catalog) return;
    const ctrl = new AbortController();
    setLoading(true);
    api
      .get<{ catalog: CatalogEntry[] }>('/api/models/catalog', ctrl.signal)
      .then((r) => setCatalog(r.catalog))
      .catch(() => undefined)
      .finally(() => setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, llamaState, providersVersion, nonce]);
  return { catalog, loading, refresh: () => setNonce((n) => n + 1) };
}

export function ModelPicker({ value, onChange }: { value: ModelChoice | null; onChange: (c: ModelChoice) => void }) {
  const [open, setOpen] = useState(false);
  const { catalog, loading, refresh } = useCatalog(open);
  const executionMode = useApp((s) => s.settings?.ai.executionMode);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    if (!catalog) return [];
    const order = (e: CatalogEntry) => (e.provider.id === 'mazz-cloud' ? -2 : e.provider.synthetic ? 3 : e.provider.locality === 'local' ? 0 : 1);
    return [...catalog].sort((a, b) => order(a) - order(b));
  }, [catalog]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-line bg-sunk text-[12px] text-fg hover:border-line-strong cursor-pointer max-w-[260px]"
      >
        {value?.providerId === 'mazz-cloud' ? <Cloud className="w-3.5 h-3.5 text-brand" /> : value?.synthetic ? <FlaskConical className="w-3.5 h-3.5 text-warn" /> : value?.locality === 'remote' ? <Cloud className="w-3.5 h-3.5 text-info" /> : <Cpu className="w-3.5 h-3.5 text-good" />}
        <span className="truncate">{value ? value.label : 'Choisir un modèle'}</span>
        <ChevronDown className="w-3.5 h-3.5 text-faint shrink-0" />
      </button>
      {open && (
        <div role="listbox" aria-label="Modèles disponibles" className="absolute bottom-9 left-0 z-[var(--z-overlay)] w-[380px] max-h-[420px] overflow-y-auto rounded-[var(--radius-lg)] border border-line bg-panel shadow-[var(--shadow-2)] py-1 fade-up">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[11px] text-faint">{executionMode === 'local_strict' ? 'Mode local strict : fournisseurs distants bloqués' : 'Mode hybride : local et distant'}</span>
            <button type="button" onClick={refresh} className="text-faint hover:text-fg cursor-pointer" aria-label="Actualiser la liste">
              {loading ? <Spinner size={12} /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
          </div>
          {!catalog && loading && <p className="px-3 py-3 text-[12px] text-muted">Interrogation des fournisseurs...</p>}
          {groups.map((g) => {
            const blocked = executionMode === 'local_strict' && g.provider.locality === 'remote';
            return (
              <div key={g.provider.id} className="py-1">
                <div className="flex items-center gap-2 px-3 py-1">
                  <span className="text-[11px] font-medium text-muted truncate">{g.provider.name}</span>
                  {g.provider.id === 'mazz-cloud' ? <Badge tone="brand">MAZZ Cloud</Badge> : g.provider.synthetic ? <Badge tone="warn">Test</Badge> : g.provider.locality === 'local' ? <Badge tone="good">Local</Badge> : <Badge tone="info">API</Badge>}
                </div>
                {g.models.length === 0 && (
                  <div className="px-3 pb-1 text-[11.5px] text-faint">
                    {g.reason || 'Aucun modèle'}
                    {g.provider.id === 'llama-local' && (
                      <button type="button" className="ml-2 text-brand hover:underline cursor-pointer" onClick={() => navigate('models')}>
                        Ouvrir le Model Hub
                      </button>
                    )}
                    {g.provider.requiresApiKey && !g.provider.hasApiKey && (
                      <button type="button" className="ml-2 text-brand hover:underline cursor-pointer" onClick={() => navigate('providers')}>
                        Ajouter une clé
                      </button>
                    )}
                  </div>
                )}
                {g.models.slice(0, 40).map((m) => {
                  const selected = value?.providerId === g.provider.id && value.modelId === m.id;
                  const disabled = blocked || !m.isAvailable;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      disabled={disabled}
                      title={blocked ? 'Bloqué par le mode local strict' : m.id}
                      onClick={() => {
                        onChange({ providerId: g.provider.id, modelId: m.id, locality: g.provider.locality, label: g.provider.id === 'llama-local' ? basename(m.id) : m.name || m.id, synthetic: g.provider.synthetic });
                        setOpen(false);
                      }}
                      className={cx('w-full flex items-center gap-2 px-3 h-8 text-left text-[12.5px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed', selected ? 'text-fg bg-raised' : 'text-muted hover:bg-raised hover:text-fg')}
                    >
                      <span className="w-3.5 shrink-0">{selected && <Check className="w-3.5 h-3.5 text-brand" />}</span>
                      <span className="truncate flex-1">{g.provider.id === 'llama-local' ? basename(m.id) : m.name || m.id}</span>
                      {m.maxContextTokens && <span className="text-[10.5px] text-faint tabular">{Math.round(m.maxContextTokens / 1000)}k</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
