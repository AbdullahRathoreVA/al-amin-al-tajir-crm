import { useMemo } from 'react';
import { api, type Dashboard as DashboardData } from '../lib/api.ts';
import { useApi, usePoll } from '../lib/hooks.ts';
import { Link, useRouter } from '../lib/router.tsx';
import { Constellation, ConstellationLegend } from '../three/Constellation.tsx';
import type { NodeSpec } from '../three/constellation.ts';
import {
  Panel, Badge, Button, Empty, Spinner, ErrorNote, Stat, NotMeasured,
  When, clockTime, isOverdue, toneForStatus,
} from '../ui/kit.tsx';

const greeting = (): string => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export function Dashboard({ userName }: { userName: string }) {
  const res = useApi<DashboardData>('/dashboard');
  usePoll(res.reload, 60_000);

  const nodes = useMemo<NodeSpec[]>(() => {
    const d = res.data;
    if (!d) return [];
    const bySeverity = (id: string) => d.attention.find((a) => a.id === id)?.severity;
    const worst = (...ids: string[]): NodeSpec['severity'] => {
      const s = ids.map(bySeverity);
      if (s.includes('critical')) return 'critical';
      if (s.includes('warning')) return 'warning';
      return 'ok';
    };
    const countOf = (id: string) => d.attention.find((a) => a.id === id)?.count ?? 0;
    const openLeads = d.pipeline.filter((p) => p.isOpen).reduce((n, p) => n + p.count, 0);
    const enrolled = d.programs.reduce((n, p) => n + p.enrolled, 0);

    return [
      { id: 'families', label: 'Families', count: d.dataHealth.totalFamilies, href: '/families',
        severity: d.dataHealth.totalFamilies > 0 ? 'ok' : 'idle' },
      // The node shows registrations that need a person, not the lifetime total:
      // this map is a work queue, not a trophy cabinet.
      { id: 'registrations', label: 'Registrations',
        count: countOf('registrations-unreviewed') + countOf('registrations-incomplete'),
        href: '/registrations', severity: worst('registrations-unreviewed', 'registrations-incomplete') },
      { id: 'tours', label: 'Tours', count: d.today.toursToday, href: '/tours',
        severity: worst('tours-unconfirmed', 'tours-today') },
      { id: 'leads', label: 'Leads', count: openLeads, href: '/leads',
        severity: worst('followups-overdue', 'leads-unowned') },
      { id: 'tasks', label: 'Tasks', count: d.today.tasksOverdue + d.today.tasksDueToday, href: '/tasks',
        severity: worst('tasks-overdue') },
      { id: 'programs', label: 'Programs', count: enrolled, href: '/programs',
        severity: enrolled > 0 ? 'ok' : 'idle' },
      // Modules that genuinely do not exist yet read as idle with an em dash,
      // rather than a confident zero. (spec 97 / 218)
      { id: 'comms', label: 'Messages', count: null, href: '/system', severity: 'idle' },
      { id: 'finance', label: 'Finance', count: null, href: '/system', severity: 'idle' },
      { id: 'ai', label: 'AI', count: null, href: '/system', severity: 'idle' },
      { id: 'integrations', label: 'Integrations', count: null, href: '/system',
        severity: worst('sync-errors', 'ingest-failed') },
    ];
  }, [res.data]);

  if (res.loading && !res.data) return <Spinner label="Loading the command centre" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  const d = res.data;
  const critical = d.attention.filter((a) => a.severity === 'critical');

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {greeting()}, {userName.split(' ')[0]}
          </h1>
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            {critical.length > 0
              ? `${critical.reduce((n, c) => n + c.count, 0)} things need action today.`
              : 'Nothing is overdue. Here is where everything stands.'}
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          <span>Updated <When iso={d.generatedAt} /></span>
          <Button size="sm" variant="ghost" onClick={res.reload}>Refresh</Button>
        </div>
      </header>

      {/* Facts. Every one of these is a COUNT over rows, never an estimate. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tours today" value={d.today.toursToday} />
        <Stat label="New leads" hint="last 24 hours" value={d.today.newLeads24h} />
        <Stat label="Registrations" hint="last 24 hours" value={d.today.registrations24h} />
        <Stat label="Tasks overdue" value={d.today.tasksOverdue}
              tone={d.today.tasksOverdue > 0 ? 'crit' : undefined} />
        <Stat label="Due today" value={d.today.tasksDueToday}
              tone={d.today.tasksDueToday > 0 ? 'warn' : undefined} />
        <Stat label="Unread alerts" value={d.today.unreadNotifications} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex flex-col gap-5">
          <Panel
            title="Command map"
            pad={false}
            action={<Link to="/families" className="text-[12px] underline decoration-dotted underline-offset-4"
                          style={{ color: 'var(--text-muted)' }}>Browse as tables</Link>}
          >
            <div className="p-3">
              <Constellation nodes={nodes} />
              <div className="mt-3 px-1"><ConstellationLegend /></div>
            </div>
          </Panel>

          <ToursToday tours={d.toursToday} />
          <Pipeline stages={d.pipeline} />
          <Programs programs={d.programs} />
        </div>

        <div className="flex flex-col gap-5">
          <AttentionRadar items={d.attention} />
          <FollowUps items={d.overdueFollowUps} />
          <DataHealthPanel health={d.dataHealth} />
          <AiBriefing />
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- attention

function AttentionRadar({ items }: { items: DashboardData['attention'] }) {
  const { navigate } = useRouter();
  return (
    <Panel title="Needs attention" pad={false}>
      {items.length === 0 ? (
        <Empty title="Nothing needs attention" hint="No overdue follow-ups, no failed syncs, no unreviewed registrations." />
      ) : (
        <ul>
          {items.map((a) => (
            <li key={a.id}>
              <button
                onClick={() => navigate(a.link)}
                className="flex w-full items-center gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-black/5 dark:hover:bg-white/5"
                style={{ borderColor: 'var(--line)' }}
              >
                <span
                  className="tabular w-9 shrink-0 text-right text-lg font-semibold"
                  style={{
                    color: a.severity === 'critical' ? 'var(--color-crit-400)'
                      : a.severity === 'warning' ? 'var(--color-warn-400)' : 'var(--color-teal-400)',
                  }}
                >{a.count}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{a.label}</span>
                  <span className="block truncate text-[11px]" style={{ color: 'var(--text-faint)' }}>{a.detail}</span>
                </span>
                <span aria-hidden style={{ color: 'var(--text-faint)' }}>&rsaquo;</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- follow-ups

function FollowUps({ items }: { items: DashboardData['overdueFollowUps'] }) {
  return (
    <Panel title="Overdue follow-ups" pad={false}
           action={<Link to="/leads?filter=overdue" className="text-[12px]" style={{ color: 'var(--text-muted)' }}>All</Link>}>
      {items.length === 0 ? (
        <Empty title="No overdue follow-ups" hint="Every open lead has a next action that is still in date." />
      ) : (
        <ul>
          {items.map((f) => (
            <li key={f.id} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/families/${f.family_id}`} className="text-[13px] font-medium hover:underline">
                  {f.family_name}
                </Link>
                <span className="shrink-0 text-[11px]" style={{ color: 'var(--color-crit-400)' }}>
                  <When iso={f.next_action_due} />
                </span>
              </div>
              <p className="mt-0.5 text-[12px]">{f.next_action}</p>
              {/* The reason is shown, not just the alert. An operator should
                  never have to guess why the system is nagging them. */}
              <p className="mt-0.5 text-[11px] italic" style={{ color: 'var(--text-faint)' }}>{f.next_action_reason}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ tours

function ToursToday({ tours }: { tours: DashboardData['toursToday'] }) {
  return (
    <Panel title="Tours today" pad={false}
           action={<Link to="/tours" className="text-[12px]" style={{ color: 'var(--text-muted)' }}>All tours</Link>}>
      {tours.length === 0 ? (
        <Empty title="No tours scheduled today" />
      ) : (
        <ul>
          {tours.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
                style={{ borderColor: 'var(--line)' }}>
              <span className="tabular w-16 shrink-0 text-sm font-semibold">{clockTime(t.scheduled_for)}</span>
              <Link to={`/families/${t.family_id}`} className="min-w-0 flex-1 text-[13px] font-medium hover:underline">
                {t.family_name}
              </Link>
              <Badge tone={toneForStatus(t.status)}>{t.status}</Badge>
              {/* Tap to call, tap to email. On a phone these are the two things
                  a director actually does from this row. (spec 235) */}
              <span className="flex gap-1.5">
                {t.phone && <a href={`tel:${t.phone.replace(/\s/g, '')}`}
                   className="rounded-md px-2.5 py-1.5 text-[12px]" style={{ background: 'var(--surface-inset)' }}>Call</a>}
                {t.email && <a href={`mailto:${t.email}`}
                   className="rounded-md px-2.5 py-1.5 text-[12px]" style={{ background: 'var(--surface-inset)' }}>Email</a>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// --------------------------------------------------------------- pipeline

function Pipeline({ stages }: { stages: DashboardData['pipeline'] }) {
  const open = stages.filter((s) => s.isOpen);
  const max = Math.max(1, ...open.map((s) => s.count));
  return (
    <Panel title="Enrolment pipeline"
           action={<Link to="/leads" className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Open leads</Link>}>
      <div className="flex flex-col gap-1.5">
        {open.map((s) => (
          <Link key={s.id} to={`/leads?stage=${s.id}`}
                className="group flex items-center gap-3 rounded-md px-1 py-1 hover:bg-black/5 dark:hover:bg-white/5">
            <span className="w-40 shrink-0 truncate text-[12px]" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
            <span className="h-2.5 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-inset)' }}>
              <span className="block h-full rounded-full transition-[width]"
                    style={{ width: `${(s.count / max) * 100}%`, background: 'var(--accent)' }} />
            </span>
            <span className="tabular w-7 shrink-0 text-right text-[12px] font-semibold">{s.count}</span>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

// --------------------------------------------------------------- programs

function Programs({ programs }: { programs: DashboardData['programs'] }) {
  return (
    <Panel title="Programs" pad={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[13px]">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide"
                style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
              <th className="px-4 py-2 font-semibold">Program</th>
              <th className="px-4 py-2 font-semibold">Enrolled</th>
              <th className="px-4 py-2 font-semibold">Capacity</th>
              <th className="px-4 py-2 font-semibold">Waitlist</th>
              <th className="px-4 py-2 font-semibold">Open enquiries</th>
            </tr>
          </thead>
          <tbody>
            {programs.map((p) => (
              <tr key={p.id} className="border-b last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                <td className="px-4 py-2.5 font-medium">{p.name}</td>
                <td className="tabular px-4 py-2.5">{p.enrolled}</td>
                <td className="tabular px-4 py-2.5">
                  {/* Capacity nobody has entered shows as "not measured", so an
                      empty field can never be misread as a full room.
                      The places and the occupancy are separated deliberately:
                      rendered adjacent, "12" and "0%" read as "120%". */}
                  {p.capacity === null
                    ? <NotMeasured why="No capacity has been recorded for this program" />
                    : (
                      <span className="flex items-baseline gap-1.5 whitespace-nowrap">
                        <span>{p.capacity} places</span>
                        {p.occupancy !== null && (
                          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                            &middot; {Math.round(p.occupancy * 100)}% full
                          </span>
                        )}
                      </span>
                    )}
                </td>
                <td className="tabular px-4 py-2.5">{p.waitlisted}</td>
                <td className="tabular px-4 py-2.5">{p.inquiries}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------ data health

function DataHealthPanel({ health }: { health: DashboardData['dataHealth'] }) {
  return (
    <Panel title="Data health">
      {!health.measured ? (
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          <NotMeasured why="There are no families yet, so there is nothing to score" />
          {' '}&mdash; no families recorded yet.
        </p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="tabular text-3xl font-semibold"
                  style={{ color: health.score! >= 90 ? 'var(--color-ok-400)'
                    : health.score! >= 70 ? 'var(--color-warn-400)' : 'var(--color-crit-400)' }}>
              {health.score}
            </span>
            <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>/ 100</span>
          </div>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            Measured across {health.totalFamilies} {health.totalFamilies === 1 ? 'family' : 'families'}.
          </p>
          {health.issues.length === 0 ? (
            <p className="mt-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>No data issues found.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {health.issues.map((i) => (
                <li key={i.id}>
                  <Link to={i.link} className="flex items-center gap-2 text-[12px] hover:underline">
                    <span className="tabular w-6 text-right font-semibold" style={{ color: 'var(--color-warn-400)' }}>
                      {i.count}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{i.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------- AI briefing

/**
 * The morning brief.
 *
 * The counts are always real. The interpretation only appears when a model is
 * configured and reachable, and is labelled as interpretation. With no provider
 * the panel says so rather than dressing the same numbers up as insight.
 * (spec 15 / 218 / 353)
 */
function AiBriefing() {
  const res = useApi<{ facts: string[]; insight: string | null; source: string; generatedAt: string }>('/ai/brief');
  const status = useApi<{ configured: boolean; reachable: boolean; detail: string; cloud: boolean }>('/ai/status');

  if (res.loading && !res.data) return <Panel title="Briefing"><Spinner label="Reading" /></Panel>;
  if (res.error) return <Panel title="Briefing"><ErrorNote error={res.error} retry={res.reload} /></Panel>;
  const d = res.data;
  if (!d) return null;

  const st = status.data;
  return (
    <Panel
      title="Briefing"
      action={
        <Badge tone={!st?.configured ? 'neutral' : st.reachable ? (st.cloud ? 'warn' : 'ok') : 'crit'}>
          {!st?.configured ? 'from records' : st.reachable ? (st.cloud ? 'cloud AI' : 'local AI') : 'AI unreachable'}
        </Badge>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {d.facts.map((f, i) => (
          <li key={i} className="flex gap-2 text-[13px]">
            <span aria-hidden style={{ color: 'var(--text-faint)' }}>&bull;</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {d.insight ? (
        <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--surface-sunken)' }}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide"
             style={{ color: 'var(--color-teal-400)' }}>
            Interpretation, not a record
          </p>
          <p className="text-[13px] leading-relaxed">{d.insight}</p>
        </div>
      ) : (
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {st?.detail ?? 'Counted directly from the database. Nothing here is generated.'}
        </p>
      )}
    </Panel>
  );
}
