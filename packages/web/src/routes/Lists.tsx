import { useState, type ReactNode } from 'react';
import { api, type FamilyRow, type LeadRow, type TourRow, type RegistrationRow, type TaskRow, type Stage } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link, useRouter } from '../lib/router.tsx';
import {
  Panel, Badge, Button, Empty, Spinner, ErrorNote, When, clockTime, isOverdue, toneForStatus, type Tone,
} from '../ui/kit.tsx';
import { AddFamily } from '../ui/AddFamily.tsx';
import { AddTask } from '../ui/AddTask.tsx';

/** Shared page frame: title, saved filters, and the list itself. (spec 288) */
function ListPage(
  { title, subtitle, filters, active, base, children, action }:
  { title: string; subtitle?: string; filters: { id: string; label: string }[];
    active: string; base: string; children: ReactNode; action?: ReactNode },
) {
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>{subtitle}</p>}
        </div>
        {action}
      </header>
      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {filters.map((f) => {
          const on = active === f.id;
          return (
            <Link
              key={f.id}
              to={f.id ? `${base}?filter=${f.id}` : base}
              className="min-h-9 shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors"
              style={on
                ? { background: 'var(--accent)', color: 'var(--accent-text)' }
                : { background: 'var(--surface-inset)', color: 'var(--text-muted)' }}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead>
          <tr className="border-b text-left text-[11px] uppercase tracking-wide"
              style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
            {head.map((h) => <th key={h} className="px-4 py-2.5 font-semibold whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const Row = ({ children }: { children: ReactNode }) => (
  <tr className="border-b transition-colors last:border-b-0 hover:bg-black/[.03] dark:hover:bg-white/[.03]"
      style={{ borderColor: 'var(--line)' }}>{children}</tr>
);

function Contact({ email, phone }: { email: string | null; phone: string | null }) {
  if (!email && !phone) {
    return <span className="text-[12px] italic" style={{ color: 'var(--color-warn-400)' }}>no contact recorded</span>;
  }
  return (
    <span className="flex flex-col gap-0.5 text-[12px]">
      {phone && <a href={`tel:${phone.replace(/\s/g, '')}`} className="hover:underline">{phone}</a>}
      {email && <a href={`mailto:${email}`} className="truncate hover:underline"
                   style={{ color: 'var(--text-muted)' }}>{email}</a>}
    </span>
  );
}

// -------------------------------------------------------------- families

export function Families() {
  const { query } = useRouter();
  const filter = query.get('filter') ?? '';
  const res = useApi<{ families: FamilyRow[] }>(`/families${filter ? `?filter=${filter}` : ''}`);
  const [adding, setAdding] = useState(false);

  return (
    <ListPage
      title="Families" base="/families" active={filter}
      subtitle="Every family the CRM knows about, newest activity first."
      action={<Button variant="primary" onClick={() => setAdding(true)}>+ Add a family</Button>}
      filters={[
        { id: '', label: 'All' },
        { id: 'duplicates', label: 'Possible duplicates' },
        { id: 'no-contact', label: 'No contact details' },
        { id: 'no-children', label: 'No child recorded' },
      ]}
    >
      {adding && <AddFamily onClose={() => setAdding(false)} onCreated={res.reload} />}
      {res.loading && !res.data ? <Spinner /> : res.error ? <ErrorNote error={res.error} retry={res.reload} /> : (
        (res.data?.families.length ?? 0) === 0
          ? (
            <Panel>
              <Empty
                title={filter ? 'No families match this filter' : 'No families yet'}
                hint={filter
                  ? undefined
                  : 'Add the first one by hand, or import a spreadsheet. Registrations from the website land here on their own.'}
                action={filter ? undefined : (
                  <Button variant="primary" onClick={() => setAdding(true)}>+ Add a family</Button>
                )}
              />
            </Panel>
          )
          : (
            <Table head={['Family', 'Status', 'Children', 'Primary contact', 'Latest activity', 'Updated']}>
              {res.data!.families.map((f) => (
                <Row key={f.id}>
                  <td className="px-4 py-3">
                    <Link to={`/families/${f.id}`} className="font-medium hover:underline">{f.name}</Link>
                  </td>
                  <td className="px-4 py-3"><Badge tone={toneForStatus(f.status)}>{f.status}</Badge></td>
                  <td className="tabular px-4 py-3">{f.children_count}</td>
                  <td className="px-4 py-3">
                    <span className="block">{f.primary_contact ?? '—'}</span>
                    <Contact email={f.email} phone={f.phone} />
                  </td>
                  <td className="max-w-[280px] truncate px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                    {f.latest_activity ?? '—'}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-faint)' }}><When iso={f.updated_at} /></td>
                </Row>
              ))}
            </Table>
          )
      )}
    </ListPage>
  );
}

// ----------------------------------------------------------------- leads

export function Leads() {
  const { query } = useRouter();
  const filter = query.get('filter') ?? '';
  const stage = query.get('stage') ?? '';
  const path = `/leads${stage ? `?stage=${stage}` : filter ? `?filter=${filter}` : ''}`;
  const res = useApi<{ leads: LeadRow[]; stages: Stage[] }>(path);

  return (
    <ListPage
      title="Leads" base="/leads" active={stage ? '' : filter}
      subtitle="Every open enquiry, and what happens next on it."
      filters={[
        { id: '', label: 'All' },
        { id: 'open', label: 'Open' },
        { id: 'overdue', label: 'Follow-up overdue' },
        { id: 'unowned', label: 'No owner' },
        { id: 'stale', label: 'Untouched 30 days' },
      ]}
    >
      {res.loading && !res.data ? <Spinner /> : res.error ? <ErrorNote error={res.error} retry={res.reload} /> : (
        (res.data?.leads.length ?? 0) === 0
          ? <Panel><Empty title="No leads match this filter" /></Panel>
          : (
            <Table head={['Family', 'Stage', 'Program', 'Next action', 'Due', 'Owner']}>
              {res.data!.leads.map((l) => (
                <Row key={l.id}>
                  <td className="px-4 py-3">
                    <Link to={`/families/${l.family_id}`} className="font-medium hover:underline">{l.family_name}</Link>
                    <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-faint)' }}>via {l.source}</span>
                  </td>
                  <td className="px-4 py-3"><Badge tone="info">{l.stage_label}</Badge></td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>{l.program_interest ?? '—'}</td>
                  <td className="max-w-[260px] px-4 py-3">
                    {l.next_action ? (
                      <>
                        <span className="block">{l.next_action}</span>
                        {l.next_action_reason && (
                          <span className="mt-0.5 block text-[11px] italic" style={{ color: 'var(--text-faint)' }}>
                            {l.next_action_reason}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[12px] italic" style={{ color: 'var(--color-warn-400)' }}>
                        nothing planned
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span style={{ color: isOverdue(l.next_action_due) ? 'var(--color-crit-400)' : 'var(--text-muted)' }}>
                      <When iso={l.next_action_due} />
                    </span>
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>
                    {l.owner_name ?? <span style={{ color: 'var(--color-warn-400)' }}>unassigned</span>}
                  </td>
                </Row>
              ))}
            </Table>
          )
      )}
    </ListPage>
  );
}

// ----------------------------------------------------------------- tours

const TOUR_NEXT: Record<string, { to: string; label: string }[]> = {
  requested: [{ to: 'scheduled', label: 'Mark scheduled' }, { to: 'cancelled', label: 'Cancel' }],
  scheduled: [{ to: 'confirmed', label: 'Confirm' }, { to: 'cancelled', label: 'Cancel' }],
  confirmed: [{ to: 'completed', label: 'Mark completed' }, { to: 'no-show', label: 'No-show' }],
};

export function Tours() {
  const { query } = useRouter();
  const filter = query.get('filter') ?? '';
  const res = useApi<{ tours: TourRow[] }>(`/tours${filter ? `?filter=${filter}` : ''}`);
  const [busy, setBusy] = useState<string | null>(null);

  async function move(id: string, status: string) {
    setBusy(id);
    try {
      await api.patch(`/tours/${id}`, {
        status, ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}),
      });
      res.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not update the tour');
    } finally { setBusy(null); }
  }

  return (
    <ListPage
      title="Tours" base="/tours" active={filter}
      subtitle="Requests, bookings and visits. Completing a tour creates the follow-up automatically."
      filters={[
        { id: '', label: 'All' },
        { id: 'today', label: 'Today' },
        { id: 'requested', label: 'Awaiting a time' },
        { id: 'upcoming', label: 'Upcoming' },
      ]}
    >
      {res.loading && !res.data ? <Spinner /> : res.error ? <ErrorNote error={res.error} retry={res.reload} /> : (
        (res.data?.tours.length ?? 0) === 0
          ? <Panel><Empty title="No tours match this filter" /></Panel>
          : (
            <Table head={['When', 'Family', 'Status', 'Contact', 'Move to']}>
              {res.data!.tours.map((t) => (
                <Row key={t.id}>
                  <td className="px-4 py-3">
                    {t.scheduled_for ? (
                      <>
                        <span className="block font-medium">
                          {new Date(t.scheduled_for).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                        </span>
                        <span className="tabular text-[12px]" style={{ color: 'var(--text-muted)' }}>
                          {clockTime(t.scheduled_for)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[12px] italic" style={{ color: 'var(--color-warn-400)' }}>no time set</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/families/${t.family_id}`} className="font-medium hover:underline">{t.family_name}</Link>
                  </td>
                  <td className="px-4 py-3"><Badge tone={toneForStatus(t.status)}>{t.status}</Badge></td>
                  <td className="px-4 py-3"><Contact email={t.email} phone={t.phone} /></td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1.5">
                      {(TOUR_NEXT[t.status] ?? []).map((n) => (
                        <Button key={n.to} size="sm" disabled={busy === t.id} onClick={() => move(t.id, n.to)}>
                          {n.label}
                        </Button>
                      ))}
                    </span>
                  </td>
                </Row>
              ))}
            </Table>
          )
      )}
    </ListPage>
  );
}

// --------------------------------------------------------- registrations

export function Registrations() {
  const { query } = useRouter();
  const filter = query.get('filter') ?? '';
  const res = useApi<{ registrations: RegistrationRow[] }>(`/registrations${filter ? `?filter=${filter}` : ''}`);

  return (
    <ListPage
      title="Registrations" base="/registrations" active={filter}
      subtitle="Everything submitted through the website, exactly as the parent sent it. Nobody retypes these."
      filters={[
        { id: '', label: 'All' },
        { id: 'submitted', label: 'Awaiting review' },
        { id: 'incomplete', label: 'Unfinished' },
      ]}
    >
      {res.loading && !res.data ? <Spinner /> : res.error ? <ErrorNote error={res.error} retry={res.reload} /> : (
        (res.data?.registrations.length ?? 0) === 0
          ? <Panel><Empty title="No registrations match this filter"
                          hint="When a parent submits the form on the website, it appears here within seconds." /></Panel>
          : (
            <Table head={['Child', 'Family', 'Status', 'Progress', 'Desired start', 'Received']}>
              {res.data!.registrations.map((r) => (
                <Row key={r.id}>
                  <td className="px-4 py-3">
                    <Link to={`/registrations/${r.id}`} className="font-medium hover:underline">
                      {r.child_first_name ?? 'Unnamed child'}
                    </Link>
                    {r.age_band && <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-faint)' }}>{r.age_band}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Link to={`/families/${r.family_id}`} className="hover:underline"
                          style={{ color: 'var(--text-muted)' }}>{r.family_name}</Link>
                  </td>
                  <td className="px-4 py-3"><Badge tone={toneForStatus(r.status)}>{r.status}</Badge></td>
                  <td className="px-4 py-3">
                    {r.total_steps ? (
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full" style={{ background: 'var(--surface-inset)' }}>
                          <span className="block h-full rounded-full"
                                style={{
                                  width: `${((r.completed_steps ?? 0) / r.total_steps) * 100}%`,
                                  background: (r.completed_steps ?? 0) >= r.total_steps ? 'var(--color-ok-400)' : 'var(--color-warn-400)',
                                }} />
                        </span>
                        <span className="tabular text-[11px]" style={{ color: 'var(--text-faint)' }}>
                          {r.completed_steps ?? 0}/{r.total_steps}
                        </span>
                      </span>
                    ) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                  </td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-muted)' }}>{r.desired_start ?? '—'}</td>
                  <td className="px-4 py-3" style={{ color: 'var(--text-faint)' }}>
                    <When iso={r.submitted_at ?? r.created_at} />
                  </td>
                </Row>
              ))}
            </Table>
          )
      )}
    </ListPage>
  );
}

// ----------------------------------------------------------------- tasks

export function Tasks() {
  const { query } = useRouter();
  const filter = query.get('filter') ?? '';
  const res = useApi<{ tasks: TaskRow[] }>(`/tasks${filter ? `?filter=${filter}` : ''}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function complete(id: string) {
    setBusy(id);
    try { await api.patch(`/tasks/${id}`, { status: 'done' }); res.reload(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not complete the task'); }
    finally { setBusy(null); }
  }

  const tone = (p: string): Tone =>
    p === 'critical' ? 'crit' : p === 'high' ? 'warn' : p === 'low' ? 'neutral' : 'info';

  return (
    <ListPage
      title="Tasks" base="/tasks" active={filter}
      subtitle="Work the system created for you, and work you created yourself. Each one says why it exists."
      action={<Button variant="primary" onClick={() => setAdding(true)}>+ Add a task</Button>}
      filters={[
        { id: '', label: 'Open' },
        { id: 'overdue', label: 'Overdue' },
        { id: 'mine', label: 'Mine' },
        { id: 'done', label: 'Done' },
      ]}
    >
      {res.loading && !res.data ? <Spinner /> : res.error ? <ErrorNote error={res.error} retry={res.reload} /> : (
        (res.data?.tasks.length ?? 0) === 0
          ? <Panel><Empty title="Nothing here" hint="No tasks match this filter." /></Panel>
          : (
            <ul className="flex flex-col gap-2">
              {res.data!.tasks.map((t) => (
                <li key={t.id} className="panel flex flex-wrap items-start gap-3 p-4">
                  <span className="flex flex-1 flex-col gap-1" style={{ minWidth: '260px' }}>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={tone(t.priority)}>{t.priority}</Badge>
                      <span className="font-medium">{t.title}</span>
                    </span>
                    {t.body && <span className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--text-muted)' }}>{t.body}</span>}
                    {/* A task that cannot say why it exists is noise. (spec 73) */}
                    {t.reason && (
                      <span className="text-[11px] italic" style={{ color: 'var(--text-faint)' }}>
                        Why: {t.reason}
                      </span>
                    )}
                    <span className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      <span style={{ color: isOverdue(t.due_at) && t.status !== 'done' ? 'var(--color-crit-400)' : undefined }}>
                        {t.due_at ? <>Due <When iso={t.due_at} /></> : 'No due date'}
                      </span>
                      <span>&middot;</span>
                      <span>{t.owner_name ?? 'unassigned'}</span>
                      {t.related_type === 'family' && t.related_id && (
                        <><span>&middot;</span><Link to={`/families/${t.related_id}`} className="underline">open family</Link></>
                      )}
                      {t.related_type === 'registration' && t.related_id && (
                        <><span>&middot;</span><Link to={`/registrations/${t.related_id}`} className="underline">open registration</Link></>
                      )}
                    </span>
                  </span>
                  {t.status !== 'done' && (
                    <Button size="sm" disabled={busy === t.id} onClick={() => complete(t.id)}>Done</Button>
                  )}
                </li>
              ))}
            </ul>
          )
      )}
      {adding && <AddTask onClose={() => setAdding(false)} onCreated={res.reload} />}
    </ListPage>
  );
}
