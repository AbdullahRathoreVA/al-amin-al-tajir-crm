/**
 * Children grow, and the CRM has to notice.
 *
 * Two different jobs, and the difference between them is the whole design:
 *
 *   1. An age band is a FACT about a date of birth. A child who turned three
 *      last Tuesday is in the "3-5 years" band whether or not anyone updated a
 *      row. So the band is recomputed on a schedule and simply corrected.
 *
 *   2. A room is a DECISION. Moving a child depends on space, on ratios, on
 *      which educator they have settled with, and on their parents. So this
 *      never moves anybody. It finds the children whose room no longer matches
 *      their age, says which room fits and why, and leaves the move to a person
 *      who can see the rest.
 *
 * Getting that backwards is how a CRM quietly reshuffles a nursery overnight
 * and nobody can say who decided it.
 */
import { one, many, run } from '../db/index.ts';
import { nowIso, plainAll } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { ageBandFor, monthsBetween, reindexChild } from './people.ts';

const SYSTEM: Actor = { type: 'system', id: null, source: 'schedule' };

// ------------------------------------------------------------- age bands

export interface BandChange {
  childId: string;
  name: string;
  from: string | null;
  to: string | null;
}

/**
 * Recomputes every enrolled or prospective child's age band from their date of
 * birth, and corrects the ones that have drifted.
 *
 * Only children with a date of birth are touched. A band somebody typed by hand
 * on a child with no birthday is the best information there is, and overwriting
 * it with a guess would be worse than leaving it.
 */
export function refreshAgeBands(actor: Actor = SYSTEM, at = new Date()): BandChange[] {
  const rows = many<{ id: string; first_name: string; date_of_birth: string; age_band: string | null }>(
    `SELECT id, first_name, date_of_birth, age_band
       FROM children
      WHERE date_of_birth IS NOT NULL AND status <> 'withdrawn'`);

  const changed: BandChange[] = [];
  for (const c of rows) {
    const band = ageBandFor(c.date_of_birth, at);
    // null means "older than any band we have". That is not a reason to wipe a
    // band that is already recorded.
    if (band === null || band === c.age_band) continue;

    run('UPDATE children SET age_band = ?, updated_at = ? WHERE id = ?', band, nowIso(), c.id);
    recordEvent({
      entityType: 'child', entityId: c.id, type: 'updated', actor,
      summary: `${c.first_name} moved from ${c.age_band ?? 'no age group'} to ${band}`,
      before: { age_band: c.age_band },
      after: { age_band: band },
    });
    reindexChild(c.id);
    changed.push({ childId: c.id, name: c.first_name, from: c.age_band, to: band });
  }
  return changed;
}

// ------------------------------------------------------------ progression

export interface Outgrown {
  childId: string;
  name: string;
  familyId: string;
  familyName: string;
  ageMonths: number;
  ageLabel: string;
  currentProgramId: string | null;
  currentProgram: string | null;
  suggestedProgramId: string | null;
  suggestedProgram: string | null;
  /** The actual room to move them into. Null when the program has no open
   *  room yet, which is a real answer and not the same as "no program fits". */
  suggestedClassroomId: string | null;
  suggestedClassroom: string | null;
  /** Free places in the suggested room, or null when nobody has set a capacity. */
  suggestedSpace: number | null;
  reason: string;
}

interface ProgramRow {
  id: string; name: string; min_months: number | null; max_months: number | null;
  age_ladder: number; capacity: number | null;
}

export const monthsLabel = (m: number): string =>
  m < 24 ? `${m} month${m === 1 ? '' : 's'}` : `${Math.floor(m / 12)} years`;

/**
 * Children who have aged past the room they are in.
 *
 * Deliberately conservative:
 *   - only children with a real date of birth. A band alone is not precise
 *     enough to move a child on.
 *   - only enrolled children. A prospective child has not been placed yet, so
 *     there is nothing to have outgrown.
 *   - only programs with bounds set, and only rungs on the ladder. A program
 *     nobody has given an age range to is left alone rather than guessed at.
 *   - a child with no room at all is not "outgrown", they are unplaced, which
 *     the register already reports separately.
 */
export function outgrown(at = new Date()): Outgrown[] {
  const programs = many<ProgramRow>(
    `SELECT id, name, min_months, max_months, age_ladder, capacity
       FROM programs WHERE active = 1`);
  const byId = new Map(programs.map((p) => [p.id, p]));

  const ladder = programs
    .filter((p) => p.age_ladder === 1 && p.min_months !== null && p.max_months !== null)
    .sort((a, b) => (a.min_months ?? 0) - (b.min_months ?? 0));
  if (!ladder.length) return [];

  /**
   * The emptiest open room in a program, and how much space is left in it.
   *
   * Emptiest rather than first so a move does not pile every child into one
   * room while another sits half empty. A room with no capacity set sorts last:
   * it may well have space, but "unknown" should not beat a room that is
   * measured and known to be free.
   */
  const roomFor = (programId: string) => {
    const rooms = many<{ id: string; name: string; capacity: number | null; taken: number }>(
      `SELECT r.id, r.name, r.capacity,
              (SELECT COUNT(*) FROM children ch
                WHERE ch.classroom_id = r.id AND ch.status = 'enrolled') AS taken
         FROM classrooms r
        WHERE r.program_id = ? AND r.active = 1`, programId);
    if (!rooms.length) return null;
    const scored = rooms.map((r) => ({
      ...r, space: r.capacity == null ? null : Math.max(0, r.capacity - r.taken),
    }));
    scored.sort((a, b) =>
      (b.space ?? -1) - (a.space ?? -1) || a.name.localeCompare(b.name));
    return scored[0]!;
  };

  const rows = many<{
    id: string; first_name: string; last_name: string | null; date_of_birth: string;
    program_id: string | null; room_program_id: string | null;
    family_id: string; family_name: string;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.program_id,
            r.program_id AS room_program_id,
            c.family_id, f.name AS family_name
       FROM children c
       JOIN families f ON f.id = c.family_id
       LEFT JOIN classrooms r ON r.id = c.classroom_id
      WHERE c.date_of_birth IS NOT NULL
        AND c.status = 'enrolled'
        AND (c.program_id IS NOT NULL OR r.program_id IS NOT NULL)`);

  const out: Outgrown[] = [];
  for (const c of rows) {
    // The room a child sits in every morning is the truth about where they
    // are; `children.program_id` is what somebody recorded. Prefer the room.
    const current = byId.get(c.room_program_id ?? c.program_id!);
    // A room with no age range set is not evidence of anything.
    if (!current || current.age_ladder !== 1 || current.max_months === null) continue;

    const months = monthsBetween(c.date_of_birth, at);
    if (months === null || months < current.max_months) continue;

    const fits = ladder.find((p) =>
      months >= (p.min_months ?? 0) && months < (p.max_months ?? Number.MAX_SAFE_INTEGER));
    const room = fits ? roomFor(fits.id) : null;

    out.push({
      childId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      familyId: c.family_id,
      familyName: c.family_name,
      ageMonths: months,
      ageLabel: monthsLabel(months),
      currentProgramId: current.id,
      currentProgram: current.name,
      suggestedProgramId: fits?.id ?? null,
      suggestedProgram: fits?.name ?? null,
      suggestedClassroomId: room?.id ?? null,
      suggestedClassroom: room?.name ?? null,
      suggestedSpace: room?.space ?? null,
      reason: !fits
        ? `${monthsLabel(months)} old, past ${current.name}, and no room here covers that age`
        : room
          ? `${monthsLabel(months)} old, and ${current.name} runs to ${monthsLabel(current.max_months)}`
          : `${monthsLabel(months)} old, and ${fits.name} fits — but it has no open room yet`,
    });
  }

  // Oldest first: the child who has been in the wrong room longest.
  return out.sort((a, b) => b.ageMonths - a.ageMonths);
}

// -------------------------------------------------------------- birthdays

export interface Birthday {
  childId: string; name: string; familyId: string; familyName: string;
  date: string; turning: number; inDays: number;
}

/**
 * Birthdays in the next `days` days.
 *
 * Compared on month and day so it does not matter which year they were born,
 * and it wraps across the end of the year, which a naive date comparison gets
 * wrong every December.
 */
export function upcomingBirthdays(days = 14, at = new Date()): Birthday[] {
  const rows = many<{
    id: string; first_name: string; last_name: string | null; date_of_birth: string;
    family_id: string; family_name: string;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.family_id, f.name AS family_name
       FROM children c JOIN families f ON f.id = c.family_id
      WHERE c.date_of_birth IS NOT NULL AND c.status IN ('enrolled','offered')`);

  const out: Birthday[] = [];
  const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

  for (const c of rows) {
    const dob = new Date(c.date_of_birth);
    if (Number.isNaN(dob.getTime())) continue;

    let next = new Date(Date.UTC(today.getUTCFullYear(), dob.getUTCMonth(), dob.getUTCDate()));
    if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, dob.getUTCMonth(), dob.getUTCDate()));

    const inDays = Math.round((next.getTime() - today.getTime()) / 86_400_000);
    if (inDays > days) continue;

    out.push({
      childId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      familyId: c.family_id,
      familyName: c.family_name,
      date: next.toISOString().slice(0, 10),
      turning: next.getUTCFullYear() - dob.getUTCFullYear(),
      inDays,
    });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

/** Everything the progression screen needs, in one read. */
export function progressionSummary(at = new Date()) {
  const moves = outgrown(at);
  return {
    outgrown: plainAll(moves as unknown as Record<string, unknown>[]),
    birthdays: plainAll(upcomingBirthdays(14, at) as unknown as Record<string, unknown>[]),
    /** Programs still missing an age range, so the gap is visible rather than
     *  silently narrowing what the view can see. */
    programsWithoutAges: plainAll(many(
      `SELECT id, name FROM programs
        WHERE active = 1 AND age_ladder = 1 AND (min_months IS NULL OR max_months IS NULL)
        ORDER BY sort_order`)),
  };
}

/**
 * The scheduled sweep. Bands are corrected; rooms are only ever reported.
 * Returns what changed so boot and the scheduler can log something truthful.
 */
export function runDailyAgeSweep(at = new Date()): { bands: number; outgrown: number } {
  const bands = refreshAgeBands(SYSTEM, at);
  return { bands: bands.length, outgrown: outgrown(at).length };
}

// -------------------------------------------------------------- scheduler

let timer: NodeJS.Timeout | null = null;

/**
 * Runs the sweep on boot and then daily.
 *
 * On boot as well as on the interval, because a machine that is restarted every
 * morning would otherwise never reach the first tick, and the bands would drift
 * exactly on the installations that restart most.
 */
export function startAgeSchedule(intervalHours = 24): void {
  const tick = () => {
    try {
      const { bands, outgrown: n } = runDailyAgeSweep();
      if (bands > 0) console.log(`[crm] ages     ${bands} child age group(s) updated`);
      if (n > 0) console.log(`[crm] ages      ${n} child(ren) have outgrown their room`);
    } catch (err) {
      console.error('[crm] age sweep failed:', err instanceof Error ? err.message : err);
    }
  };
  tick();
  timer = setInterval(tick, intervalHours * 3_600_000);
  timer.unref();
}

export function stopAgeSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

// ------------------------------------------------------- the whole picture

export interface PlacementRow {
  childId: string; name: string; familyId: string; familyName: string;
  status: string;
  dateOfBirth: string | null;
  ageMonths: number | null;
  ageLabel: string | null;
  currentRoomId: string | null; currentRoom: string | null;
  shouldBeProgramId: string | null; shouldBeProgram: string | null;
  shouldBeRoomId: string | null; shouldBeRoom: string | null;
  /** What a person has to do about this child, if anything. */
  verdict: 'correct' | 'move' | 'unplaced' | 'no-room-for-age' | 'no-birthday';
  reason: string;
}

/**
 * Every child, and the room their age says they belong in.
 *
 * `outgrown()` answers a narrower question — who has aged past their room —
 * and is what the register needs. This answers the question somebody actually
 * asks when they open a spreadsheet of children: for each of these, where do
 * they go? So it includes children with no room at all, children with no
 * birthday recorded, and children who are already in the right place, because
 * "everyone is fine" is only believable if the ones who are fine are shown.
 */
export function placementPlan(at = new Date()): PlacementRow[] {
  const programs = many<ProgramRow>(
    `SELECT id, name, min_months, max_months, age_ladder, capacity FROM programs WHERE active = 1`);
  const ladder = programs
    .filter((p) => p.age_ladder === 1 && p.min_months !== null && p.max_months !== null)
    .sort((a, b) => (a.min_months ?? 0) - (b.min_months ?? 0));

  const rooms = many<{ id: string; name: string; program_id: string | null; capacity: number | null; taken: number }>(
    `SELECT r.id, r.name, r.program_id, r.capacity,
            (SELECT COUNT(*) FROM children ch WHERE ch.classroom_id = r.id AND ch.status = 'enrolled') AS taken
       FROM classrooms r WHERE r.active = 1`);

  const roomFor = (programId: string) => {
    const opts = rooms.filter((r) => r.program_id === programId)
      .map((r) => ({ ...r, space: r.capacity == null ? null : Math.max(0, r.capacity - r.taken) }))
      .sort((a, b) => (b.space ?? -1) - (a.space ?? -1) || a.name.localeCompare(b.name));
    return opts[0] ?? null;
  };

  const children = many<{
    id: string; first_name: string; last_name: string | null; date_of_birth: string | null;
    status: string; classroom_id: string | null; family_id: string; family_name: string;
    room_name: string | null;
  }>(
    `SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.status, c.classroom_id,
            c.family_id, f.name AS family_name, r.name AS room_name
       FROM children c
       JOIN families f ON f.id = c.family_id
       LEFT JOIN classrooms r ON r.id = c.classroom_id
      WHERE c.status <> 'withdrawn'
      ORDER BY f.name, c.first_name`);

  return children.map((c): PlacementRow => {
    const months = c.date_of_birth ? monthsBetween(c.date_of_birth, at) : null;
    const base = {
      childId: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      familyId: c.family_id, familyName: c.family_name,
      status: c.status,
      dateOfBirth: c.date_of_birth,
      ageMonths: months,
      ageLabel: months === null || months < 0 ? null : monthsLabel(months),
      currentRoomId: c.classroom_id, currentRoom: c.room_name,
    };

    // Without a birthday there is nothing to reason from, and a guess about
    // which room a child belongs in is exactly the wrong thing to guess.
    if (months === null || months < 0) {
      return { ...base, shouldBeProgramId: null, shouldBeProgram: null,
        shouldBeRoomId: null, shouldBeRoom: null,
        verdict: 'no-birthday',
        reason: 'No date of birth recorded, so their age group cannot be worked out.' };
    }

    const fits = ladder.find((p) =>
      months >= (p.min_months ?? 0) && months < (p.max_months ?? Number.MAX_SAFE_INTEGER));
    if (!fits) {
      return { ...base, shouldBeProgramId: null, shouldBeProgram: null,
        shouldBeRoomId: null, shouldBeRoom: null,
        verdict: 'no-room-for-age',
        reason: `${monthsLabel(months)} old, and no room here covers that age.` };
    }

    const target = roomFor(fits.id);
    const inRightPlace = c.classroom_id
      && rooms.find((r) => r.id === c.classroom_id)?.program_id === fits.id;

    const shape = {
      ...base,
      shouldBeProgramId: fits.id, shouldBeProgram: fits.name,
      shouldBeRoomId: target?.id ?? null, shouldBeRoom: target?.name ?? null,
    };

    if (inRightPlace) {
      return { ...shape, verdict: 'correct',
        reason: `${monthsLabel(months)} old — ${fits.name} is the right group.` };
    }
    if (!c.classroom_id) {
      return { ...shape, verdict: 'unplaced',
        reason: `${monthsLabel(months)} old — belongs in ${fits.name}, but has no room yet.` };
    }
    return { ...shape, verdict: 'move',
      reason: `${monthsLabel(months)} old — in ${c.room_name}, but ${fits.name} fits their age.` };
  });
}
