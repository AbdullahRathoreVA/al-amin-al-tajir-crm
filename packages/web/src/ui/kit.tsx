import type { ReactNode } from 'react';

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
