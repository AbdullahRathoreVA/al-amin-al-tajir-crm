/**
 * The event store. Every consequential change goes through recordEvent() inside
 * the same transaction as the change itself, so the log can never disagree with
 * the data. That single property is what makes audit, undo, the family timeline
 * and "what changed today" all fall out of one table. (spec 34 / 140)
 */
import { one, many, run } from '../db/index.ts';
import { newId, nowIso, plainAll, safeJson } from './util.ts';

export type ActorType = 'user' | 'system' | 'integration' | 'ai';

export interface Actor { type: ActorType; id: string | null; source?: string }

export const SYSTEM: Actor = { type: 'system', id: null, source: 'manual' };

export interface EventInput {
  entityType: string;
  entityId: string;
  type: string;
  actor: Actor;
  /** One human-readable line. This is what a person reads in the timeline, so
   *  write it for them: "Tour moved to Thursday 10:00", not "status=scheduled". */
  summary: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

export function recordEvent(e: EventInput): string {
  const id = newId();
  run(
    `INSERT INTO events (id, entity_type, entity_id, type, actor_type, actor_id, source, summary, before_json, after_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, e.entityType, e.entityId, e.type, e.actor.type, e.actor.id,
    e.actor.source ?? 'manual', e.summary,
    e.before ? JSON.stringify(e.before) : null,
    e.after ? JSON.stringify(e.after) : null,
    nowIso(),
  );
  return id;
}

export interface EventRow {
  seq: number; id: string; entity_type: string; entity_id: string; type: string;
  actor_type: ActorType; actor_id: string | null; source: string;
  summary: string | null; before_json: string | null; after_json: string | null; created_at: string;
}

export function timelineFor(entityType: string, entityId: string, limit = 100): EventRow[] {
  return plainAll(many<EventRow>(
    `SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT ?`,
    entityType, entityId, limit,
  ));
}

/**
 * A family's timeline pulls in everything hanging off it, not just events whose
 * entity_id is the family. A tour rescheduled is family news. (spec 146)
 */
export function familyTimeline(familyId: string, limit = 200): EventRow[] {
  return plainAll(many<EventRow>(
    `SELECT e.* FROM events e
     WHERE (e.entity_type = 'family' AND e.entity_id = ?)
        OR e.entity_id IN (
             SELECT id FROM children      WHERE family_id = ?
       UNION SELECT id FROM guardians     WHERE family_id = ?
       UNION SELECT id FROM leads         WHERE family_id = ?
       UNION SELECT id FROM tours         WHERE family_id = ?
       UNION SELECT id FROM registrations WHERE family_id = ?
       UNION SELECT id FROM waitlist      WHERE family_id = ?
     )
     ORDER BY e.seq DESC LIMIT ?`,
    familyId, familyId, familyId, familyId, familyId, familyId, familyId, limit,
  ));
}

/** Everything since a point in time, for "what changed?". (spec 209) */
export function changesSince(sinceIso: string, limit = 500): EventRow[] {
  return plainAll(many<EventRow>(
    'SELECT * FROM events WHERE created_at >= ? ORDER BY seq DESC LIMIT ?', sinceIso, limit,
  ));
}

/**
 * Reconstructs an entity as it stood at a moment, by walking its events
 * backwards and un-applying each after->before. Only as good as what the write
 * paths recorded, which is why they record full before/after. (spec 35)
 */
export function stateAt(entityType: string, entityId: string, atIso: string): Record<string, unknown> | null {
  const current = one<Record<string, unknown>>(
    `SELECT after_json FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY seq DESC LIMIT 1`,
    entityType, entityId,
  );
  if (!current) return null;
  let state = safeJson<Record<string, unknown>>(current.after_json as string | null, {});
  const newer = many<EventRow>(
    `SELECT * FROM events WHERE entity_type = ? AND entity_id = ? AND created_at > ? ORDER BY seq DESC`,
    entityType, entityId, atIso,
  );
  for (const ev of newer) {
    const before = safeJson<Record<string, unknown> | null>(ev.before_json, null);
    if (before === null) return null; // created after the target moment
    state = { ...state, ...before };
  }
  return state;
}

/** Field-level diff, used for the audit view and undo. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const out: { field: string; from: unknown; to: unknown }[] = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const f = before?.[k] ?? null;
    const t = after?.[k] ?? null;
    if (JSON.stringify(f) !== JSON.stringify(t)) out.push({ field: k, from: f, to: t });
  }
  return out;
}

/** Reads are not changes, but reading a child record is still answerable. */
export function logAccess(
  userId: string | null, action: string,
  entityType?: string, entityId?: string, detail?: string,
): void {
  run(
    'INSERT INTO access_log (id, user_id, action, entity_type, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)',
    newId(), userId, action, entityType ?? null, entityId ?? null, detail ?? null, nowIso(),
  );
}

/**
 * What the append-only log still remembers about a record that is no longer in
 * its table.
 *
 * The log outlives the row it describes, which is the whole point of it being
 * append-only. So when a lookup misses, there are two very different answers:
 * "that identifier was never real" and "that was deleted on Tuesday". Returning
 * "not found" for both sends someone hunting for a broken link when the honest
 * answer is that the record is gone and the log knows exactly when.
 *
 * This is not hypothetical. A task in the attention radar outlived the
 * registration it pointed at, and following it reported "No such registration".
 */
export function historyOf(
  entityType: string,
  entityId: string,
): { created: string; last: string; lastSummary: string | null } | null {
  const row = one<{ created: string | null; last: string | null; lastSummary: string | null }>(
    `SELECT MIN(created_at) AS created,
            MAX(created_at) AS last,
            (SELECT summary FROM events WHERE entity_type = ? AND entity_id = ?
              ORDER BY seq DESC LIMIT 1) AS lastSummary
       FROM events WHERE entity_type = ? AND entity_id = ?`,
    entityType, entityId, entityType, entityId,
  );
  if (!row?.created || !row.last) return null;
  return { created: row.created, last: row.last, lastSummary: row.lastSummary };
}
