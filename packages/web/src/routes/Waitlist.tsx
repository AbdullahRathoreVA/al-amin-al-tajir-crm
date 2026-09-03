/**
 * The waiting list.
 *
 * Built around the one thing every source on childcare waitlists agrees about:
 * the way a list fails is not losing it, it is going quiet. A family joins,
 * hears nothing for months, and has enrolled elsewhere by the time anybody
 * rings. So the two things this screen puts in front of you are offers that
 * have run out and families nobody has spoken to since spring.
 *
 * Two numbers are deliberately absent. There is no estimated wait, because the
 * CRM cannot know when a place will free up and a guess on this screen becomes
 * a promise made to a parent. And position is computed here every time rather
 * than stored, because a stored position is wrong the moment somebody leaves
 * the middle of the list.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import {
  Panel, Badge, Button, Empty, Spinner, ErrorNote, Stat, Modal, Field,
  TextInput, TextArea, SelectInput, NotMeasured, When,
} from '../ui/kit.tsx';

interface Entry {
  id: string; position: number;
  familyId: string; familyName: string; childName: string | null;
  programName: string | null; status: string;
  addedAt: string; waitingDays: number;
  hasSiblingHere: boolean;
  daysSinceContact: number | null; isStale: boolean;
  offerExpiresAt: string | null; offerDaysLeft: number | null;
}
interface ProgramStanding {
  id: string; name: string; age_label: string | null;
  capacity: number | null; enrolled: number; waiting: number; offered: number;
}
interface Data {
  entries: Entry[]; programs: ProgramStanding[];
  staleAfterDays: number; defaultOfferDays: number;
  orderingPolicy: string;
}

export function Waitlist({ canWrite }: { canWrite: boolean }) {
  const res = useApi<Data>('/waitlist');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offering, setOffering] = useState<Entry | null>(null);
  const [responding, setResponding] = useState<{ entry: Entry; kind: 'accept' | 'decline' } | null>(null);

  async function act(entry: Entry, path: string, body: Record<string, unknown> = {}) {
    setBusy(entry.id); setError(null);
    try { await api.post(`/waitlist/${entry.id}/${path}`, body); res.reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'That did not work'); }
    finally { setBusy(null); }
  }

  const d = res.data;
  const entries = d?.entries ?? [];
  const waiting = entries.filter((e) => e.status === 'waiting');
  const offered = entries.filter((e) => e.status === 'offered');
  const expired = offered.filter((e) => (e.offerDaysLeft ?? 1) < 0);
  const stale = waiting.filter((e) => e.isStale);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Waiting list</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {/* Stated on the screen, not just in a policy document nobody opens.
              A waiting list only feels fair if the rule can be repeated to a
              parent on the phone, word for word. */}
          {d?.orderingPolicy ?? 'In the order families joined.'}
        </p>
      </header>

      {res.loading && !d && <Spinner label="Reading the list" />}
      {res.error && <ErrorNote error={res.error} retry={res.reload} />}
      {error && <ErrorNote error={error} retry={() => setError(null)} />}

      {d && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Waiting" value={waiting.length} />
          <Stat label="Offered a place" value={offered.length}
                hint="Waiting to hear back" />
          <Stat label="Past the deadline" value={expired.length}
                tone={expired.length ? 'crit' : undefined}
                hint={expired.length ? 'These places cannot go to anybody else yet' : undefined} />
          <Stat label="Not heard from" value={stale.length}
                tone={stale.length ? 'warn' : undefined}
                hint={`No contact in ${d.staleAfterDays} days`} />
        </div>
      )}

      {/* --------------------------------------------------- places free */}
      {d && (
        <Panel title="Places, by age group">
          <p className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Free places are the licensed number minus the children enrolled. There is no
            estimated wait here on purpose — nobody can know when a place will come up, and
            a guess on this screen turns into a promise on the phone.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  <th className="py-1 text-left font-medium">Age group</th>
                  <th className="py-1 text-right font-medium">Licensed</th>
                  <th className="py-1 text-right font-medium">Enrolled</th>
                  <th className="py-1 text-right font-medium">Free</th>
                  <th className="py-1 text-right font-medium">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {d.programs.map((p) => {
                  const free = p.capacity === null ? null : Math.max(0, p.capacity - p.enrolled);
                  return (
                    <tr key={p.id} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="py-1.5">
                        {p.name}
                        {p.age_label && (
                          <span className="ml-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                            {p.age_label}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right">
                        {p.capacity ?? <NotMeasured why="No licensed capacity recorded for this age group" />}
                      </td>
                      <td className="py-1.5 text-right">{p.enrolled}</td>
                      <td className="py-1.5 text-right font-medium"
                          style={{ color: free === 0 ? 'var(--color-warn-600)' : undefined }}>
                        {free === null ? '—' : free}
                      </td>
                      <td className="py-1.5 text-right">{p.waiting}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* ------------------------------------------------ needs an answer */}
      {offered.length > 0 && (
        <Panel title="Offered a place, waiting to hear back">
          <ul className="flex flex-col gap-2">
            {offered.map((e) => (
              <li key={e.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                  style={{ borderColor: (e.offerDaysLeft ?? 1) < 0
                    ? 'var(--color-crit-400)' : 'var(--line-strong)' }}>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {e.childName ?? e.familyName}{' '}
                    <Link to={`/families/${e.familyId}`} className="text-[12px] font-normal underline"
                          style={{ color: 'var(--text-muted)' }}>{e.familyName}</Link>
                  </span>
                  <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {e.programName ?? 'no age group set'} &middot;{' '}
                    {(e.offerDaysLeft ?? 0) < 0
                      ? <strong style={{ color: 'var(--color-crit-400)' }}>
                          answer was due {Math.abs(e.offerDaysLeft ?? 0)} day
                          {Math.abs(e.offerDaysLeft ?? 0) === 1 ? '' : 's'} ago
                        </strong>
                      : <>{e.offerDaysLeft} day{e.offerDaysLeft === 1 ? '' : 's'} left to answer</>}
                  </span>
                </span>
                {canWrite && (
                  <span className="flex flex-wrap gap-2">
                    <Button size="sm" variant="primary" disabled={busy === e.id}
                            onClick={() => setResponding({ entry: e, kind: 'accept' })}>
                      They accepted
                    </Button>
                    <Button size="sm" disabled={busy === e.id}
                            onClick={() => setResponding({ entry: e, kind: 'decline' })}>
                      They said no
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ------------------------------------------------------ the list */}
      {d && (
        <Panel title={`Waiting (${waiting.length})`} pad={false}>
          {waiting.length === 0 ? (
            <Empty title="Nobody is waiting"
                   hint="Families join from the website, or you can add them from their family page." />
          ) : (
            <ul>
              {waiting.map((e) => (
                <li key={e.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0"
                    style={{ borderColor: 'var(--line)' }}>
                  <span className="grid size-8 shrink-0 place-items-center rounded-full text-[12px] font-semibold"
                        style={{ background: 'var(--surface-inset)' }}>
                    {e.position}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong className="text-[13px]">{e.childName ?? e.familyName}</strong>
                      {/* Shown because it is useful to know you already have
                          this family on the phone. It changes nothing about
                          their place: the centre's policy is strict order of
                          joining, and the list is sorted on nothing else. */}
                      {e.hasSiblingHere && <Badge tone="neutral">already with us</Badge>}
                      {e.isStale && <Badge tone="warn">not heard from</Badge>}
                    </span>
                    <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      <Link to={`/families/${e.familyId}`} className="underline">{e.familyName}</Link>
                      {' · '}{e.programName ?? 'no age group set'}
                      {' · waiting '}{e.waitingDays} day{e.waitingDays === 1 ? '' : 's'}
                    </span>
                    <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      joined <When iso={e.addedAt} />
                      {e.daysSinceContact !== null
                        && ` · last spoken to ${e.daysSinceContact} days ago`}
                    </span>
                  </span>
                  {canWrite && (
                    <span className="flex flex-wrap gap-2">
                      <Button size="sm" variant="primary" disabled={busy === e.id}
                              onClick={() => setOffering(e)}>Offer a place</Button>
                      <Button size="sm" disabled={busy === e.id}
                              onClick={() => void act(e, 'contact')}>Checked in</Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {offering && d && (
        <OfferDialog entry={offering} defaultDays={d.defaultOfferDays}
                     onClose={() => setOffering(null)} onDone={res.reload} />
      )}
      {responding && (
        <RespondDialog {...responding} onClose={() => setResponding(null)} onDone={res.reload} />
      )}
    </div>
  );
}

function OfferDialog(
  { entry, defaultDays, onClose, onDone }:
  { entry: Entry; defaultDays: number; onClose: () => void; onDone: () => void },
) {
  const [days, setDays] = useState(String(defaultDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true); setError(null);
    try {
      await api.post(`/waitlist/${entry.id}/offer`, { expiresInDays: Number(days) });
      onDone(); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not offer that place');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Offer a place to ${entry.familyName}`}
      description="A deadline is required. An offer with no deadline is how a place sits reserved for a family that has already gone elsewhere."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !Number(days)} onClick={() => void go()}>
            {busy ? 'Offering…' : 'Offer the place'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <ErrorNote error={error} />}
        <Field label="Days to answer" required
               hint="A task is raised to tell them, and another if the deadline passes with no answer.">
          {(p) => <TextInput {...p} type="number" min={1} max={90} value={days}
                             onChange={(e) => setDays(e.target.value)} />}
        </Field>
        <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          This does not send anything. It records the offer and reminds you to make the call.
        </p>
      </div>
    </Modal>
  );
}

function RespondDialog(
  { entry, kind, onClose, onDone }:
  { entry: Entry; kind: 'accept' | 'decline'; onClose: () => void; onDone: () => void },
) {
  const [reason, setReason] = useState('');
  const [keepWaiting, setKeepWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const declining = kind === 'decline';

  async function go() {
    setBusy(true); setError(null);
    try {
      await api.post(`/waitlist/${entry.id}/${kind}`,
        declining ? { reason, keepWaiting } : { reason: reason || undefined });
      onDone(); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={declining ? `${entry.familyName} turned the place down` : `${entry.familyName} accepted`}
      description={declining
        ? 'Why matters more than the row does — it is the only way anybody learns why places go unfilled.'
        : 'The child is marked as enrolled. Which room they go in is decided on Ages & Rooms.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || (declining && !reason.trim())}
                  onClick={() => void go()}>
            {busy ? 'Saving…' : declining ? 'Record it' : 'Enrol them'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <ErrorNote error={error} />}
        <Field label={declining ? 'Why did they say no?' : 'Anything worth noting'}
               required={declining}
               hint={declining ? 'Found care elsewhere, wrong start date, changed their mind…' : undefined}>
          {(p) => <TextArea {...p} rows={3} value={reason} autoFocus
                            onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {declining && (
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={keepWaiting} className="mt-0.5 size-4"
                   onChange={(e) => setKeepWaiting(e.target.checked)} />
            <span>
              Keep them on the list
              <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                For a family who wanted September and was offered June. They keep their place
                in the queue.
              </span>
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}
