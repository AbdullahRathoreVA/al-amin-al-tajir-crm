/**
 * INGEST -> VALIDATE -> MATCH -> DEDUPE -> CREATE/UPDATE -> AUDIT -> NOTIFY -> FOLLOW UP
 *
 * The whole point of this file is that a parent's registration reaches a staff
 * member's screen without anyone retyping it, and that sending it twice does
 * not produce two families. (spec 2 / 30 / 31)
 *
 * The CRM write is one transaction. Anything outbound (Sheets, email) is queued
 * in `outbox` afterwards, so a Sheets outage can never fail a registration that
 * is already safely stored. (spec 280)
 */
import { one, run, tx } from '../db/index.ts';
import { newId, nowIso, sha256, familyNameFrom } from '../core/util.ts';
import { recordEvent, type Actor } from '../core/events.ts';
import { queue as queueForSync } from '../core/sync.ts';
import { findFamilyMatches, type FamilyMatch } from '../core/match.ts';
import { indexEntity } from '../core/search.ts';
// Families, guardians and children are written in exactly one place, so the
// manual path and this one cannot drift apart. See core/people.ts.
import { insertFamily, upsertGuardian, upsertChild, reindexFamily } from '../core/people.ts';
import { notify, createTask } from '../core/notify.ts';
import type {
  EventEnvelope, RegistrationData, TourRequestData, ContactData, GuardianInput, ChildInput, AnalyticsBatch,
} from '../../../shared/src/contract.ts';
import { ingestAnalytics, type AnalyticsResult } from './analytics.ts';

export interface IngestResult {
  status: 'processed' | 'duplicate';
  eventId: string;
  familyId: string;
  childId?: string;
  leadId?: string;
  registrationId?: string;
  tourId?: string;
  /** true when this event created a brand new family rather than adding to one. */
  createdFamily: boolean;
  /** Set when a near-match was found but deliberately NOT auto-merged. */
  needsReview?: { candidates: FamilyMatch[] };
}

const INTEGRATION: Actor = { type: 'integration', id: null, source: 'website' };

// --------------------------------------------------------------- idempotency

/** Returns the earlier result if this eventId was already handled. (spec 31) */
function previousResult(eventId: string): IngestResult | AnalyticsResult | null {
  const row = one<{ status: string; result_json: string | null }>(
    'SELECT status, result_json FROM ingest_events WHERE event_id = ?', eventId);
  if (!row || row.status !== 'processed' || !row.result_json) return null;
  try {
    return { ...(JSON.parse(row.result_json) as IngestResult | AnalyticsResult), status: 'duplicate' };
  } catch { return null; }
}

// ------------------------------------------------------------------- writers

function defaultStage(id: string): string {
  const row = one<{ id: string }>('SELECT id FROM lead_stages WHERE id = ?', id);
  if (row) return row.id;
  const first = one<{ id: string }>('SELECT id FROM lead_stages ORDER BY sort_order LIMIT 1');
  if (!first) throw new Error('No lead stages configured. Run db:migrate and db:seed.');
  return first.id;
}

function upsertLead(
  familyId: string, stageId: string, source: string, sourceId: string | null,
  fields: { programInterest?: string; ageBand?: string; desiredStart?: string },
): string {
  const existing = one<{ id: string; stage_id: string }>(
    `SELECT l.id, l.stage_id FROM leads l JOIN lead_stages s ON s.id = l.stage_id
      WHERE l.family_id = ? AND s.is_open = 1 ORDER BY l.created_at DESC LIMIT 1`, familyId);
  const now = nowIso();

  if (existing) {
    const target = defaultStage(stageId);
    const cur = one<{ sort_order: number }>('SELECT sort_order FROM lead_stages WHERE id = ?', existing.stage_id);
    const next = one<{ sort_order: number }>('SELECT sort_order FROM lead_stages WHERE id = ?', target);
    // Only ever move a lead forward. A late "contact us" must not drag a family
    // that already booked a tour back to New.
    const advance = (next?.sort_order ?? 0) > (cur?.sort_order ?? 0);
    run(
      `UPDATE leads SET stage_id = ?, program_interest = COALESCE(?, program_interest),
         age_band = COALESCE(?, age_band), desired_start = COALESCE(?, desired_start), updated_at = ?
       WHERE id = ?`,
      advance ? target : existing.stage_id,
      fields.programInterest ?? null, fields.ageBand ?? null, fields.desiredStart ?? null,
      now, existing.id,
    );
    return existing.id;
  }

  const id = newId();
  run(
    `INSERT INTO leads (id, family_id, stage_id, source, source_id, program_interest, age_band,
       desired_start, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, familyId, defaultStage(stageId), source, sourceId,
    fields.programInterest ?? null, fields.ageBand ?? null, fields.desiredStart ?? null, now, now,
  );
  return id;
}


/** Queue an outbound sync. Never called inside the CRM write transaction's
 *  success path in a way that could fail it. */
/**
 * Queues outbound work. Delegates to core/sync so there is one definition of
 * what a queued row looks like - in particular `family_id`, which is what lets
 * the sender honour a family's "never sync" setting in the query that selects
 * rows, rather than in a check somebody has to remember.
 */
function queueOutbox(channel: string, payload: { familyId?: string } & Record<string, unknown>): void {
  queueForSync(channel, payload, payload.familyId ?? null);
}

// ------------------------------------------------------------- family resolve

function resolveFamily(
  guardian: GuardianInput, source: string, sourceId: string | null, actor: Actor,
): { familyId: string; created: boolean; review?: FamilyMatch[] } {
  const matches = findFamilyMatches(guardian);
  const linkable = matches.find((m) => m.decision === 'link');
  if (linkable) return { familyId: linkable.familyId, created: false };

  const familyId = insertFamily(familyNameFrom(guardian.fullName), source, sourceId, actor);
  const review = matches.filter((m) => m.decision === 'review');
  return { familyId, created: true, ...(review.length ? { review } : {}) };
}

function flagForReview(familyId: string, candidates: FamilyMatch[], actor: Actor): void {
  const top = candidates[0]!;
  createTask({
    title: `Possible duplicate family: ${top.familyName}`,
    body: `A new family record was created from an inbound ${top.reasons.length ? '' : ''}submission, but it looks similar to an existing one.\n\n` +
      candidates.map((c) => `- ${c.familyName} (${Math.round(c.confidence * 100)}% - ${c.reasons.join('; ')})`).join('\n') +
      `\n\nNothing was merged automatically. Review and either merge or keep separate.`,
    priority: 'high',
    relatedType: 'family', relatedId: familyId,
    source: 'system',
    reason: 'Inbound record matched an existing family on a weak signal only',
    dedupeKey: `dup:${familyId}`,
  }, actor);
  notify({
    tier: 'high',
    title: 'Possible duplicate family detected',
    body: `New record looks like "${top.familyName}". Nothing merged.`,
    linkType: 'family', linkId: familyId,
    dedupeKey: `dup:${familyId}`,
  });
}

// ---------------------------------------------------------------- entrypoints

export function ingest(env: EventEnvelope, meta: { country?: string } = {}): IngestResult | AnalyticsResult {
  const prior = previousResult(env.eventId);
  if (prior) return prior;

  const payloadHash = sha256(JSON.stringify(env.data));
  const now = nowIso();
  // Claim the eventId first. A UNIQUE violation here means a concurrent
  // duplicate landed while we were working; we hand back the winner's result.
  try {
    run(
      `INSERT INTO ingest_events (event_id, type, source, payload_hash, status, attempts, received_at)
       VALUES (?,?,?,?, 'received', 1, ?)`,
      env.eventId, env.type, env.source, payloadHash, now,
    );
  } catch {
    const again = previousResult(env.eventId);
    if (again) return again;
    throw new Error('This event is already being processed.');
  }

  try {
    // Analytics takes its own path: it is high-volume, creates no family, and
    // must never raise a task, an alert or a Sheets row. Nobody needs a
    // notification because somebody looked at a page.
    if (env.type === 'web.analytics') {
      const result = ingestAnalytics(env.eventId, env.data as AnalyticsBatch, meta.country);
      run(`UPDATE ingest_events SET status='processed', result_json=?, processed_at=? WHERE event_id=?`,
        JSON.stringify(result), nowIso(), env.eventId);
      return result;
    }

    const result = tx(() => {
      switch (env.type) {
        case 'registration.created':
        case 'registration.updated':
          return handleRegistration(env as EventEnvelope<RegistrationData>);
        case 'tour.requested':
          return handleTour(env as EventEnvelope<TourRequestData>, 'tour');
        case 'waitlist.requested':
          return handleTour(env as EventEnvelope<TourRequestData>, 'waitlist');
        case 'contact.created':
          return handleContact(env as EventEnvelope<ContactData>);
        default:
          throw new Error(`Unsupported event type: ${env.type}`);
      }
    });

    run(`UPDATE ingest_events SET status='processed', result_json=?, processed_at=? WHERE event_id=?`,
      JSON.stringify(result), nowIso(), env.eventId);

    // Outbound work happens only after the CRM write is committed. (spec 280)
    queueOutbox('google-sheets', { eventType: env.type, ...result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(`UPDATE ingest_events SET status='failed', error=?, processed_at=? WHERE event_id=?`,
      message, nowIso(), env.eventId);
    throw err;
  }
}

function handleRegistration(env: EventEnvelope<RegistrationData>): IngestResult {
  const d = env.data;
  const { familyId, created, review } = resolveFamily(d.guardian, env.source, env.eventId, INTEGRATION);
  upsertGuardian(familyId, d.guardian, true);
  const childId = upsertChild(familyId, d.child);

  const submitted = (d.completedSteps ?? 0) >= (d.totalSteps ?? Number.MAX_SAFE_INTEGER);
  const leadId = upsertLead(familyId, submitted ? 'application_submitted' : 'application_started',
    env.source, env.eventId, {
      programInterest: d.programInterest, ageBand: d.child.ageBand, desiredStart: d.desiredStart,
    });

  const regId = newId();
  const now = nowIso();
  run(
    `INSERT INTO registrations (id, family_id, child_id, lead_id, status, desired_start,
       completed_steps, total_steps, payload_json, source, source_id, submitted_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    regId, familyId, childId, leadId, submitted ? 'submitted' : 'incomplete',
    d.desiredStart ?? null, d.completedSteps ?? null, d.totalSteps ?? null,
    JSON.stringify(d), env.source, env.eventId, submitted ? env.occurredAt : null, now, now,
  );
  run(`UPDATE families SET status = CASE WHEN status = 'prospective' THEN 'applying' ELSE status END,
       updated_at = ? WHERE id = ?`, now, familyId);

  const childLabel = d.child.firstName;
  recordEvent({
    entityType: 'registration', entityId: regId, type: 'created', actor: INTEGRATION,
    summary: submitted
      ? `Registration submitted for ${childLabel} via the website`
      : `Registration started for ${childLabel} (${d.completedSteps ?? 0} of ${d.totalSteps ?? '?'} steps) via the website`,
    after: { status: submitted ? 'submitted' : 'incomplete', child: childLabel, program: d.programInterest ?? null },
  });
  recordEvent({
    entityType: 'family', entityId: familyId, type: created ? 'created' : 'updated', actor: INTEGRATION,
    summary: created
      ? `Family created from a website registration for ${childLabel}`
      : `Website registration received for ${childLabel}`,
    after: { source: env.source },
  });

  indexEntity('registration', regId, `Registration: ${childLabel}`,
    [d.programInterest, d.desiredStart, d.notes].filter(Boolean).join(' '), familyId);
  indexEntity('child', childId, [d.child.firstName, d.child.lastName].filter(Boolean).join(' '),
    [d.child.ageBand, d.programInterest].filter(Boolean).join(' '), familyId);
  reindexFamily(familyId);

  // Follow-up is created here, not left to someone remembering. (spec 28)
  const due = new Date(Date.now() + (submitted ? 864e5 : 2 * 864e5)).toISOString();
  run('UPDATE leads SET next_action = ?, next_action_due = ?, next_action_reason = ?, updated_at = ? WHERE id = ?',
    submitted ? 'Review submitted registration' : 'Help the family finish their registration',
    due,
    submitted
      ? 'Registration arrived from the website and has not been reviewed'
      : `Registration stopped at step ${d.completedSteps ?? 0} of ${d.totalSteps ?? '?'}`,
    now, leadId);

  createTask({
    title: submitted ? `Review registration for ${childLabel}` : `Follow up: unfinished registration for ${childLabel}`,
    body: d.notes ? `Parent's note: ${d.notes}` : undefined,
    priority: submitted ? 'high' : 'normal',
    dueAt: due,
    relatedType: 'registration', relatedId: regId,
    source: env.source,
    reason: submitted
      ? 'A parent submitted a registration through the website'
      : 'A parent started a registration and did not finish it',
    dedupeKey: `reg:${regId}`,
  }, INTEGRATION);

  notify({
    tier: submitted ? 'high' : 'normal',
    title: submitted ? `New registration: ${childLabel}` : `Unfinished registration: ${childLabel}`,
    body: `${d.guardian.fullName}${d.programInterest ? ` - ${d.programInterest}` : ''}`,
    linkType: 'registration', linkId: regId,
    dedupeKey: `reg:${regId}`,
  });

  if (review) flagForReview(familyId, review, INTEGRATION);

  return {
    status: 'processed', eventId: env.eventId, familyId, childId, leadId,
    registrationId: regId, createdFamily: created,
    ...(review ? { needsReview: { candidates: review } } : {}),
  };
}

function handleTour(env: EventEnvelope<TourRequestData>, kind: 'tour' | 'waitlist'): IngestResult {
  const d = env.data;
  const { familyId, created, review } = resolveFamily(d.guardian, env.source, env.eventId, INTEGRATION);
  upsertGuardian(familyId, d.guardian, true);
  const childId = d.child?.firstName ? upsertChild(familyId, d.child) : undefined;
  const now = nowIso();

  const leadId = upsertLead(familyId, kind === 'tour' ? 'tour_requested' : 'waitlist',
    env.source, env.eventId, { programInterest: d.programInterest, ageBand: d.child?.ageBand });

  let tourId: string | undefined;
  if (kind === 'tour') {
    tourId = newId();
    run(
      `INSERT INTO tours (id, family_id, lead_id, status, scheduled_for, notes, source, created_at, updated_at)
       VALUES (?,?,?,'requested',?,?,?,?,?)`,
      tourId, familyId, leadId, d.preferredDates?.[0] ?? null,
      // Preferences are recorded as notes, never as a booking. Staff confirm.
      [d.notes, d.preferredDates?.length ? `Parent's preferred dates: ${d.preferredDates.join(', ')}` : null]
        .filter(Boolean).join('\n') || null,
      env.source, now, now,
    );
    run(`UPDATE families SET status = CASE WHEN status = 'prospective' THEN 'touring' ELSE status END,
         updated_at = ? WHERE id = ?`, now, familyId);
    recordEvent({
      entityType: 'tour', entityId: tourId, type: 'created', actor: INTEGRATION,
      summary: `Tour requested via the website${d.preferredDates?.length ? ` (prefers ${d.preferredDates[0]})` : ''}`,
      after: { status: 'requested', preferred: d.preferredDates ?? null },
    });
    indexEntity('tour', tourId, `Tour request: ${d.guardian.fullName}`, d.notes ?? '', familyId);
  } else {
    run(
      `INSERT INTO waitlist (id, family_id, child_id, status, added_at, notes, created_at, updated_at)
       VALUES (?,?,?,'waiting',?,?,?,?)`,
      newId(), familyId, childId ?? null, now, d.notes ?? null, now, now,
    );
    run(`UPDATE families SET status = 'waitlisted', updated_at = ? WHERE id = ?`, now, familyId);
  }

  recordEvent({
    entityType: 'family', entityId: familyId, type: created ? 'created' : 'updated', actor: INTEGRATION,
    summary: created
      ? `Family created from a website ${kind} request`
      : `Website ${kind} request received`,
    after: { source: env.source },
  });
  reindexFamily(familyId);

  const due = new Date(Date.now() + 864e5).toISOString();
  run('UPDATE leads SET next_action = ?, next_action_due = ?, next_action_reason = ?, updated_at = ? WHERE id = ?',
    kind === 'tour' ? 'Confirm a tour time with the family' : 'Acknowledge the waitlist request',
    due, `Website ${kind} request arrived and has not been answered`, now, leadId);

  createTask({
    title: kind === 'tour'
      ? `Confirm tour time with ${d.guardian.fullName}`
      : `Acknowledge waitlist request from ${d.guardian.fullName}`,
    priority: 'high', dueAt: due,
    relatedType: kind === 'tour' ? 'tour' : 'family',
    relatedId: tourId ?? familyId,
    source: env.source,
    reason: `A parent requested a ${kind} through the website`,
    dedupeKey: `${kind}:${tourId ?? familyId}`,
  }, INTEGRATION);

  notify({
    tier: 'high',
    title: kind === 'tour' ? `Tour requested: ${d.guardian.fullName}` : `Waitlist request: ${d.guardian.fullName}`,
    body: d.preferredDates?.length ? `Prefers ${d.preferredDates.join(', ')}` : (d.notes ?? undefined),
    linkType: kind === 'tour' ? 'tour' : 'family',
    linkId: tourId ?? familyId,
    dedupeKey: `${kind}:${tourId ?? familyId}`,
  });

  if (review) flagForReview(familyId, review, INTEGRATION);

  return {
    status: 'processed', eventId: env.eventId, familyId, leadId, createdFamily: created,
    ...(childId ? { childId } : {}), ...(tourId ? { tourId } : {}),
    ...(review ? { needsReview: { candidates: review } } : {}),
  };
}

function handleContact(env: EventEnvelope<ContactData>): IngestResult {
  const d = env.data;
  const { familyId, created, review } = resolveFamily(d.guardian, env.source, env.eventId, INTEGRATION);
  upsertGuardian(familyId, d.guardian, true);
  const now = nowIso();
  const leadId = upsertLead(familyId, 'new', env.source, env.eventId, {});

  run('INSERT INTO notes (id, entity_type, entity_id, body, created_at) VALUES (?,?,?,?,?)',
    newId(), 'family', familyId,
    `Website enquiry${d.subject ? ` - ${d.subject}` : ''}\n\n${d.message}`, now);

  recordEvent({
    entityType: 'family', entityId: familyId, type: created ? 'created' : 'updated', actor: INTEGRATION,
    summary: created ? 'Family created from a website enquiry' : 'Website enquiry received',
    after: { subject: d.subject ?? null },
  });
  reindexFamily(familyId);

  const due = new Date(Date.now() + 864e5).toISOString();
  run('UPDATE leads SET next_action = ?, next_action_due = ?, next_action_reason = ?, updated_at = ? WHERE id = ?',
    'Reply to the enquiry', due, 'A website enquiry has not been answered', now, leadId);

  createTask({
    title: `Reply to ${d.guardian.fullName}`,
    body: d.message, priority: 'normal', dueAt: due,
    relatedType: 'family', relatedId: familyId, source: env.source,
    reason: 'A parent sent an enquiry through the website',
    dedupeKey: `contact:${env.eventId}`,
  }, INTEGRATION);

  notify({
    tier: 'normal', title: `Website enquiry: ${d.guardian.fullName}`,
    body: d.subject ?? d.message.slice(0, 120),
    linkType: 'family', linkId: familyId, dedupeKey: `contact:${env.eventId}`,
  });

  if (review) flagForReview(familyId, review, INTEGRATION);

  return {
    status: 'processed', eventId: env.eventId, familyId, leadId, createdFamily: created,
    ...(review ? { needsReview: { candidates: review } } : {}),
  };
}
