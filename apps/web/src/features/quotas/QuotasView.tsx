// Quotas: what every compute source has consumed and what is left (Colab, Modal, Kaggle, Groq, local),
// read from MAZZ Control through /api/control/quotas. Each card names where its numbers come from;
// a source that cannot be measured shows its error instead of a value.
import { useEffect, useState } from 'react';
import { RefreshCw } from '../../components/icons';
import { api } from '../../lib/api';
import { fmtNum, fmtRelative } from '../../lib/format';
import { Badge, Button, Card, ErrorBox, Page, PageHeader, Stat, useAsync } from '../../components/ui';
import { Meter } from '../../components/charts';

interface QuotaSource {
  id: string;
  label: string;
  source: string;
  status: 'ok' | 'error';
  error: string | null;
  measured_at: number;
  unit?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  percent?: number;
  reset?: string;
  estimated?: boolean;
  burn_per_hour?: number;
  active_sessions?: number;
  hours_left_at_rate?: number;
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_requests?: string;
  tokens_generated?: number;
  tokens_processed?: number;
  gen_tok_per_s?: number;
  kernels?: Array<{ ref: string; last_run: string }>;
}

const n = (v: number | undefined | null, digits = 2) => (v === undefined || v === null ? 'N/D' : fmtNum(v, digits));

function SourceBody({ s }: { s: QuotaSource }) {
  if (s.status === 'error') return <p className="text-[12.5px] text-warn break-words">Mesure impossible : {s.error}</p>;
  switch (s.id) {
    case 'colab':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Unités restantes" value={n(s.remaining)} source={s.source} />
          <Stat label="Consommation" value={`${n(s.burn_per_hour)} /h`} tone={s.burn_per_hour && s.burn_per_hour > 1 ? 'warn' : undefined} />
          <Stat label="Sessions actives" value={s.active_sessions ?? 'N/D'} tone={s.active_sessions ? 'warn' : 'good'} hint={s.active_sessions ? 'Une session consomme tant qu’elle est attribuée' : undefined} />
        </div>
      );
    case 'modal':
    case 'kaggle':
      return (
        <div className="space-y-3">
          <Meter value={s.used} max={s.limit} label={`${n(s.used)} / ${n(s.limit)} ${s.unit ?? ''}`} detail={s.reset ? `Remise à zéro : ${s.reset}` : undefined} />
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Restant" value={`${n(s.remaining)}`} hint={s.unit} />
            <Stat label="Utilisé" value={`${n(s.percent, 1)} %`} />
            <Stat label="Fiabilité" value={s.estimated ? 'Estimé localement' : 'Mesuré'} mono={false} tone={s.estimated ? 'warn' : 'good'} />
          </div>
          {s.kernels?.length ? (
            <ul className="text-[12px] text-muted space-y-0.5">
              {s.kernels.slice(0, 5).map((k) => (
                <li key={k.ref} className="flex justify-between gap-3"><span className="font-mono truncate">{k.ref}</span><span className="shrink-0">{k.last_run}</span></li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case 'groq':
      return (
        <div className="space-y-3">
          <Meter value={s.requests_limit !== undefined && s.requests_remaining !== undefined ? s.requests_limit - s.requests_remaining : undefined} max={s.requests_limit} label={`Requêtes : ${n(s.requests_remaining, 0)} restantes sur ${n(s.requests_limit, 0)}`} detail={s.reset_requests ? `Remise à zéro dans ${s.reset_requests}` : undefined} />
          <Meter value={s.tokens_limit !== undefined && s.tokens_remaining !== undefined ? s.tokens_limit - s.tokens_remaining : undefined} max={s.tokens_limit} label={`Tokens/min : ${n(s.tokens_remaining, 0)} restants sur ${n(s.tokens_limit, 0)}`} />
        </div>
      );
    case 'local':
      return (
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Tokens générés" value={n(s.tokens_generated, 0)} source={s.source} />
          <Stat label="Tokens lus" value={n(s.tokens_processed, 0)} />
          <Stat label="Coût" value="0 €" tone="good" />
        </div>
      );
    default:
      return <pre className="text-[11px] font-mono text-muted overflow-x-auto">{JSON.stringify(s, null, 2)}</pre>;
  }
}

export default function QuotasView() {
  const [nonce, setNonce] = useState(0);
  const [force, setForce] = useState(false);
  const state = useAsync((signal) => api.get<{ sources: QuotaSource[]; generated_at: number }>(`/api/control/quotas${force ? '?force=1' : ''}`, signal), [nonce]);
  // Cached sources refresh on their own cadence server-side; the view polls every minute.
  useEffect(() => {
    const id = window.setInterval(() => { if (document.hidden) return; setForce(false); setNonce((x) => x + 1); }, 60_000);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  return (
    <Page wide>
      <PageHeader
        title="Quotas et consommation"
        subtitle="Colab, Modal, Kaggle, API gratuites et modèle local. Chaque valeur indique sa source ; N/D quand elle n’est pas mesurable."
        actions={
          <Button size="sm" variant="ghost" icon={<RefreshCw className="w-3.5 h-3.5" />} onClick={() => { setForce(true); setNonce((x) => x + 1); }} disabled={state.loading}>
            Mesurer maintenant
          </Button>
        }
      />
      {state.error ? <ErrorBox error={state.error} onRetry={() => setNonce((x) => x + 1)} title="MAZZ Control injoignable" /> : null}
      {!state.data && state.loading ? <p className="text-[12.5px] text-muted">Lecture des quotas (Colab et Modal prennent quelques secondes)…</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {state.data?.sources.map((s) => (
          <Card
            key={s.id}
            title={s.label}
            subtitle={<span className="text-[11.5px] text-faint">{s.source} · mesuré {fmtRelative(s.measured_at * 1000, now)}</span>}
            actions={<Badge tone={s.status !== 'ok' ? 'warn' : s.estimated ? 'info' : 'good'}>{s.status !== 'ok' ? 'Indisponible' : s.estimated ? 'Estimé' : 'Mesuré'}</Badge>}
          >
            <SourceBody s={s} />
          </Card>
        ))}
      </div>
    </Page>
  );
}
