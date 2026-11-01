// Display formatting. Missing measurements always render as "N/D", never as 0.

export const ND = 'N/D';

export function fmtBytes(n?: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return ND;
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fr-FR', { maximumFractionDigits: i === 0 ? 0 : digits })} ${units[i]}`;
}

export function fmtMb(mb?: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return ND;
  return mb >= 1024 ? `${(mb / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Go` : `${Math.round(mb)} Mo`;
}

export function fmtNum(n?: number | null, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return ND;
  return n.toLocaleString('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 && n < 100 ? Math.min(digits, 1) : 0 });
}

export function fmtInt(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return ND;
  return Math.round(n).toLocaleString('fr-FR');
}

export function fmtRate(n?: number | null): string {
  return n == null || !Number.isFinite(n) ? ND : `${fmtNum(n, n < 10 ? 2 : 1)} tok/s`;
}

export function fmtMs(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return ND;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m} min ${s.toString().padStart(2, '0')} s`;
}

export function fmtParams(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return ND;
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Md`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} M`;
  return fmtInt(n);
}

export function fmtDate(ts?: number | null): string {
  if (!ts) return ND;
  return new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtTime(ts?: number | null): string {
  if (!ts) return ND;
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtRelative(ts?: number | null, now = Date.now()): string {
  if (!ts) return ND;
  const d = Math.round((now - ts) / 1000);
  if (d < 45) return 'à l’instant';
  if (d < 3600) return `il y a ${Math.round(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  if (d < 7 * 86400) return `il y a ${Math.round(d / 86400)} j`;
  return fmtDate(ts);
}

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(-half)}`;
}

const SECRET_KEYS = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

/** Redacts values of secret-looking keys before displaying tool arguments. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '••••' : redactSecrets(v);
    return out;
  }
  if (typeof value === 'string') return value.replace(/\b(sk-ant-[\w-]{6,}|sk-[\w-]{12,}|gsk_[\w]{8,}|AIza[\w-]{20,})/g, '••••');
  return value;
}

export const SOURCE_LABEL: Record<string, string> = {
  runtime_timings: 'Mesuré par le runtime (llama.cpp)',
  provider_usage: 'Déclaré par le fournisseur',
  client_estimate: 'Estimation côté client',
  synthetic: 'Moteur de test (aucune mesure)',
  unavailable: 'Non disponible',
};
