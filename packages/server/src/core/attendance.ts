/**
 * Attendance and classrooms.
 *
 * The register is the first thing here that records what happened to a child
 * rather than how their family enquired, so two rules run through all of it:
 *
 *   Scope before query. `visibleClassroomIds()` is consulted first and every
 *   read is filtered by it. An educator assigned to no room sees nobody, which
 *   is the correct answer rather than an edge case to paper over.
 *
 *   Never invent a number. A room with no ratio rule reports `measured: false`
 *   rather than a comfortable-looking ratio nobody configured, and a room with
 *   no staff assigned reports that too instead of dividing by zero.
 */
import { one, many, run, tx } from '../db/index.ts';
import { newId, nowIso, plain, plainAll } from './util.ts';
import { recordEvent, logAccess, type Actor } from './events.ts';
import { canSeeSensitive, type User } from './auth.ts';

export type AttendanceStatus =
  'expected' | 'present' | 'absent' | 'late' | 'excused' | 'left_early';

/** The local calendar day. Not derived from a timestamp — see the migration. */
export function today(): string { return nowIso().slice(0, 10); }

export function isDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** Thrown for a refusal a person should read, rather than a 500. */
export class AttendanceError extends Error {}

// ------------------------------------------------------------------- scope

/**
 * Which classrooms this user may see.
 *
 * `null` means "every room" and is not the same as an empty array, which means
 * "no rooms at all". Collapsing the two would turn an unassigned educator into
 * an administrator, so callers must branch on it rather than treat a falsy
 * value as permissive.
 */
export function visibleClassroomIds(user: User): string[] | null {
  if (user.role !== 'educator') return null;
  return many<{ classroom_id: string }>(
    'SELECT classroom_id FROM classroom_staff WHERE user_id = ?', user.id,
  ).map((r) => r.classroom_id);
}

/** True when this user may act on this room at all. */
export function mayTouchClassroom(user: User, classroomId: string | null): boolean {
  const scope = visibleClassroomIds(user);
  if (scope === null) return true;
  if (!classroomId) return false; // an unassigned child belongs to no educator
  return scope.includes(classroomId);
}

/** Renders a scope as a SQL fragment plus params, or null for "no filter". */
function scopeClause(user: User, column: string): { sql: string; params: string[] } | null {
  const scope = visibleClassroomIds(user);
  if (scope === null) return null;
  if (!scope.length) return { sql: '0 = 1', params: [] }; // no room, no rows
  return { sql: `${column} IN (${scope.map(() => '?').join(',')})`, params: scope };
}

// -------------------------------------------------------------- classrooms

export function listClassrooms(user: User): Record<string, unknown>[] {
  const scope = scopeClause(user, 'c.id');
  const where = ['c.active = 1'];
  const params: string[] = [];
  if (scope) { where.push(scope.sql); params.push(...scope.params); }

  return plainAll(many<Record<string, unknown>>(
    `SELECT c.id, c.name, c.capacity, c.program_id, p.name AS program_name,
            (SELECT COUNT(*) FROM children ch WHERE ch.classroom_id = c.id
              AND ch.status = 'enrolled')                                        AS enrolled,
            (SELECT COUNT(*) FROM classroom_staff s WHERE s.classroom_id = c.id) AS staff
       FROM classrooms c
       LEFT JOIN programs p ON p.id = c.program_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.name`, ...params));
}

export function assignStaff(
  classroomId: string, userId: string, role: string, actor: Actor,
): string {
  const id = newId();
  tx(() => {
    run(`INSERT INTO classroom_staff (id, classroom_id, user_id, role, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(classroom_id, user_id) DO UPDATE SET role = excluded.role`,
      id, classroomId, userId, role, nowIso());
    const who = one<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
    const room = one<{ name: string }>('SELECT name FROM classrooms WHERE id = ?', classroomId);
    recordEvent({
      entityType: 'classroom', entityId: classroomId, type: 'staff_assigned', actor,
      // This changes what a person can see, so the log says so in those terms.
      summary: `${who?.name ?? 'A user'} assigned to ${room?.name ?? 'a room'} as ${role}, `
             + `and can now see its register`,
      before: null, after: { userId, role },
    });
  });
  return id;
}

export function unassignStaff(classroomId: string, userId: string, actor: Actor): boolean {
  const existing = one<{ id: string }>(
    'SELECT id FROM classroom_staff WHERE classroom_id = ? AND user_id = ?', classroomId, userId);
  if (!existing) return false;
  tx(() => {
    run('DELETE FROM classroom_staff WHERE classroom_id = ? AND user_id = ?', classroomId, userId);
    const who = one<{ name: string }>('SELECT name FROM users WHERE id = ?', userId);
    const room = one<{ name: string }>('SELECT name FROM classrooms WHERE id = ?', classroomId);
    recordEvent({
      entityType: 'classroom', entityId: classroomId, type: 'staff_unassigned', actor,
      summary: `${who?.name ?? 'A user'} removed from ${room?.name ?? 'a room'} `
             + `and can no longer see its register`,
      before: { userId }, after: null,
    });
  });
  return true;
}

export function staffFor(classroomId: string): Record<string, unknown>[] {
  return plainAll(many<Record<string, unknown>>(
    `SELECT s.user_id, s.role, u.name, u.email
       FROM classroom_staff s JOIN users u ON u.id = s.user_id
      WHERE s.classroom_id = ? ORDER BY s.role, u.name`, classroomId));
}

// ------------------------------------------------------------- the register

/**
 * The day's register for every child this user may see.
 *
 * Children with no row yet appear as `expected` rather than being missing from
 * the list: a register that only lists children someone already ticked is not
 * a register.
 */
export function register(user: User, day: string, classroomId?: string): Record<string, unknown>[] {
  const scope = scopeClause(user, 'ch.classroom_id');
  const where = [`ch.status = 'enrolled'`];
  const params: string[] = [day];
  if (scope) { where.push(scope.sql); params.push(...scope.params); }
  if (classroomId) { where.push('ch.classroom_id = ?'); params.push(classroomId); }

  const rows = plainAll(many<Record<string, unknown>>(
    `SELECT ch.id AS child_id, ch.first_name, ch.last_name, ch.date_of_birth, ch.age_band,
            ch.classroom_id, cl.name AS classroom_name,
            f.id AS family_id, f.name AS family_name,
            a.id AS attendance_id,
            COALESCE(a.status, 'expected') AS status,
            a.checked_in_at, a.checked_out_at, a.released_to, a.note
       FROM children ch
       JOIN families f ON f.id = ch.family_id
       LEFT JOIN classrooms cl ON cl.id = ch.classroom_id
       LEFT JOIN attendance a ON a.child_id = ch.id AND a.day = ?
      WHERE ${where.join(' AND ')}
      ORDER BY cl.name, ch.first_name`, ...params));

  // Same rule as every other child read: a role without child:read_sensitive
  // gets the column removed, not blanked. (spec 27)
  if (!canSeeSensitive(user)) for (const r of rows) delete r.date_of_birth;
  return rows;
}

export interface MarkInput {
  childId: string;
  day: string;
  status: AttendanceStatus;
  at?: string;
  releasedTo?: string;
  note?: string;
}

const isArrival = (s: AttendanceStatus) => s === 'present' || s === 'late';
const isDeparture = (s: AttendanceStatus) => s === 'left_early';

export function mark(user: User, actor: Actor, input: MarkInput): Record<string, unknown> {
  const child = one<{ id: string; first_name: string; classroom_id: string | null }>(
    'SELECT id, first_name, classroom_id FROM children WHERE id = ?', input.childId);
  if (!child) throw new AttendanceError('No such child');
  if (!mayTouchClassroom(user, child.classroom_id)) {
    throw new AttendanceError('That child is not in a room you are assigned to');
  }

  // Leaving means somebody took them. checkOut() is the way to record that,
  // because it is the path that insists on a name.
  if (isDeparture(input.status) && !input.releasedTo?.trim()) {
    throw new AttendanceError('Record who collected the child before marking them as left');
  }

  const now = input.at ?? nowIso();
  const existing = plain(one<Record<string, unknown>>(
    'SELECT * FROM attendance WHERE child_id = ? AND day = ?', input.childId, input.day));

  let result!: Record<string, unknown>;
  tx(() => {
    if (!existing) {
      run(`INSERT INTO attendance (id, child_id, classroom_id, day, status, checked_in_at,
             checked_in_by, checked_out_at, checked_out_by, released_to, note, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId(), input.childId, child.classroom_id, input.day, input.status,
        isArrival(input.status) ? now : null, isArrival(input.status) ? user.id : null,
        isDeparture(input.status) ? now : null, isDeparture(input.status) ? user.id : null,
        input.releasedTo ?? null, input.note ?? null, now, now);
    } else {
      const arriving = isArrival(input.status) && !existing.checked_in_at;
      const leaving = isDeparture(input.status) && !existing.checked_out_at;
      run(`UPDATE attendance
              SET status = ?,
                  checked_in_at  = COALESCE(checked_in_at, ?),
                  checked_in_by  = COALESCE(checked_in_by, ?),
                  checked_out_at = COALESCE(checked_out_at, ?),
                  checked_out_by = COALESCE(checked_out_by, ?),
                  released_to    = COALESCE(?, released_to),
                  note           = COALESCE(?, note),
                  updated_at     = ?
            WHERE id = ?`,
        input.status,
        arriving ? now : null, arriving ? user.id : null,
        leaving ? now : null, leaving ? user.id : null,
        input.releasedTo ?? null, input.note ?? null, now, String(existing.id));
    }

    result = plain(one<Record<string, unknown>>(
      'SELECT * FROM attendance WHERE child_id = ? AND day = ?', input.childId, input.day))!;

    recordEvent({
      entityType: 'child', entityId: input.childId, type: 'attendance_marked', actor,
      summary: summarise(child.first_name, input.status, result),
      before: existing, after: result,
    });
  });
  return result;
}

function summarise(
  name: string, status: AttendanceStatus, row: Record<string, unknown>,
): string {
  const when = (v: unknown) => (typeof v === 'string' ? v.slice(11, 16) : 'an unrecorded time');
  switch (status) {
    case 'present':    return `${name} checked in at ${when(row.checked_in_at)}`;
    case 'late':       return `${name} arrived late, at ${when(row.checked_in_at)}`;
    case 'absent':     return `${name} marked absent${row.note ? `: ${String(row.note)}` : ''}`;
    case 'excused':    return `${name} excused${row.note ? `: ${String(row.note)}` : ''}`;
    case 'left_early': return `${name} collected early at ${when(row.checked_out_at)} `
                            + `by ${String(row.released_to ?? 'someone unrecorded')}`;
    default:           return `${name} marked ${status}`;
  }
}

/**
 * Check a child out at the end of the day.
 *
 * Separate from mark() because it has a requirement mark() does not: somebody's
 * name. "Who collected them" is the question asked after something goes wrong,
 * and a blank there is indistinguishable from a forgotten answer.
 */
export function checkOut(
  user: User, actor: Actor, childId: string, day: string, releasedTo: string, at?: string,
): Record<string, unknown> {
  const who = releasedTo.trim();
  if (!who) throw new AttendanceError('Record who collected the child before checking them out');

  const child = one<{ id: string; first_name: string; classroom_id: string | null }>(
    'SELECT id, first_name, classroom_id FROM children WHERE id = ?', childId);
  if (!child) throw new AttendanceError('No such child');
  if (!mayTouchClassroom(user, child.classroom_id)) {
    throw new AttendanceError('That child is not in a room you are assigned to');
  }

  const existing = plain(one<Record<string, unknown>>(
    'SELECT * FROM attendance WHERE child_id = ? AND day = ?', childId, day));
  if (!existing) throw new AttendanceError(`${child.first_name} has not been checked in today`);
  if (existing.checked_out_at) {
    throw new AttendanceError(
      `${child.first_name} was already collected at ${String(existing.checked_out_at).slice(11, 16)}`);
  }

  const now = at ?? nowIso();
  let result!: Record<string, unknown>;
  tx(() => {
    run(`UPDATE attendance
            SET checked_out_at = ?, checked_out_by = ?, released_to = ?,
                status = CASE WHEN status = 'expected' THEN 'present' ELSE status END,
                updated_at = ?
          WHERE id = ?`, now, user.id, who, now, String(existing.id));
    result = plain(one<Record<string, unknown>>(
      'SELECT * FROM attendance WHERE id = ?', String(existing.id)))!;
    recordEvent({
      entityType: 'child', entityId: childId, type: 'checked_out', actor,
      summary: `${child.first_name} collected at ${now.slice(11, 16)} by ${who}`,
      before: existing, after: result,
    });
  });
  return result;
}

// ------------------------------------------------------------------ ratios

export interface RoomStanding {
  classroomId: string;
  classroomName: string;
  present: number;
  staffOnShift: number;
  /** False when no ratio rule is configured, or no staff are assigned. */
  measured: boolean;
  requiredPerStaff: number | null;
  /** Only meaningful while measured is true. */
  withinRatio: boolean | null;
  note: string | null;
}

/**
 * Who is in each room, against the required ratio.
 *
 * Every unmeasurable case returns `measured: false` with the reason, because a
 * ratio panel showing a green tick for a room nobody configured is worse than
 * one admitting it does not know.
 */
export function roomStandings(user: User, day: string): RoomStanding[] {
  const scope = scopeClause(user, 'c.id');
  const where = ['c.active = 1'];
  const params: string[] = [day];
  if (scope) { where.push(scope.sql); params.push(...scope.params); }

  const rows = many<{
    id: string; name: string; present: number; staff: number; required: number | null;
  }>(`SELECT c.id, c.name,
             (SELECT COUNT(*) FROM attendance a
               WHERE a.classroom_id = c.id AND a.day = ?
                 AND a.status IN ('present','late') AND a.checked_out_at IS NULL) AS present,
             (SELECT COUNT(*) FROM classroom_staff s WHERE s.classroom_id = c.id) AS staff,
             (SELECT r.children_per_staff FROM ratio_rules r
               WHERE r.program_id = c.program_id)                                 AS required
        FROM classrooms c
       WHERE ${where.join(' AND ')}
       ORDER BY c.name`, ...params);

  return rows.map((r) => {
    const base = {
      classroomId: r.id, classroomName: r.name, present: r.present, staffOnShift: r.staff,
    };
    if (r.required === null) {
      return {
        ...base, measured: false, requiredPerStaff: null, withinRatio: null,
        note: 'No ratio is configured for this program, so this is not measured.',
      };
    }
    if (r.staff === 0) {
      return {
        ...base, measured: false, requiredPerStaff: r.required, withinRatio: null,
        note: 'Nobody is assigned to this room, so the ratio cannot be worked out.',
      };
    }
    return {
      ...base, measured: true, requiredPerStaff: r.required,
      withinRatio: r.present <= r.staff * r.required, note: null,
    };
  });
}

/** A day's totals, for the dashboard. */
export function daySummary(user: User, day: string): Record<string, unknown> {
  const rows = register(user, day);
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return {
    day,
    expected: rows.length,
    present: count('present') + count('late'),
    absent: count('absent') + count('excused'),
    notYetMarked: count('expected'),
    stillIn: rows.filter(
      (r) => (r.status === 'present' || r.status === 'late') && !r.checked_out_at).length,
  };
}

/** Reading a register is reading about named children. Record that. */
export function logRegisterRead(user: User, day: string, classroomId?: string): void {
  logAccess(user.id, 'view_register', 'attendance', classroomId ?? day);
}
