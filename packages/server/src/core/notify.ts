/**
 * Notifications and tasks.
 *
 * A notification has to earn the interruption. Two rules enforce that here:
 * every one carries a deep link to the exact record (no "go check the
 * dashboard"), and every one carries a dedupe key so five related events
 * collapse into one alert instead of five. (spec 66 / 71 / 72)
 */
import { one, many, run } from '../db/index.ts';
import { newId, nowIso, plainAll } from './util.ts';
import { indexEntity, familyForRelated } from './search.ts';
import { recordEvent, type Actor, SYSTEM } from './events.ts';

export type Tier = 'critical' | 'high' | 'normal' | 'digest' | 'log';

export interface NotifyInput {
  tier: Tier;
  title: string;
  body?: string;
  /** Required together. A notification that cannot open the record it is about
   *  is a to-do list for the reader, not a notification. */
  linkType: string;
  linkId: string;
  userId?: string | null;
  dedupeKey?: string;
}

export function notify(n: NotifyInput): string | null {
  const now = nowIso();
  if (n.dedupeKey) {
    const existing = one<{ id: string; state: string }>(
      'SELECT id, state FROM notifications WHERE dedupe_key = ?', n.dedupeKey);
    if (existing) {
      // Refresh an unread one rather than stacking a second copy. If the user
      // already dealt with it, do not resurrect it.
      if (existing.state === 'unread') {
        run('UPDATE notifications SET title = ?, body = ?, tier = ?, updated_at = ? WHERE id = ?',
          n.title, n.body ?? null, n.tier, now, existing.id);
      }
      return existing.id;
    }
  }
  const id = newId();
  run(
    `INSERT INTO notifications (id, tier, title, body, link_type, link_id, user_id, dedupe_key, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'unread',?,?)`,
    id, n.tier, n.title, n.body ?? null, n.linkType, n.linkId, n.userId ?? null, n.dedupeKey ?? null, now, now,
  );
  return id;
}

export function unreadFor(userId: string | null, limit = 50) {
  return plainAll(many(
    `SELECT * FROM notifications
      WHERE state IN ('unread','snoozed')
        AND (user_id IS NULL OR user_id = ?)
        AND (snoozed_until IS NULL OR snoozed_until <= ?)
      ORDER BY CASE tier WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               created_at DESC
      LIMIT ?`,
    userId, nowIso(), limit,
  ));
}

/** State transitions feed the alert-fatigue record: what got acted on vs
 *  dismissed is the only honest input for tuning this later. (spec 69/155) */
export function setNotificationState(
  id: string, state: 'read' | 'acted' | 'dismissed' | 'snoozed', snoozeUntil?: string,
): boolean {
  return run('UPDATE notifications SET state = ?, snoozed_until = ?, updated_at = ? WHERE id = ?',
    state, snoozeUntil ?? null, nowIso(), id).changes > 0;
}

// ---------------------------------------------------------------------- tasks

export interface TaskInput {
  title: string;
  body?: string;
  ownerId?: string | null;
  priority?: 'critical' | 'high' | 'normal' | 'low';
  dueAt?: string | null;
  relatedType?: string;
  relatedId?: string;
  source?: string;
  /** Why this task exists, shown verbatim. A task with no reason is noise. */
  reason?: string;
  createdBy?: string | null;
  /** When set, creating the same logical task twice is a no-op. */
  dedupeKey?: string;
}

export function createTask(t: TaskInput, actor: Actor = SYSTEM): string {
  if (t.dedupeKey && t.relatedId) {
    const dup = one<{ id: string }>(
      `SELECT id FROM tasks WHERE related_id = ? AND title = ? AND status IN ('open','doing')`,
      t.relatedId, t.title);
    if (dup) return dup.id;
  }
  const id = newId();
  const now = nowIso();
  run(
    `INSERT INTO tasks (id, title, body, owner_id, priority, status, due_at, related_type, related_id, source, reason, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`,
    id, t.title, t.body ?? null, t.ownerId ?? null, t.priority ?? 'normal',
    t.dueAt ?? null, t.relatedType ?? null, t.relatedId ?? null,
    t.source ?? 'manual', t.reason ?? null, t.createdBy ?? null, now, now,
  );
  indexEntity('task', id, t.title, [t.body, t.reason].filter(Boolean).join(' '),
    familyForRelated(t.relatedType, t.relatedId));
  recordEvent({
    entityType: 'task', entityId: id, type: 'created', actor,
    summary: `Task created: ${t.title}`,
    after: { title: t.title, status: 'open', due_at: t.dueAt ?? null, priority: t.priority ?? 'normal' },
  });
  return id;
}

export function completeTask(id: string, actor: Actor): boolean {
  const before = one<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id);
  if (!before) return false;
  const now = nowIso();
  run('UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?', 'done', now, now, id);
  recordEvent({
    entityType: 'task', entityId: id, type: 'status_changed', actor,
    summary: `Task completed: ${before.title as string}`,
    before: { status: before.status }, after: { status: 'done' },
  });
  return true;
}
