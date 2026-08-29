/**
 * The register.
 *
 * Two things here are deliberate and should stay that way.
 *
 * A room whose ratio cannot be worked out renders <NotMeasured/> with the
 * reason, never a reassuring tick. The server already refuses to guess; this
 * screen must not undo that by rendering `0 / 0` as if it meant something.
 *
 * Checking a child out is a small form rather than a button, because it needs
 * a name. "Who collected them" is the question asked after something has gone
 * wrong, and a one-tap check-out quietly makes that question unanswerable.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import {
  Panel, Button, Badge, Stat, Spinner, ErrorNote, Empty, NotMeasured, clockTime, toneForStatus,
} from '../ui/kit.tsx';
import { RegisterSetup } from './RegisterSetup.tsx';

interface RegisterRow {
  child_id: string;
  first_name: string;
  last_name: string | null;
  classroom_id: string | null;
  classroom_name: string | null;
  family_id: string;
  family_name: string;
  status: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
  released_to: string | null;
  note: string | null;
}

interface Standing {
  classroomId: string;
  classroomName: string;
  present: number;
  staffOnShift: number;
  measured: boolean;
  requiredPerStaff: number | null;
  withinRatio: boolean | null;
  note: string | null;
}

interface Summary {
  day: string; expected: number; present: number; absent: number;
  notYetMarked: number; stillIn: number;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export function Attendance() {
  const [day, setDay] = useState(todayIso());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reg = useApi<{ day: string; register: RegisterRow[]; summary: Summary }>(
    `/attendance?day=${day}`, [day]);
  const rooms = useApi<{ rooms: Standing[] }>(`/attendance/standings?day=${day}`, [day]);
  const me = useApi<{ capabilities: string[] }>('/auth/me');

  async function act(childId: string, body: Record<string, unknown>, path: string) {
    setBusy(childId); setError(null);
    try {
      await api.post(path, { childId, day, ...body });
      reg.reload(); rooms.reload();
    } catch (err) {
      // The server's refusals are written to be read by a person — "that child
      // is not in a room you are assigned to" — so show them, not a generic.
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const rows = reg.data?.register ?? [];
  const summary = reg.data?.summary;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Register</h1>
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Who is here, and who took them home.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <span style={{ color: 'var(--text-muted)' }}>Day</span>
          <input type="date" value={day} onChange={(e) => setDay(e.target.value || todayIso())}
                 className="rounded-lg border px-2.5 py-1.5 text-[13px] outline-none"
                 style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' }} />
          {day !== todayIso() && (
            <Button size="sm" variant="ghost" onClick={() => setDay(todayIso())}>Today</Button>
          )}
        </label>
      </header>

      {error && <ErrorNote error={error} retry={() => setError(null)} />}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="In the building" value={summary.stillIn} tone="ok"
                hint="Checked in and not yet collected" />
          <Stat label="Present today" value={summary.present} />
          <Stat label="Absent" value={summary.absent} tone={summary.absent ? 'warn' : undefined} />
          <Stat label="Not yet marked" value={summary.notYetMarked}
                tone={summary.notYetMarked ? 'warn' : undefined}
                hint={summary.notYetMarked ? 'These children have no entry yet' : 'Every child accounted for'} />
        </div>
      )}

      <RegisterSetup
        canEdit={me.data?.capabilities.includes('classroom:write') ?? false}
        onChanged={() => { reg.reload(); rooms.reload(); }}
      />

      {/* ------------------------------------------------------------ ratios */}
      <Panel title="Rooms">
        {rooms.loading && <Spinner label="Working out the rooms" />}
        {rooms.error && <ErrorNote error={rooms.error} retry={rooms.reload} />}
        {rooms.data && rooms.data.rooms.length === 0 && (
          <Empty title="No rooms to show"
                 hint="Either no classrooms are set up, or you are not assigned to one." />
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.data?.rooms.map((r) => (
            <div key={r.classroomId} className="rounded-lg border px-3.5 py-3"
                 style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-semibold">{r.classroomName}</span>
                <span className="tabular text-lg font-semibold">{r.present}</span>
              </div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                {r.present === 1 ? '1 child in' : `${r.present} children in`}
                {' · '}
                {r.staffOnShift === 1 ? '1 educator' : `${r.staffOnShift} educators`}
              </div>
              <div className="mt-2">
                {r.measured ? (
                  <Badge tone={r.withinRatio ? 'ok' : 'crit'}>
                    {r.withinRatio ? 'within ratio' : 'over ratio'}
                    {r.requiredPerStaff !== null && ` · 1:${r.requiredPerStaff}`}
                  </Badge>
                ) : (
                  // Deliberately not a green tick. The reason travels with it.
                  <NotMeasured why={r.note ?? undefined} />
                )}
              </div>
              {!r.measured && r.note && (
                <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>{r.note}</p>
              )}
            </div>
          ))}
        </div>
      </Panel>

      {/* ---------------------------------------------------------- register */}
      <Panel title={`Children · ${day}`}>
        {reg.loading && <Spinner label="Loading the register" />}
        {reg.error && <ErrorNote error={reg.error} retry={reg.reload} />}
        {reg.data && rows.length === 0 && (
          <Empty
            title="Nobody to show"
            hint={(rooms.data?.rooms.length ?? 0) === 0
              ? 'There are no rooms yet. Open “Rooms and ratios” above to make one and put the children in it.'
              : 'An educator sees the children in the rooms they are assigned to. If this is unexpected, ask a director to check your room assignment.'}
          />
        )}
        <div className="flex flex-col divide-y" style={{ borderColor: 'var(--line)' }}>
          {rows.map((r) => (
            <ChildRow key={r.child_id} row={r} busy={busy === r.child_id}
                      onMark={(body) => act(r.child_id, body, '/attendance/mark')}
                      onCheckOut={(releasedTo) => act(r.child_id, { releasedTo }, '/attendance/checkout')} />
          ))}
        </div>
      </Panel>
    </div>
  );
}

function ChildRow(
  { row, busy, onMark, onCheckOut }: {
    row: RegisterRow;
    busy: boolean;
    onMark: (body: Record<string, unknown>) => void;
    onCheckOut: (releasedTo: string) => void;
  },
) {
  const [collecting, setCollecting] = useState(false);
  const [releasedTo, setReleasedTo] = useState('');

  const out = !!row.checked_out_at;
  const inBuilding = (row.status === 'present' || row.status === 'late') && !out;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium">
            {row.first_name}{row.last_name ? ` ${row.last_name}` : ''}
          </span>
          <Badge tone={toneForStatus(row.status)}>{row.status.replace('_', ' ')}</Badge>
          {row.classroom_name && (
            <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{row.classroom_name}</span>
          )}
        </div>
        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          <Link to={`/families/${row.family_id}`} className="hover:underline">{row.family_name}</Link>
          {row.checked_in_at && ` · in ${clockTime(row.checked_in_at)}`}
          {out && ` · out ${clockTime(row.checked_out_at)}`}
          {/* Naming the collector is the point of the field, so show it. */}
          {out && row.released_to && ` · to ${row.released_to}`}
          {row.note && ` · ${row.note}`}
        </div>
      </div>

      {collecting ? (
        <form
          className="flex w-full items-center gap-2 sm:w-auto"
          onSubmit={(e) => {
            e.preventDefault();
            if (!releasedTo.trim()) return;
            onCheckOut(releasedTo.trim());
            setCollecting(false); setReleasedTo('');
          }}
        >
          <input
            autoFocus value={releasedTo} onChange={(e) => setReleasedTo(e.target.value)}
            placeholder="Who collected them?"
            aria-label={`Who collected ${row.first_name}`}
            className="min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[13px] outline-none sm:w-56"
            style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' }}
          />
          <Button size="sm" variant="primary" type="submit" disabled={!releasedTo.trim() || busy}>
            Check out
          </Button>
          <Button size="sm" variant="ghost" type="button"
                  onClick={() => { setCollecting(false); setReleasedTo(''); }}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {!out && (
            <>
              <Button size="sm" variant={inBuilding ? 'ghost' : 'primary'} disabled={busy}
                      onClick={() => onMark({ status: 'present' })}>
                {inBuilding ? 'In' : 'Check in'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => onMark({ status: 'late' })}>Late</Button>
              <Button size="sm" variant="ghost" disabled={busy}
                      onClick={() => onMark({ status: 'absent' })}>Absent</Button>
            </>
          )}
          {inBuilding && (
            <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => setCollecting(true)}>Check out…</Button>
          )}
          {out && (
            <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>collected</span>
          )}
        </div>
      )}
    </div>
  );
}
