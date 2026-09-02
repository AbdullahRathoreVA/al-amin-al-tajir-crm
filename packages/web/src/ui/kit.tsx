import { useEffect, useRef, type ReactNode } from 'react';

// ------------------------------------------------------------------- layout

export function Panel(
  { title, action, children, className = '', pad = true }:
  { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; pad?: boolean },
) {
  return (
    <section className={`panel overflow-hidden ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3"
                style={{ borderColor: 'var(--line)' }}>
          <h2 className="text-[13px] font-semibold tracking-wide uppercase"
              style={{ color: 'var(--text-muted)' }}>{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Button(
  { children, variant = 'default', size = 'md', className = '', ...rest }:
  { children: ReactNode; variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'md' }
  & React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors ' +
    // 44px minimum touch target on the small size too. (spec 125)
    'disabled:opacity-45 disabled:pointer-events-none select-none';
  const sizes = { sm: 'text-[13px] px-3 min-h-9', md: 'text-sm px-4 min-h-11' };
  const variants = {
    default: 'border hover:brightness-110',
    primary: 'border-transparent hover:brightness-110',
    ghost: 'border-transparent hover:bg-black/5 dark:hover:bg-white/5',
    danger: 'border-transparent text-white hover:brightness-110',
  };
  const style =
    variant === 'primary' ? { background: 'var(--accent)', color: 'var(--accent-text)' }
    : variant === 'danger' ? { background: 'var(--color-crit-600)' }
    : variant === 'default' ? { borderColor: 'var(--line-strong)', background: 'var(--surface-inset)', color: 'var(--text)' }
    : { color: 'var(--text-muted)' };

  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} style={style} {...rest}>
      {children}
    </button>
  );
}

const TONES = {
  ok:      { bg: 'color-mix(in oklab, var(--color-ok-400) 18%, transparent)',   fg: 'var(--color-ok-400)' },
  warn:    { bg: 'color-mix(in oklab, var(--color-warn-400) 18%, transparent)', fg: 'var(--color-warn-400)' },
  crit:    { bg: 'color-mix(in oklab, var(--color-crit-400) 18%, transparent)', fg: 'var(--color-crit-400)' },
  info:    { bg: 'color-mix(in oklab, var(--color-teal-400) 18%, transparent)', fg: 'var(--color-teal-400)' },
  neutral: { bg: 'color-mix(in oklab, var(--text-muted) 14%, transparent)',     fg: 'var(--text-muted)' },
  gold:    { bg: 'color-mix(in oklab, var(--color-gold-400) 18%, transparent)', fg: 'var(--color-gold-400)' },
} as const;

export type Tone = keyof typeof TONES;

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const t = TONES[tone];
  return (
    <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
          style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  );
}

/** Maps the domain vocabulary to a tone in one place, so a status never gets
 *  two different colours on two different screens. */
export function toneForStatus(s: string): Tone {
  switch (s) {
    case 'enrolled': case 'approved': case 'completed': case 'confirmed': case 'done': case 'accepted':
      return 'ok';
    case 'submitted': case 'applying': case 'offered': case 'reviewing': case 'scheduled': case 'doing':
      return 'info';
    case 'incomplete': case 'waitlisted': case 'waiting': case 'requested': case 'touring': case 'open':
      return 'warn';
    case 'lost': case 'declined': case 'withdrawn': case 'cancelled': case 'no-show': case 'unresponsive':
      return 'crit';
    default:
      return 'neutral';
  }
}

export function Stat(
  { label, value, hint, tone }:
  { label: string; value: ReactNode; hint?: string; tone?: Tone },
) {
  return (
    <div className="panel px-4 py-3">
      <div className="tabular text-2xl font-semibold leading-none"
           style={{ color: tone ? TONES[tone].fg : 'var(--text)' }}>{value}</div>
      <div className="mt-1.5 text-[13px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>{hint}</div>}
    </div>
  );
}

/**
 * Used wherever a number has not been measured. Rendering 0 there would be a
 * lie: "we counted and found none" is a different claim from "we never
 * counted". (spec 150)
 */
export function NotMeasured({ why }: { why?: string }) {
  return (
    <span className="text-[13px] italic" style={{ color: 'var(--text-faint)' }} title={why}>
      not measured
    </span>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="text-2xl opacity-40" aria-hidden>&#11088;</div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-[13px]" style={{ color: 'var(--text-muted)' }}>{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-[13px]" style={{ color: 'var(--text-muted)' }}>
      <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg px-4 py-3 text-[13px]"
         style={{ background: TONES.crit.bg, color: TONES.crit.fg }}>
      <span>{error}</span>
      {retry && <Button size="sm" onClick={retry}>Try again</Button>}
    </div>
  );
}

// --------------------------------------------------------------------- time

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(secs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(secs), 'second');
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour');
  if (abs < 2592000) return rtf.format(Math.round(secs / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function When({ iso, prefix }: { iso: string | null | undefined; prefix?: string }) {
  if (!iso) return <span style={{ color: 'var(--text-faint)' }}>&mdash;</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="whitespace-nowrap">
      {prefix}{relativeTime(iso)}
    </time>
  );
}

export function clockTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const isOverdue = (iso: string | null | undefined): boolean =>
  !!iso && new Date(iso).getTime() < Date.now();

// -------------------------------------------------------------------- forms
//
// These exist so that every form in the CRM gets a real <label> tied to its
// input, a visible required marker, and errors attached with aria-describedby
// rather than only coloured red. Written once here because a form assembled by
// hand each time is a form where half of that quietly goes missing.

let autoId = 0;
const nextId = () => `f${++autoId}`;

export function Field(
  { label, hint, error, required, children, id }:
  { label: string; hint?: string; error?: string | null; required?: boolean;
    children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean; required?: boolean }) => ReactNode;
    id?: string },
) {
  const fieldId = id ?? nextId();
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errId = error ? `${fieldId}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-[12px] font-medium">
        {label}
        {required && <span aria-hidden className="ml-0.5" style={{ color: 'var(--color-crit-400)' }}>*</span>}
        {required && <span className="sr-only"> (required)</span>}
      </label>
      {children({
        id: fieldId,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true } : {}),
        ...(required ? { required: true } : {}),
      })}
      {error && (
        <p id={errId} className="text-[11px]" style={{ color: 'var(--color-crit-400)' }}>{error}</p>
      )}
      {hint && !error && (
        <p id={hintId} className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{hint}</p>
      )}
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border px-3 py-2.5 text-sm outline-none min-h-11 focus-visible:ring-2';
export const inputStyle = {
  borderColor: 'var(--line-strong)',
  background: 'var(--surface-sunken)',
  color: 'var(--text)',
} as const;

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} style={{ ...inputStyle, ...props.style }} />;
}

export function SelectInput(
  { children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode },
) {
  return (
    <select {...rest} className={`${inputClass} ${rest.className ?? ''}`} style={{ ...inputStyle, ...rest.style }}>
      {children}
    </select>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ''}`} style={{ ...inputStyle, ...props.style }} />;
}

// ------------------------------------------------------------------- dialog

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A dialog that behaves like one.
 *
 * Keyboard users are the reason this is not just a div with a shadow. Tab is
 * trapped inside while it is open, Escape closes it, focus moves to the first
 * field on open and returns to whatever opened it on close — otherwise closing
 * a dialog drops the caret back at the top of the document and a keyboard user
 * has to travel the whole page again.
 *
 * Scrolling the page behind a modal is disabled for the same reason it is
 * disabled everywhere else: on a phone the background scrolls instead of the
 * dialog and the buttons walk off the screen.
 */
export function Modal(
  { title, description, onClose, children, footer, wide }:
  { title: string; description?: string; onClose: () => void; children: ReactNode;
    footer?: ReactNode; wide?: boolean },
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const titleId = useRef(nextId()).current;
  const descId = `${titleId}-desc`;

  useEffect(() => {
    restoreTo.current = document.activeElement as HTMLElement | null;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        .filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first2 = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first2) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first2.focus(); }
    };

    // Capture, so Escape closes this dialog rather than something underneath it.
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreTo.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 py-[6vh]"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description ? { 'aria-describedby': descId } : {})}
        tabIndex={-1}
        className={`panel w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} shadow-2xl outline-none`}
      >
        <header className="flex items-start justify-between gap-3 border-b px-5 py-4"
                style={{ borderColor: 'var(--line)' }}>
          <div>
            <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
            {description && (
              <p id={descId} className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {description}
              </p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" type="button"
                  className="-mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-lg text-lg"
                  style={{ color: 'var(--text-faint)' }}>&times;</button>
        </header>

        <div className="px-5 py-4">{children}</div>

        {footer && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3"
                  style={{ borderColor: 'var(--line)' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
