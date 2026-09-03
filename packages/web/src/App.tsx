import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me, type SearchHit, type Notification } from './lib/api.ts';
import { useApi, useDebounced, useTheme, usePoll } from './lib/hooks.ts';
import { Link, useRouter, RouterProvider } from './lib/router.tsx';
import { Button, Badge, Panel, Spinner, When } from './ui/kit.tsx';
import { Dashboard } from './routes/Dashboard.tsx';
import { Families, Leads, Tours, Registrations, Tasks } from './routes/Lists.tsx';
import { FamilyDetail, RegistrationDetail } from './routes/Details.tsx';
import { System } from './routes/System.tsx';
import { Analytics } from './routes/Analytics.tsx';
import { Import } from './routes/Import.tsx';
import { Automations } from './routes/Automations.tsx';
import { Attendance } from './routes/Attendance.tsx';
import { Logbook } from './routes/Logbook.tsx';
import { Help } from './routes/Help.tsx';
import { Account } from './routes/Account.tsx';
import { AgesRooms } from './routes/AgesRooms.tsx';
import { Waitlist } from './routes/Waitlist.tsx';

/**
 * `cap` hides an entry from roles that cannot use it. Only the register is
 * gated so far: an educator has no reason to see a link that will refuse them,
 * and a link that refuses is worse than no link.
 */
const NAV: { to: string; label: string; glyph: string; cap?: string }[] = [
  { to: '/', label: 'Dashboard', glyph: '◇' },
  { to: '/attendance', label: 'Register', glyph: '☑', cap: 'attendance:read' },
  { to: '/families', label: 'Families', glyph: '⌂' },
  { to: '/ages', label: 'Ages & Rooms', glyph: '◳', cap: 'classroom:read' },
  { to: '/leads', label: 'Leads', glyph: '↗' },
  { to: '/tours', label: 'Tours', glyph: '◷' },
  { to: '/registrations', label: 'Registrations', glyph: '≡' },
  { to: '/waitlist', label: 'Waiting list', glyph: '⧗' },
  { to: '/tasks', label: 'Tasks', glyph: '✓' },
  { to: '/logbook', label: 'Logbook', glyph: '✎', cap: 'logbook:read' },
  { to: '/analytics', label: 'Analytics', glyph: '◔' },
  { to: '/automations', label: 'Automations', glyph: '↻' },
  { to: '/import', label: 'Import', glyph: '⤓' },
  { to: '/system', label: 'System', glyph: '⚙' },
  { to: '/help', label: 'Help', glyph: '?' },
  { to: '/account', label: 'Your account', glyph: '◎' },
];

// What a phone actually needs. The register is on it because marking children
// in is done standing in a doorway, not at a desk. (spec 239)
const MOBILE_NAV = ['/', '/attendance', '/tasks', '/families', '/help'];

export function App() {
  return <RouterProvider><Root /></RouterProvider>;
}

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  const load = useCallback(() => {
    api.get<Me>('/auth/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(load, [load]);

  if (checking) {
    return <div className="grid h-full place-items-center"><Spinner label="Starting the Command Center" /></div>;
  }
  if (!me) return <Login onSignedIn={load} />;
  return <Shell me={me} onSignedOut={() => setMe(null)} />;
}

// ------------------------------------------------------------------- login

function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/auth/login', { email, password });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  const field = 'w-full rounded-lg border px-3 py-2.5 text-sm outline-none';
  const fieldStyle = { borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' };

  if (recover) return <Recover onBack={() => setRecover(false)} />;

  return (
    <div className="cst-stage grid min-h-full place-items-center p-5">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6">
        <div className="mb-5 text-center">
          <div className="text-3xl" aria-hidden>&#11088;</div>
          <h1 className="mt-2 text-lg font-semibold tracking-tight">Tiny Stars Command Center</h1>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
            Private. Staff only.
          </p>
        </div>

        {/* type="text", not "email": accounts may be a plain username. The
            browser would otherwise refuse to submit "tinystarsCANADA". */}
        <label className="mb-1 block text-[12px] font-medium" htmlFor="email">Email or username</label>
        <input id="email" type="text" required autoComplete="username" autoFocus
               autoCapitalize="none" spellCheck={false}
               value={email} onChange={(e) => setEmail(e.target.value)}
               className={`${field} mb-3`} style={fieldStyle} />

        <label className="mb-1 block text-[12px] font-medium" htmlFor="password">Password</label>
        <div className="relative">
          <input id="password" type={showPw ? 'text' : 'password'} required autoComplete="current-password"
                 value={password} onChange={(e) => setPassword(e.target.value)}
                 className={`${field} pr-16`} style={fieldStyle} />
          <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}
                  aria-controls="password"
                  className="absolute right-1 top-1 bottom-1 rounded-md px-2.5 text-[11px] font-medium"
                  style={{ color: 'var(--text-muted)', background: 'var(--surface-inset)' }}>
            {showPw ? 'Hide' : 'Show'}
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-lg px-3 py-2 text-[13px]"
             style={{ background: 'color-mix(in oklab, var(--color-crit-400) 16%, transparent)', color: 'var(--color-crit-400)' }}>
            {error}
          </p>
        )}

        <Button type="submit" variant="primary" className="mt-4 w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <button type="button" onClick={() => setRecover(true)}
                className="mt-3 w-full text-center text-[12px] underline"
                style={{ color: 'var(--text-faint)' }}>
          Forgotten your password?
        </button>
      </form>
    </div>
  );
}

/**
 * "Forgotten your password?"
 *
 * There is no mail server here, and there are a handful of staff. So rather
 * than a form that emails a link nothing can deliver, this names the people who
 * can actually reset it — which for a nursery is the manager, who is in the
 * building. It is deliberately anonymous and returns names and roles only,
 * never an email address, so it cannot be used to discover accounts.
 */
function Recover({ onBack }: { onBack: () => void }) {
  const res = useApi<{ canResetForYou: { name: string; role: string }[]; how: string }>(
    '/auth/recover');

  return (
    <div className="cst-stage grid min-h-full place-items-center p-5">
      <div className="panel w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold tracking-tight">Forgotten your password?</h1>
        <p className="mt-2 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {res.data?.how ?? 'Checking who can help…'}
        </p>

        {res.data && res.data.canResetForYou.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {res.data.canResetForYou.map((p) => (
              <li key={p.name} className="rounded-lg px-3 py-2 text-[13px]"
                  style={{ background: 'var(--surface-inset)' }}>
                <strong>{p.name}</strong>{' '}
                <span style={{ color: 'var(--text-faint)' }}>({p.role})</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Nobody can look up your existing password &mdash; passwords are stored
          scrambled on purpose. It can only be replaced with a new one.
        </p>

        <Button className="mt-4 w-full" onClick={onBack}>Back to sign in</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- shell

function Shell({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const { path } = useRouter();
  const [dark, toggleTheme] = useTheme();
  const [cmdOpen, setCmdOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdOpen(true); }
      // Bare "/" focuses search, but only when the user is not already typing.
      else if (e.key === '/' && !typing) { e.preventDefault(); setCmdOpen(true); }
      else if (e.key === 'Escape') setCmdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function signOut() {
    try { await api.post('/auth/logout'); } finally { onSignedOut(); }
  }

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* --------------------------------------------------- desktop sidebar */}
      <aside className="sticky top-0 z-20 hidden h-screen w-56 shrink-0 flex-col border-r px-3 py-4 lg:flex"
             style={{ borderColor: 'var(--line)', background: 'var(--surface-raised)' }}>
        <Link to="/" className="mb-5 flex items-center gap-2 px-2">
          <span className="text-lg" aria-hidden>&#11088;</span>
          <span className="text-[13px] leading-tight font-semibold">Tiny Stars<br />
            <span className="font-normal" style={{ color: 'var(--text-muted)' }}>Command Center</span>
          </span>
        </Link>

        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.filter((n) => !n.cap || me.capabilities.includes(n.cap)).map((n) => {
            const on = n.to === '/' ? path === '/' : path.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to}
                    className="flex min-h-10 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium transition-colors"
                    style={on
                      ? { background: 'var(--accent)', color: 'var(--accent-text)' }
                      : { color: 'var(--text-muted)' }}>
                <span aria-hidden className="w-4 text-center opacity-80">{n.glyph}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--line)' }}>
          <Link to="/account" className="block rounded-lg px-3 py-1 hover:underline">
            <span className="block text-[12px] font-medium">{me.user.name}</span>
            <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
              {me.user.role} &middot; account
            </span>
          </Link>
          <div className="mt-2 flex gap-1 px-1">
            <Button size="sm" variant="ghost" onClick={toggleTheme}>{dark ? 'Light' : 'Dark'}</Button>
            <Button size="sm" variant="ghost" onClick={signOut}>Sign out</Button>
          </div>
        </div>
      </aside>

      {/* ------------------------------------------------------------- main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex items-center gap-2 border-b px-4 py-2.5 backdrop-blur"
                style={{ borderColor: 'var(--line)', background: 'color-mix(in oklab, var(--surface) 88%, transparent)' }}>
          <Link to="/" className="flex items-center gap-1.5 lg:hidden">
            <span className="text-base" aria-hidden>&#11088;</span>
            <span className="text-[13px] font-semibold">Tiny Stars</span>
          </Link>

          <button
            onClick={() => setCmdOpen(true)}
            className="flex min-h-10 flex-1 items-center gap-2 rounded-lg border px-3 text-left text-[13px] lg:max-w-md"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-sunken)', color: 'var(--text-faint)' }}
          >
            <span aria-hidden>&#9906;</span>
            {/* Truncate rather than wrap: at 375px this placeholder ran to four
                lines and pushed the whole header down the screen. */}
            <span className="min-w-0 flex-1 truncate">Search families, children, tours&hellip;</span>
            <kbd className="hidden rounded px-1.5 py-0.5 text-[10px] sm:inline"
                 style={{ background: 'var(--surface-inset)' }}>Ctrl K</kbd>
          </button>

          <Bell />
          {me.mode === 'demo' && <Badge tone="gold">demo data</Badge>}
        </header>

        {me.mode === 'demo' && (
          // Visible on every screen, not just the dashboard, so a screenshot of
          // any page carries the caveat with it. (spec 225)
          <p className="px-4 py-1.5 text-center text-[11px]"
             style={{ background: 'color-mix(in oklab, var(--color-gold-400) 14%, transparent)', color: 'var(--color-gold-600)' }}>
            Demo mode &mdash; every family, child and educator shown here is invented. No real records.
          </p>
        )}

        <main className="min-w-0 flex-1 px-4 py-5 pb-24 lg:px-6 lg:pb-8">
          <Routes me={me} onSignedOut={onSignedOut} />
        </main>

        {/* -------------------------------------------------- mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t lg:hidden"
             style={{ borderColor: 'var(--line)', background: 'var(--surface-raised)',
                      paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {NAV.filter((n) => MOBILE_NAV.includes(n.to)
                          && (!n.cap || me.capabilities.includes(n.cap))).map((n) => {
            const on = n.to === '/' ? path === '/' : path.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to}
                    className="flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium"
                    style={{ color: on ? 'var(--accent)' : 'var(--text-muted)' }}>
                <span aria-hidden className="text-base">{n.glyph}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {cmdOpen && <CommandBar onClose={() => setCmdOpen(false)} />}
    </div>
  );
}

function Routes({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const { path } = useRouter();
  if (path === '/') return <Dashboard userName={me.user.name} />;
  if (path === '/families') return <Families />;
  if (path.startsWith('/families/')) return <FamilyDetail />;
  if (path === '/leads') return <Leads />;
  if (path === '/tours') return <Tours />;
  if (path === '/registrations') return <Registrations />;
  if (path.startsWith('/registrations/')) return <RegistrationDetail />;
  if (path === '/tasks') return <Tasks />;
  if (path === '/attendance') return <Attendance />;
  if (path === '/logbook') return <Logbook />;
  if (path === '/analytics') return <Analytics />;
  if (path === '/import') return <Import />;
  if (path === '/automations') return <Automations />;
  if (path === '/system' || path === '/programs') return <System />;
  if (path === '/help') return <Help />;
  if (path === '/account') return <Account me={me} onSignedOut={onSignedOut} />;
  if (path === '/ages') return <AgesRooms canMove={me.capabilities.includes('child:write')} />;
  if (path === '/waitlist') return <Waitlist canWrite={me.capabilities.includes('registration:write')} />;
  return (
    <Panel><div className="py-8 text-center">
      <p className="text-sm font-medium">This page does not exist.</p>
      <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        <Link to="/" className="underline">Back to the dashboard</Link>
      </p>
    </div></Panel>
  );
}

// ------------------------------------------------------------------ alerts

function Bell() {
  const res = useApi<{ notifications: Notification[] }>('/notifications');
  const [open, setOpen] = useState(false);
  usePoll(res.reload, 45_000);
  const items = res.data?.notifications ?? [];

  async function act(n: Notification, state: 'acted' | 'dismissed') {
    await api.patch(`/notifications/${n.id}`, { state });
    res.reload();
  }

  const linkFor = (n: Notification): string | null => {
    if (!n.link_type || !n.link_id) return null;
    if (n.link_type === 'family') return `/families/${n.link_id}`;
    if (n.link_type === 'registration') return `/registrations/${n.link_id}`;
    if (n.link_type === 'tour') return '/tours';
    return null;
  };

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
              className="relative grid size-10 place-items-center rounded-lg"
              style={{ background: 'var(--surface-sunken)' }}
              aria-label={`Alerts${items.length ? `, ${items.length} unread` : ''}`}>
        <span aria-hidden>&#9788;</span>
        {items.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold"
                style={{ background: 'var(--color-crit-400)', color: '#fff' }}>
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <button className="fixed inset-0 z-30 cursor-default" aria-label="Close alerts" onClick={() => setOpen(false)} />
          <div className="panel absolute right-0 top-12 z-40 max-h-[70vh] w-[min(92vw,360px)] overflow-y-auto shadow-2xl">
            <p className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide"
               style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>Alerts</p>
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                Nothing needs you right now.
              </p>
            ) : items.map((n) => {
              const href = linkFor(n);
              return (
                <div key={n.id} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                  <div className="flex items-start gap-2">
                    <Badge tone={n.tier === 'critical' ? 'crit' : n.tier === 'high' ? 'warn' : 'info'}>{n.tier}</Badge>
                    <span className="min-w-0 flex-1">
                      {/* Opens the exact record, never a generic screen. */}
                      {href
                        ? <Link to={href} onClick={() => { void act(n, 'acted'); setOpen(false); }}
                                className="block text-[13px] font-medium hover:underline">{n.title}</Link>
                        : <span className="block text-[13px] font-medium">{n.title}</span>}
                      {n.body && <span className="mt-0.5 block text-[12px]" style={{ color: 'var(--text-muted)' }}>{n.body}</span>}
                      <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                        <When iso={n.created_at} />
                      </span>
                    </span>
                    <button onClick={() => void act(n, 'dismissed')} aria-label="Dismiss"
                            className="shrink-0 px-1 text-[13px]" style={{ color: 'var(--text-faint)' }}>&times;</button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- command bar

const ACTIONS = [
  { label: 'Go to dashboard', to: '/' },
  { label: "Today's tours", to: '/tours?filter=today' },
  { label: 'Tour requests awaiting a time', to: '/tours?filter=requested' },
  { label: 'Registrations awaiting review', to: '/registrations?filter=submitted' },
  { label: 'Unfinished registrations', to: '/registrations?filter=incomplete' },
  { label: 'Overdue follow-ups', to: '/leads?filter=overdue' },
  { label: 'Overdue tasks', to: '/tasks?filter=overdue' },
  { label: 'My tasks', to: '/tasks?filter=mine' },
  { label: 'Possible duplicate families', to: '/families?filter=duplicates' },
  { label: 'System health', to: '/system' },
  { label: 'Help: how do I…', to: '/help' },
  { label: 'Who is waiting for a place?', to: '/waitlist' },
  { label: 'Offers waiting for an answer', to: '/waitlist' },
  { label: 'Where should each child go?', to: '/ages' },
  { label: 'Children who need a room', to: '/ages' },
  { label: 'Change my password', to: '/account' },
  { label: 'Staff accounts', to: '/account' },
];

function CommandBar({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 180);
  const { navigate } = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(0);

  const res = useApi<{ results: SearchHit[] }>(
    debounced.trim().length >= 2 ? `/search?q=${encodeURIComponent(debounced.trim())}` : null,
  );

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => setCursor(0), [debounced]);

  const actions = ACTIONS.filter((a) => !q.trim() || a.label.toLowerCase().includes(q.trim().toLowerCase()));
  const hits = res.data?.results ?? [];

  // Two kinds of thing have a page of their own. Everything else is shown
  // inside its family, and the index now carries which family that is, so a
  // child's name opens the child's family instead of an unfiltered list.
  const hrefFor = (h: SearchHit): string => {
    if (h.entity_type === 'family') return `/families/${h.entity_id}`;
    if (h.entity_type === 'registration') return `/registrations/${h.entity_id}`;
    if (h.family_id) return `/families/${h.family_id}`;
    // Genuinely unowned — a task about nothing in particular. The task list is
    // the right destination, not a family page that would be a guess.
    return h.entity_type === 'task' ? '/tasks' : '/families';
  };

  const rows: { key: string; label: string; sub?: string; to: string }[] = [
    ...actions.map((a) => ({ key: `a:${a.to}`, label: a.label, to: a.to })),
    ...hits.map((h) => ({
      key: `h:${h.entity_id}`, label: h.title,
      sub: `${h.entity_type} · ${h.snippet.replace(/\s+/g, ' ')}`, to: hrefFor(h),
    })),
  ];

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') {
      const row = rows[cursor];
      if (row) { navigate(row.to); onClose(); }
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 p-4 pt-[12vh]"
         onClick={onClose} role="dialog" aria-modal="true" aria-label="Command bar">
      <div className="panel w-full max-w-lg overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
          placeholder="Search or jump to…"
          className="w-full border-b px-4 py-3.5 text-sm outline-none"
          style={{ borderColor: 'var(--line)', background: 'transparent', color: 'var(--text)' }}
        />
        <div className="max-h-[52vh] overflow-y-auto">
          {res.loading && <p className="px-4 py-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>Searching…</p>}
          {rows.length === 0 && !res.loading && (
            <p className="px-4 py-6 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
              {q.trim().length >= 2 ? 'Nothing found.' : 'Type at least two characters to search.'}
            </p>
          )}
          {rows.map((r, i) => (
            <button
              key={r.key}
              onMouseEnter={() => setCursor(i)}
              onClick={() => { navigate(r.to); onClose(); }}
              className="flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left"
              style={{ background: i === cursor ? 'var(--surface-inset)' : 'transparent' }}
            >
              <span className="text-[13px] font-medium">{r.label}</span>
              {r.sub && <span className="w-full truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>{r.sub}</span>}
            </button>
          ))}
        </div>
        <p className="border-t px-4 py-2 text-[11px]" style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
          Enter to open &middot; arrows to move &middot; Esc to close
        </p>
      </div>
    </div>
  );
}
