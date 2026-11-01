// Lightweight SVG charts (no chart library): sparkline, line chart with axis,
// horizontal meter. Undefined points are gaps, never zeros.
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface Point {
  x: number;
  y: number | undefined;
}

function pathFor(points: Point[], sx: (x: number) => number, sy: (y: number) => number): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (p.y === undefined || !Number.isFinite(p.y)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

export function Sparkline({ values, width = 120, height = 28, label, color = 'var(--brand)' }: { values: Array<number | undefined>; width?: number; height?: number; label: string; color?: string }) {
  const defined = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  if (defined.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={`${label} : données insuffisantes`}>
        <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="var(--line)" strokeDasharray="3 3" />
      </svg>
    );
  }
  const max = Math.max(...defined);
  const min = Math.min(0, ...defined);
  const pts = values.map((y, x) => ({ x, y }));
  const sx = (x: number) => (x / Math.max(1, values.length - 1)) * (width - 2) + 1;
  const sy = (y: number) => height - 2 - ((y - min) / Math.max(1e-9, max - min)) * (height - 4);
  return (
    <svg width={width} height={height} role="img" aria-label={`${label} : maximum ${max.toFixed(1)}`}>
      <path d={pathFor(pts, sx, sy)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface Series {
  name: string;
  color: string;
  points: Point[];
}

export function LineChart({ series, height = 180, yLabel, xFormat, yFormat, label }: { series: Series[]; height?: number; yLabel?: string; xFormat?: (x: number) => string; yFormat?: (y: number) => string; label: string }) {
  const clipId = useId();
  // Rendered at the container's pixel width so labels keep their 10 px size.
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const { xMin, xMax, yMax } = useMemo(() => {
    const xs = series.flatMap((s) => s.points.map((p) => p.x));
    const ys = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== undefined && Number.isFinite(y)));
    return { xMin: Math.min(...xs), xMax: Math.max(...xs), yMax: ys.length ? Math.max(...ys) * 1.1 : 1 };
  }, [series]);
  const hasData = series.some((s) => s.points.filter((p) => p.y !== undefined).length >= 1);
  if (!hasData) {
    return (
      <div ref={box} className="h-[120px] grid place-items-center text-[12px] text-faint border border-dashed border-line rounded-md">
        Aucune mesure enregistrée
      </div>
    );
  }
  const sx = (x: number) => pad.l + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * (width - pad.l - pad.r);
  const sy = (y: number) => height - pad.b - (y / yMax) * (height - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const fy = yFormat || ((y: number) => (y >= 100 ? y.toFixed(0) : y.toFixed(1)));
  return (
    <div ref={box} className="w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img" aria-label={label}>
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={width - pad.l - pad.r} height={height - pad.t - pad.b} />
          </clipPath>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 6} y={sy(t) + 3} textAnchor="end" fontSize={10} fill="var(--faint)" className="tabular">
              {fy(t)}
            </text>
          </g>
        ))}
        {xFormat && (
          <>
            <text x={pad.l} y={height - 6} fontSize={10} fill="var(--faint)">
              {xFormat(xMin)}
            </text>
            <text x={width - pad.r} y={height - 6} fontSize={10} fill="var(--faint)" textAnchor="end">
              {xFormat(xMax)}
            </text>
          </>
        )}
        {yLabel && (
          <text x={4} y={pad.t + 8} fontSize={10} fill="var(--faint)">
            {yLabel}
          </text>
        )}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => (
            <g key={s.name}>
              <path d={pathFor(s.points, sx, sy)} fill="none" stroke={s.color} strokeWidth={1.75} strokeLinejoin="round" />
              {s.points.map((p, i) => p.y !== undefined && <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={2.2} fill={s.color} />)}
            </g>
          ))}
        </g>
      </svg>
      <div className="flex flex-wrap gap-3 mt-1">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="w-2.5 h-0.5 rounded" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}

export function Meter({ value, max, label, tone = 'brand', detail }: { value: number | undefined; max: number; label: string; tone?: 'brand' | 'good' | 'warn' | 'bad'; detail?: string }) {
  const pct = value === undefined ? undefined : Math.max(0, Math.min(100, (value / max) * 100));
  const color = { brand: 'bg-brand', good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad' }[pct !== undefined && pct > 90 ? 'bad' : pct !== undefined && pct > 75 ? 'warn' : tone];
  return (
    <div>
      <div className="flex justify-between text-[11.5px] mb-1">
        <span className="text-muted">{label}</span>
        <span className="text-faint tabular">{detail ?? (pct === undefined ? 'N/D' : `${pct.toFixed(0)} %`)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-sunk border border-line overflow-hidden" role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        {pct !== undefined && <div className={`h-full ${color} transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-propagate)]`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}
