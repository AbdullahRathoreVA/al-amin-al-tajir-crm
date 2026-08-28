import { useApi } from '../lib/hooks.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { Panel, Badge, Empty, Spinner, ErrorNote, NotMeasured, When } from '../ui/kit.tsx';

type Window = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOWS: { id: Window; label: string }[] = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

interface Bundle {
  window: Window;
  since: string;
  overview: {
    measured: boolean; sessions: number; pageviews: number;
    avgEngagedSeconds: number | null; conversions: number;
    conversionRate: number | null; bounceRate: number | null;
  };
  topPages: { path: string; views: number; sessions: number; avgEngagedSeconds: number | null }[];
  topSources: { source: string; label: string; sessions: number; conversions: number }[];
  topClicks: { name: string; count: number; sessions: number }[];
  devices: { device: string; sessions: number }[];
  daily: { day: string; sessions: number; pageviews: number; conversions: number }[];
  funnel: { step: string; label: string; sessions: number }[];
  recentSessions: Record<string, string | number | null>[];
}

const duration = (s: number | null): string => {
  if (s === null) return '';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
};

const pct = (v: number | null): string => (v === null ? '' : `${Math.round(v * 100)}%`);

/** Turns snake_case event names into something a director can read. */
const humanise = (name: string): string =>
  name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function Analytics() {
  const { query } = useRouter();
  const w = (query.get('window') ?? '30d') as Window;
  const res = useApi<Bundle>(`/analytics?window=${w}`);

  if (res.loading && !res.data) return <Spinner label="Reading website analytics" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  const d = res.data;
  const o = d.overview;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Website analytics</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Measured on the public site. No cookies, no cross-visit identity, no IP addresses stored.
        </p>
      </header>

      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {WINDOWS.map((x) => (
          <Link key={x.id} to={`/analytics?window=${x.id}`}
                className="min-h-9 shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium"
                style={w === x.id
                  ? { background: 'var(--accent)', color: 'var(--accent-text)' }
                  : { background: 'var(--surface-inset)', color: 'var(--text-muted)' }}>
            {x.label}
          </Link>
        ))}
      </nav>

      {!o.measured ? (
        <Panel>
          <Empty
            title="No website traffic recorded yet"
            hint="The site sends analytics only once CRM_INGEST_URL and CRM_INGEST_SECRET are set in its environment. Until then nothing is collected, and this stays empty rather than showing zeros."
          />
        </Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Metric label="Visits" value={o.sessions} hint="tab sessions" />
            <Metric label="Page views" value={o.pageviews} />
            <Metric label="Avg time on site"
                    value={o.avgEngagedSeconds === null ? <NotMeasured /> : duration(o.avgEngagedSeconds)}
                    hint="visible and active" />
            <Metric label="Enquiries started" value={o.conversions}
                    hint={o.conversionRate === null ? undefined : `${pct(o.conversionRate)} of visits`} />
            <Metric label="Left immediately"
                    value={o.bounceRate === null ? <NotMeasured /> : pct(o.bounceRate)}
                    hint="one page, under 10s" />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Funnel steps={d.funnel} />
            <Sources rows={d.topSources} />
            <Pages rows={d.topPages} />
            <Clicks rows={d.topClicks} />
            <Daily rows={d.daily} />
            <Devices rows={d.devices} />
          </div>

          <RecentSessions rows={d.recentSessions} />
        </>
      )}

      <Panel title="What is and is not collected">
        <div className="grid gap-4 text-[13px] sm:grid-cols-2">
          <div>
            <p className="mb-1 font-medium" style={{ color: 'var(--color-teal-400)' }}>Collected</p>
            <ul className="flex flex-col gap-1" style={{ color: 'var(--text-muted)' }}>
              <li>Which pages were viewed, and for how long the tab was visible</li>
              <li>Named interactions (tour clicks, searches, phone taps)</li>
              <li>Referring site host, and utm_ tags if present</li>
              <li>Device class and country</li>
            </ul>
          </div>
          <div>
            <p className="mb-1 font-medium" style={{ color: 'var(--color-crit-400)' }}>Never collected</p>
            <ul className="flex flex-col gap-1" style={{ color: 'var(--text-muted)' }}>
              <li>Cookies or any persistent identifier</li>
              <li>IP addresses (the server sees one, stores only a country)</li>
              <li>Anything a parent typed: names, messages, child details</li>
              <li>Full referrer URLs, which can contain search terms</li>
            </ul>
          </div>
        </div>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          A session id lives in the tab and dies with it, so the same person on Monday and Friday is
          two visits with no way to join them. Global Privacy Control and Do Not Track are honoured.
        </p>
      </Panel>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="tabular text-2xl font-semibold leading-none">{value}</div>
      <div className="mt-1.5 text-[13px] font-medium">{label}</div>
      {hint && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>{hint}</div>}
    </div>
  );
}

function Bar({ value, max, tone = 'var(--accent)' }: { value: number; max: number; tone?: string }) {
  return (
    <span className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-inset)' }}>
      <span className="block h-full rounded-full"
            style={{ width: `${max > 0 ? (value / max) * 100 : 0}%`, background: tone }} />
    </span>
  );
}

function Funnel({ steps }: { steps: Bundle['funnel'] }) {
  const top = steps[0]?.sessions ?? 0;
  return (
    <Panel title="From visit to enquiry">
      <div className="flex flex-col gap-2.5">
        {steps.map((s, i) => {
          const prev = i > 0 ? steps[i - 1]!.sessions : s.sessions;
          const drop = prev > 0 ? 1 - s.sessions / prev : 0;
          return (
            <div key={s.step}>
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span>{s.label}</span>
                <span className="tabular font-semibold">{s.sessions}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <Bar value={s.sessions} max={top} />
                <span className="tabular w-10 text-right text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {top > 0 ? `${Math.round((s.sessions / top) * 100)}%` : ''}
                </span>
              </div>
              {i > 0 && drop > 0.5 && s.sessions > 0 && (
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--color-warn-400)' }}>
                  {Math.round(drop * 100)}% dropped off at this step
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Sources({ rows }: { rows: Bundle['topSources'] }) {
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  return (
    <Panel title="Where visitors came from" pad={false}>
      {rows.length === 0 ? <Empty title="Nothing recorded yet" /> : (
        <ul>
          {rows.map((r) => (
            <li key={r.source} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
                style={{ borderColor: 'var(--line)' }}>
              <span className="w-40 shrink-0 truncate text-[13px]">{r.label}</span>
              <Bar value={r.sessions} max={max} />
              <span className="tabular w-8 shrink-0 text-right text-[13px] font-semibold">{r.sessions}</span>
              {r.conversions > 0 && <Badge tone="ok">{r.conversions} enquiry</Badge>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Pages({ rows }: { rows: Bundle['topPages'] }) {
  const max = Math.max(1, ...rows.map((r) => r.views));
  return (
    <Panel title="Most viewed pages" pad={false}>
      {rows.length === 0 ? <Empty title="Nothing recorded yet" /> : (
        <ul>
          {rows.map((r) => (
            <li key={r.path} className="border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center gap-3">
                <span className="w-44 shrink-0 truncate font-mono text-[12px]">{r.path}</span>
                <Bar value={r.views} max={max} />
                <span className="tabular w-8 shrink-0 text-right text-[13px] font-semibold">{r.views}</span>
              </div>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {r.sessions} {r.sessions === 1 ? 'visit' : 'visits'}
                {r.avgEngagedSeconds !== null && ` · ${duration(r.avgEngagedSeconds)} average`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Clicks({ rows }: { rows: Bundle['topClicks'] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Panel title="What people clicked" pad={false}>
      {rows.length === 0 ? <Empty title="No interactions recorded yet" /> : (
        <ul>
          {rows.map((r) => (
            <li key={r.name} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
                style={{ borderColor: 'var(--line)' }}>
              <span className="w-44 shrink-0 truncate text-[13px]">{humanise(r.name)}</span>
              <Bar value={r.count} max={max} tone="var(--color-teal-400)" />
              <span className="tabular w-8 shrink-0 text-right text-[13px] font-semibold">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Daily({ rows }: { rows: Bundle['daily'] }) {
  const max = Math.max(1, ...rows.map((r) => r.sessions));
  return (
    <Panel title="Visits per day">
      {rows.length === 0 ? <Empty title="Nothing recorded yet" /> : (
        <div className="flex h-32 items-end gap-1">
          {rows.map((r) => (
            <div key={r.day} className="group relative flex flex-1 flex-col items-center justify-end gap-1"
                 title={`${r.day}: ${r.sessions} visits, ${r.pageviews} page views, ${r.conversions} enquiries`}>
              <span className="w-full rounded-t"
                    style={{ height: `${(r.sessions / max) * 100}%`, minHeight: '2px', background: 'var(--accent)' }} />
              {r.conversions > 0 && (
                <span className="absolute bottom-0 w-full rounded-t"
                      style={{ height: `${(r.conversions / max) * 100}%`, minHeight: '2px', background: 'var(--color-ok-400)' }} />
              )}
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {rows[0]?.day} to {rows[rows.length - 1]?.day}. Green is enquiries started.
        </p>
      )}
    </Panel>
  );
}

function Devices({ rows }: { rows: Bundle['devices'] }) {
  const total = rows.reduce((n, r) => n + r.sessions, 0);
  return (
    <Panel title="Devices">
      {rows.length === 0 ? <Empty title="Nothing recorded yet" /> : (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.device} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-[13px] capitalize">{r.device}</span>
              <Bar value={r.sessions} max={Math.max(1, total)} />
              <span className="tabular w-14 shrink-0 text-right text-[12px]">
                {r.sessions} · {total > 0 ? Math.round((r.sessions / total) * 100) : 0}%
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function RecentSessions({ rows }: { rows: Bundle['recentSessions'] }) {
  return (
    <Panel title="Recent visits" pad={false}>
      {rows.length === 0 ? <Empty title="Nothing recorded yet" /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-[13px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide"
                  style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
                <th className="px-4 py-2.5 font-semibold">When</th>
                <th className="px-4 py-2.5 font-semibold">Landed on</th>
                <th className="px-4 py-2.5 font-semibold">From</th>
                <th className="px-4 py-2.5 font-semibold">Device</th>
                <th className="px-4 py-2.5 font-semibold">Pages</th>
                <th className="px-4 py-2.5 font-semibold">Time</th>
                <th className="px-4 py-2.5 font-semibold">Enquiry</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={String(r.id)} className="border-b last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                  <td className="px-4 py-2.5" style={{ color: 'var(--text-faint)' }}>
                    <When iso={String(r.first_seen)} />
                  </td>
                  <td className="max-w-[180px] truncate px-4 py-2.5 font-mono text-[12px]">
                    {r.landing_path ?? '—'}
                  </td>
                  <td className="max-w-[140px] truncate px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>
                    {r.utm_source ?? r.referrer_host ?? 'direct'}
                  </td>
                  <td className="px-4 py-2.5 capitalize" style={{ color: 'var(--text-muted)' }}>
                    {r.device ?? '—'}{r.country ? ` · ${r.country}` : ''}
                  </td>
                  <td className="tabular px-4 py-2.5">{Number(r.pageviews)}</td>
                  <td className="tabular px-4 py-2.5">{duration(Math.round(Number(r.engaged_ms) / 1000))}</td>
                  <td className="px-4 py-2.5">
                    {Number(r.converted) === 1 ? <Badge tone="ok">yes</Badge> : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
