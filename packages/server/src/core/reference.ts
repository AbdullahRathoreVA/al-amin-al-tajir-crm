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
export const PROGRAMS: [string, string, string][] = [
  ['twinkle-stars', 'Twinkle Stars', '12-18 months'],
  ['comet-stars', 'Comet Stars', '18 months - 3 years'],
  ['nova-stars', 'Nova Stars', '3-5 years'],
  ['galaxy-stars', 'Galaxy Stars', '5-6 years'],
  ['cosmic-stars', 'Cosmic Stars', '6-12 years'],
  ['learning-adventures', 'Learning Adventures', 'Ages 2-5'],
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

  for (const [i, [slug, name, age]] of PROGRAMS.entries()) {
    if (one('SELECT id FROM programs WHERE slug = ?', slug)) continue;
    run(`INSERT INTO programs (id, slug, name, age_label, capacity, active, sort_order, created_at)
         VALUES (?,?,?,?,NULL,1,?,?)`, newId(), slug, name, age, i * 10, now);
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
