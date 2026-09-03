/**
 * Reference data: the lead stages and programs the CRM cannot operate without.
 *
 * This used to live in the demo seeder, which production correctly never runs.
 * The result was a fresh production install that accepted a registration, got
 * as far as creating the lead, and threw "No lead stages configured" — losing
 * the registration and telling the parent nothing was wrong. Found by posting a
 * real submission through the live website.
 *
 * Reference data is not demo data. It seeds at boot, in every mode, and only
 * inserts what is missing.
 */
import { one, run } from '../db/index.ts';
import { newId, nowIso } from './util.ts';

/** id, label, sort, is_open, is_won */
export const STAGES: [string, string, number, number, number][] = [
  ['new', 'New', 10, 1, 0],
  ['contacted', 'Contacted', 20, 1, 0],
  ['qualified', 'Qualified', 30, 1, 0],
  ['tour_requested', 'Tour requested', 40, 1, 0],
  ['tour_booked', 'Tour booked', 50, 1, 0],
  ['tour_completed', 'Tour completed', 60, 1, 0],
  ['application_started', 'Application started', 70, 1, 0],
  ['application_submitted', 'Application submitted', 80, 1, 0],
  ['waitlist', 'Waitlist', 90, 1, 0],
  ['offered', 'Offered', 100, 1, 0],
  ['enrolled', 'Enrolled', 110, 0, 1],
  ['lost', 'Lost', 120, 0, 0],
  ['unresponsive', 'Unresponsive', 130, 0, 0],
  ['cancelled', 'Cancelled', 140, 0, 0],
];

/**
 * Tiny Stars' real programs, matching the public website exactly so a parent
 * choosing "Comet Stars" lands on the same thing staff see.
 *
 * Capacity is deliberately null: nobody has told us what it is, and inventing
 * a number would make the occupancy figures fiction. The UI shows "not
 * measured" until somebody sets it.
 */
/**
 * slug, name, age label, min months (inclusive), max months (exclusive),
 * and whether the program is a rung on the normal progression.
 *
 * The months are what lets the CRM answer "who has outgrown their room?".
 * Learning Adventures spans ages 2 to 5 and deliberately overlaps three other
 * rooms, so it carries real bounds but sits out of the ladder — otherwise every
 * toddler would look misplaced. See migration 011.
 *
 * Tiny Stars has no infant room, so nothing here covers under 12 months.
 */
export const PROGRAMS: [string, string, string, number | null, number | null, number, number | null][] = [
  // slug, name, label, min months, max months (exclusive), on the ladder, capacity.
  //
  // These are the centre's LICENSED ranges, from its own capacity poster, not
  // a reading of the program names. The difference matters: 12-19 rather than
  // 12-18 is a whole month of children in or out of the infant room.
  //
  // Capacity is per licensed range because that is how the licence is written.
  // Rooms are left unmeasured rather than having 76 toddler places split three
  // ways by guesswork.
  ['twinkle-stars', 'Twinkle Stars', '12-19 months', 12, 19, 1, 28],
  ['comet-stars', 'Comet Stars', '19-36 months', 19, 36, 1, 76],
  ['nova-stars', 'Nova Stars', '3-4 years', 36, 48, 1, 46],
  // No room in the enrolment export serves this range. The program exists so
  // the ladder has no hole in it, and Ages & Rooms says plainly that the
  // children who fit it have nowhere to go yet.
  ['preschool-4-5', 'Pre-school (4-5)', '4-5 years', 48, 60, 1, 54],
  ['galaxy-stars', 'Galaxy Stars', '5-6 years', 60, 72, 1, 74],
  // The poster counts these places together with Kindergarten age, so the 74
  // above covers both and this stays unmeasured rather than invented.
  ['cosmic-stars', 'Cosmic Stars', 'Grades 1-6 (out of school care)', 72, 144, 1, null],
  ['learning-adventures', 'Learning Adventures', 'Ages 2-5', 24, 60, 0, null],
];

export function seedReference(): { stages: number; programs: number } {
  const now = nowIso();
  let stages = 0;
  let programs = 0;

  for (const [id, label, sort, open, won] of STAGES) {
    if (one('SELECT id FROM lead_stages WHERE id = ?', id)) continue;
    run('INSERT INTO lead_stages (id, label, sort_order, is_open, is_won) VALUES (?,?,?,?,?)',
      id, label, sort, open, won);
    stages++;
  }

  for (const [i, [slug, name, age, minM, maxM, ladder, cap]] of PROGRAMS.entries()) {
    if (one('SELECT id FROM programs WHERE slug = ?', slug)) continue;
    run(`INSERT INTO programs (id, slug, name, age_label, capacity, active, sort_order, created_at,
           min_months, max_months, age_ladder)
         VALUES (?,?,?,?,?,1,?,?,?,?,?)`,
      newId(), slug, name, age, cap, i * 10, now, minM, maxM, ladder);
    programs++;
  }

  return { stages, programs };
}

/** Boot check: the system genuinely cannot take a registration without these. */
export function referenceIsPresent(): { ok: boolean; stages: number; programs: number } {
  const stages = Number(one<{ n: number }>('SELECT COUNT(*) n FROM lead_stages')?.n ?? 0);
  const programs = Number(one<{ n: number }>('SELECT COUNT(*) n FROM programs')?.n ?? 0);
  return { ok: stages > 0, stages, programs };
}
