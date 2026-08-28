/**
 * Entity resolution: deciding whether an inbound guardian is a family we
 * already know.
 *
 * The rule that matters: only an exact contact-point match is allowed to link
 * automatically. Anything weaker produces a flagged candidate for a human,
 * because silently merging two families is far more expensive to undo than
 * clearing a duplicate. (spec 143 / 144)
 *
 * Every result carries the reasons that produced it, so the UI can show WHY
 * rather than a bare percentage. (spec 58)
 */
import { many } from '../db/index.ts';
import { normEmail, normPhone, splitName } from './util.ts';
import type { GuardianInput, ChildInput } from '../../../shared/src/contract.ts';

export type MatchDecision = 'link' | 'review' | 'new';

export interface FamilyMatch {
  familyId: string;
  familyName: string;
  confidence: number;      // 0..1, from the rules below. Not a model score.
  decision: MatchDecision;
  reasons: string[];
}

interface GuardianRow {
  id: string; family_id: string; first_name: string; last_name: string | null;
  email_norm: string | null; phone_norm: string | null; family_name: string;
}

export function findFamilyMatches(guardian: GuardianInput): FamilyMatch[] {
  const email = normEmail(guardian.email);
  const phone = normPhone(guardian.phone);
  const { first, last } = splitName(guardian.fullName);

  const clauses: string[] = [];
  const params: (string | null)[] = [];
  if (email) { clauses.push('g.email_norm = ?'); params.push(email); }
  if (phone) { clauses.push('g.phone_norm = ?'); params.push(phone); }
  if (last)  { clauses.push('LOWER(g.last_name) = ?'); params.push(last.toLowerCase()); }
  if (!clauses.length) return [];

  const rows = many<GuardianRow>(
    `SELECT g.id, g.family_id, g.first_name, g.last_name, g.email_norm, g.phone_norm,
            f.name AS family_name
       FROM guardians g JOIN families f ON f.id = g.family_id
      WHERE (${clauses.join(' OR ')})
        AND f.dup_of IS NULL
      LIMIT 50`,
    ...params,
  );

  const byFamily = new Map<string, FamilyMatch>();
  for (const r of rows) {
    const reasons: string[] = [];
    let score = 0;

    if (email && r.email_norm === email) { score += 0.75; reasons.push(`same email address (${email})`); }
    if (phone && r.phone_norm === phone) { score += 0.75; reasons.push('same phone number'); }
    if (last && r.last_name && r.last_name.toLowerCase() === last.toLowerCase()) {
      score += 0.2; reasons.push(`same surname (${r.last_name})`);
    }
    if (first && r.first_name.toLowerCase() === first.toLowerCase()) {
      score += 0.15; reasons.push(`same first name (${r.first_name})`);
    }
    if (score === 0) continue;

    const confidence = Math.min(1, score);
    const existing = byFamily.get(r.family_id);
    if (existing && existing.confidence >= confidence) continue;
    byFamily.set(r.family_id, {
      familyId: r.family_id,
      familyName: r.family_name,
      confidence,
      // 0.75 is exactly one exact contact-point hit. Below that a human looks.
      decision: confidence >= 0.75 ? 'link' : 'review',
      reasons,
    });
  }

  return [...byFamily.values()].sort((a, b) => b.confidence - a.confidence);
}

export interface ChildRow {
  id: string; first_name: string; last_name: string | null;
  date_of_birth: string | null; age_band: string | null;
}

/**
 * Within an already-identified family, is this the same child? Names inside one
 * family are few and distinctive, so first name plus a non-conflicting DOB is
 * enough. A conflicting DOB means it is a sibling, not a duplicate.
 */
export function findChildInFamily(familyId: string, child: ChildInput): ChildRow | null {
  const rows = many<ChildRow>(
    'SELECT id, first_name, last_name, date_of_birth, age_band FROM children WHERE family_id = ?',
    familyId,
  );
  const first = child.firstName.trim().toLowerCase();
  for (const r of rows) {
    if (r.first_name.trim().toLowerCase() !== first) continue;
    if (child.dateOfBirth && r.date_of_birth && child.dateOfBirth !== r.date_of_birth) continue;
    return { ...r };
  }
  return null;
}
