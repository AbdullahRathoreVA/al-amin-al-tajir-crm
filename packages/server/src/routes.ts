/**
 * API v1. Versioned in the path so the website is not broken by CRM changes.
 * (spec 118 / 197)
 */
import { Router, badRequest, notFound, gone, forbidden, verifySignature, HttpError, type Ctx } from './http.ts';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from './core/ratelimit.ts';
import { one, many, run, tx } from './db/index.ts';
import { config } from './core/config.ts';
import { newId, nowIso, plain, plainAll, safeJson } from './core/util.ts';
import { login, logout, capabilitiesFor, canSeeSensitive, can, sessionsFor, revokeSession } from './core/auth.ts';
import { recordEvent, familyTimeline, timelineFor, changesSince, diff, logAccess, historyOf, type Actor } from './core/events.ts';
import { search as fullTextSearch, indexEntity, type Indexable } from './core/search.ts';
import { notify, unreadFor, setNotificationState, createTask, completeTask } from './core/notify.ts';
import {
  todaySummary, attention, pipeline, programHealth, dataHealth, systemHealth,
  toursToday, overdueFollowUps,
} from './core/queries.ts';
import { validateEnvelope } from '../../shared/src/contract.ts';
import { analyticsBundle, isWindow, type Window } from './core/analytics.ts';
import { assessRegistration, assessFamilyRegistration, incompleteRegistrations } from './core/completeness.ts';
import { templates, composeDraft, suggestTemplate, saveDraft, draftsFor,
         requestSend, pendingDeliveries, SendRefused } from './core/drafts.ts';
import { parseCsv, guessMapping, preview as previewImport, commitImport, IMPORT_FIELDS, FIELD_LABELS,
  type ImportField } from './core/csv.ts';
import { createBackup, listBackups, testRestore, pruneBackups } from './core/backup.ts';
import { listAutomations, runAutomation, runScheduled, recentRuns, runsFor, disableAll,
  TRIGGERS, type Automation } from './core/automations.ts';
import { aiStatus, summariseFamily, dailyBrief, factsForFamily } from './core/ai.ts';
import { listTargets, upsertTarget, runChannel, recentRuns as syncRuns, channelStatus,
         DEFAULT_MAPPING, mappingFor, targetFor, SYNC_CHANNELS } from './core/sync.ts';
import {
  listClassrooms, assignStaff, unassignStaff, staffFor, register, mark, checkOut,
  roomStandings, daySummary, logRegisterRead, today, isDay, AttendanceError,
  type AttendanceStatus,
} from './core/attendance.ts';
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

/**
 * "Not found" and "deleted" are different answers, and only one of them sends
 * someone looking for a typo in a link that was always correct.
 *
 * The append-only event log outlives the row, so it can tell them apart. When
 * it has a history for this id, the record was real and is gone: say so, with
 * the date, and let the caller stop hunting.
 */
function missing(entityType: string, id: string, message: string): HttpError {
  const h = historyOf(entityType, id);
  if (!h) return notFound(message);
  return gone(
    `This ${entityType} was deleted. It existed from ${h.created} until ${h.last}. ` +
    `The event log still holds its history.`,
    { deleted: true, entityType, id, created: h.created, deletedAfter: h.last, lastKnown: h.lastSummary },
  );
}

// ------------------------------------------------------------------ auth

router.post('/api/v1/auth/login', (c) => {
  const b = requireBody<{ email?: string; password?: string }>(c);
  if (!b.email || !b.password) throw badRequest('Email and password are required');

  // Behind a proxy the socket address is the proxy's. Trust the forwarded
  // header only for throttling, never for anything that grants access.
  const fwd = c.req.headers['x-forwarded-for'];
  const address = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim()
    || c.req.socket.remoteAddress || 'unknown';

  const verdict = checkLoginAllowed(b.email, address);
  if (!verdict.allowed) {
    logAccess(null, 'login_throttled', undefined, undefined, b.email.slice(0, 60));
    throw new HttpError(429,
      `Too many sign-in attempts. Try again in ${verdict.retryAfterSeconds} seconds.`);
  }

  const result = login(b.email, b.password, c.req.headers['user-agent']);
  if (!result) {
    recordLoginFailure(b.email, address);
    // Same message whether the account exists or the password was wrong.
    throw badRequest('That email and password do not match');
  }

  recordLoginSuccess(b.email, address);
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
  if (!family) throw missing('family', id, 'No such family');

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
  if (!before) throw missing('family', id, 'No such family');
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
  if (!before) throw missing('lead', id, 'No such lead');
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
  if (!before) throw missing('tour', id, 'No such tour');
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
  if (!reg) throw missing('registration', id, 'No such registration');
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
  if (!before) throw missing('registration', id, 'No such registration');
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


// ------------------------------------------------------- completeness

router.get('/api/v1/registrations/:id/completeness', (c) => {
  c.require('registration:read');
  const result = assessRegistration(c.params.id!);
  if (!result) throw missing('registration', c.params.id!, 'No such registration');
  return result;
});

router.get('/api/v1/completeness/incomplete', (c) => {
  c.require('registration:read');
  return { registrations: incompleteRegistrations(intParam(c.query.get('limit'), 50)) };
});

// ------------------------------------------------------------- drafts

router.get('/api/v1/templates', (c) => {
  c.require('note:write');
  return { templates: templates() };
});

/**
 * Composes a message. Does NOT send: nothing in this system sends anything to a
 * parent, by design. The response carries the recipient and any warnings so the
 * person pressing send sees them first.
 */
router.get('/api/v1/families/:id/draft', (c) => {
  c.require('note:write');
  const familyId = c.params.id!;
  const templateId = c.query.get('template') || suggestTemplate(familyId);
  try {
    const draft = composeDraft(familyId, templateId, c.user!.name);
    return { draft, suggested: templateId };
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : 'Could not compose a draft');
  }
});

router.get('/api/v1/families/:id/drafts', (c) => {
  c.require('note:write');
  return { drafts: draftsFor(c.params.id!) };
});

/** Records what a person decided to do with a draft. */
router.post('/api/v1/families/:id/draft', (c) => {
  c.require('note:write');
  const familyId = c.params.id!;
  const b = requireBody<{ templateId?: string; status?: string; body?: string; subject?: string }>(c);
  const valid = ['composed', 'sent', 'discarded'] as const;
  const status = (b.status ?? 'composed') as (typeof valid)[number];
  if (!valid.includes(status)) throw badRequest(`status must be one of: ${valid.join(', ')}`);

  const draft = composeDraft(familyId, b.templateId ?? suggestTemplate(familyId), c.user!.name);
  if (draft.blocked && status === 'sent') {
    throw badRequest('This draft cannot be sent', draft.warnings);
  }
  // A person may have edited the wording; store what they actually had.
  if (typeof b.body === 'string' && b.body.trim()) draft.body = b.body.trim();
  if (typeof b.subject === 'string') draft.subject = b.subject;

  const id = saveDraft(familyId, draft, actorOf(c), status);
  return { id, status };
});


// ------------------------------------------------------------- import

/**
 * Three steps on purpose: parse, then preview, then commit. Nothing is written
 * until a person has seen the counts and the sample rows. (spec 45 / 47)
 */
router.post('/api/v1/import/parse', (c) => {
  c.require('family:write');
  const b = requireBody<{ csv?: string }>(c);
  if (typeof b.csv !== 'string' || !b.csv.trim()) throw badRequest('Send the file contents as { csv: "..." }');
  if (b.csv.length > 5_000_000) throw badRequest('That file is larger than 5 MB.');

  const parsed = parseCsv(b.csv);
  if (!parsed.headers.length) throw badRequest('No header row found. The first line must name the columns.');

  return {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    truncated: parsed.truncated,
    mapping: guessMapping(parsed.headers),
    fields: IMPORT_FIELDS.map((f) => ({ id: f, label: FIELD_LABELS[f] })),
    // A few raw rows so a person can see the mapping is pointing at the right
    // columns before anything is validated.
    sampleRows: parsed.rows.slice(0, 5),
  };
});

router.post('/api/v1/import/preview', (c) => {
  c.require('family:write');
  const b = requireBody<{ csv?: string; mapping?: Record<string, number> }>(c);
  if (typeof b.csv !== 'string') throw badRequest('csv is required');
  const parsed = parseCsv(b.csv);
  return previewImport(parsed, (b.mapping ?? {}) as Partial<Record<ImportField, number>>);
});

router.post('/api/v1/import/commit', (c) => {
  c.require('family:write');
  const b = requireBody<{ csv?: string; mapping?: Record<string, number>; source?: string }>(c);
  if (typeof b.csv !== 'string') throw badRequest('csv is required');
  const parsed = parseCsv(b.csv);
  const result = commitImport(
    parsed,
    (b.mapping ?? {}) as Partial<Record<ImportField, number>>,
    actorOf(c),
    (b.source ?? 'a spreadsheet').slice(0, 80),
  );
  logAccess(c.user!.id, 'import', 'family', undefined,
    `batch ${result.batchId} created=${result.created} updated=${result.updated}`);
  return result;
});

// ------------------------------------------------------------- export

/** CSV out. Its own capability: seeing families is not the same permission as
 *  walking out with all of them. (spec 165) */
router.get('/api/v1/export/families', (c) => {
  c.require('data:export');
  const rows = many<Record<string, string | number | null>>(
    `SELECT f.name AS family, f.status, f.source,
            g.first_name AS guardian_first, g.last_name AS guardian_last,
            g.email AS guardian_email, g.phone AS guardian_phone, g.relationship,
            ch.first_name AS child_first, ch.last_name AS child_last, ch.age_band,
            f.created_at
       FROM families f
       LEFT JOIN guardians g ON g.family_id = f.id AND g.is_primary = 1
       LEFT JOIN children ch ON ch.family_id = f.id
      ORDER BY f.created_at DESC`);

  logAccess(c.user!.id, 'export', 'family', undefined, `${rows.length} rows`);

  const headers = rows.length ? Object.keys(rows[0]!) : [];
  // A leading =, +, - or @ makes Excel treat a cell as a formula. Prefix with a
  // quote so an imported name can never execute in someone's spreadsheet.
  const esc = (v: unknown): string => {
    let sv = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(sv)) sv = "'" + sv;
    return '"' + sv.replace(/"/g, '""') + '"';
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  return { filename: `tiny-stars-families-${new Date().toISOString().slice(0, 10)}.csv`, csv, rows: rows.length };
});


// ------------------------------------------------------------- backups

router.get('/api/v1/backups', (c) => {
  c.require('audit:read');
  return { backups: listBackups() };
});

router.post('/api/v1/backups', (c) => {
  c.require('settings:write');
  const result = createBackup();
  logAccess(c.user!.id, 'backup_created', undefined, undefined, result.path.split(/[\\/]/).pop());
  return {
    file: result.path.split(/[\\/]/).pop(),
    sizeBytes: result.sizeBytes,
    verified: result.verify.ok,
    problems: result.verify.problems,
  };
});

/** Rehearses a restore against a separate connection. Touches nothing live. */
router.post('/api/v1/backups/:file/test-restore', async (c) => {
  c.require('settings:write');
  const result = await testRestore(c.params.file!);
  logAccess(c.user!.id, 'backup_restore_test', undefined, undefined,
    `${c.params.file} -> ${result.ok ? 'ok' : 'FAILED'}`);
  return result;
});


// --------------------------------------------------------- automations

router.get('/api/v1/automations', (c) => {
  c.require('audit:read');
  return { automations: listAutomations(), triggers: TRIGGERS, runs: recentRuns(50) };
});

router.get('/api/v1/automations/:id/runs', (c) => {
  c.require('audit:read');
  return { runs: runsFor(c.params.id!, intParam(c.query.get('limit'), 50)) };
});

router.patch('/api/v1/automations/:id', (c) => {
  c.require('settings:write');
  const id = c.params.id!;
  const before = plain(one<Record<string, unknown>>('SELECT * FROM automations WHERE id = ?', id));
  if (!before) throw notFound('No such automation');
  const b = requireBody<{ enabled?: boolean; test_mode?: boolean; max_per_run?: number }>(c);

  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
  if (b.test_mode !== undefined) { sets.push('test_mode = ?'); params.push(b.test_mode ? 1 : 0); }
  if (b.max_per_run !== undefined) {
    sets.push('max_per_run = ?'); params.push(Math.max(1, Math.min(500, Math.trunc(b.max_per_run))));
  }
  if (!sets.length) throw badRequest('Nothing to update');

  run(`UPDATE automations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...params, nowIso(), id);
  const after = plain(one<Record<string, unknown>>('SELECT * FROM automations WHERE id = ?', id))!;
  recordEvent({
    entityType: 'automation', entityId: id, type: 'updated', actor: actorOf(c),
    summary: `Automation "${String(after.name)}" ${after.enabled ? 'enabled' : 'disabled'}` +
      (after.test_mode ? ' (test mode)' : ''),
    before, after,
  });
  return after;
});

/** Runs one rule now. Respects its own test mode. */
router.post('/api/v1/automations/:id/run', (c) => {
  c.require('settings:write');
  const row = one<{ id: string }>('SELECT id FROM automations WHERE id = ?', c.params.id!);
  if (!row) throw notFound('No such automation');
  const all = listAutomations();
  const a = all.find((x) => x.id === c.params.id) as Automation;
  const summary = runAutomation(a, actorOf(c));
  logAccess(c.user!.id, 'automation_run', 'automation', a.id, JSON.stringify(summary));
  return summary;
});

router.post('/api/v1/automations/run-all', (c) => {
  c.require('settings:write');
  const results = runScheduled(actorOf(c));
  logAccess(c.user!.id, 'automation_run_all', undefined, undefined, `${results.length} rule(s)`);
  return { results };
});

/** The kill switch. (spec 186) */
router.post('/api/v1/automations/disable-all', (c) => {
  c.require('settings:write');
  const n = disableAll(actorOf(c));
  logAccess(c.user!.id, 'automation_kill_switch', undefined, undefined, `${n} disabled`);
  return { disabled: n };
});


// ------------------------------------------------------------------- ai

router.get('/api/v1/ai/status', async () => aiStatus());

/**
 * A family summary. Rules always; a model adds interpretation when one is
 * configured and reachable. Facts and inference are separate fields so the UI
 * cannot present a guess as a record.
 */
router.get('/api/v1/families/:id/summary', async (c) => {
  c.require('family:read');
  // Built from the CALLER's permissions, so an educator cannot obtain a date of
  // birth by asking the AI for it. (spec 27)
  const result = await summariseFamily(c.params.id!, c.user!);
  if (!result) throw missing('family', c.params.id!, 'No such family');
  logAccess(c.user!.id, 'ai_summary', 'family', c.params.id!);
  return result;
});

/** What AI would be shown for this family, verbatim. */
router.get('/api/v1/families/:id/ai-facts', (c) => {
  c.require('family:read');
  const facts = factsForFamily(c.params.id!, c.user!);
  if (!facts) throw missing('family', c.params.id!, 'No such family');
  return facts;
});

router.get('/api/v1/ai/brief', async (c) => await dailyBrief(c.user!));


// ------------------------------------------------------ inbound recovery

/**
 * A failed website event, retried. The original payload is not kept (it may
 * contain family details), so this clears the event so the website can resend,
 * rather than replaying it from here.
 */
router.post('/api/v1/system/ingest/:eventId/dismiss', (c) => {
  c.require('settings:write');
  const row = one<{ event_id: string; status: string; type: string }>(
    'SELECT event_id, status, type FROM ingest_events WHERE event_id = ?', c.params.eventId!);
  if (!row) throw notFound('No such inbound event');
  if (row.status !== 'failed') throw badRequest('Only failed events can be dismissed');

  run('DELETE FROM ingest_events WHERE event_id = ?', row.event_id);
  recordEvent({
    entityType: 'system', entityId: 'ingest', type: 'updated', actor: actorOf(c),
    summary: `Dismissed a failed ${row.type} event after resolving the cause`,
  });
  logAccess(c.user!.id, 'ingest_dismissed', undefined, undefined, row.event_id);
  return { dismissed: row.event_id };
});

/** Clears every failed inbound event at once, after fixing whatever broke. */
router.post('/api/v1/system/ingest/dismiss-failed', (c) => {
  c.require('settings:write');
  const n = run("DELETE FROM ingest_events WHERE status = 'failed'").changes;
  if (n > 0) {
    recordEvent({
      entityType: 'system', entityId: 'ingest', type: 'updated', actor: actorOf(c),
      summary: `Dismissed ${n} failed inbound event(s) after resolving the cause`,
    });
  }
  logAccess(c.user!.id, 'ingest_dismissed_all', undefined, undefined, String(n));
  return { dismissed: n };
});

// ------------------------------------------------------------------ health

/**
 * Liveness, for the platform's health check. Anonymous and deliberately empty
 * of detail: a probe must not tell an unauthenticated caller the version, the
 * record counts, or whether anything is wrong.
 */
router.get('/healthz', () => ({ ok: true }), { anonymous: true });

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

// ------------------------------------------------------ classrooms & register

/**
 * An AttendanceError is a refusal a person should read — "that child is not in
 * a room you are assigned to" — not a crash. Anything else keeps falling
 * through to the generic 500, with the detail staying on stderr.
 */
function attendance<T>(work: () => T): T {
  try {
    return work();
  } catch (err) {
    if (err instanceof AttendanceError) throw badRequest(err.message);
    throw err;
  }
}

/** The day being asked about. Rejects junk rather than silently using today. */
function dayParam(c: Ctx): string {
  const raw = c.query.get('day');
  if (raw === null) return today();
  if (!isDay(raw)) throw badRequest('day must be a date in YYYY-MM-DD form');
  return raw;
}

router.get('/api/v1/classrooms', (c) => {
  const user = c.require('classroom:read');
  return { classrooms: listClassrooms(user) };
});

router.get('/api/v1/classrooms/:id/staff', (c) => {
  c.require('classroom:read');
  return { staff: staffFor(c.params.id!) };
});

router.post('/api/v1/classrooms/:id/staff', (c) => {
  c.require('classroom:write');
  const b = requireBody<{ userId?: string; role?: string; remove?: boolean }>(c);
  if (!b.userId) throw badRequest('userId is required');
  const room = c.params.id!;

  // Removal is a POST because the router speaks GET, POST and PATCH. Naming it
  // in the body beats inventing a second path that means "the opposite".
  if (b.remove) {
    if (!unassignStaff(room, b.userId, actorOf(c))) throw notFound('That person is not in this room');
    return { removed: true };
  }

  const role = b.role ?? 'support';
  if (!['lead', 'support', 'relief'].includes(role)) {
    throw badRequest('role must be lead, support or relief');
  }
  assignStaff(room, b.userId, role, actorOf(c));
  return { staff: staffFor(room) };
});

router.get('/api/v1/attendance', (c) => {
  const user = c.require('attendance:read');
  const day = dayParam(c);
  const classroom = c.query.get('classroom') ?? undefined;
  logRegisterRead(user, day, classroom);
  return {
    day,
    register: register(user, day, classroom),
    summary: daySummary(user, day),
  };
});

router.get('/api/v1/attendance/standings', (c) => {
  const user = c.require('attendance:read');
  const day = dayParam(c);
  return { day, rooms: roomStandings(user, day) };
});

const STATUSES = ['expected', 'present', 'absent', 'late', 'excused', 'left_early'];

router.post('/api/v1/attendance/mark', (c) => {
  const user = c.require('attendance:write');
  const b = requireBody<{
    childId?: string; day?: string; status?: string; releasedTo?: string; note?: string;
  }>(c);
  if (!b.childId) throw badRequest('childId is required');
  if (!b.status || !STATUSES.includes(b.status)) {
    throw badRequest(`status must be one of ${STATUSES.join(', ')}`);
  }
  const day = b.day ?? today();
  if (!isDay(day)) throw badRequest('day must be a date in YYYY-MM-DD form');

  return attendance(() => mark(user, actorOf(c), {
    childId: b.childId!, day, status: b.status as AttendanceStatus,
    releasedTo: b.releasedTo, note: b.note,
  }));
});

router.post('/api/v1/attendance/checkout', (c) => {
  const user = c.require('attendance:write');
  const b = requireBody<{ childId?: string; day?: string; releasedTo?: string }>(c);
  if (!b.childId) throw badRequest('childId is required');
  const day = b.day ?? today();
  if (!isDay(day)) throw badRequest('day must be a date in YYYY-MM-DD form');

  return attendance(() => checkOut(user, actorOf(c), b.childId!, day, b.releasedTo ?? ''));
});

// -------------------------------------------------------------- outbound sync



router.get('/api/v1/sync', (c) => {
  c.require('audit:read');
  return {
    targets: listTargets(),
    channels: SYNC_CHANNELS.map(channelStatus),
    defaultMapping: DEFAULT_MAPPING,
    runs: syncRuns(undefined, 20),
  };
});

router.patch('/api/v1/sync/:channel', (c) => {
  c.require('settings:write');
  const channel = c.params.channel!;
  if (!(SYNC_CHANNELS as readonly string[]).includes(channel)) throw notFound('No such sync channel');

  const b = requireBody<{
    label?: string; externalId?: string | null; tabName?: string | null;
    mapping?: Record<string, string>; enabled?: boolean;
  }>(c);

  if (b.mapping !== undefined) {
    if (typeof b.mapping !== 'object' || b.mapping === null || Array.isArray(b.mapping)) {
      throw badRequest('mapping must be an object of column heading to field path');
    }
    for (const [heading, path] of Object.entries(b.mapping)) {
      if (typeof path !== 'string' || !path.trim()) {
        throw badRequest(`mapping["${heading}"] must be a non-empty field path`);
      }
    }
  }

  const before = targetFor(channel);
  const after = upsertTarget(channel, b);

  // Turning a sync on starts sending family details somewhere else. That is
  // worth a line in the log that cannot be rewritten.
  if (before?.enabled !== after.enabled) {
    recordEvent({
      entityType: 'system', entityId: `sync:${channel}`, type: 'updated', actor: actorOf(c),
      summary: after.enabled
        ? `Outbound sync to ${after.label} switched ON`
        : `Outbound sync to ${after.label} switched OFF`,
      before: before ? { enabled: !!before.enabled } : null, after: { enabled: !!after.enabled },
    });
  }
  return { target: after, mapping: mappingFor(after), status: channelStatus(channel) };
});

/** Run now, rather than waiting for the sweep. */
router.post('/api/v1/sync/:channel/run', async (c) => {
  c.require('settings:write');
  const channel = c.params.channel!;
  if (!(SYNC_CHANNELS as readonly string[]).includes(channel)) throw notFound('No such sync channel');
  const result = await runChannel(channel);
  return { result, status: channelStatus(channel) };
});

/**
 * Send a drafted message.
 *
 * The only route in the system that can put words in front of a parent, and it
 * is a POST from a signed-in person with `message:send`. There is deliberately
 * no scheduled, automated or AI-triggered path to it: `requestSend` refuses any
 * actor that is not a user, and a database trigger refuses any delivery row
 * that cannot name one. Three layers, because this is the rule that makes the
 * rest of the system trustworthy.
 */
router.post('/api/v1/drafts/:id/send', (c) => {
  const user = c.require('message:send');
  try {
    const draft = requestSend(c.params.id!, user, actorOf(c));
    return { draft, queued: true };
  } catch (err) {
    if (err instanceof SendRefused) throw badRequest(err.message);
    throw err;
  }
});

router.get('/api/v1/drafts/pending', (c) => {
  c.require('family:read');
  return { pending: pendingDeliveries() };
});
