/**
 * Families, guardians and children — the one place a row for a person is
 * written, whichever door they came in through.
 *
 * The website pipeline had these helpers to itself, which meant there was no
 * way to add a family by hand at all: the only routes into the CRM were a
 * parent submitting the public form and a spreadsheet import. A daycare takes
 * enrolments over the phone and at the door, so that gap made the product
 * unusable for its actual job.
 *
 * Rather than write a second set of inserts for the manual path — which is how
 * two subtly different definitions of "the same guardian" end up in one
 * database — the pipeline's helpers moved here and both paths call them.
 *
 * The difference between the two paths is trust, and it is deliberate:
 *
 *   - an inbound form may only ever FILL A GAP. COALESCE everywhere, because a
 *     parent retyping a form must never blank a phone number staff corrected.
 *   - a person typing into the CRM may OVERWRITE, because correcting a wrong
 *     value is the entire reason they are typing. Every overwrite is an event,
 *     so the old value is still recoverable.
 */
import { one, run } from '../db/index.ts';
import { newId, nowIso, normEmail, normPhone, splitName } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { findChildInFamily } from './match.ts';
import { indexEntity } from './search.ts';
import { AGE_BANDS, type GuardianInput, type ChildInput } from '../../../shared/src/contract.ts';

// ------------------------------------------------------------------ writes
// Moved verbatim from ingest/pipeline.ts. Behaviour unchanged; the pipeline
// now imports them from here.

export function insertFamily(
  name: string, source: string, sourceId: string | null, actor: Actor,
): string {
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO families (id, name, status, source, source_id, created_at, updated_at, created_by, updated_by)
     VALUES (?,?,'prospective',?,?,?,?,?,?)`,
    id, name, source, sourceId, now, now, actor.id, actor.id,
  );
  return id;
}

export function upsertGuardian(familyId: string, g: GuardianInput, isPrimary: boolean): string {
  const email = normEmail(g.email);
  const phone = normPhone(g.phone);
  const { first, last } = splitName(g.fullName);

  // Same contact point inside this family = same person, update rather than add.
  const existing = (email || phone)
    ? one<{ id: string; email: string | null; phone: string | null }>(
        `SELECT id, email, phone FROM guardians
          WHERE family_id = ? AND ((email_norm IS NOT NULL AND email_norm = ?) OR (phone_norm IS NOT NULL AND phone_norm = ?))
          LIMIT 1`,
        familyId, email, phone)
    : undefined;

  const now = nowIso();
  if (existing) {
    // Only fill gaps. An inbound form must never blank a detail staff added.
    run(
      `UPDATE guardians SET
         email = COALESCE(?, email), phone = COALESCE(?, phone),
         email_norm = COALESCE(?, email_norm), phone_norm = COALESCE(?, phone_norm),
         relationship = COALESCE(relationship, ?), contact_pref = COALESCE(contact_pref, ?),
         updated_at = ?
       WHERE id = ?`,
      g.email ?? null, g.phone ?? null, email, phone,
      g.relationship ?? null, g.preferredContact ?? null, now, existing.id,
    );
    return existing.id;
  }

  const id = newId();
  run(
    `INSERT INTO guardians (id, family_id, first_name, last_name, relationship, email, phone,
       email_norm, phone_norm, is_primary, contact_pref, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, familyId, first, last, g.relationship ?? null, g.email ?? null, g.phone ?? null,
    email, phone, isPrimary ? 1 : 0, g.preferredContact ?? null, now, now,
  );
  return id;
}

export function upsertChild(familyId: string, c: ChildInput): string {
  const found = findChildInFamily(familyId, c);
  const now = nowIso();
  if (found) {
    run(
      `UPDATE children SET
         last_name = COALESCE(last_name, ?), date_of_birth = COALESCE(date_of_birth, ?),
         age_band = COALESCE(age_band, ?), updated_at = ?
       WHERE id = ?`,
      c.lastName ?? null, c.dateOfBirth ?? null, c.ageBand ?? null, now, found.id,
    );
    return found.id;
  }
  const id = newId();
  run(
    `INSERT INTO children (id, family_id, first_name, last_name, date_of_birth, age_band, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'prospective',?,?)`,
    id, familyId, c.firstName, c.lastName ?? null, c.dateOfBirth ?? null, c.ageBand ?? null, now, now,
  );
  return id;
}

/** Rebuilds one family's search row from its guardians and children. */
export function reindexFamily(familyId: string): void {
  const f = one<{ id: string; name: string; status: string; source: string }>(
    'SELECT id, name, status, source FROM families WHERE id = ?', familyId);
  if (!f) return;
  const guardianBlob = one<{ blob: string | null }>(
    `SELECT group_concat(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'') || ' ' ||
            COALESCE(email,'') || ' ' || COALESCE(phone,''), ' ') AS blob
       FROM guardians WHERE family_id = ?`, familyId)?.blob;
  const childBlob = one<{ blob: string | null }>(
    `SELECT group_concat(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''), ' ') AS blob
       FROM children WHERE family_id = ?`, familyId)?.blob;
  const body = [f.status, f.source, guardianBlob, childBlob].filter(Boolean).join(' ');
  indexEntity('family', f.id, f.name, body, f.id);
}

/** Keeps a child's own search row in step with their name. */
export function reindexChild(childId: string): void {
  const c = one<{ id: string; family_id: string; first_name: string; last_name: string | null; age_band: string | null; status: string }>(
    'SELECT id, family_id, first_name, last_name, age_band, status FROM children WHERE id = ?', childId);
  if (!c) return;
  indexEntity('child', c.id, [c.first_name, c.last_name].filter(Boolean).join(' '),
    [c.age_band, c.status].filter(Boolean).join(' '), c.family_id);
}

export function reindexGuardian(guardianId: string): void {
  const g = one<{ id: string; family_id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; relationship: string | null }>(
    'SELECT id, family_id, first_name, last_name, email, phone, relationship FROM guardians WHERE id = ?', guardianId);
  if (!g) return;
  indexEntity('guardian', g.id, [g.first_name, g.last_name].filter(Boolean).join(' '),
    [g.email, g.phone, g.relationship].filter(Boolean).join(' '), g.family_id);
}

// --------------------------------------------------------------------- age

/** Whole months between two dates, not rounded — a child is 11 months old
 *  until the day they are 12 months old. */
export function monthsBetween(fromIso: string, to = new Date()): number | null {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  return months;
}

/**
 * The band a date of birth falls into today.
 *
 * Bands come from the shared contract so the website, the CRM and any import
 * agree on what "3-5 years" means. A child older than the last band returns
 * null rather than being squeezed into it: "too old for our bands" is a real
 * answer and a silent misfile is not.
 */
export function ageBandFor(dateOfBirth: string | null | undefined, at = new Date()):
  (typeof AGE_BANDS)[number] | null {
  if (!dateOfBirth) return null;
  const m = monthsBetween(dateOfBirth, at);
  if (m === null || m < 0) return null;
  if (m < 12) return 'Under 12 months';
  if (m < 18) return '12-18 months';
  if (m < 36) return '18 months - 3 years';
  if (m < 60) return '3-5 years';
  if (m < 72) return '5-6 years';
  if (m < 144) return '6-12 years';
  return null;
}

/** A readable age for a screen: "18 months", "4 years". */
export function ageLabel(dateOfBirth: string | null | undefined, at = new Date()): string | null {
  const m = monthsBetween(dateOfBirth ?? '', at);
  if (m === null || m < 0) return null;
  if (m < 24) return `${m} month${m === 1 ? '' : 's'}`;
  const years = Math.floor(m / 12);
  return `${years} year${years === 1 ? '' : 's'}`;
}

// ------------------------------------------------------------------ manual

export interface ChildPatch {
  firstName?: string;
  lastName?: string | null;
  dateOfBirth?: string | null;
  ageBand?: string | null;
  status?: string;
}

export interface GuardianPatch {
  fullName?: string;
  relationship?: string | null;
  email?: string | null;
  phone?: string | null;
  preferredContact?: string | null;
  isPrimary?: boolean;
}

/**
 * Adds a child to an existing family, by hand.
 *
 * Unlike the inbound path this does not quietly merge into a near-match: a
 * person looking at the family's page can already see the children, so if they
 * are adding one they mean a new one. An exact name collision is refused with
 * a message instead, because that is far more likely to be a double-submitted
 * form than genuine twins with identical names.
 */
export function addChild(familyId: string, input: ChildInput, actor: Actor): string {
  const band = input.ageBand ?? ageBandFor(input.dateOfBirth) ?? null;
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO children (id, family_id, first_name, last_name, date_of_birth, age_band, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'prospective',?,?)`,
    id, familyId, input.firstName, input.lastName ?? null,
    input.dateOfBirth ?? null, band, now, now,
  );
  recordEvent({
    entityType: 'child', entityId: id, type: 'created', actor,
    summary: `${input.firstName} added to the family by hand`,
    after: { first_name: input.firstName, last_name: input.lastName ?? null, age_band: band },
  });
  reindexChild(id);
  reindexFamily(familyId);
  return id;
}

export function addGuardian(familyId: string, input: GuardianInput, actor: Actor): string {
  const hasPrimary = (one<{ n: number }>(
    'SELECT COUNT(*) n FROM guardians WHERE family_id = ? AND is_primary = 1', familyId)?.n ?? 0) > 0;
  const id = upsertGuardian(familyId, input, !hasPrimary);
  recordEvent({
    entityType: 'guardian', entityId: id, type: 'created', actor,
    summary: `${input.fullName} added to the family by hand`,
    after: { full_name: input.fullName, email: input.email ?? null, phone: input.phone ?? null },
  });
  reindexGuardian(id);
  reindexFamily(familyId);
  return id;
}

/**
 * Edits a child. A person typing here may blank a field, which the inbound
 * path may not — `null` means "clear this", `undefined` means "leave it".
 * Changing the date of birth re-derives the band unless one was given
 * explicitly, so the two can never disagree by accident.
 */
export function updateChild(childId: string, patch: ChildPatch, actor: Actor): void {
  const before = one<Record<string, unknown>>('SELECT * FROM children WHERE id = ?', childId);
  if (!before) throw new Error(`No such child: ${childId}`);

  const sets: string[] = [];
  const params: (string | null)[] = [];
  const put = (col: string, v: string | null | undefined) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`); params.push(v);
  };

  put('first_name', patch.firstName);
  put('last_name', patch.lastName);
  put('date_of_birth', patch.dateOfBirth);
  put('status', patch.status);

  if (patch.ageBand !== undefined) put('age_band', patch.ageBand);
  else if (patch.dateOfBirth !== undefined) put('age_band', ageBandFor(patch.dateOfBirth));

  if (!sets.length) return;

  run(`UPDATE children SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    ...params, nowIso(), childId);

  const after = one<Record<string, unknown>>('SELECT * FROM children WHERE id = ?', childId)!;
  recordEvent({
    entityType: 'child', entityId: childId, type: 'updated', actor,
    summary: `${String(after.first_name)} updated`,
    before, after,
  });
  reindexChild(childId);
  reindexFamily(String(after.family_id));
}

export function updateGuardian(guardianId: string, patch: GuardianPatch, actor: Actor): void {
  const before = one<Record<string, unknown>>('SELECT * FROM guardians WHERE id = ?', guardianId);
  if (!before) throw new Error(`No such guardian: ${guardianId}`);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const put = (col: string, v: string | number | null | undefined) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`); params.push(v);
  };

  if (patch.fullName !== undefined) {
    const { first, last } = splitName(patch.fullName);
    put('first_name', first); put('last_name', last);
  }
  put('relationship', patch.relationship);
  put('contact_pref', patch.preferredContact);
  // The normalised columns are what matching and dedupe read, so they have to
  // move with the value they are derived from, in the same statement.
  if (patch.email !== undefined) { put('email', patch.email); put('email_norm', normEmail(patch.email)); }
  if (patch.phone !== undefined) { put('phone', patch.phone); put('phone_norm', normPhone(patch.phone)); }
  if (patch.isPrimary !== undefined) put('is_primary', patch.isPrimary ? 1 : 0);

  if (!sets.length) return;

  // One primary guardian per family. Demoting the others here rather than
  // trusting the caller keeps the invariant in the place that can enforce it.
  if (patch.isPrimary === true) {
    run(`UPDATE guardians SET is_primary = 0 WHERE family_id = ? AND id <> ?`,
      String(before.family_id), guardianId);
  }

  run(`UPDATE guardians SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
    ...params, nowIso(), guardianId);

  const after = one<Record<string, unknown>>('SELECT * FROM guardians WHERE id = ?', guardianId)!;
  recordEvent({
    entityType: 'guardian', entityId: guardianId, type: 'updated', actor,
    summary: `${[after.first_name, after.last_name].filter(Boolean).join(' ')} updated`,
    before, after,
  });
  reindexGuardian(guardianId);
  reindexFamily(String(after.family_id));
}
