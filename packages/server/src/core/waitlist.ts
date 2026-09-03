/**
 * The waiting list.
 *
 * The research on childcare waitlists agrees on the failure mode, and it is
 * not losing the list. It is going quiet. A family joins, hears nothing for
 * four months, and has enrolled somewhere else by the time anybody rings. So
 * most of what is here is about contact and deadlines rather than ordering.
 *
 * Three rules shape the whole file:
 *
 *   1. POSITION IS COMPUTED, never stored. A stored position is wrong the
 *      instant somebody leaves the middle of the list, and a number that is
 *      quietly wrong is worse than no number at all.
 *
 *   2. NO ESTIMATED WAIT. The CRM cannot know when a place will free up. An
 *      estimate shown to staff becomes a promise made to a parent. "Fourth,
 *      and two places are free" is a fact; "about four months" is not.
 *
 *   3. WHETHER A SIBLING JUMPS THE QUEUE IS NOT A DATABASE'S DECISION. Whether
 *      a family already has a child here IS a fact, so it is shown. The person
 *      moving somebody up can see that they are the one doing it.
 */
import { one, many, run, tx } from '../db/index.ts';
import { newId, nowIso, plain, plainAll } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { createTask, notify } from './notify.ts';

export class WaitlistError extends Error {}

/**
 * THE CENTRE'S WAITING LIST POLICY, decided 2026-09-04.
 *
 * Strict order of joining. Siblings do NOT move up the queue.
 *
 * This is written down because the research on childcare waitlists is blunt
 * about it: most centres run a hybrid by accident — a sibling here, a
 * full-timer there — and then cannot explain to a parent why somebody who
 * joined in June was offered a place before somebody who joined in March. A
 * policy only feels fair if it can be stated in one sentence, and this one can.
 *
 * The consequence for this file is that `list()` orders by added_at and by
 * nothing else. `hasSiblingHere` is still computed and still shown, because it
 * is useful to know you already have that family on the phone — but it is a
 * fact about them, not a lever, and there is a test that proves it moves
 * nobody.
 */
export const ORDERING_POLICY =
  'Strict order of joining. Siblings do not move up the queue.';

/** How long a family has to answer an offer. Two weeks: long enough to talk it
 *  over, short enough that a place is not held hostage. Confirmed by the centre
 *  on 2026-09-04. */
export const DEFAULT_OFFER_DAYS = 14;

/** The research says refresh every three to six months. Three, because the
 *  cost of an unnecessary friendly email is far lower than the cost of a
 *  family quietly giving up on you. */
export const STALE_AFTER_DAYS = 90;

export interface WaitlistEntry extends Record<string, unknown> {
  id: string;
  position: number;
  familyId: string;
  familyName: string;
  childName: string | null;
  programName: string | null;
  status: string;
  addedAt: string;
  waitingDays: number;
  /** True when this family already has a child attending. A fact, not a rule. */
  hasSiblingHere: boolean;
  daysSinceContact: number | null;
  isStale: boolean;
  offerExpiresAt: string | null;
  offerDaysLeft: number | null;
}

const days = (from: string | null, to = Date.now()): number | null => {
  if (!from) return null;
  const t = Date.parse(from);
  if (Number.isNaN(t)) return null;
  return Math.floor((to - t) / 86_400_000);
};

/**
 * The list, in order, with a position per program.
 *
 * Ordering is application date within a program and nothing else. That is the
 * centre's policy, not a default this file fell into — see ORDERING_POLICY
 * above. Siblings are shown, never sorted on.
 */
export function list(opts: { programId?: string; status?: string } = {}): WaitlistEntry[] {
  const where = ["w.status <> 'removed'"];
  const params: string[] = [];
  if (opts.programId) { where.push('w.program_id = ?'); params.push(opts.programId); }
  if (opts.status) { where.push('w.status = ?'); params.push(opts.status); }

  const rows = many<Record<string, unknown>>(
    `SELECT w.*, f.name AS family_name,
            ch.first_name AS child_first, ch.last_name AS child_last,
            p.name AS program_name,
            (SELECT COUNT(*) FROM children sib
              WHERE sib.family_id = w.family_id AND sib.status = 'enrolled') AS siblings_here
       FROM waitlist w
       JOIN families f ON f.id = w.family_id
       LEFT JOIN children ch ON ch.id = w.child_id
       LEFT JOIN programs p ON p.id = w.program_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.sort_order, w.added_at, w.created_at`, ...params);

  // Position counts within a program, and only among those still waiting: a
  // family who has been offered a place is not ahead of anybody any more.
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = String(r.program_id ?? 'none');
    let position = 0;
    if (r.status === 'waiting') {
      position = (seen.get(key) ?? 0) + 1;
      seen.set(key, position);
    }
    const contact = days(String(r.last_contacted_at ?? r.confirmed_at ?? '') || null);
    const expires = r.offer_expires_at ? String(r.offer_expires_at) : null;
    return {
      ...plain(r)!,
      id: String(r.id),
      position,
      familyId: String(r.family_id),
      familyName: String(r.family_name),
      childName: [r.child_first, r.child_last].filter(Boolean).join(' ') || null,
      programName: r.program_name ? String(r.program_name) : null,
      status: String(r.status),
      addedAt: String(r.added_at),
      waitingDays: days(String(r.added_at)) ?? 0,
      hasSiblingHere: Number(r.siblings_here ?? 0) > 0,
      daysSinceContact: contact,
      // Never contacted counts as stale once they have been waiting that long,
      // which is the case this is really for.
      isStale: r.status === 'waiting'
        && (contact ?? days(String(r.added_at)) ?? 0) >= STALE_AFTER_DAYS,
      offerExpiresAt: expires,
      offerDaysLeft: expires === null ? null : -(days(expires) ?? 0),
    } as WaitlistEntry;
  });
}

/**
 * Places free in each program, and how many are waiting for them.
 *
 * This is the number that makes the screen worth opening. It is only possible
 * because the licensed capacity per age range is recorded — without it the
 * honest answer would be "not measured", and it says exactly that when a
 * program has no capacity set.
 */
export function programStanding(): Record<string, unknown>[] {
  return plainAll(many<Record<string, unknown>>(
    `SELECT p.id, p.name, p.age_label, p.capacity,
            (SELECT COUNT(*) FROM children c
               LEFT JOIN classrooms r ON r.id = c.classroom_id
              WHERE c.status = 'enrolled'
                AND COALESCE(r.program_id, c.program_id) = p.id) AS enrolled,
            (SELECT COUNT(*) FROM waitlist w
              WHERE w.program_id = p.id AND w.status = 'waiting') AS waiting,
            (SELECT COUNT(*) FROM waitlist w
              WHERE w.program_id = p.id AND w.status = 'offered') AS offered
       FROM programs p
      WHERE p.active = 1
      ORDER BY p.sort_order`));
}

export interface JoinInput {
  familyId: string;
  childId?: string | null;
  programId?: string | null;
  desiredStart?: string | null;
  careType?: 'full-time' | 'part-time' | null;
  notes?: string | null;
}

export function join(input: JoinInput, actor: Actor): Record<string, unknown> {
  const family = one<{ id: string; name: string }>(
    'SELECT id, name FROM families WHERE id = ?', input.familyId);
  if (!family) throw new WaitlistError('No such family');

  // The same child waiting twice for the same program is a mistake, not a
  // stronger claim on a place.
  const existing = one<{ id: string }>(
    `SELECT id FROM waitlist
      WHERE family_id = ? AND status IN ('waiting','offered')
        AND (child_id IS ? OR child_id = ?)
        AND (program_id IS ? OR program_id = ?)`,
    input.familyId, input.childId ?? null, input.childId ?? null,
    input.programId ?? null, input.programId ?? null);
  if (existing) throw new WaitlistError('They are already on this waiting list');

  const id = newId();
  const now = nowIso();
  tx(() => {
    run(
      `INSERT INTO waitlist (id, family_id, child_id, program_id, status, desired_start,
         added_at, notes, care_type, created_at, updated_at)
       VALUES (?,?,?,?, 'waiting', ?,?,?,?,?,?)`,
      id, input.familyId, input.childId ?? null, input.programId ?? null,
      input.desiredStart ?? null, now, input.notes ?? null, input.careType ?? null, now, now,
    );
    recordEvent({
      entityType: 'waitlist', entityId: id, type: 'created', actor,
      summary: `${family.name} joined the waiting list`,
      after: { program_id: input.programId ?? null, desired_start: input.desiredStart ?? null },
    });
  });
  return plain(one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id))!;
}

/**
 * Offering a place.
 *
 * The deadline is required, not optional. An offer with no deadline is how a
 * place sits reserved for a family that has already gone elsewhere, and the
 * database refuses one anyway.
 */
export function offer(
  id: string, actor: Actor, userId: string | null, expiresInDays = DEFAULT_OFFER_DAYS,
): Record<string, unknown> {
  const row = one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id);
  if (!row) throw new WaitlistError('No such waiting list entry');
  if (row.status !== 'waiting') throw new WaitlistError(`That entry is already ${String(row.status)}`);
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
    throw new WaitlistError('An offer has to run out between 1 and 90 days from now');
  }

  const family = one<{ name: string }>('SELECT name FROM families WHERE id = ?', String(row.family_id));
  const now = nowIso();
  const expires = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();

  tx(() => {
    run(`UPDATE waitlist SET status = 'offered', offered_at = ?, offer_expires_at = ?,
           offered_by = ?, last_contacted_at = ?, updated_at = ? WHERE id = ?`,
      now, expires, userId, now, now, id);
    recordEvent({
      entityType: 'waitlist', entityId: id, type: 'updated', actor,
      summary: `Place offered to ${family?.name ?? 'the family'}, answer needed by ${expires.slice(0, 10)}`,
      before: { status: 'waiting' },
      after: { status: 'offered', offer_expires_at: expires },
    });
    // The offer is not the job. Telling them, and hearing back, is the job.
    createTask({
      title: `Tell ${family?.name ?? 'the family'} their place is ready`,
      body: `They have until ${expires.slice(0, 10)} to answer. Record what they say on the waiting list.`,
      priority: 'high',
      dueAt: expires,
      relatedType: 'family', relatedId: String(row.family_id),
      source: 'system',
      reason: 'A place was offered and the family has a deadline to answer',
      dedupeKey: `waitlist-offer:${id}`,
    }, actor);
  });
  return plain(one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id))!;
}

/** They said yes. The child becomes enrolled; the room is chosen separately,
 *  because which room is a placement decision and Ages & Rooms owns that. */
export function accept(id: string, actor: Actor, reason?: string): Record<string, unknown> {
  const row = one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id);
  if (!row) throw new WaitlistError('No such waiting list entry');
  if (row.status !== 'offered') throw new WaitlistError('A place has to be offered before it can be accepted');

  const now = nowIso();
  tx(() => {
    run(`UPDATE waitlist SET status = 'accepted', responded_at = ?, outcome_reason = ?,
           last_contacted_at = ?, updated_at = ? WHERE id = ?`,
      now, reason ?? null, now, now, id);
    if (row.child_id) {
      run(`UPDATE children SET status = 'enrolled', updated_at = ? WHERE id = ?`, now, String(row.child_id));
      recordEvent({
        entityType: 'child', entityId: String(row.child_id), type: 'updated', actor,
        summary: 'Accepted a place from the waiting list',
        after: { status: 'enrolled' },
      });
    }
    run(`UPDATE families SET status = 'enrolled', updated_at = ? WHERE id = ?`,
      now, String(row.family_id));
    recordEvent({
      entityType: 'waitlist', entityId: id, type: 'updated', actor,
      summary: 'Place accepted',
      before: { status: 'offered' }, after: { status: 'accepted' },
    });
  });
  return plain(one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id))!;
}

/** They said no, or they have gone elsewhere. The reason is worth more than
 *  the row: it is the only way anybody learns why places go unfilled. */
export function decline(
  id: string, reason: string, actor: Actor, keepWaiting = false,
): Record<string, unknown> {
  const row = one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id);
  if (!row) throw new WaitlistError('No such waiting list entry');
  const text = reason?.trim();
  if (!text) throw new WaitlistError('Say why, even briefly — it is the only way anyone learns');

  const now = nowIso();
  tx(() => {
    // Declining one offer does not always mean leaving the list. A family who
    // wanted September and was offered June is still waiting for September.
    run(`UPDATE waitlist SET status = ?, responded_at = ?, outcome_reason = ?,
           offered_at = NULL, offer_expires_at = NULL,
           last_contacted_at = ?, updated_at = ? WHERE id = ?`,
      keepWaiting ? 'waiting' : 'declined', now, text.slice(0, 500), now, now, id);
    recordEvent({
      entityType: 'waitlist', entityId: id, type: 'updated', actor,
      summary: keepWaiting
        ? `Turned this offer down but stayed on the list: ${text.slice(0, 80)}`
        : `Left the waiting list: ${text.slice(0, 80)}`,
      before: { status: String(row.status) },
      after: { status: keepWaiting ? 'waiting' : 'declined' },
    });
  });
  return plain(one<Record<string, unknown>>('SELECT * FROM waitlist WHERE id = ?', id))!;
}

/** Somebody rang them, or they wrote back. Resets the silence clock. */
export function recordContact(id: string, actor: Actor, note?: string): void {
  const row = one<{ id: string; family_id: string }>(
    'SELECT id, family_id FROM waitlist WHERE id = ?', id);
  if (!row) throw new WaitlistError('No such waiting list entry');
  const now = nowIso();
  run(`UPDATE waitlist SET last_contacted_at = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
    now, now, now, id);
  recordEvent({
    entityType: 'waitlist', entityId: id, type: 'updated', actor,
    summary: note?.trim() ? `Checked in: ${note.trim().slice(0, 120)}` : 'Checked in, still waiting',
    after: { last_contacted_at: now },
  });
}

/**
 * The sweep that stops anybody going quiet.
 *
 * Two jobs: chase offers that have run out, and raise a check-in for families
 * nobody has spoken to in three months. Neither changes a status on its own —
 * an expired offer is a conversation to have, not a place to withdraw behind
 * somebody's back.
 */
export function sweep(actor: Actor): { expired: number; stale: number } {
  const now = nowIso();

  const expired = many<{ id: string; family_id: string; family_name: string; offer_expires_at: string }>(
    `SELECT w.id, w.family_id, f.name AS family_name, w.offer_expires_at
       FROM waitlist w JOIN families f ON f.id = w.family_id
      WHERE w.status = 'offered' AND w.offer_expires_at < ?`, now);

  for (const e of expired) {
    createTask({
      title: `${e.family_name} has not answered about their place`,
      body: `The offer ran out on ${e.offer_expires_at.slice(0, 10)}. Ring them, then either extend it or give the place to the next family.`,
      priority: 'critical',
      relatedType: 'family', relatedId: e.family_id,
      source: 'system',
      reason: 'An offered place has passed its deadline with no answer',
      dedupeKey: `waitlist-expired:${e.id}`,
    }, actor);
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString();
  const stale = many<{ id: string; family_id: string; family_name: string }>(
    `SELECT w.id, w.family_id, f.name AS family_name
       FROM waitlist w JOIN families f ON f.id = w.family_id
      WHERE w.status = 'waiting'
        AND COALESCE(w.last_contacted_at, w.added_at) < ?`, cutoff);

  for (const s of stale) {
    createTask({
      title: `Check ${s.family_name} still wants a place`,
      body: 'Nobody has spoken to them in three months. A family who has found care elsewhere is holding a place nobody can offer.',
      priority: 'normal',
      relatedType: 'family', relatedId: s.family_id,
      source: 'system',
      reason: 'Three months with no contact — the commonest way a waiting list rots',
      dedupeKey: `waitlist-stale:${s.id}`,
    }, actor);
  }

  if (expired.length) {
    notify({
      tier: 'high',
      title: `${expired.length} offered place${expired.length === 1 ? '' : 's'} past the deadline`,
      body: 'Families have not answered. The places cannot be given to anybody else until they do.',
      // Links to the first one rather than nowhere: an alert that cannot be
      // opened is an alert people learn to ignore.
      linkType: 'family', linkId: expired[0]!.family_id,
      dedupeKey: `waitlist-expired-batch:${now.slice(0, 10)}`,
    });
  }
  return { expired: expired.length, stale: stale.length };
}

/** Counts for the attention radar. */
export function attentionCounts(): { expiredOffers: number; staleWaiting: number } {
  const n = (sql: string, ...p: string[]) => Number(one<{ n: number }>(sql, ...p)?.n ?? 0);
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000).toISOString();
  return {
    expiredOffers: n(
      `SELECT COUNT(*) n FROM waitlist WHERE status = 'offered' AND offer_expires_at < ?`, nowIso()),
    staleWaiting: n(
      `SELECT COUNT(*) n FROM waitlist WHERE status = 'waiting'
        AND COALESCE(last_contacted_at, added_at) < ?`, cutoff),
  };
}
