/**
 * Ages & Rooms — every child, and the room their age says they belong in.
 *
 * The question this answers is the one somebody asks the moment a roll of
 * children lands in front of them: for each of these, where do they go? The
 * register's "Ready to move up" answers a narrower version (who has aged past
 * their room). This shows everybody, including the children who are already in
 * the right place, because "everyone is fine" is not believable unless the
 * ones who are fine are on the screen too.
 *
 * It still never moves anyone on its own. Same reason as everywhere else:
 * space, ratios, the educator a child has settled with, and their parents.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import {
  Panel, Badge, Button, Empty, Spinner, ErrorNote, Stat, Modal, SelectInput, NotMeasured,
} from '../ui/kit.tsx';

type Verdict = 'correct' | 'move' | 'unplaced' | 'no-room-for-age' | 'no-birthday';

interface Row {
  childId: string; name: string; familyId: string; familyName: string;
  status: string; dateOfBirth: string | null; ageLabel: string | null;
  currentRoomId: string | null; currentRoom: string | null;
  shouldBeProgram: string | null;
  shouldBeRoomId: string | null; shouldBeRoom: string | null;
  verdict: Verdict; reason: string;
}
interface RoomOption {
  id: string; name: string; program_name: string | null;
  capacity: number | null; enrolled: number;
}
interface Plan {
  rows: Row[];
  rooms: RoomOption[];
  summary: { total: number; correct: number; move: number; unplaced: number;
             noRoomForAge: number; noBirthday: number };
}

const VERDICT: Record<Verdict, { label: string; tone: 'ok' | 'warn' | 'crit' | 'info' }> = {
  correct: { label: 'in the right room', tone: 'ok' },
  move: { label: 'should move', tone: 'warn' },
  unplaced: { label: 'needs a room', tone: 'warn' },
  'no-room-for-age': { label: 'no room for this age', tone: 'crit' },
  'no-birthday': { label: 'no birthday recorded', tone: 'info' },
};

const ORDER: Verdict[] = ['move', 'unplaced', 'no-room-for-age', 'no-birthday', 'correct'];

export function AgesRooms({ canMove }: { canMove: boolean }) {
  const res = useApi<Plan>('/placement');
  const [filter, setFilter] = useState<Verdict | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last move made on this screen, so a mis-click has a way back that does
  // not involve hunting for the room they came from.
  const [lastMove, setLastMove] = useState<{ childId: string; name: string; room: string } | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  // Nothing moves until this is answered.
  const [pending, setPending] = useState<{ row: Row; roomId: string; roomName: string } | null>(null);

  /**
   * Moving a child is confirmed, always.
   *
   * It used to happen on one click, and it moved the wrong child twice in an
   * afternoon - the rows are one line apart and every button says much the
   * same thing. An undo afterwards is not a substitute for being asked first.
   */
  async function confirmMove(row: Row, roomId: string, roomName: string) {
    setBusy(row.childId); setError(null); setUndoNote(null);
    try {
      await api.patch(`/children/${row.childId}/placement`, { classroomId: roomId });
      setLastMove({ childId: row.childId, name: row.name, room: roomName });
      setPending(null);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move that child.');
    } finally { setBusy(null); }
  }

  async function undo() {
    if (!lastMove) return;
    setBusy(lastMove.childId); setError(null); setUndoNote(null);
    try {
      const r = await api.post<{ undone: boolean; room?: string | null; why?: string }>(
        `/children/${lastMove.childId}/placement/undo`, {});
      if (r.undone) { setLastMove(null); res.reload(); }
      else setUndoNote(r.why ?? 'That could not be undone.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not undo that.');
    } finally { setBusy(null); }
  }

  const d = res.data;
  const rows = (d?.rows ?? [])
    .filter((r) => filter === 'all' || r.verdict === filter)
    .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict)
      || a.name.localeCompare(b.name));

  const needsSomething = (d?.summary.move ?? 0) + (d?.summary.unplaced ?? 0);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Ages &amp; Rooms</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Every child, and the room their age says they belong in. Nothing moves
          until you say so.
        </p>
      </header>

      {res.loading && !d && <Spinner label="Working out where everyone goes" />}
      {res.error && <ErrorNote error={res.error} retry={res.reload} />}
      {error && <ErrorNote error={error} retry={() => setError(null)} />}

      {/* A move is one click, so undoing one should be too. The window is
          short on purpose: undoing something from last week is not an undo,
          it is a move that deserves the room's numbers in front of you. */}
      {lastMove && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2"
             role="status"
             style={{ background: 'color-mix(in oklab, var(--color-ok-400) 14%, transparent)',
                      color: 'var(--color-ok-600)' }}>
          <span className="text-[13px]">
            {lastMove.name} moved to {lastMove.room}.
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" disabled={busy === lastMove.childId} onClick={() => void undo()}>
              {busy === lastMove.childId ? 'Undoing…' : 'Undo'}
            </Button>
            <button type="button" onClick={() => { setLastMove(null); setUndoNote(null); }}
                    className="text-[12px] underline" style={{ color: 'inherit' }}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {undoNote && <ErrorNote error={undoNote} retry={() => setUndoNote(null)} />}

      {d && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Children" value={d.summary.total} />
          <Stat label="In the right room" value={d.summary.correct} tone="ok" />
          <Stat label="Should move" value={d.summary.move}
                tone={d.summary.move ? 'warn' : undefined} />
          <Stat label="Need a room" value={d.summary.unplaced}
                tone={d.summary.unplaced ? 'warn' : undefined} />
        </div>
      )}

      {d && (
        <Panel
          title={needsSomething ? `${needsSomething} need something doing` : 'Nothing needs doing'}
          pad={false}
          action={
            <select
              aria-label="Show which children"
              value={filter}
              onChange={(e) => setFilter(e.target.value as Verdict | 'all')}
              className="rounded-lg border px-2 py-1 text-[12px]"
              style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)',
                       color: 'var(--text)' }}
            >
              <option value="all">Everyone</option>
              {ORDER.map((v) => <option key={v} value={v}>{VERDICT[v].label}</option>)}
            </select>
          }
        >
          {rows.length === 0 ? (
            <Empty title="Nobody matches that"
                   hint={d.summary.total === 0
                     ? 'No children yet. Add a family, or bring your list in from Import.'
                     : 'Try a different filter.'} />
          ) : (
            <ul>
              {rows.map((r) => {
                const v = VERDICT[r.verdict];
                return (
                  <li key={r.childId}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 last:border-b-0"
                      style={{ borderColor: 'var(--line)' }}>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <strong className="text-[13px]">{r.name}</strong>
                        <Badge tone={v.tone}>{v.label}</Badge>
                        {r.ageLabel && (
                          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                            {r.ageLabel}
                          </span>
                        )}
                      </span>
                      <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        {r.reason}
                      </span>
                      <Link to={`/families/${r.familyId}`}
                            className="text-[11px] underline" style={{ color: 'var(--text-faint)' }}>
                        {r.familyName}
                      </Link>
                    </span>

                    <span className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <Badge tone="neutral">{r.currentRoom ?? 'no room'}</Badge>
                      {r.verdict !== 'correct' && r.shouldBeRoom && (
                        <>
                          <span aria-hidden style={{ color: 'var(--text-faint)' }}>&rarr;</span>
                          <Badge tone="ok">{r.shouldBeRoom}</Badge>
                        </>
                      )}
                    </span>

                    {canMove && (
                      <span className="flex flex-wrap items-center gap-2">
                        {r.shouldBeRoomId && r.verdict !== 'correct' && (
                          <Button size="sm" variant="primary" disabled={busy === r.childId}
                                  onClick={() => setPending({
                                    row: r, roomId: r.shouldBeRoomId!,
                                    roomName: r.shouldBeRoom ?? 'that room',
                                  })}>
                            Put in {r.shouldBeRoom}
                          </Button>
                        )}
                        {/* Any child, any room. A child moves for reasons this
                            screen cannot see - a friend, a key worker, a parent
                            asking - and refusing those means somebody keeps a
                            second list somewhere else. */}
                        <SelectInput
                          aria-label={`Move ${r.name} to a different room`}
                          value=""
                          disabled={busy === r.childId}
                          onChange={(e) => {
                            const room = (d?.rooms ?? []).find((x) => x.id === e.target.value);
                            if (room) setPending({ row: r, roomId: room.id, roomName: room.name });
                          }}
                          className="w-auto min-w-40 text-[12px]"
                        >
                          <option value="">Move to…</option>
                          {(d?.rooms ?? [])
                            .filter((room) => room.id !== r.currentRoomId)
                            .map((room) => (
                              <option key={room.id} value={room.id}>{room.name}</option>
                            ))}
                        </SelectInput>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      )}

      {pending && (
        <MoveDialog
          row={pending.row}
          roomName={pending.roomName}
          room={(d?.rooms ?? []).find((x) => x.id === pending.roomId) ?? null}
          busy={busy === pending.row.childId}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmMove(pending.row, pending.roomId, pending.roomName)}
        />
      )}

      {d && (d.summary.noBirthday > 0 || d.summary.noRoomForAge > 0) && (
        <Panel title="Why some children cannot be placed">
          <ul className="flex flex-col gap-2 text-[13px]">
            {d.summary.noBirthday > 0 && (
              <li>
                <strong>{d.summary.noBirthday}</strong> {d.summary.noBirthday === 1 ? 'child has' : 'children have'}{' '}
                no date of birth recorded. Their age cannot be worked out, and guessing
                which room a child belongs in is exactly the wrong thing to guess. Add
                the birthday on the family page and they will appear here.
              </li>
            )}
            {d.summary.noRoomForAge > 0 && (
              <li>
                <strong>{d.summary.noRoomForAge}</strong> {d.summary.noRoomForAge === 1 ? 'child is' : 'children are'}{' '}
                outside every age range you have set. Either the centre does not run a
                room for that age, or a program is missing its age range — you can set
                one on the Register, under Rooms and ratios.
              </li>
            )}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/**
 * "Move this child?" - the question that was missing.
 *
 * It names the child, the room they are leaving and the room they are going
 * to, because the mistake being prevented is pressing the button on the row
 * above or below the one you meant. Free places are shown so the decision is
 * made with the room's numbers in front of you rather than after the fact.
 */
function MoveDialog(
  { row, roomName, room, busy, onCancel, onConfirm }:
  { row: Row; roomName: string; room: RoomOption | null; busy: boolean;
    onCancel: () => void; onConfirm: () => void },
) {
  const free = room?.capacity == null ? null : Math.max(0, room.capacity - room.enrolled);
  return (
    <Modal
      title={`Move ${row.name}?`}
      description="Nothing has changed yet."
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={onConfirm}>
            {busy ? 'Moving…' : `Yes, move to ${roomName}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{row.currentRoom ?? 'no room'}</Badge>
          <span aria-hidden style={{ color: 'var(--text-faint)' }}>&rarr;</span>
          <Badge tone="ok">{roomName}</Badge>
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          {row.name} is {row.ageLabel ?? 'of unknown age'}
          {row.familyName ? `, from the ${row.familyName}` : ''}.
        </p>
        <p style={{ color: 'var(--text-muted)' }}>
          {free === null
            ? <>Nobody has set a capacity for {roomName}, so free places are{' '}
                <NotMeasured why="No capacity recorded for that room or its age group" />.</>
            : free === 0
              ? <strong style={{ color: 'var(--color-warn-600)' }}>
                  {roomName} is already full. You can still move them, but check the ratio.
                </strong>
              : <>{roomName} has {free} place{free === 1 ? '' : 's'} free.</>}
        </p>
      </div>
    </Modal>
  );
}
