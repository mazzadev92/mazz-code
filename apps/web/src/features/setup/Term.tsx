import { useId, useState, type ReactNode } from 'react';
import { GLOSSARY } from './glossary';

/** Terme technique avec infobulle : bouton focusable, définition liée par aria-describedby, Échap ferme. */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const entry = GLOSSARY[id];
  const [open, setOpen] = useState(false);
  const popId = useId();
  if (!entry) return <>{children}</>;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-describedby={open ? popId : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        className="cursor-help underline decoration-dotted underline-offset-2 text-fg"
      >
        {children ?? entry.label}
      </button>
      {open && (
        <span id={popId} role="tooltip" className="absolute left-0 top-full mt-1 z-50 w-64 p-2 rounded-md border border-line-strong bg-panel text-[12px] text-fg shadow-lg font-normal text-left">
          <strong className="block mb-0.5">{entry.label}</strong>
          {entry.text}
        </span>
      )}
    </span>
  );
}
