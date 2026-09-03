import { useState } from 'react';
import { api, type EventRow } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link, useParams } from '../lib/router.tsx';
import {
  Panel, Badge, Button, Empty, Spinner, ErrorNote, When, clockTime, toneForStatus, NotMeasured,
} from '../ui/kit.tsx';
import { CompletenessPanel, DraftComposer, DraftHistory, FamilySummary } from '../ui/Compose.tsx';
import { EditChild, EditGuardian, AddPerson } from '../ui/EditPerson.tsx';

type Row = Record<string, string | number | null>;

interface FamilyDetailData {
  family: Record<string, string | number | null>;
  guardians: Record<string, string | number | null>[];
  children: Record<string, string | number | null>[];
  leads: Record<string, string | null>[];
  tours: Record<string, string | null>[];
  registrations: Record<string, string | number | null>[];
  waitlist: Record<string, string | null>[];
  tasks: Record<string, string | null>[];
  notes: Record<string, string | null>[];
  timeline: EventRow[];
  sensitiveVisible: boolean;
}

const TABS = ['Overview', 'Children', 'Timeline', 'Messages', 'Tours', 'Registrations', 'Tasks', 'Notes'] as const;
type Tab = (typeof TABS)[number];

export function FamilyDetail() {
  const params = useParams('/families/:id');
  const id = params?.id ?? '';
  const res = useApi<FamilyDetailData>(id ? `/families/${id}` : null);
  const [tab, setTab] = useState<Tab>('Overview');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Editing is one dialog at a time on purpose: a row of inline inputs on a
  // page this dense is how the wrong child's birthday gets changed.
  const [editChild, setEditChild] = useState<Row | null>(null);
  const [editGuardian, setEditGuardian] = useState<Row | null>(null);
  const [adding, setAdding] = useState<'child' | 'guardian' | null>(null);
  const me = useApi<{ capabilities: string[] }>('/auth/me');

  if (res.loading && !res.data) return <Spinner label="Loading family" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  const d = res.data;
  const f = d.family;
  const primary = d.guardians.find((g) => g.is_primary) ?? d.guardians[0];
  const canWrite = me.data?.capabilities.includes('child:write') ?? false;
  const nextTask = d.tasks.find((t) => t.status === 'open' || t.status === 'doing');
  const openLead = d.leads[0];

  async function addNote() {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await api.post('/notes', { entityType: 'family', entityId: id, body: note.trim() });
      setNote('');
      res.reload();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not save the note');
    } finally { setSaving(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link to="/families" className="text-[12px]" style={{ color: 'var(--text-muted)' }}>&larr; All families</Link>

      <header className="panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight">{String(f.name)}</h1>
              <Badge tone={toneForStatus(String(f.status))}>{String(f.status)}</Badge>
              {f.dup_of && <Badge tone="warn">possible duplicate</Badge>}
            </div>
            <p className="mt-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              {d.children.length} {d.children.length === 1 ? 'child' : 'children'}
              {primary && <> &middot; {String(primary.first_name)} {String(primary.last_name ?? '')}</>}
              {' '}&middot; from {String(f.source)}
            </p>
            {/* Quick actions: on a phone these are what staff actually press. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {primary?.phone && (
                <a href={`tel:${String(primary.phone).replace(/\s/g, '')}`}
                   className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium"
                   style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>Call</a>
              )}
              {primary?.email && (
                <a href={`mailto:${String(primary.email)}`}
                   className="inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium"
                   style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-inset)' }}>Email</a>
              )}
              <Button onClick={() => setTab('Messages')}>Write follow-up</Button>
              <Button onClick={() => setTab('Notes')}>Add note</Button>
            </div>
          </div>

          <div className="min-w-[220px] rounded-lg p-3.5" style={{ background: 'var(--surface-inset)' }}>
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
              Next action
            </p>
            {openLead?.next_action ? (
              <>
                <p className="mt-1 text-[13px] font-medium">{openLead.next_action}</p>
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Due <When iso={openLead.next_action_due} />
                </p>
                {openLead.next_action_reason && (
                  <p className="mt-1 text-[11px] italic" style={{ color: 'var(--text-faint)' }}>
                    {openLead.next_action_reason}
                  </p>
                )}
              </>
            ) : nextTask ? (
              <p className="mt-1 text-[13px] font-medium">{nextTask.title}</p>
            ) : (
              <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>Nothing planned</p>
            )}
          </div>
        </div>
      </header>

      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
                  className="min-h-9 shrink-0 rounded-lg px-3 text-[13px] font-medium transition-colors"
                  style={tab === t
                    ? { background: 'var(--accent)', color: 'var(--accent-text)' }
                    : { background: 'var(--surface-inset)', color: 'var(--text-muted)' }}>
            {t}
          </button>
        ))}
      </nav>

      {tab === 'Overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2"><FamilySummary familyId={id} /></div>
          <Panel title="Guardians" pad={false}
                 action={canWrite && (
                   <Button size="sm" onClick={() => setAdding('guardian')}>+ Add</Button>
                 )}>
            {d.guardians.length === 0 ? (
              <Empty title="No guardians recorded"
                     hint="A family with no way to contact them cannot be followed up."
                     action={canWrite
                       ? <Button size="sm" onClick={() => setAdding('guardian')}>Add a guardian</Button>
                       : undefined} />
            ) : (
              <ul>
                {d.guardians.map((g) => (
                  <li key={String(g.id)} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{String(g.first_name)} {String(g.last_name ?? '')}</span>
                      {g.is_primary === 1 && <Badge tone="gold">primary</Badge>}
                      {g.relationship && <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{String(g.relationship)}</span>}
                      {canWrite && (
                        <button type="button" onClick={() => setEditGuardian(g)}
                                className="ml-auto text-[12px] underline"
                                style={{ color: 'var(--text-faint)' }}>Edit</button>
                      )}
                    </div>
                    <div className="mt-1 flex flex-col gap-0.5 text-[12px]">
                      {g.phone && <a href={`tel:${String(g.phone)}`} className="hover:underline">{String(g.phone)}</a>}
                      {g.email && <a href={`mailto:${String(g.email)}`} className="hover:underline"
                                     style={{ color: 'var(--text-muted)' }}>{String(g.email)}</a>}
                      {!g.phone && !g.email && (
                        <span className="italic" style={{ color: 'var(--color-warn-400)' }}>no contact details</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Record">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
              <dt style={{ color: 'var(--text-muted)' }}>Source</dt><dd>{String(f.source)}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Created</dt><dd><When iso={String(f.created_at)} /></dd>
              <dt style={{ color: 'var(--text-muted)' }}>Updated</dt><dd><When iso={String(f.updated_at)} /></dd>
              <dt style={{ color: 'var(--text-muted)' }}>Privacy</dt>
              <dd className="flex flex-wrap gap-1.5">
                {f.local_only === 1 && <Badge tone="crit">local only</Badge>}
                {f.no_ai === 1 && <Badge tone="warn">never send to AI</Badge>}
                {f.no_sync === 1 && <Badge tone="warn">never sync</Badge>}
                {!f.local_only && !f.no_ai && !f.no_sync && <span style={{ color: 'var(--text-muted)' }}>standard</span>}
              </dd>
            </dl>
          </Panel>
        </div>
      )}

      {tab === 'Children' && (
        <Panel title="Children" pad={false}
               action={canWrite && (
                 <Button size="sm" onClick={() => setAdding('child')}>+ Add a child</Button>
               )}>
          {!d.sensitiveVisible && (
            <p className="border-b px-4 py-2.5 text-[12px]" style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
              Dates of birth are hidden for your role. Age bands are shown instead.
            </p>
          )}
          {d.children.length === 0 ? (
            <Empty title="No children recorded for this family"
                   hint="An enquiry before a child is born is normal — add them when you know."
                   action={canWrite
                     ? <Button size="sm" onClick={() => setAdding('child')}>Add a child</Button>
                     : undefined} />
          ) : (
            <ul>
              {d.children.map((c) => (
                <li key={String(c.id)} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
                    style={{ borderColor: 'var(--line)' }}>
                  <span className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold"
                        style={{ background: 'var(--surface-inset)' }} aria-hidden>
                    {String(c.first_name).charAt(0)}
                  </span>
                  <span className="flex-1">
                    <span className="block font-medium">{String(c.first_name)} {String(c.last_name ?? '')}</span>
                    <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {c.age_band ? String(c.age_band) : <NotMeasured why="No age band recorded" />}
                      {d.sensitiveVisible && c.date_of_birth ? ` · born ${String(c.date_of_birth)}` : ''}
                    </span>
                  </span>
                  <Badge tone={toneForStatus(String(c.status))}>{String(c.status)}</Badge>
                  {canWrite && (
                    <button type="button" onClick={() => setEditChild(c)}
                            className="text-[12px] underline" style={{ color: 'var(--text-faint)' }}>
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {editChild && (
        <EditChild child={editChild} canSeeDob={d.sensitiveVisible}
                   onClose={() => setEditChild(null)} onSaved={res.reload} />
      )}
      {editGuardian && (
        <EditGuardian guardian={editGuardian}
                      onClose={() => setEditGuardian(null)} onSaved={res.reload} />
      )}
      {adding && (
        <AddPerson familyId={id} kind={adding}
                   onClose={() => setAdding(null)} onSaved={res.reload} />
      )}

      {tab === 'Timeline' && <Timeline events={d.timeline} />}

      {tab === 'Messages' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <DraftComposer familyId={id} onSent={res.reload} />
          <DraftHistory familyId={id} />
        </div>
      )}

      {tab === 'Tours' && (
        <Panel title="Tours" pad={false}>
          {d.tours.length === 0 ? <Empty title="No tours yet" /> : (
            <ul>
              {d.tours.map((t) => (
                <li key={String(t.id)} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
                    style={{ borderColor: 'var(--line)' }}>
                  <span className="flex-1">
                    <span className="block font-medium">
                      {t.scheduled_for
                        ? `${new Date(t.scheduled_for).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} at ${clockTime(t.scheduled_for)}`
                        : 'No time set yet'}
                    </span>
                    {t.notes && <span className="mt-0.5 block text-[12px] whitespace-pre-wrap"
                                      style={{ color: 'var(--text-muted)' }}>{t.notes}</span>}
                  </span>
                  <Badge tone={toneForStatus(String(t.status))}>{String(t.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {tab === 'Registrations' && (
        <Panel title="Registrations" pad={false}>
          {d.registrations.length === 0 ? <Empty title="No registrations yet" /> : (
            <ul>
              {d.registrations.map((r) => (
                <li key={String(r.id)} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
                    style={{ borderColor: 'var(--line)' }}>
                  <Link to={`/registrations/${String(r.id)}`} className="flex-1 font-medium hover:underline">
                    Registration &middot; {r.completed_steps ?? 0} of {r.total_steps ?? '?'} steps
                  </Link>
                  <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                    <When iso={String(r.submitted_at ?? r.created_at)} />
                  </span>
                  <Badge tone={toneForStatus(String(r.status))}>{String(r.status)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {tab === 'Tasks' && (
        <Panel title="Tasks" pad={false}>
          {d.tasks.length === 0 ? <Empty title="No tasks for this family" /> : (
            <ul>
              {d.tasks.map((t) => (
                <li key={String(t.id)} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={toneForStatus(String(t.status))}>{String(t.status)}</Badge>
                    <span className="font-medium">{String(t.title)}</span>
                  </div>
                  {t.reason && <p className="mt-1 text-[11px] italic" style={{ color: 'var(--text-faint)' }}>Why: {t.reason}</p>}
                  {t.due_at && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>Due <When iso={t.due_at} /></p>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {tab === 'Notes' && (
        <Panel title="Notes">
          <div className="flex flex-col gap-2">
            <textarea
              value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="What happened, in your own words."
              rows={3}
              className="w-full resize-y rounded-lg border p-3 text-[13px] outline-none"
              style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' }}
            />
            <div><Button variant="primary" onClick={addNote} disabled={saving || !note.trim()}>
              {saving ? 'Saving…' : 'Save note'}
            </Button></div>
          </div>
          {d.notes.length > 0 && (
            <ul className="mt-4 flex flex-col gap-3">
              {d.notes.map((n) => (
                <li key={String(n.id)} className="rounded-lg p-3" style={{ background: 'var(--surface-sunken)' }}>
                  <p className="text-[13px] whitespace-pre-wrap">{String(n.body)}</p>
                  <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    {n.author_name ?? 'System'} &middot; <When iso={String(n.created_at)} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}

// -------------------------------------------------------------- timeline

function Timeline({ events }: { events: EventRow[] }) {
  if (events.length === 0) return <Panel><Empty title="Nothing has happened yet" /></Panel>;
  return (
    <Panel title="Everything that has happened" pad={false}>
      <ol className="relative px-4 py-3">
        {events.map((e) => (
          <li key={e.id} className="relative flex gap-3 pb-4 pl-4 last:pb-0">
            {/* One continuous rail, one dot per event. The line stops at the
                last item rather than dangling past it. */}
            <span aria-hidden className="absolute left-0 top-1.5 size-2 rounded-full"
                  style={{ background: e.actor_type === 'integration' ? 'var(--color-teal-400)'
                    : e.actor_type === 'system' ? 'var(--text-faint)' : 'var(--accent)' }} />
            <span aria-hidden className="absolute left-[3.5px] top-4 h-[calc(100%-1rem)] w-px last:hidden"
                  style={{ background: 'var(--line)' }} />
            <span className="flex-1">
              <span className="block text-[13px]">{e.summary ?? e.type}</span>
              <span className="mt-0.5 block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                <When iso={e.created_at} /> &middot; {e.actor_type === 'integration' ? `via ${e.source}` : e.actor_type}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// -------------------------------------------------- registration detail

interface RegistrationDetailData {
  registration: Record<string, string | number | null>;
  payload: Record<string, unknown>;
  timeline: EventRow[];
}

export function RegistrationDetail() {
  const params = useParams('/registrations/:id');
  const id = params?.id ?? '';
  const res = useApi<RegistrationDetailData>(id ? `/registrations/${id}` : null);
  const [busy, setBusy] = useState(false);

  if (res.loading && !res.data) return <Spinner label="Loading registration" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  const r = res.data.registration;
  const p = res.data.payload as {
    guardian?: { fullName?: string; email?: string; phone?: string; relationship?: string };
    child?: { firstName?: string; lastName?: string; ageBand?: string; dateOfBirth?: string };
    programInterest?: string; desiredStart?: string; notes?: string;
  };

  async function setStatus(status: string) {
    setBusy(true);
    try { await api.patch(`/registrations/${id}`, { status }); res.reload(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not update'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Link to="/registrations" className="text-[12px]" style={{ color: 'var(--text-muted)' }}>&larr; All registrations</Link>

      <header className="panel flex flex-wrap items-start justify-between gap-4 p-5">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">
              {p.child?.firstName ?? 'Registration'}
            </h1>
            <Badge tone={toneForStatus(String(r.status))}>{String(r.status)}</Badge>
          </div>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            <Link to={`/families/${String(r.family_id)}`} className="hover:underline">{String(r.family_name)}</Link>
            {' '}&middot; arrived via {String(r.source)} &middot; <When iso={String(r.submitted_at ?? r.created_at)} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => setStatus('reviewing')}>Reviewing</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setStatus('approved')}>Approve</Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="What the parent sent">
          {/* Rendered from the stored payload verbatim. Nobody retypes this,
              and nothing here was inferred. (spec 2) */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[13px]">
            <dt style={{ color: 'var(--text-muted)' }}>Guardian</dt>
            <dd>{p.guardian?.fullName ?? '—'}{p.guardian?.relationship ? ` (${p.guardian.relationship})` : ''}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Email</dt>
            <dd>{p.guardian?.email ? <a className="hover:underline" href={`mailto:${p.guardian.email}`}>{p.guardian.email}</a> : '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Phone</dt>
            <dd>{p.guardian?.phone ? <a className="hover:underline" href={`tel:${p.guardian.phone}`}>{p.guardian.phone}</a> : '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Child</dt>
            <dd>{p.child?.firstName ?? '—'} {p.child?.lastName ?? ''}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Age</dt>
            <dd>{p.child?.ageBand ?? <NotMeasured why="The parent was not asked for an exact age at this step" />}</dd>
            {p.child?.dateOfBirth && (<><dt style={{ color: 'var(--text-muted)' }}>Born</dt><dd>{p.child.dateOfBirth}</dd></>)}
            <dt style={{ color: 'var(--text-muted)' }}>Program</dt>
            <dd>{p.programInterest ?? '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>Desired start</dt>
            <dd>{p.desiredStart ?? '—'}</dd>
          </dl>
          {p.notes && (
            <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--surface-sunken)' }}>
              <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
                Their note
              </p>
              <p className="mt-1 text-[13px] whitespace-pre-wrap">{p.notes}</p>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          <CompletenessPanel registrationId={id} />
          <Timeline events={res.data.timeline} />
        </div>
      </div>
    </div>
  );
}
