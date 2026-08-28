/**
 * API v1. Versioned in the path so the website is not broken by CRM changes.
 * (spec 118 / 197)
 */
import { Router, badRequest, notFound, forbidden, verifySignature, type Ctx } from './http.ts';
import { one, many, run, tx } from './db/index.ts';
import { config } from './core/config.ts';
import { newId, nowIso, plain, plainAll, safeJson } from './core/util.ts';
import { login, logout, capabilitiesFor, canSeeSensitive, can, sessionsFor, revokeSession } from './core/auth.ts';
import { recordEvent, familyTimeline, timelineFor, changesSince, diff, logAccess, type Actor } from './core/events.ts';
import { search as fullTextSearch, indexEntity, type Indexable } from './core/search.ts';
import { notify, unreadFor, setNotificationState, createTask, completeTask } from './core/notify.ts';
import {
  todaySummary, attention, pipeline, programHealth, dataHealth, systemHealth,
  toursToday, overdueFollowUps,
} from './core/queries.ts';
import { validateEnvelope } from '@crm/shared';
import { analyticsBundle, isWindow, type Window } from './core/analytics.ts';
import { ingest } from './ingest/pipeline.ts';

export const router = new Router();

const actorOf = (c: Ctx): Actor => ({ type: 'user', id: c.user?.id ?? null, source: 'manual' });

function requireBody<T extends Record<string, unknown>>(c: Ctx): T {
  if (!c.body || typeof c.body !== 'object') throw badRequest('A JSON object body is required');
  return c.body as T;
}

const intParam = (v: string | null, dflt: number, max = 200): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

// ------------------------------------------------------------------ auth

router.post('/api/v1/auth/login', (c) => {
  const b = requireBody<{ email?: string; password?: string }>(c);
  if (!b.email || !b.password) throw badRequest('Email and password are required');
  const result = login(b.email, b.password, c.req.headers['user-agent']);
  if (!result) throw badRequest('That email and password do not match');
  c.setCookie('crm_session', result.token, { expires: result.expiresAt });
  logAccess(result.user.id, 'login');
  return { user: result.user, capabilities: capabilitiesFor(result.user.role) };
}, { anonymous: true });

router.post('/api/v1/auth/logout', (c) => {
  if (c.cookies.crm_session) logout(c.cookies.crm_session);
  logAccess(c.user?.id ?? null, 'logout');
  c.clearCookie('crm_session');
  return { ok: true };
});

router.get('/api/v1/auth/me', (c) => ({
  user: c.user,
  capabilities: capabilitiesFor(c.user!.role),
  mode: config.mode,
  sessions: sessionsFor(c.user!.id),
}));

router.del('/api/v1/auth/sessions/:id', (c) => {
  if (!revokeSession(c.params.id!, c.user!.id)) throw notFound('No such active session');
  return { ok: true };
});

// ------------------------------------------------------------- dashboard

router.get('/api/v1/dashboard', (c) => {
  logAccess(c.user!.id, 'view_dashboard');
  return {
    mode: config.mode,
    today: todaySummary(),
    attention: attention(),
    pipeline: pipeline(),
    programs: programHealth(),
    dataHealth: dataHealth(),
    toursToday: toursToday(),
    overdueFollowUps: overdueFollowUps(10),
    notifications: unreadFor(c.user!.id, 20),
    generatedAt: nowIso(),
  };
});

router.get('/api/v1/system/health', (c) => {
  c.require('audit:read');
  return {
    checks: systemHealth(),
    outbox: plainAll(many('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 50')),
    ingest: plainAll(many('SELECT * FROM ingest_events ORDER BY received_at DESC LIMIT 50')),
    mode: config.mode,
  };
});

// ---------------------------------------------------------------- search

router.get('/api/v1/search', (c) => {
  const q = c.query.get('q')?.trim() ?? '';
  if (q.length < 2) return { query: q, results: [] };
  const typesParam = c.query.get('types');
  const types = typesParam ? (typesParam.split(',') as Indexable[]) : undefined;
  const results = fullTextSearch(q, intParam(c.query.get('limit'), 25), types);
  logAccess(c.user!.id, 'search', undefined, undefined, q.slice(0, 80));
  return { query: q, results };
});

// -------------------------------------------------------------- families

router.get('/api/v1/families', (c) => {
  c.require('family:read');
  const filter = c.query.get('filter');
  const status = c.query.get('status');
  const limit = intParam(c.query.get('limit'), 50);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (status) { where.push('f.status = ?'); params.push(status); }
  if (filter === 'duplicates') {
    where.push(`EXISTS (SELECT 1 FROM tasks t WHERE t.related_id = f.id AND t.title LIKE 'Possible duplicate%' AND t.status IN ('open','doing'))`);
  }
  if (filter === 'no-contact') {
    where.push(`NOT EXISTS (SELECT 1 FROM guardians g WHERE g.family_id = f.id AND (g.email IS NOT NULL OR g.phone IS NOT NULL))`);
  }
  if (filter === 'no-children') {
    where.push('NOT EXISTS (SELECT 1 FROM children c WHERE c.family_id = f.id)');
  }
  const sql = `
    SELECT f.id, f.name, f.status, f.source, f.owner_id, f.created_at, f.updated_at,
           (SELECT COUNT(*) FROM children c WHERE c.family_id = f.id) AS children_count,
           (SELECT g.first_name || COALESCE(' ' || g.last_name, '') FROM guardians g
             WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS primary_contact,
           (SELECT g.email FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS email,
           (SELECT g.phone FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS phone,
           (SELECT e.summary FROM events e WHERE e.entity_type='family' AND e.entity_id=f.id ORDER BY e.seq DESC LIMIT 1) AS latest_activity
      FROM families f
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY f.updated_at DESC LIMIT ?`;
  return { families: plainAll(many(sql, ...params, limit)) };
});

router.get('/api/v1/families/:id', (c) => {
  c.require('family:read');
  const id = c.params.id!;
  const family = plain(one('SELECT * FROM families WHERE id = ?', id));
  if (!family) throw notFound('No such family');

  const sensitive = canSeeSensitive(c.user);
  // A date of birth is not shown to roles that have no operational need for it.
  // The column is omitted entirely rather than nulled, so the UI cannot
  // accidentally render an empty field as "not recorded". (spec 164)
  const childCols = sensitive
    ? 'id, first_name, last_name, date_of_birth, age_band, program_id, classroom_id, status, notes, created_at'
    : 'id, first_name, last_name, age_band, program_id, classroom_id, status, notes, created_at';

  logAccess(c.user!.id, sensitive ? 'view_family_sensitive' : 'view_family', 'family', id);

  return {
    family,
    guardians: plainAll(many('SELECT * FROM guardians WHERE family_id = ? ORDER BY is_primary DESC, created_at', id)),
    children: plainAll(many(`SELECT ${childCols} FROM children WHERE family_id = ? ORDER BY created_at`, id)),
    leads: plainAll(many(
      `SELECT l.*, s.label AS stage_label FROM leads l JOIN lead_stages s ON s.id = l.stage_id
        WHERE l.family_id = ? ORDER BY l.created_at DESC`, id)),
    tours: plainAll(many('SELECT * FROM tours WHERE family_id = ? ORDER BY COALESCE(scheduled_for, created_at) DESC', id)),
    registrations: plainAll(many('SELECT * FROM registrations WHERE family_id = ? ORDER BY created_at DESC', id)),
    waitlist: plainAll(many('SELECT * FROM waitlist WHERE family_id = ? ORDER BY added_at DESC', id)),
    tasks: plainAll(many(
      `SELECT * FROM tasks WHERE related_id = ? OR related_id IN (SELECT id FROM tours WHERE family_id = ?)
        ORDER BY status, due_at`, id, id)),
    notes: plainAll(many(
      `SELECT n.*, u.name AS author_name FROM notes n LEFT JOIN users u ON u.id = n.author_id
        WHERE n.entity_type = 'family' AND n.entity_id = ? ORDER BY n.created_at DESC`, id)),
    timeline: familyTimeline(id, 100),
    sensitiveVisible: sensitive,
  };
});

router.patch('/api/v1/families/:id', (c) => {
  c.require('family:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM families WHERE id = ?', id));
  if (!before) throw notFound('No such family');
  const b = requireBody<Record<string, unknown>>(c);

  const allowed = ['name', 'status', 'owner_id', 'local_only', 'no_ai', 'no_sync'] as const;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const k of allowed) {
    if (b[k] === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(typeof b[k] === 'boolean' ? (b[k] ? 1 : 0) : (b[k] as string | number | null));
  }
  if (!sets.length) throw badRequest('Nothing to update');

  tx(() => {
    run(`UPDATE families SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...params, nowIso(), c.user!.id, id);
    const after = plain(one<Record<string, unknown>>('SELECT * FROM families WHERE id = ?', id))!;
    const changed = diff(before, after);
    recordEvent({
      entityType: 'family', entityId: id, type: 'updated', actor: actorOf(c),
      summary: changed.map((d) => `${d.field}: ${String(d.from ?? 'empty')} to ${String(d.to ?? 'empty')}`).join('; ') || 'Updated',
      before, after,
    });
  });
  return plain(one('SELECT * FROM families WHERE id = ?', id));
});

// ----------------------------------------------------------------- leads

router.get('/api/v1/leads', (c) => {
  c.require('lead:read');
  const filter = c.query.get('filter');
  const stage = c.query.get('stage');
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (stage) { where.push('l.stage_id = ?'); params.push(stage); }
  if (filter === 'overdue') { where.push('l.next_action_due IS NOT NULL AND l.next_action_due < ?'); params.push(nowIso()); }
  if (filter === 'unowned') where.push('l.owner_id IS NULL AND s.is_open = 1');
  if (filter === 'open') where.push('s.is_open = 1');
  if (filter === 'stale') {
    where.push('s.is_open = 1 AND l.updated_at < ?');
    params.push(new Date(Date.now() - 30 * 864e5).toISOString());
  }
  return {
    leads: plainAll(many(
      `SELECT l.*, s.label AS stage_label, s.sort_order, f.name AS family_name, u.name AS owner_name
         FROM leads l
         JOIN lead_stages s ON s.id = l.stage_id
         JOIN families f ON f.id = l.family_id
         LEFT JOIN users u ON u.id = l.owner_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY s.sort_order, COALESCE(l.next_action_due, l.updated_at)
        LIMIT ?`, ...params, intParam(c.query.get('limit'), 100))),
    stages: pipeline(),
  };
});

router.patch('/api/v1/leads/:id', (c) => {
  c.require('lead:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM leads WHERE id = ?', id));
  if (!before) throw notFound('No such lead');
  const b = requireBody<Record<string, unknown>>(c);

  const allowed = ['stage_id', 'owner_id', 'program_interest', 'desired_start',
    'next_action', 'next_action_due', 'next_action_reason', 'last_contact_at'] as const;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const k of allowed) {
    if (b[k] === undefined) continue;
    sets.push(`${k} = ?`);
    params.push(b[k] as string | null);
  }
  if (!sets.length) throw badRequest('Nothing to update');

  tx(() => {
    run(`UPDATE leads SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...params, nowIso(), c.user!.id, id);
    const after = plain(one<Record<string, unknown>>('SELECT * FROM leads WHERE id = ?', id))!;
    const stageChanged = before.stage_id !== after.stage_id;
    const label = stageChanged
      ? one<{ label: string }>('SELECT label FROM lead_stages WHERE id = ?', after.stage_id as string)?.label
      : null;
    recordEvent({
      entityType: 'lead', entityId: id, type: stageChanged ? 'status_changed' : 'updated', actor: actorOf(c),
      summary: stageChanged ? `Lead moved to ${label ?? after.stage_id}` : 'Lead updated',
      before, after,
    });
  });
  return plain(one('SELECT * FROM leads WHERE id = ?', id));
});

// ----------------------------------------------------------------- tours

router.get('/api/v1/tours', (c) => {
  c.require('tour:read');
  const filter = c.query.get('filter');
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter === 'today') {
    const s = new Date(); s.setHours(0, 0, 0, 0);
    const e = new Date(); e.setHours(23, 59, 59, 999);
    where.push('t.scheduled_for BETWEEN ? AND ?'); params.push(s.toISOString(), e.toISOString());
  }
  if (filter === 'requested') where.push(`t.status = 'requested'`);
  if (filter === 'upcoming') { where.push('t.scheduled_for >= ?'); params.push(nowIso()); }
  return {
    tours: plainAll(many(
      `SELECT t.*, f.name AS family_name, u.name AS owner_name,
              (SELECT g.phone FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS phone,
              (SELECT g.email FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS email
         FROM tours t JOIN families f ON f.id = t.family_id LEFT JOIN users u ON u.id = t.owner_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(t.scheduled_for, t.created_at) DESC LIMIT ?`,
      ...params, intParam(c.query.get('limit'), 100))),
  };
});

router.patch('/api/v1/tours/:id', (c) => {
  c.require('tour:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM tours WHERE id = ?', id));
  if (!before) throw notFound('No such tour');
  const b = requireBody<Record<string, unknown>>(c);

  const allowed = ['status', 'scheduled_for', 'owner_id', 'notes', 'completed_at'] as const;
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const k of allowed) {
    if (b[k] === undefined) continue;
    sets.push(`${k} = ?`); params.push(b[k] as string | null);
  }
  if (!sets.length) throw badRequest('Nothing to update');

  tx(() => {
    run(`UPDATE tours SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
    const after = plain(one<Record<string, unknown>>('SELECT * FROM tours WHERE id = ?', id))!;
    recordEvent({
      entityType: 'tour', entityId: id, type: before.status !== after.status ? 'status_changed' : 'updated',
      actor: actorOf(c),
      summary: before.status !== after.status
        ? `Tour ${String(after.status)}${after.scheduled_for ? ` for ${new Date(after.scheduled_for as string).toLocaleString()}` : ''}`
        : 'Tour updated',
      before, after,
    });

    // A completed tour always leaves a next step behind. (spec 77)
    if (after.status === 'completed' && before.status !== 'completed') {
      const due = new Date(Date.now() + 2 * 864e5).toISOString();
      const fam = one<{ name: string }>('SELECT name FROM families WHERE id = ?', after.family_id as string);
      createTask({
        title: `Follow up after tour: ${fam?.name ?? 'family'}`,
        priority: 'high', dueAt: due,
        relatedType: 'family', relatedId: after.family_id as string,
        source: 'system',
        reason: 'A tour was completed and the family has no next step recorded',
        dedupeKey: `tour-followup:${id}`,
      }, actorOf(c));
      if (after.lead_id) {
        run('UPDATE leads SET next_action = ?, next_action_due = ?, next_action_reason = ?, updated_at = ? WHERE id = ?',
          'Follow up after the tour', due, 'Tour completed, no follow-up logged yet', nowIso(), after.lead_id as string);
      }
    }
  });
  return plain(one('SELECT * FROM tours WHERE id = ?', id));
});

// --------------------------------------------------------- registrations

router.get('/api/v1/registrations', (c) => {
  c.require('registration:read');
  const filter = c.query.get('filter');
  const where: string[] = [];
  if (filter === 'incomplete') where.push(`r.status = 'incomplete'`);
  if (filter === 'submitted') where.push(`r.status = 'submitted'`);
  return {
    registrations: plainAll(many(
      `SELECT r.id, r.status, r.desired_start, r.completed_steps, r.total_steps, r.source,
              r.submitted_at, r.created_at, r.updated_at,
              f.id AS family_id, f.name AS family_name,
              ch.first_name AS child_first_name, ch.age_band
         FROM registrations r
         JOIN families f ON f.id = r.family_id
         LEFT JOIN children ch ON ch.id = r.child_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.created_at DESC LIMIT ?`, intParam(c.query.get('limit'), 100))),
  };
});

router.get('/api/v1/registrations/:id', (c) => {
  c.require('registration:read');
  const id = c.params.id!;
  const reg = plain(one<Record<string, unknown>>(
    `SELECT r.*, f.name AS family_name FROM registrations r JOIN families f ON f.id = r.family_id WHERE r.id = ?`, id));
  if (!reg) throw notFound('No such registration');
  logAccess(c.user!.id, 'view_registration', 'registration', id);

  const payload = safeJson<Record<string, unknown>>(reg.payload_json as string, {});
  // The raw payload can contain a DOB the parent typed. Strip it for roles that
  // are not cleared for it, same rule as the child record itself.
  if (!canSeeSensitive(c.user) && payload.child && typeof payload.child === 'object') {
    const { dateOfBirth: _hidden, ...rest } = payload.child as Record<string, unknown>;
    payload.child = rest;
  }
  return { registration: { ...reg, payload_json: undefined }, payload, timeline: timelineFor('registration', id, 50) };
});

router.patch('/api/v1/registrations/:id', (c) => {
  c.require('registration:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM registrations WHERE id = ?', id));
  if (!before) throw notFound('No such registration');
  const b = requireBody<{ status?: string; program_id?: string | null; desired_start?: string | null }>(c);
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (b.status !== undefined) { sets.push('status = ?'); params.push(b.status); }
  if (b.program_id !== undefined) { sets.push('program_id = ?'); params.push(b.program_id); }
  if (b.desired_start !== undefined) { sets.push('desired_start = ?'); params.push(b.desired_start); }
  if (!sets.length) throw badRequest('Nothing to update');

  tx(() => {
    run(`UPDATE registrations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
    const after = plain(one<Record<string, unknown>>('SELECT * FROM registrations WHERE id = ?', id))!;
    recordEvent({
      entityType: 'registration', entityId: id, type: 'status_changed', actor: actorOf(c),
      summary: `Registration ${String(after.status)}`, before, after,
    });
  });
  return plain(one('SELECT * FROM registrations WHERE id = ?', id));
});

// ----------------------------------------------------------------- tasks

router.get('/api/v1/tasks', (c) => {
  c.require('task:read');
  const filter = c.query.get('filter');
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter === 'overdue') { where.push(`t.status IN ('open','doing') AND t.due_at < ?`); params.push(nowIso()); }
  else if (filter === 'mine') { where.push(`t.owner_id = ? AND t.status IN ('open','doing')`); params.push(c.user!.id); }
  else if (filter === 'done') where.push(`t.status = 'done'`);
  else where.push(`t.status IN ('open','doing')`);
  return {
    tasks: plainAll(many(
      `SELECT t.*, u.name AS owner_name FROM tasks t LEFT JOIN users u ON u.id = t.owner_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                 COALESCE(t.due_at, '9999') LIMIT ?`,
      ...params, intParam(c.query.get('limit'), 100))),
  };
});

router.post('/api/v1/tasks', (c) => {
  c.require('task:write');
  const b = requireBody<{ title?: string; body?: string; ownerId?: string; priority?: string;
    dueAt?: string; relatedType?: string; relatedId?: string; reason?: string }>(c);
  if (!b.title?.trim()) throw badRequest('A task needs a title');
  const id = createTask({
    title: b.title.trim(), body: b.body, ownerId: b.ownerId ?? c.user!.id,
    priority: (b.priority as 'critical' | 'high' | 'normal' | 'low') ?? 'normal',
    dueAt: b.dueAt ?? null, relatedType: b.relatedType, relatedId: b.relatedId,
    source: 'manual', reason: b.reason, createdBy: c.user!.id,
  }, actorOf(c));
  return plain(one('SELECT * FROM tasks WHERE id = ?', id));
});

router.patch('/api/v1/tasks/:id', (c) => {
  c.require('task:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id));
  if (!before) throw notFound('No such task');
  const b = requireBody<Record<string, unknown>>(c);

  if (b.status === 'done') { completeTask(id, actorOf(c)); return plain(one('SELECT * FROM tasks WHERE id = ?', id)); }

  const allowed = ['title', 'body', 'owner_id', 'priority', 'status', 'due_at'] as const;
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const k of allowed) {
    if (b[k] === undefined) continue;
    sets.push(`${k} = ?`); params.push(b[k] as string | null);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  tx(() => {
    run(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
    const after = plain(one<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id))!;
    if (typeof after.title === 'string') indexEntity('task', id, after.title, String(after.body ?? ''));
    recordEvent({
      entityType: 'task', entityId: id, type: 'updated', actor: actorOf(c),
      summary: `Task updated: ${String(after.title)}`, before, after,
    });
  });
  return plain(one('SELECT * FROM tasks WHERE id = ?', id));
});

// ----------------------------------------------------------------- notes

router.post('/api/v1/notes', (c) => {
  c.require('note:write');
  const b = requireBody<{ entityType?: string; entityId?: string; body?: string }>(c);
  if (!b.entityType || !b.entityId || !b.body?.trim()) {
    throw badRequest('entityType, entityId and body are all required');
  }
  // Narrowed once, so these are plain strings rather than string|undefined
  // threaded through every call below.
  const entityType = b.entityType;
  const entityId = b.entityId;
  const noteBody = b.body.trim();
  const id = newId();
  const now = nowIso();
  tx(() => {
    run('INSERT INTO notes (id, entity_type, entity_id, body, author_id, created_at) VALUES (?,?,?,?,?,?)',
      id, entityType, entityId, noteBody, c.user!.id, now);
    indexEntity('note', id, `Note on ${entityType}`, noteBody);
    recordEvent({
      entityType, entityId, type: 'note_added', actor: actorOf(c),
      summary: `Note added: ${noteBody.slice(0, 80)}`,
    });
  });
  return plain(one('SELECT * FROM notes WHERE id = ?', id));
});

// --------------------------------------------------------- notifications

router.get('/api/v1/notifications', (c) => ({ notifications: unreadFor(c.user!.id, 50) }));

router.patch('/api/v1/notifications/:id', (c) => {
  const b = requireBody<{ state?: string; snoozeUntil?: string }>(c);
  const valid = ['read', 'acted', 'dismissed', 'snoozed'] as const;
  if (!b.state || !valid.includes(b.state as (typeof valid)[number])) {
    throw badRequest(`state must be one of: ${valid.join(', ')}`);
  }
  if (!setNotificationState(c.params.id!, b.state as (typeof valid)[number], b.snoozeUntil)) {
    throw notFound('No such notification');
  }
  return { ok: true };
});

// ---------------------------------------------------------------- events

router.get('/api/v1/events', (c) => {
  c.require('audit:read');
  const since = c.query.get('since');
  return {
    events: since ? changesSince(since, intParam(c.query.get('limit'), 200))
      : plainAll(many('SELECT * FROM events ORDER BY seq DESC LIMIT ?', intParam(c.query.get('limit'), 100))),
  };
});

router.get('/api/v1/events/:type/:id', (c) => {
  c.require('audit:read');
  return { events: timelineFor(c.params.type!, c.params.id!, intParam(c.query.get('limit'), 100)) };
});

// ------------------------------------------------------------------ meta

router.get('/api/v1/meta', (c) => ({
  mode: config.mode,
  stages: pipeline(),
  programs: plainAll(many('SELECT id, slug, name, age_label, capacity FROM programs WHERE active = 1 ORDER BY sort_order')),
  users: can(c.user, 'user:manage') || can(c.user, 'family:write')
    ? plainAll(many(`SELECT id, name, role FROM users WHERE status = 'active' ORDER BY name`))
    : [],
  contractVersion: 1,
}));

// ------------------------------------------------------------- analytics

router.get('/api/v1/analytics', (c) => {
  // Website behaviour is business data, not family data, so it sits behind
  // audit:read rather than one of the family capabilities.
  c.require('audit:read');
  const w = c.query.get('window');
  return analyticsBundle(isWindow(w) ? (w as Window) : '30d');
});

// ---------------------------------------------------------------- ingest

/**
 * The website's entry point. Anonymous in the session sense, authenticated by
 * an HMAC signature over the exact raw body. (spec 33)
 */
router.post('/api/v1/ingest', (c) => {
  if (!config.ingestSecret) {
    throw forbidden('Inbound events are disabled: CRM_INGEST_SECRET is not set on this server.');
  }
  const sig = c.req.headers['x-crm-signature'];
  if (!verifySignature(c.rawBody, Array.isArray(sig) ? sig[0] : sig, config.ingestSecret)) {
    throw forbidden('Invalid or missing signature');
  }
  // Replay window. A captured request cannot be replayed indefinitely.
  const tsHeader = c.req.headers['x-crm-timestamp'];
  const ts = Number(Array.isArray(tsHeader) ? tsHeader[0] : tsHeader);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) {
    throw forbidden('Request timestamp is missing or outside the accepted window');
  }

  const parsed = validateEnvelope(c.body);
  if (!parsed.ok) throw badRequest('Event failed validation', parsed.errors);

  // Most edges add a coarse country header. Country only: never a city, never
  // a coordinate, never an IP address.
  const geo = c.req.headers['x-vercel-ip-country'] ?? c.req.headers['cf-ipcountry'];
  const country = (Array.isArray(geo) ? geo[0] : geo)?.slice(0, 2).toUpperCase();
  return ingest(parsed.value, country ? { country } : {});
}, { anonymous: true });

/** Lets the website check it is wired up correctly without sending data. */
router.get('/api/v1/ingest/ping', () => ({
  ok: true, contractVersion: 1,
  configured: Boolean(config.ingestSecret),
  mode: config.mode,
}), { anonymous: true });
