/**
 * Getting the register working.
 *
 * This exists because the register shipped without it: the permission rules and
 * the ratio honesty were right, but nothing created a room, put a child in one,
 * or set a ratio — so the screen could only ever be empty, and there was no way
 * to change that without going into the database.
 *
 * It opens itself when there are no rooms yet, because at that point it is not
 * a settings panel, it is the only useful thing on the page.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Panel, Button, Badge, Spinner, ErrorNote, NotMeasured } from '../ui/kit.tsx';

interface Room {
  id: string; name: string; capacity: number | null;
  program_id: string | null; program_name: string | null;
  enrolled: number; staff: number;
}
interface Waiting {
  id: string; first_name: string; last_name: string | null;
  age_band: string | null; status: string; family_name: string;
}
interface ProgramRatio {
  id: string; name: string; children_per_staff: number | null; source: string | null;
}
interface Person { user_id?: string; id?: string; name: string; role: string }
interface SetupData {
  classrooms: Room[]; unplaced: Waiting[]; programs: ProgramRatio[];
  assignable: Person[]; staff: Record<string, Person[]>;
}

export function RegisterSetup({ canEdit, onChanged }: { canEdit: boolean; onChanged: () => void }) {
  const res = useApi<SetupData>('/classrooms/setup');
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [roomName, setRoomName] = useState('');
  const [roomProgram, setRoomProgram] = useState('');
  const [roomCapacity, setRoomCapacity] = useState('');

  const data = res.data;
  const noRooms = !!data && data.classrooms.length === 0;
  // Open while there is still set-up to do, which is not the same as "no rooms":
  // making the first room stops `noRooms` being true, and keying off that alone
  // slammed the panel shut the instant you created a room, before you could put
  // anybody in it. Children still waiting is the honest "unfinished" signal.
  const unfinished = noRooms || (!!data && data.unplaced.length > 0);
  const expanded = open ?? unfinished;

  async function call(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); res.reload(); onChanged(); return true; }
    catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      return false;
    } finally { setBusy(false); }
  }

  async function addRoom() {
    const name = roomName.trim();
    if (!name) return;
    const capacity = roomCapacity.trim() ? Number(roomCapacity) : null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity <= 0)) {
      setError('Capacity is a whole number of places, or leave it blank.');
      return;
    }
    const ok = await call(() => api.post('/classrooms', {
      name, programId: roomProgram || null, capacity,
    }));
    if (ok) { setRoomName(''); setRoomCapacity(''); setRoomProgram(''); }
  }

  const field = 'rounded-lg border px-2.5 py-1.5 text-[13px] outline-none';
  const fieldStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  if (res.loading && !data) return <Panel title="Rooms"><Spinner label="Checking the set-up" /></Panel>;
  if (res.error) return <Panel title="Rooms"><ErrorNote error={res.error} retry={res.reload} /></Panel>;
  if (!data) return null;

  return (
    <Panel pad={false}>
      <button
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold">Rooms and ratios</span>
          {noRooms && <Badge tone="warn">nothing set up yet</Badge>}
          {!noRooms && data.unplaced.length > 0 && (
            <Badge tone="info">{data.unplaced.length} waiting for a room</Badge>
          )}
        </span>
        <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {expanded ? 'Hide' : 'Show'}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-5 border-t px-4 py-4" style={{ borderColor: 'var(--line)' }}>
          {error && <ErrorNote error={error} retry={() => setError(null)} />}

          {noRooms && (
            <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
              The register lists enrolled children by room, so nothing appears until there is a
              room to list them in. Make one, put the children in it, and set the ratio.
            </p>
          )}

          {/* ------------------------------------------------------- rooms */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-faint)' }}>Rooms</h3>

            {data.classrooms.map((r) => (
              <RoomLine
                key={r.id} room={r} canEdit={canEdit} busy={busy}
                staff={data.staff[r.id] ?? []}
                assignable={data.assignable}
                onSave={(patch) => void call(() => api.patch(`/classrooms/${r.id}`, patch))}
                onStaff={(userId, remove) => void call(() =>
                  api.post(`/classrooms/${r.id}/staff`, { userId, remove, role: 'support' }))}
              />
            ))}

            {canEdit && (
              <div className="flex flex-wrap gap-2 pt-1">
                <input value={roomName} onChange={(e) => setRoomName(e.target.value)}
                       onKeyDown={(e) => { if (e.key === 'Enter') void addRoom(); }}
                       placeholder="Room name" aria-label="New room name"
                       className={`${field} min-w-40 flex-1`} style={fieldStyle} />
                <select value={roomProgram} onChange={(e) => setRoomProgram(e.target.value)}
                        aria-label="Program" className={`${field} w-44`} style={fieldStyle}>
                  <option value="">No program</option>
                  {data.programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input value={roomCapacity} onChange={(e) => setRoomCapacity(e.target.value)}
                       placeholder="Places" aria-label="Capacity" inputMode="numeric"
                       className={`${field} w-24`} style={fieldStyle} />
                <Button size="sm" variant="primary" disabled={busy || !roomName.trim()}
                        onClick={() => void addRoom()}>Add room</Button>
              </div>
            )}
          </section>

          {/* --------------------------------------------- waiting children */}
          {data.unplaced.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[12px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-faint)' }}>
                Children with no room ({data.unplaced.length})
              </h3>
              {data.classrooms.length === 0 ? (
                <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  Make a room first, then you can place them.
                </p>
              ) : (
                data.unplaced.map((ch) => (
                  <div key={ch.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-[13px]">
                      {ch.first_name}{ch.last_name ? ` ${ch.last_name}` : ''}
                      <span className="ml-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                        {ch.family_name}{ch.age_band ? ` · ${ch.age_band}` : ''} · {ch.status}
                      </span>
                    </span>
                    {canEdit && (
                      <select
                        aria-label={`Put ${ch.first_name} in a room`}
                        defaultValue=""
                        className={`${field} w-52`} style={fieldStyle}
                        disabled={busy}
                        onChange={(e) => {
                          const classroomId = e.target.value;
                          if (!classroomId) return;
                          // Enrols at the same time, in one request. Placing
                          // without enrolling leaves them invisible on the
                          // register, which reads as the placement failing.
                          void call(() => api.patch(`/children/${ch.id}/placement`, {
                            classroomId, status: 'enrolled',
                          }));
                        }}
                      >
                        <option value="">Place and enrol in…</option>
                        {data.classrooms.map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ))
              )}
            </section>
          )}

          {/* ------------------------------------------------------ ratios */}
          <section className="flex flex-col gap-2">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide"
                style={{ color: 'var(--text-faint)' }}>Supervision ratios</h3>
            <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              One adult per how many children. Set by provincial regulation, so it is stored
              rather than built in. A program with no rule reports as not measured.
            </p>
            {data.programs.map((p) => (
              <RatioLine key={p.id} program={p} canEdit={canEdit} busy={busy}
                         onSet={(n, source) => void call(() =>
                           api.patch(`/programs/${p.id}/ratio`, { childrenPerStaff: n, source }))} />
            ))}
          </section>
        </div>
      )}
    </Panel>
  );
}

function RoomLine(
  { room, canEdit, busy, staff, assignable, onSave, onStaff }: {
    room: Room; canEdit: boolean; busy: boolean;
    staff: Person[]; assignable: Person[];
    onSave: (patch: Record<string, unknown>) => void;
    onStaff: (userId: string, remove: boolean) => void;
  },
) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [capacity, setCapacity] = useState(room.capacity === null ? '' : String(room.capacity));

  const field = 'rounded-lg border px-2.5 py-1.5 text-[13px] outline-none';
  const fieldStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  if (editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Room name"
               className={`${field} min-w-40 flex-1`} style={fieldStyle} autoFocus />
        <input value={capacity} onChange={(e) => setCapacity(e.target.value)} aria-label="Capacity"
               placeholder="Places" inputMode="numeric" className={`${field} w-24`} style={fieldStyle} />
        <Button size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => {
          onSave({ name: name.trim(), capacity: capacity.trim() ? Number(capacity) : null });
          setEditing(false);
        }}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="text-[13px] font-medium">{room.name}</span>
      {room.program_name && (
        <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{room.program_name}</span>
      )}
      <span className="min-w-0 flex-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        {room.enrolled} enrolled{room.capacity ? ` of ${room.capacity}` : ''}
        {' · '}
        {room.staff === 0
          ? 'nobody assigned'
          : room.staff === 1 ? '1 educator' : `${room.staff} educators`}
      </span>
      {canEdit && (
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>Edit</Button>
          {/* Closing rather than deleting: a room with a term of attendance
              behind it should stop appearing, not stop having happened. */}
          <Button size="sm" variant="ghost" disabled={busy}
                  onClick={() => onSave({ active: false })}>Close</Button>
        </span>
      )}

      {/* Who works here. Without at least one, the ratio stays unmeasurable
          however carefully it is configured — so this belongs next to it. */}
      {canEdit && (
        <div className="flex w-full flex-wrap items-center gap-1.5 pl-0 pt-1">
          {staff.map((p) => (
            <span key={p.user_id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: 'var(--surface-inset)' }}>
              {p.name}
              <button onClick={() => onStaff(String(p.user_id), true)} disabled={busy}
                      aria-label={`Take ${p.name} out of ${room.name}`}
                      style={{ color: 'var(--text-faint)' }}>&times;</button>
            </span>
          ))}
          <select
            aria-label={`Add an educator to ${room.name}`} defaultValue="" disabled={busy}
            className="rounded-lg border px-2 py-1 text-[11px] outline-none"
            style={{ borderColor: 'var(--line)', background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
            onChange={(e) => { if (e.target.value) { onStaff(e.target.value, false); e.target.value = ''; } }}
          >
            <option value="">Add an educator…</option>
            {assignable
              .filter((p) => !staff.some((s) => s.user_id === p.id))
              .map((p) => <option key={p.id} value={p.id}>{p.name} ({p.role})</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

function RatioLine(
  { program, canEdit, busy, onSet }: {
    program: ProgramRatio; canEdit: boolean; busy: boolean;
    onSet: (n: number | null, source: string | null) => void;
  },
) {
  const [value, setValue] = useState(
    program.children_per_staff === null ? '' : String(program.children_per_staff));

  const field = 'rounded-lg border px-2.5 py-1.5 text-[13px] outline-none';
  const fieldStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-[13px]">{program.name}</span>
      {program.children_per_staff === null && !canEdit && <NotMeasured why="No ratio configured" />}
      {canEdit ? (
        <>
          <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>1 adult per</span>
          <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="numeric"
                 aria-label={`Children per adult in ${program.name}`}
                 placeholder="—" className={`${field} w-16 text-center`} style={fieldStyle} />
          <Button size="sm" variant="ghost" disabled={busy || !value.trim()}
                  onClick={() => onSet(Number(value), program.source)}>Set</Button>
          {program.children_per_staff !== null && (
            <Button size="sm" variant="ghost" disabled={busy}
                    onClick={() => { setValue(''); onSet(null, null); }}>Remove</Button>
          )}
        </>
      ) : (
        program.children_per_staff !== null && (
          <span className="text-[13px]">1 : {program.children_per_staff}</span>
        )
      )}
    </div>
  );
}
