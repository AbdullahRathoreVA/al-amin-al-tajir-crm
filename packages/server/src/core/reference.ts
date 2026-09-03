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
  // Starts at 0: the centre is allowed three under-12-month places and they
  // are in the Twinkle rooms. 28 licensed infant places plus those 3.
  ['twinkle-stars', 'Twinkle Stars', 'Under 12 months to 19 months', 0, 19, 1, 31],
  ['comet-stars', 'Comet Stars', '19-36 months', 19, 36, 1, 76],
  // Both pre-school ranges live in the Nova Stars rooms, so they are one rung
  // here: the poster's 46 places for 3-4 plus 54 for 4-5.
  ['nova-stars', 'Nova Stars', '3-5 years', 36, 60, 1, 100],
  // The poster gives Kindergarten age and out-of-school care ONE line, and the
  // roll agrees: five-year-olds and nine-year-olds share Galaxy Stars Map.
  ['galaxy-stars', 'Galaxy Stars', '5-6 years, and Grades 1-6 out of school care', 60, 144, 1, 74],
  // Still offered and still on the website, but not a rung: the children it
  // describes are in the Galaxy Stars room, whose range now covers them.
  ['cosmic-stars', 'Cosmic Stars', 'Grades 1-6 (out of school care)', 72, 144, 0, null],
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
