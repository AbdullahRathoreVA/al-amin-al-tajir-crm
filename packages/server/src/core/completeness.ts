/**
 * Registration completeness.
 *
 * Deterministic on purpose. "Is there an emergency contact?" is a question SQL
 * answers exactly, and asking a language model instead would be slower, more
 * expensive and occasionally wrong about something a regulator cares about.
 * AI is for judgement; this is arithmetic. (spec 13 / 61)
 *
 * Every gap names the field, says why it matters, and says where to fix it, so
 * the answer is actionable rather than a percentage.
 */
import { one, many } from '../db/index.ts';

export type Severity = 'required' | 'recommended';

export interface Gap {
  field: string;
  label: string;
  /** Plain English, for a person who is about to phone a parent about it. */
  why: string;
  severity: Severity;
  /** Which record to open to fix it. */
  where: 'guardian' | 'child' | 'registration' | 'family';
}

export interface Completeness {
  status: 'complete' | 'incomplete' | 'needs_review';
  /** 0-100 over REQUIRED fields only. Recommended ones do not dilute it. */
  percent: number;
  gaps: Gap[];
  requiredMissing: number;
  recommendedMissing: number;
}

interface Row {
  reg_id: string; family_id: string; child_id: string | null;
  program_id: string | null; desired_start: string | null; status: string;
}

export function assessRegistration(registrationId: string): Completeness | null {
  const reg = one<Row>(
    `SELECT r.id AS reg_id, r.family_id, r.child_id, r.program_id, r.desired_start, r.status
       FROM registrations r WHERE r.id = ?`, registrationId);
  if (!reg) return null;
  return assess(reg);
}

/** Same rules, addressed by family, for the family profile. */
export function assessFamilyRegistration(familyId: string): Completeness | null {
  const reg = one<Row>(
    `SELECT r.id AS reg_id, r.family_id, r.child_id, r.program_id, r.desired_start, r.status
       FROM registrations r WHERE r.family_id = ? ORDER BY r.created_at DESC LIMIT 1`, familyId);
  if (!reg) return null;
  return assess(reg);
}

function assess(reg: Row): Completeness {
  const gaps: Gap[] = [];
  const need = (cond: boolean, g: Gap) => { if (!cond) gaps.push(g); };

  const guardians = many<{
    id: string; first_name: string; last_name: string | null; relationship: string | null;
    email: string | null; phone: string | null; is_emergency: number; can_pickup: number;
  }>(`SELECT id, first_name, last_name, relationship, email, phone, is_emergency, can_pickup
        FROM guardians WHERE family_id = ? ORDER BY is_primary DESC`, reg.family_id);

  const primary = guardians[0];
  const child = reg.child_id
    ? one<{ first_name: string; last_name: string | null; date_of_birth: string | null; age_band: string | null }>(
        'SELECT first_name, last_name, date_of_birth, age_band FROM children WHERE id = ?', reg.child_id)
    : undefined;

  // ------------------------------------------------------------- guardian
  need(!!primary, {
    field: 'guardian', label: 'A parent or guardian',
    why: 'There is nobody on this registration to contact.',
    severity: 'required', where: 'family',
  });
  need(!!primary?.last_name, {
    field: 'guardian.last_name', label: "Guardian's surname",
    why: 'Only a first name is on file, which makes this family hard to identify.',
    severity: 'recommended', where: 'guardian',
  });
  need(!!primary?.phone, {
    field: 'guardian.phone', label: 'Guardian phone number',
    why: 'A phone number is needed to reach a parent during the day.',
    severity: 'required', where: 'guardian',
  });
  need(!!primary?.email, {
    field: 'guardian.email', label: 'Guardian email address',
    why: 'Used for confirmations and documents.',
    severity: 'recommended', where: 'guardian',
  });
  need(!!primary?.relationship, {
    field: 'guardian.relationship', label: 'Relationship to the child',
    why: 'Who this adult is to the child is not recorded.',
    severity: 'recommended', where: 'guardian',
  });

  // A second contact is not paperwork. It is who gets called when the first
  // cannot be reached and a child needs collecting.
  const secondContact = guardians.length > 1 || guardians.some((g) => g.is_emergency === 1);
  need(secondContact, {
    field: 'emergency_contact', label: 'A second contact',
    why: 'Only one adult is on file. There is nobody to call if they cannot be reached.',
    severity: 'required', where: 'family',
  });

  const pickup = guardians.some((g) => g.can_pickup === 1);
  need(pickup, {
    field: 'authorized_pickup', label: 'Authorised pickup',
    why: 'Nobody is marked as allowed to collect this child.',
    severity: 'required', where: 'family',
  });

  // ---------------------------------------------------------------- child
  need(!!child, {
    field: 'child', label: 'The child',
    why: 'This registration is not linked to a child record.',
    severity: 'required', where: 'registration',
  });
  need(!!child?.last_name, {
    field: 'child.last_name', label: "Child's surname",
    why: 'Needed on official records and for matching siblings.',
    severity: 'recommended', where: 'child',
  });
  // Age band is what the website collects; the exact date is required before a
  // child actually starts, because ratios and room placement depend on it.
  need(!!child?.date_of_birth, {
    field: 'child.date_of_birth', label: 'Date of birth',
    why: 'Room placement and staffing ratios depend on the exact age, not a band.',
    severity: 'required', where: 'child',
  });

  // --------------------------------------------------------- registration
  need(!!reg.program_id, {
    field: 'program', label: 'Program',
    why: 'No program has been chosen or assigned.',
    severity: 'required', where: 'registration',
  });
  need(!!reg.desired_start, {
    field: 'desired_start', label: 'Desired start date',
    why: 'Without a start date this cannot be planned into a room.',
    severity: 'required', where: 'registration',
  });

  const requiredTotal = 8;
  const requiredMissing = gaps.filter((g) => g.severity === 'required').length;
  const recommendedMissing = gaps.filter((g) => g.severity === 'recommended').length;

  const percent = Math.max(0, Math.round(((requiredTotal - requiredMissing) / requiredTotal) * 100));

  const status: Completeness['status'] =
    requiredMissing > 0 ? 'incomplete'
    : reg.status === 'submitted' ? 'needs_review'
    : 'complete';

  return { status, percent, gaps, requiredMissing, recommendedMissing };
}

/** Every registration that a person still has to chase, worst first. */
export function incompleteRegistrations(limit = 50) {
  const rows = many<{ id: string; family_id: string; family_name: string; child_first_name: string | null }>(
    `SELECT r.id, r.family_id, f.name AS family_name, c.first_name AS child_first_name
       FROM registrations r
       JOIN families f ON f.id = r.family_id
       LEFT JOIN children c ON c.id = r.child_id
      WHERE r.status IN ('started','submitted','incomplete','reviewing')
      ORDER BY r.created_at DESC LIMIT ?`, limit);

  return rows
    .map((r) => ({ ...r, completeness: assessRegistration(r.id) }))
    .filter((r) => r.completeness && r.completeness.requiredMissing > 0)
    .sort((a, b) => (b.completeness!.requiredMissing - a.completeness!.requiredMissing));
}
