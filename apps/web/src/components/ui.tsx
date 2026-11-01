// Shared UI primitives. Rule: loading, errors and missing data are stated
// explicitly; no placeholder value is ever presented as real.
import { forwardRef, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { AlertTriangle, Check, Info, RefreshCw, X } from 'lucide-react';
import { errorMessage } from '../lib/api';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-on-primary hover:brightness-110 border border-transparent',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-raised-2',
  ghost: 'text-muted hover:text-fg hover:bg-raised border border-transparent',
  subtle: 'bg-sunk text-fg border border-line hover:bg-raised',
  danger: 'text-bad border border-bad/40 bg-bad/5 hover:bg-bad/10',
};
const SIZE: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-[5px]',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center whitespace-nowrap font-medium select-none cursor-pointer',
        'transition-[background-color,border-color,color,filter] duration-[var(--dur-fast)]',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        VARIANT[variant],
        SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? <span className="spinner w-3.5 h-3.5" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, children, className, active, size = 'md', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cx(
        'inline-flex items-center justify-center rounded-md cursor-pointer transition-colors duration-[var(--dur-fast)]',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        size === 'sm' ? 'w-6 h-6' : 'w-7 h-7',
        active ? 'bg-raised text-fg' : 'text-muted hover:text-fg hover:bg-raised',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- badges

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand';

const TONE: Record<Tone, string> = {
  neutral: 'text-muted border-line bg-sunk',
  good: 'text-good border-good/35 bg-good/8',
  warn: 'text-warn border-warn/35 bg-warn/8',
  bad: 'text-bad border-bad/40 bg-bad/8',
  info: 'text-info border-info/35 bg-info/8',
  brand: 'text-brand border-brand/35 bg-brand/8',
};

export function Badge({ tone = 'neutral', children, title, icon, className }: { tone?: Tone; children: ReactNode; title?: string; icon?: ReactNode; className?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 h-5 px-1.5 text-[11px] font-medium rounded border whitespace-nowrap', TONE[tone], className)}>
      {icon}
      {children}
    </span>
  );
}

export function StatusDot({ tone, pulse, label }: { tone: Tone; pulse?: boolean; label?: string }) {
  const color = { neutral: 'bg-faint', good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', brand: 'bg-brand' }[tone];
  return (
    <span className="relative inline-flex w-2 h-2 shrink-0" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {pulse && <span className={cx('absolute inset-0 rounded-full opacity-50 animate-ping', color)} />}
      <span className={cx('relative inline-flex w-2 h-2 rounded-full', color)} />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex items-center h-[18px] px-1 text-[10.5px] font-mono text-faint border border-line rounded bg-sunk">{children}</kbd>;
}

// ---------------------------------------------------------------- layout

export function PageHeader({ title, subtitle, icon, actions, badge }: { title: string; subtitle?: ReactNode; icon?: string; actions?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 fade-up">
      <div className="flex items-start gap-3.5 min-w-0">
        {icon && <img src={`/brand/icons/${icon}.webp`} alt="" width={40} height={40} className="w-10 h-10 rounded-[23%] shrink-0" draggable={false} />}
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-[20px] font-medium text-fg">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="text-[13px] text-muted mt-1 max-w-3xl leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}

export function Page({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={cx('mx-auto w-full px-6 py-6 space-y-5', wide ? 'max-w-[1400px]' : 'max-w-[1100px]')}>{children}</div>
    </div>
  );
}

export function Card({ title, children, actions, className, subtitle, padded = true }: { title?: ReactNode; subtitle?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-[var(--radius-lg)] border border-line bg-panel', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
          <div className="min-w-0">
            {title && <h2 className="text-[13px] font-semibold text-fg">{title}</h2>}
            {subtitle && <p className="text-[12px] text-muted mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}
      <div className={padded ? cx('px-4 pb-4', !(title || actions) && 'pt-4') : undefined}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, tone, mono = true, source }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; mono?: boolean; source?: string }) {
  const color = tone ? { neutral: 'text-fg', good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info', brand: 'text-brand' }[tone] : 'text-fg';
  return (
    <div className="px-3 py-2.5 rounded-[var(--radius-md)] bg-sunk border border-line min-w-0" title={source}>
      <div className="text-[11px] text-faint truncate">{label}</div>
      <div className={cx('text-[17px] font-semibold mt-0.5 truncate', mono && 'tabular', color)}>{value}</div>
      {hint && <div className="text-[11px] text-faint mt-0.5 truncate">{hint}</div>}
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <div className={cx('h-px bg-line', className)} />;
}

// ---------------------------------------------------------------- states

export function Spinner({ size = 14, label }: { size?: number; label?: string }) {
  return <span role="status" aria-label={label || 'Chargement'} className="spinner inline-block shrink-0" style={{ width: size, height: size }} />;
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Chargement">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${100 - i * 18}%` }} />
      ))}
    </div>
  );
}

export function ErrorBox({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const msg = errorMessage(error);
  return (
    <div role="alert" className="p-3 rounded-[var(--radius-md)] border border-bad/35 bg-bad/5">
      <div className="flex items-center gap-2 text-bad text-[13px] font-medium">
        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden />
        {title || 'Erreur'}
      </div>
      <p className="text-[12.5px] text-muted mt-1 whitespace-pre-wrap break-words">{msg}</p>
      {onRetry && (
        <Button size="xs" variant="ghost" className="mt-2" icon={<RefreshCw className="w-3 h-3" />} onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', title, children, action }: { tone?: Tone; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'bad' || tone === 'warn' ? AlertTriangle : tone === 'good' ? Check : Info;
  const color = { neutral: 'border-line', good: 'border-good/35 bg-good/5', warn: 'border-warn/35 bg-warn/5', bad: 'border-bad/35 bg-bad/5', info: 'border-info/30 bg-info/5', brand: 'border-brand/30 bg-brand/5' }[tone];
  const iconColor = { neutral: 'text-muted', good: 'text-good', warn: 'text-warn', bad: 'text-bad', info: 'text-info', brand: 'text-brand' }[tone];
  return (
    <div className={cx('flex gap-2.5 p-3 rounded-[var(--radius-md)] border', color)}>
      <Icon className={cx('w-4 h-4 shrink-0 mt-0.5', iconColor)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">{title}</div>
        {children && <div className="text-[12.5px] text-muted mt-0.5 leading-relaxed">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, children, actions, decorative = true }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode; decorative?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center text-center px-6 py-10 rounded-[var(--radius-lg)] border border-dashed border-line', decorative && 'deco-grid')}>
      {icon && <div className="text-faint mb-3">{icon}</div>}
      <h3 className="text-[14px] font-medium text-fg">{title}</h3>
      {children && <div className="text-[12.5px] text-muted mt-1.5 max-w-md leading-relaxed">{children}</div>}
      {actions && <div className="flex flex-wrap justify-center gap-2 mt-4">{actions}</div>}
    </div>
  );
}

/** Availability label for features whose backend is absent or partial. */
export function Availability({ state, children }: { state: 'available' | 'experimental' | 'config' | 'unavailable'; children?: ReactNode }) {
  const map = {
    available: { tone: 'good' as Tone, label: 'Disponible' },
    experimental: { tone: 'warn' as Tone, label: 'Expérimental' },
    config: { tone: 'info' as Tone, label: 'Configuration requise' },
    unavailable: { tone: 'neutral' as Tone, label: 'Non disponible' },
  }[state];
  return (
    <Badge tone={map.tone} title={typeof children === 'string' ? children : undefined}>
      {map.label}
    </Badge>
  );
}

// ---------------------------------------------------------------- form

export function Field({ label, hint, error, children, htmlFor, inline }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; htmlFor?: string; inline?: boolean }) {
  return (
    <div className={cx(inline ? 'flex items-center justify-between gap-4' : 'space-y-1.5')}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[12.5px] font-medium text-fg">
          {label}
        </label>
        {hint && <div className="text-[11.5px] text-faint mt-0.5 leading-snug">{hint}</div>}
      </div>
      <div className={inline ? 'shrink-0' : undefined}>{children}</div>
      {error && (
        <p className="text-[11.5px] text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        'h-8 px-2.5 w-full rounded-md bg-sunk border text-[13px] text-fg placeholder:text-faint',
        'focus:outline-none focus:border-brand/60 transition-colors',
        invalid ? 'border-bad/60' : 'border-line',
        className
      )}
      {...rest}
    />
  );
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx('h-8 px-2 rounded-md bg-sunk border border-line text-[13px] text-fg cursor-pointer focus:outline-none focus:border-brand/60', className)}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex w-9 h-5 rounded-full border transition-colors duration-[var(--dur-base)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        checked ? 'bg-brand/80 border-brand' : 'bg-sunk border-line-strong'
      )}
    >
      <span className={cx('absolute top-[2px] w-3.5 h-3.5 rounded-full transition-transform duration-[var(--dur-base)]', checked ? 'translate-x-[18px] bg-on-primary' : 'translate-x-[2px] bg-muted')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label, size = 'sm' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>; label: string; size?: 'xs' | 'sm' }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex p-0.5 rounded-md bg-sunk border border-line">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            'px-2.5 rounded-[5px] font-medium cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            size === 'xs' ? 'h-5 text-[11px]' : 'h-6 text-[12px]',
            value === o.value ? 'bg-raised text-fg shadow-[var(--shadow-1)]' : 'text-muted hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: Array<{ id: T; label: ReactNode; count?: number }>; value: T; onChange: (t: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx('flex gap-0.5 border-b border-line overflow-x-auto [scrollbar-width:none]', className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'inline-flex items-center gap-1.5 h-8 px-3 -mb-px text-[12.5px] border-b-2 whitespace-nowrap cursor-pointer transition-colors',
            value === t.id ? 'border-brand text-fg' : 'border-transparent text-muted hover:text-fg'
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="text-[10.5px] text-faint tabular">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

export function Dialog({ open, onClose, title, children, footer, width = 520, description }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children?: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusable = () => Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter((el) => !el.hasAttribute('disabled'));
    (focusable().find((el) => el.dataset.autofocus !== undefined) ?? focusable()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const els = focusable();
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[var(--z-dialog)] flex items-center justify-center p-4 bg-black/55 fade-in" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-h-[86vh] flex flex-col rounded-[var(--radius-xl)] border border-line bg-panel shadow-[var(--shadow-2)] fade-up"
        style={{ maxWidth: width }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[15px] font-medium text-fg">
              {title}
            </h2>
            {description && <div className="text-[12.5px] text-muted mt-1">{description}</div>}
          </div>
          <IconButton label="Fermer" onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        {children && <div className="px-5 py-4 overflow-y-auto">{children}</div>}
        {footer && <div className="flex justify-end gap-2 px-5 py-3 border-t border-line">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation for destructive or important actions; the confirm button guards double clicks. */
export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirmer', danger, onConfirm, onClose }: { open: boolean; title: string; children?: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={title}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-muted">
        {children}
        {error != null && <ErrorBox error={error} />}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- async helper

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Loads data with cancellation; `deps` re-run the loader. */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    loader(ctrl.signal)
      .then((d) => !ctrl.signal.aborted && setData(d))
      .catch((e) => !ctrl.signal.aborted && (e as Error).name !== 'AbortError' && setError(e))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData };
}
