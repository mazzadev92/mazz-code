import { useEffect, useState } from 'react';
import { Square } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { navigate, toast } from '../../lib/store';
import { fmtMs } from '../../lib/format';
import { Badge, Button, Card, Stat, StatusDot } from '../../components/ui';

interface ServiceState {
  running: boolean;
  ownedByStudio: boolean;
  model?: string;
  config?: Record<string, unknown>;
  error?: string;
  log: string[];
  port: number;
  telemetry?: Record<string, number | string | null>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/** MUCE HTTP service (Python bridge 8098): state and /muce/v1/telemetry, polled every 3 s. */
export function MuceServiceCard() {
  const [st, setSt] = useState<ServiceState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api.get<ServiceState>('/api/muce/service').then((r) => alive && setSt(r)).catch(() => undefined);
    void load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const t = st?.telemetry ?? {};
  const tg = num(t.tokens_per_second);
  const pp = num(t.prompt_tokens_per_second);
  const ttft = num(t.time_to_first_token_ms);
  const acc = num(t.speculative_acceptance_rate);
  const ram = num(t.ram_usage_bytes);
  const reused = num(t.prompt_tokens_reused);
  const toolLatency = num(t.tool_call_latency_ms);
  return (
    <Card
      title="Service MUCE (127.0.0.1:8098)"
      subtitle="Pont Python officiel de MUCE devant son llama-server. Les valeurs viennent de /muce/v1/telemetry : timings du runtime pour la dernière requête, N/D tant que rien n’a été mesuré."
      actions={
        st?.running && st.ownedByStudio ? (
          <Button
            size="sm"
            variant="danger"
            icon={<Square className="w-3 h-3" />}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/api/muce/service/stop');
              } catch (e) {
                toast('bad', 'Arrêt impossible', errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Arrêter
          </Button>
        ) : !st?.running ? (
          <Button size="sm" onClick={() => navigate('models')}>
            Démarrer depuis le Model Hub
          </Button>
        ) : undefined
      }
    >
      <div className="flex items-center gap-2 text-[12.5px] mb-3">
        <StatusDot tone={st?.running ? 'good' : 'neutral'} label={st?.running ? 'En service' : 'Arrêté'} />
        <span className="text-fg">{st?.running ? 'En service' : 'Arrêté'}</span>
        {st?.running && <Badge>{st.ownedByStudio ? 'Démarré par le Studio' : 'Démarré hors du Studio'}</Badge>}
        {st?.model && <span className="font-mono text-[11.5px] text-muted truncate">{st.model}</span>}
      </div>
      {st?.error && <div className="text-[12px] text-bad mb-2">{st.error}</div>}
      {st?.running && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
          <Stat label="Génération" value={tg !== undefined ? `${tg.toFixed(1)} tok/s` : 'N/D'} source="runtime" />
          <Stat label="Prompt" value={pp !== undefined ? `${pp.toFixed(0)} tok/s` : 'N/D'} />
          <Stat label="Premier jeton" value={ttft !== undefined ? fmtMs(ttft) : 'N/D'} />
          <Stat label="Acceptation spéculative" value={acc !== undefined ? `${Math.round(acc * 100)} %` : 'N/D'} />
          <Stat label="Jetons repris du cache" value={reused !== undefined ? String(reused) : 'N/D'} hint="cache de prompt de llama.cpp" />
          <Stat label="RAM du modèle" value={ram !== undefined ? `${(ram / 1073741824).toFixed(2)} Go` : 'N/D'} />
          <Stat label="Latence outil" value={toolLatency !== undefined ? fmtMs(toolLatency) : 'N/D'} hint="Dernière exécution d’outil remontée par l’agent." source="Studio → MUCE" />
        </div>
      )}
    </Card>
  );
}
