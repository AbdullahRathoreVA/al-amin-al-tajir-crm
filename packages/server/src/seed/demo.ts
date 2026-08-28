/**
 * DEMO SEED — every person in this file is invented.
 *
 * No real Tiny Stars family, child or educator appears here. Children are given
 * a first name and an age band only: no surnames, no dates of birth, no health
 * information. A demo of a childcare system should model good data hygiene
 * rather than just look full. (spec 224 / 346)
 *
 * Two programs are deliberately left with no capacity recorded, so the "not
 * measured" path in the UI is exercised by real data instead of assumed to work.
 */
import { connect, run, one, tx } from '../db/index.ts';
import { config } from '../core/config.ts';
import { seedReference as seedRef } from '../core/reference.ts';
import { migrateUp } from '../db/migrate.ts';
import { newId, nowIso } from '../core/util.ts';
import { hashPassword } from '../core/auth.ts';
import { reindexAll } from '../core/search.ts';
import { recordEvent, SYSTEM } from '../core/events.ts';
import { createTask, notify } from '../core/notify.ts';

const iso = (daysFromNow: number, hour = 10, minute = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

// STAGES, PROGRAMS and seedReference now live in core/reference.ts: they are
// reference data the CRM needs in production, not demo data.
export { seedReference } from '../core/reference.ts';

/** Demo staff accounts. Only ever created by this seeder, never at boot. */
const USERS: [string, string, string, string][] = [
  ['owner@demo.local', 'Amara Osei', 'owner', 'demo1234'],
  ['director@demo.local', 'Priya Raman', 'director', 'demo1234'],
  ['admissions@demo.local', 'Jonah Blake', 'admissions', 'demo1234'],
  ['educator@demo.local', 'Sofia Marchetti', 'educator', 'demo1234'],
];

function seedUsers(): string[] {
  const ids: string[] = [];
  for (const [email, name, role, password] of USERS) {
    const existing = one<{ id: string }>('SELECT id FROM users WHERE email = ?', email);
    if (existing) { ids.push(existing.id); continue; }
    const id = newId();
    run('INSERT INTO users (id, email, name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
      id, email, name, role, hashPassword(password), 'active', nowIso());
    ids.push(id);
  }
  return ids;
}

interface DemoFamily {
  surname: string;
  guardian: { first: string; email: string; phone: string; relationship: string };
  child: { first: string; band: string };
  program: string;
  stage: string;
  status: string;
  tour?: { whenDays: number; status: string };
  registration?: { status: 'incomplete' | 'submitted'; steps: number; total: number };
  nextAction?: { text: string; dueDays: number; reason: string };
  note?: string;
}

const FAMILIES: DemoFamily[] = [
  {
    surname: 'Okonkwo', guardian: { first: 'Ngozi', email: 'ngozi@example.invalid', phone: '416-555-0142', relationship: 'Parent' },
    child: { first: 'Chidi', band: '18 months - 3 years' }, program: 'Comet Stars',
    stage: 'application_submitted', status: 'applying',
    tour: { whenDays: -6, status: 'completed' },
    registration: { status: 'submitted', steps: 5, total: 5 },
    nextAction: { text: 'Review submitted registration', dueDays: -1, reason: 'Registration arrived and has not been reviewed' },
    note: 'Asked about the settling-in visit before the start date.',
  },
  {
    surname: 'Varga', guardian: { first: 'Katalin', email: 'katalin@example.invalid', phone: '647-555-0119', relationship: 'Parent' },
    child: { first: 'Emese', band: '3-5 years' }, program: 'Nova Stars',
    stage: 'tour_booked', status: 'touring',
    tour: { whenDays: 0, status: 'confirmed' },
    nextAction: { text: 'Confirm this morning tour', dueDays: 0, reason: 'Tour is today' },
  },
  {
    surname: 'Ferreira', guardian: { first: 'Rui', email: 'rui@example.invalid', phone: '905-555-0188', relationship: 'Parent' },
    child: { first: 'Beatriz', band: 'Under 12 months' }, program: 'Twinkle Stars',
    stage: 'application_started', status: 'applying',
    registration: { status: 'incomplete', steps: 2, total: 5 },
    nextAction: { text: 'Help the family finish their registration', dueDays: -3, reason: 'Registration stopped at step 2 of 5' },
    note: 'Stopped at the immunisation section. Might need the form explained.',
  },
  {
    surname: 'Haddad', guardian: { first: 'Layla', email: 'layla@example.invalid', phone: '416-555-0177', relationship: 'Guardian' },
    child: { first: 'Yusuf', band: '5-6 years' }, program: 'Galaxy Stars',
    stage: 'tour_requested', status: 'touring',
    tour: { whenDays: 2, status: 'requested' },
    nextAction: { text: 'Offer the family a tour time', dueDays: 0, reason: 'Tour requested and no time offered yet' },
  },
  {
    surname: 'Nakamura', guardian: { first: 'Hiro', email: 'hiro@example.invalid', phone: '289-555-0163', relationship: 'Parent' },
    child: { first: 'Aiko', band: '3-5 years' }, program: 'Nova Stars',
    stage: 'enrolled', status: 'enrolled',
    tour: { whenDays: -30, status: 'completed' },
    registration: { status: 'submitted', steps: 5, total: 5 },
    note: 'Second child. Older sibling attended in 2023.',
  },
  {
    surname: 'Silva', guardian: { first: 'Mariana', email: 'mariana@example.invalid', phone: '416-555-0155', relationship: 'Parent' },
    child: { first: 'Tomas', band: '6-12 years' }, program: 'Cosmic Stars',
    stage: 'waitlist', status: 'waitlisted',
    nextAction: { text: 'Check back about a September place', dueDays: 12, reason: 'Family is waiting on a place for September' },
  },
  {
    surname: 'Byrne', guardian: { first: 'Aoife', email: 'aoife@example.invalid', phone: '647-555-0131', relationship: 'Parent' },
    child: { first: 'Cillian', band: '12-18 months' }, program: 'Twinkle Stars',
    stage: 'contacted', status: 'prospective',
    nextAction: { text: 'Second follow-up call', dueDays: -8, reason: 'No reply to the first message' },
  },
  {
    surname: 'Mensah', guardian: { first: 'Kwame', email: 'kwame@example.invalid', phone: '905-555-0196', relationship: 'Parent' },
    child: { first: 'Ama', band: '18 months - 3 years' }, program: 'Comet Stars',
    stage: 'new', status: 'prospective',
    nextAction: { text: 'First contact', dueDays: 1, reason: 'New enquiry from the website' },
  },
];

function seedFamilies(userIds: string[]): void {
  const [ownerId, directorId, admissionsId] = userIds;
  const now = nowIso();

  for (const [i, f] of FAMILIES.entries()) {
    const familyId = newId();
    const createdAt = iso(-20 + i * 2, 9);
    const owner = [admissionsId, directorId, ownerId][i % 3] ?? null;

    run(`INSERT INTO families (id, name, status, owner_id, source, source_id, created_at, updated_at, created_by, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      familyId, `${f.surname} family`, f.status, owner, 'website', null, createdAt, now, null, null);

    run(`INSERT INTO guardians (id, family_id, first_name, last_name, relationship, email, phone,
           email_norm, phone_norm, is_primary, contact_pref, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      newId(), familyId, f.guardian.first, f.surname, f.guardian.relationship,
      f.guardian.email, f.guardian.phone, f.guardian.email.toLowerCase(),
      f.guardian.phone.replace(/[^\d]/g, '').slice(-10), 'either', createdAt, now);

    const programId = one<{ id: string }>('SELECT id FROM programs WHERE name = ?', f.program)?.id ?? null;
    const childId = newId();
    run(`INSERT INTO children (id, family_id, first_name, age_band, program_id, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      childId, familyId, f.child.first, f.child.band, programId,
      f.status === 'enrolled' ? 'enrolled' : f.status === 'waitlisted' ? 'waitlisted' : 'prospective',
      createdAt, now);

    const leadId = newId();
    run(`INSERT INTO leads (id, family_id, stage_id, source, program_interest, age_band, owner_id,
           next_action, next_action_due, next_action_reason, last_contact_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      leadId, familyId, f.stage, 'website', f.program, f.child.band, owner,
      f.nextAction?.text ?? null,
      f.nextAction ? iso(f.nextAction.dueDays, 12) : null,
      f.nextAction?.reason ?? null,
      iso(-3 - i, 14), createdAt, now);

    if (f.tour) {
      const tourId = newId();
      run(`INSERT INTO tours (id, family_id, lead_id, status, scheduled_for, completed_at, owner_id, source, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        tourId, familyId, leadId, f.tour.status, iso(f.tour.whenDays, 10, 30),
        f.tour.status === 'completed' ? iso(f.tour.whenDays, 11) : null,
        owner, 'website', createdAt, now);
      recordEvent({
        entityType: 'tour', entityId: tourId, type: 'created', actor: SYSTEM,
        summary: `Tour ${f.tour.status} for the ${f.surname} family`,
        after: { status: f.tour.status },
      });
    }

    if (f.registration) {
      const regId = newId();
      const submitted = f.registration.status === 'submitted';
      run(`INSERT INTO registrations (id, family_id, child_id, lead_id, status, program_id, completed_steps,
             total_steps, payload_json, source, submitted_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        regId, familyId, childId, leadId, f.registration.status, programId,
        f.registration.steps, f.registration.total,
        JSON.stringify({
          guardian: { fullName: `${f.guardian.first} ${f.surname}`, email: f.guardian.email, phone: f.guardian.phone },
          child: { firstName: f.child.first, ageBand: f.child.band },
          programInterest: f.program,
        }),
        'website', submitted ? iso(-2, 19) : null, createdAt, now);
      recordEvent({
        entityType: 'registration', entityId: regId, type: 'created', actor: SYSTEM,
        summary: submitted
          ? `Registration submitted for ${f.child.first} via the website`
          : `Registration started for ${f.child.first} (${f.registration.steps} of ${f.registration.total} steps)`,
        after: { status: f.registration.status },
      });
      if (submitted) {
        createTask({
          title: `Review registration for ${f.child.first}`, priority: 'high',
          dueAt: iso(-1, 12), relatedType: 'registration', relatedId: regId,
          ownerId: owner, source: 'website',
          reason: 'A parent submitted a registration through the website',
        }, SYSTEM);
        notify({
          tier: 'high', title: `New registration: ${f.child.first}`,
          body: `${f.guardian.first} ${f.surname} - ${f.program}`,
          linkType: 'registration', linkId: regId, dedupeKey: `reg:${regId}`,
        });
      } else {
        createTask({
          title: `Follow up: unfinished registration for ${f.child.first}`, priority: 'normal',
          dueAt: iso(-3, 12), relatedType: 'registration', relatedId: regId,
          ownerId: owner, source: 'website',
          reason: `Registration stopped at step ${f.registration.steps} of ${f.registration.total}`,
        }, SYSTEM);
      }
    }

    if (f.status === 'waitlisted') {
      run(`INSERT INTO waitlist (id, family_id, child_id, program_id, status, added_at, created_at, updated_at)
           VALUES (?,?,?,?,'waiting',?,?,?)`,
        newId(), familyId, childId, programId, createdAt, createdAt, now);
    }

    if (f.note) {
      run('INSERT INTO notes (id, entity_type, entity_id, body, created_at) VALUES (?,?,?,?,?)',
        newId(), 'family', familyId, f.note, iso(-2, 16));
    }

    recordEvent({
      entityType: 'family', entityId: familyId, type: 'created', actor: SYSTEM,
      summary: `${f.surname} family created from a website enquiry`,
      after: { status: f.status, source: 'website' },
    });
  }
}

export function seedDemo(): void {
  if (config.mode === 'production') {
    throw new Error('Refusing to seed demo data: CRM_MODE is "production". Demo records must never reach a real install.');
  }
  tx(() => {
    seedRef();
    const userIds = seedUsers();
    const already = one<{ n: number }>('SELECT COUNT(*) n FROM families')?.n ?? 0;
    if (already > 0) {
      console.log(`[seed] ${already} families already present - reference data refreshed, no demo families added.`);
      console.log('[seed] To start clean:  npm run db:reset');
      return;
    }
    seedFamilies(userIds);
  });
  const indexed = reindexAll();
  const families = one<{ n: number }>('SELECT COUNT(*) n FROM families')?.n ?? 0;
  const tasks = one<{ n: number }>('SELECT COUNT(*) n FROM tasks')?.n ?? 0;
  console.log(`[seed] done. families=${families} tasks=${tasks} search-index=${indexed}`);
  console.log('[seed] sign in with  owner@demo.local  /  demo1234   (also director@, admissions@, educator@)');
}

if (process.argv[1]?.endsWith('demo.ts')) {
  await connect();
  migrateUp();
  seedDemo();
}
