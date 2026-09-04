/**
 * API v1. Versioned in the path so the website is not broken by CRM changes.
 * (spec 118 / 197)
 */
import { Router, badRequest, notFound, gone, forbidden, verifySignature, HttpError, type Ctx } from './http.ts';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess } from './core/ratelimit.ts';
import { one, many, run, tx } from './db/index.ts';
import { config } from './core/config.ts';
import { newId, nowIso, plain, plainAll, safeJson, familyNameFrom } from './core/util.ts';
import { findFamilyMatches } from './core/match.ts';
import { progressionSummary, placementPlan } from './core/progression.ts';
import { list as wlList, join as wlJoin, offer as wlOffer, accept as wlAccept,
         decline as wlDecline, recordContact as wlContact, programStanding,
         WaitlistError, STALE_AFTER_DAYS, DEFAULT_OFFER_DAYS,
         ORDERING_POLICY } from './core/waitlist.ts';
import { familiesWorkbook, admissionsWorkbook, exportCounts } from './core/exports.ts';
import { HELP, HELP_SECTIONS, searchHelp, topicsAsContext } from './core/help.ts';
import {
  insertFamily, upsertGuardian, addChild, addGuardian, updateChild, updateGuardian,
  reindexFamily, type ChildPatch, type GuardianPatch,
} from './core/people.ts';
import {
  login, logout, capabilitiesFor, canSeeSensitive, can, sessionsFor, revokeSession,
  changeOwnPassword, resetPasswordFor, setUserStatus, setUserRole, listUsers, emailTaken,
  createUser, AccountError, MIN_PASSWORD, ROLE_NAMES, type Role,
} from './core/auth.ts';
import { recordEvent, familyTimeline, timelineFor, changesSince, diff, logAccess, historyOf, type Actor } from './core/events.ts';
import { search as fullTextSearch, indexEntity, familyForRelated, type Indexable } from './core/search.ts';
import { notify, unreadFor, setNotificationState, createTask, completeTask } from './core/notify.ts';
import {
  todaySummary, attention, pipeline, programHealth, dataHealth, systemHealth,
  toursToday, overdueFollowUps,
} from './core/queries.ts';
import { validateEnvelope, validateGuardianInput, validateChildInput } from '../../shared/src/contract.ts';
import { analyticsBundle, isWindow, type Window } from './core/analytics.ts';
import { assessRegistration, assessFamilyRegistration, incompleteRegistrations } from './core/completeness.ts';
import { templates, composeDraft, suggestTemplate, saveDraft, draftsFor,
         requestSend, pendingDeliveries, SendRefused } from './core/drafts.ts';
import { parseTabular, guessMapping, preview as previewImport, commitImport, IMPORT_FIELDS, FIELD_LABELS,
  type ImportField } from './core/csv.ts';
import { createBackup, listBackups, testRestore, pruneBackups } from './core/backup.ts';
import { listAutomations, runAutomation, runScheduled, recentRuns, runsFor, disableAll,
  TRIGGERS, type Automation } from './core/automations.ts';
import { aiStatus, summariseFamily, dailyBrief, factsForFamily, provider as aiProvider } from './core/ai.ts';
import { listTargets, upsertTarget, runChannel, recentRuns as syncRuns, channelStatus,
         DEFAULT_MAPPING, mappingFor, targetFor, SYNC_CHANNELS } from './core/sync.ts';
import {
  listClassrooms, assignStaff, unassignStaff, staffFor, register, mark, checkOut,
  roomStandings, daySummary, logRegisterRead, today, isDay, AttendanceError,
  createClassroom, updateClassroom, assignChild, unplacedChildren,
  setRatio, clearRatio, programsWithRatios, assignableStaff, staffByClassroom,
  undoLastPlacement,
  type AttendanceStatus,
} from './core/attendance.ts';
import { ingest } from './ingest/pipeline.ts';
import { parseUtterance, gapsIn, record as logRecord, update as logUpdate, list as logList,
         totals as logTotals, recall as logRecall, workbook as logWorkbook,
         remove as logRemove, restore as logRestore, removed as logRemoved,
         splitUtterance,
         LogbookError, type LogKind, type LogDraft } from './core/logbook.ts';

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

/**
 * Changing your own password, from the app.
 *
 * Until this existed the only way was over SSH, which meant in practice nobody
 * ever did it — the one security action every user needs was the one that
 * required a developer. It is also why a placeholder password can survive on a
 * live system: rotating it was too hard to bother with.
 */
router.post('/api/v1/auth/password', (c) => {
  const b = requireBody<{ currentPassword?: string; newPassword?: string }>(c);
  try {
    const r = changeOwnPassword(
      c.user!.id, b.currentPassword ?? '', b.newPassword ?? '', c.cookies.crm_session,
    );
    logAccess(c.user!.id, 'password_changed');
    return { ok: true, signedOut: r.signedOut };
  } catch (err) {
    if (err instanceof AccountError) throw badRequest(err.message);
    throw err;
  }
});

/**
 * What "forgotten password" means for a nursery.
 *
 * There is no mail server, there are a handful of staff, and the manager is in
 * the building. So this tells the person exactly who can reset it for them,
 * by name, rather than showing a form that sends an email nothing can deliver.
 *
 * Anonymous by necessity — the person cannot sign in. It therefore returns
 * only names and roles of people who can help, never an email address or
 * anything that would let somebody enumerate accounts.
 */
router.get('/api/v1/auth/recover', () => {
  const helpers = many<{ name: string; role: string }>(
    `SELECT name, role FROM users
      WHERE status = 'active' AND role IN ('owner','director')
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, name LIMIT 5`);
  return {
    canResetForYou: helpers,
    // Said plainly rather than implying a self-service flow exists.
    how: helpers.length
      ? 'Ask one of these people to reset it for you. They do it from "Your account" in under a minute.'
      : 'No manager account is active. Whoever installed the CRM can reset it from the command line.',
  };
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

// ------------------------------------------------- adding people by hand
//
// A daycare enrols children over the phone, at the door, and from a form a
// parent filled in on paper. Until these existed the only ways into the CRM
// were the public website and a spreadsheet import, which made the product
// unusable for its actual job.
//
// These write through core/people.ts, the same helpers the website pipeline
// uses, so a family typed in here and a family that arrived from a form are
// the same shape of record.

router.post('/api/v1/families', (c) => {
  c.require('family:write');
  const b = requireBody<{
    familyName?: string;
    guardians?: unknown[];
    children?: unknown[];
    notes?: string;
    /** Set once the person has seen the possible duplicates and meant it. */
    confirmDuplicate?: boolean;
  }>(c);

  const rawGuardians = Array.isArray(b.guardians) ? b.guardians : [];
  if (!rawGuardians.length) throw badRequest('A family needs at least one guardian');

  // The same validators the website's events go through, so a typed-in record
  // cannot be looser than one a parent submitted.
  const guardians = rawGuardians.map((g, i) => {
    const v = validateGuardianInput(g);
    if (!v.ok) {
      throw new HttpError(400, `Guardian ${i + 1}: ${v.errors[0]!.message}`, { errors: v.errors });
    }
    return v.value;
  });
  const children = (Array.isArray(b.children) ? b.children : []).map((ch, i) => {
    const v = validateChildInput(ch);
    if (!v.ok) {
      throw new HttpError(400, `Child ${i + 1}: ${v.errors[0]!.message}`, { errors: v.errors });
    }
    return v.value;
  });

  // Look before creating, and say so, rather than making a duplicate and
  // raising a task about it afterwards. The person is right here.
  const candidates = findFamilyMatches(guardians[0]!)
    .filter((m) => m.decision === 'link' || m.decision === 'review');
  if (candidates.length && !b.confirmDuplicate) {
    throw new HttpError(409,
      `This looks like an existing family: ${candidates[0]!.familyName}`,
      { duplicates: candidates });
  }

  const actor = actorOf(c);
  const name = (typeof b.familyName === 'string' && b.familyName.trim())
    ? b.familyName.trim().slice(0, 120)
    : familyNameFrom(guardians[0]!.fullName);

  let familyId = '';
  const guardianIds: string[] = [];
  const childIds: string[] = [];

  tx(() => {
    familyId = insertFamily(name, 'manual', null, actor);
    recordEvent({
      entityType: 'family', entityId: familyId, type: 'created', actor,
      summary: `${name} added by ${c.user!.name}`,
      after: { name, source: 'manual', guardians: guardians.length, children: children.length },
    });
    guardians.forEach((g, i) => { guardianIds.push(upsertGuardian(familyId, g, i === 0)); });
    for (const ch of children) childIds.push(addChild(familyId, ch, actor));

    if (typeof b.notes === 'string' && b.notes.trim()) {
      const noteId = newId();
      run('INSERT INTO notes (id, entity_type, entity_id, body, author_id, created_at) VALUES (?,?,?,?,?,?)',
        noteId, 'family', familyId, b.notes.trim().slice(0, 4000), c.user!.id, nowIso());
      indexEntity('note', noteId, 'Note on family', b.notes.trim().slice(0, 4000), familyId);
    }
    reindexFamily(familyId);
  });

  return { familyId, guardianIds, childIds, duplicatesAcknowledged: candidates.length || undefined };
});

router.post('/api/v1/families/:id/children', (c) => {
  c.require('child:write');
  const familyId = c.params.id!;
  if (!one('SELECT id FROM families WHERE id = ?', familyId)) {
    throw missing('family', familyId, 'No such family');
  }
  const v = validateChildInput(requireBody(c));
  if (!v.ok) throw new HttpError(400, v.errors[0]!.message, { errors: v.errors });

  let childId = '';
  tx(() => { childId = addChild(familyId, v.value, actorOf(c)); });
  return plain(one(`SELECT * FROM children WHERE id = ?`, childId));
});

router.post('/api/v1/families/:id/guardians', (c) => {
  c.require('family:write');
  const familyId = c.params.id!;
  if (!one('SELECT id FROM families WHERE id = ?', familyId)) {
    throw missing('family', familyId, 'No such family');
  }
  const v = validateGuardianInput(requireBody(c));
  if (!v.ok) throw new HttpError(400, v.errors[0]!.message, { errors: v.errors });

  let guardianId = '';
  tx(() => { guardianId = addGuardian(familyId, v.value, actorOf(c)); });
  return plain(one('SELECT * FROM guardians WHERE id = ?', guardianId));
});

router.patch('/api/v1/children/:id', (c) => {
  c.require('child:write');
  const id = c.params.id!;
  if (!one('SELECT id FROM children WHERE id = ?', id)) {
    throw missing('child', id, 'No such child');
  }
  const b = requireBody<Record<string, unknown>>(c) as ChildPatch;
  // A date of birth is sensitive, so writing one needs the capability to see
  // one. Otherwise a role that cannot read a birthday could still set it.
  if (b.dateOfBirth !== undefined && !canSeeSensitive(c.user)) {
    throw forbidden('Your role cannot set a date of birth');
  }
  tx(() => { updateChild(id, b, actorOf(c)); });
  return plain(one('SELECT * FROM children WHERE id = ?', id));
});

router.patch('/api/v1/guardians/:id', (c) => {
  c.require('family:write');
  const id = c.params.id!;
  if (!one('SELECT id FROM guardians WHERE id = ?', id)) {
    throw missing('guardian', id, 'No such guardian');
  }
  const patch = requireBody<Record<string, unknown>>(c) as GuardianPatch;
  tx(() => { updateGuardian(id, patch, actorOf(c)); });
  return plain(one('SELECT * FROM guardians WHERE id = ?', id));
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
    if (typeof after.title === 'string') {
      indexEntity('task', id, after.title, String(after.body ?? ''),
        familyForRelated(after.related_type as string | null, after.related_id as string | null));
    }
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
    indexEntity('note', id, `Note on ${entityType}`, noteBody,
      familyForRelated(entityType, entityId));
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
/** Body shared by all three import steps. Each re-parses rather than holding
 *  server-side state, so an abandoned import leaves nothing behind. */
interface ImportBody extends Record<string, unknown> {
  csv?: string;
  /** An .xlsx as base64. Read directly — no "save as CSV" step. */
  xlsxBase64?: string;
  /** Which tab. Defaults to the first. */
  sheet?: string;
  mapping?: Record<string, number>;
  source?: string;
}

/** 5 MB of CSV, or an .xlsx whose base64 is under ~6.7 MB (base64 is 4/3). */
function parseUpload(b: ImportBody) {
  const size = (b.csv?.length ?? 0) + (b.xlsxBase64?.length ?? 0);
  if (size > 6_800_000) throw badRequest('That file is larger than 5 MB.');
  try {
    return parseTabular(b);
  } catch (err) {
    // A bad spreadsheet is the operator's problem to fix, so the message has
    // to say what to do rather than name an exception.
    throw badRequest(err instanceof Error ? err.message : 'That file could not be read.');
  }
}

router.post('/api/v1/import/parse', (c) => {
  c.require('family:write');
  const b = requireBody<ImportBody>(c);
  const parsed = parseUpload(b);
  if (!parsed.headers.length) throw badRequest('No header row found. The first row must name the columns.');

  return {
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    truncated: parsed.truncated,
    // Present only for a workbook, so the UI can offer the other tabs.
    sheetNames: parsed.sheetNames,
    sheet: parsed.sheet,
    mapping: guessMapping(parsed.headers),
    fields: IMPORT_FIELDS.map((f) => ({ id: f, label: FIELD_LABELS[f] })),
    // A few raw rows so a person can see the mapping is pointing at the right
    // columns before anything is validated.
    sampleRows: parsed.rows.slice(0, 5),
  };
});

router.post('/api/v1/import/preview', (c) => {
  c.require('family:write');
  const b = requireBody<ImportBody>(c);
  return previewImport(parseUpload(b), (b.mapping ?? {}) as Partial<Record<ImportField, number>>);
});

router.post('/api/v1/import/commit', (c) => {
  c.require('family:write');
  const b = requireBody<ImportBody>(c);
  const parsed = parseUpload(b);
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

/**
 * The same records as a real workbook rather than a flat CSV.
 *
 * A CSV is right for feeding another system and wrong for what people actually
 * do with an export, which is print it and point at it in a meeting. Sheets,
 * frozen headers, formatted dates and money, and a summary that adds up.
 */
router.get('/api/v1/export/families.xlsx', (c) => {
  c.require('data:export');
  // Dates of birth follow the same rule as everywhere else: a role without
  // child:read_sensitive gets the column dropped, not blanked, so a birthday
  // cannot be recovered from a file that was passed on.
  const sensitive = canSeeSensitive(c.user);
  const buf = familiesWorkbook({ sensitive });
  const counts = exportCounts();
  logAccess(c.user!.id, 'export', 'family', undefined,
    `workbook, ${counts.families} families, dob=${sensitive ? 'included' : 'omitted'}`);
  return {
    filename: `tiny-stars-families-${nowIso().slice(0, 10)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: buf.toString('base64'),
    bytes: buf.length,
    counts,
  };
});

router.get('/api/v1/export/admissions.xlsx', (c) => {
  c.require('data:export');
  const buf = admissionsWorkbook();
  logAccess(c.user!.id, 'export', 'lead', undefined, 'admissions workbook');
  return {
    filename: `tiny-stars-admissions-${nowIso().slice(0, 10)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: buf.toString('base64'),
    bytes: buf.length,
    counts: exportCounts(),
  };
});

/** What each file would contain, so a person knows before downloading. */
router.get('/api/v1/export/counts', (c) => {
  c.require('data:export');
  return { counts: exportCounts(), sensitive: canSeeSensitive(c.user) };
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

/**
 * Who has outgrown their room, and whose birthday is coming.
 *
 * Read-only on purpose. The move itself goes through the existing placement
 * endpoint, which means a person decides it and the event log records who.
 */
// ---------------------------------------------------------------- help
//
// The whole user guide, and a question box over it. Available to every signed
// in role: help about a screen you cannot open is harmless, and a person who
// cannot find out how something works will invent a worse way to do it.

router.get('/api/v1/help', () => ({ sections: HELP_SECTIONS, topics: HELP }));

/**
 * Answers a question about using the CRM.
 *
 * The search is deterministic and always runs, so this works with AI switched
 * off — that is the baseline, not a fallback. When a provider is configured it
 * also writes a short answer, and it is given ONLY the matching help topics to
 * write from. No family data, no database, no general knowledge: an AI that
 * confidently describes a feature this CRM does not have is worse than no
 * answer, because the person will go looking for it.
 */
router.post('/api/v1/help/ask', async (c) => {
  const b = requireBody<{ question?: string }>(c);
  const question = (b.question ?? '').trim().slice(0, 300);
  if (!question) throw badRequest('Type a question first');

  const topics = searchHelp(question, 4);
  const base = {
    question,
    topics: topics.map((t) => ({ id: t.id, title: t.title, summary: t.summary, section: t.section })),
  };

  if (!topics.length) {
    return {
      ...base,
      answer: null,
      answeredBy: 'none' as const,
      note: 'Nothing in the guide covers that. Try a different word, or browse the sections below.',
    };
  }

  const ai = aiProvider();
  if (!ai) {
    return {
      ...base,
      answer: null,
      answeredBy: 'search' as const,
      note: 'These are the parts of the guide that match. Turn on an AI provider to get an answer written out.',
    };
  }

  const prompt = [
    'You are answering a question from a person who runs a daycare, about the software they use.',
    'Answer ONLY from the guide below. If the guide does not answer the question, say so plainly.',
    'Never describe a feature that is not in the guide. Do not guess. Do not invent numbers.',
    'Two or three short sentences, plain words, no jargon, no lists.',
    '',
    '--- GUIDE ---',
    topicsAsContext(topics),
    '--- END GUIDE ---',
    '',
    `Question: ${question}`,
  ].join('\n');

  const answer = await ai.complete(prompt, { maxTokens: 300 });
  return {
    ...base,
    answer,
    answeredBy: answer ? ('ai' as const) : ('search' as const),
    note: answer
      ? `Written by ${ai.name} from the guide only. Check the topics below if in doubt.`
      : 'The AI provider did not answer. These are the matching parts of the guide.',
  };
});

// ---------------------------------------------------------------- accounts
//
// Managing staff accounts from the app rather than over SSH. The CLI still
// exists and is still the way to create the very first account — there has to
// be a way in before there is anybody to sign in as.

router.get('/api/v1/users', (c) => {
  c.require('user:manage');
  return { users: plainAll(listUsers()), minPassword: MIN_PASSWORD, roles: ROLE_NAMES };
});

router.post('/api/v1/users', (c) => {
  c.require('user:manage');
  const b = requireBody<{ email?: string; name?: string; role?: string; password?: string }>(c);
  const email = (b.email ?? '').trim().toLowerCase();
  const name = (b.name ?? '').trim();
  if (!email) throw badRequest('An email address or username is required');
  if (!name) throw badRequest('A name is required');
  if (!ROLE_NAMES.includes(b.role as Role)) throw badRequest(`Role must be one of: ${ROLE_NAMES.join(', ')}`);
  if (emailTaken(email)) throw badRequest(`"${email}" already has an account.`);
  if ((b.password ?? '').length < MIN_PASSWORD) {
    throw badRequest(`A password needs at least ${MIN_PASSWORD} characters.`);
  }

  const created = createUser(email, name, b.role as Role, b.password!);
  logAccess(c.user!.id, 'user_created', 'user', created.id, `${email} as ${b.role}`);
  return plain(created as unknown as Record<string, unknown>);
});

/** A manager resetting somebody's password. This is the real answer to
 *  "I have forgotten mine". */
router.post('/api/v1/users/:id/password', (c) => {
  c.require('user:manage');
  const b = requireBody<{ password?: string }>(c);
  try {
    const r = resetPasswordFor(c.params.id!, b.password ?? '');
    logAccess(c.user!.id, 'password_reset', 'user', c.params.id, `${r.email}, ${r.signedOut} session(s) ended`);
    return { ok: true, ...r };
  } catch (err) {
    if (err instanceof AccountError) throw badRequest(err.message);
    throw err;
  }
});

router.patch('/api/v1/users/:id', (c) => {
  c.require('user:manage');
  const id = c.params.id!;
  const b = requireBody<{ status?: string; role?: string }>(c);

  // Locking yourself out of the only owner account is unrecoverable from
  // inside the app, so it is refused here rather than regretted later.
  if (id === c.user!.id && (b.status === 'suspended' || (b.role && b.role !== c.user!.role))) {
    throw badRequest('You cannot suspend or change the role of the account you are signed in with.');
  }

  try {
    if (b.status === 'active' || b.status === 'suspended') {
      setUserStatus(id, b.status);
      logAccess(c.user!.id, 'user_status', 'user', id, b.status);
    }
    if (b.role) {
      if (!ROLE_NAMES.includes(b.role as Role)) throw badRequest(`Unknown role "${b.role}"`);
      setUserRole(id, b.role as Role);
      logAccess(c.user!.id, 'user_role', 'user', id, b.role);
    }
  } catch (err) {
    if (err instanceof AccountError) throw badRequest(err.message);
    throw err;
  }
  return plain(one('SELECT id,email,name,role,status,created_at,last_login_at FROM users WHERE id = ?', id));
});

// ---------------------------------------------------------------- waitlist
//
// Position is computed, never stored, and there is deliberately no estimated
// wait: the CRM cannot know when a place will free up, and a guess shown to
// staff becomes a promise made to a parent.

router.get('/api/v1/waitlist', (c) => {
  c.require('registration:read');
  return {
    entries: wlList({
      programId: c.query.get('programId') ?? undefined,
      status: c.query.get('status') ?? undefined,
    }),
    programs: programStanding(),
    staleAfterDays: STALE_AFTER_DAYS,
    defaultOfferDays: DEFAULT_OFFER_DAYS,
    orderingPolicy: ORDERING_POLICY,
  };
});

router.post('/api/v1/waitlist', (c) => {
  c.require('registration:write');
  const b = requireBody<{
    familyId?: string; childId?: string; programId?: string;
    desiredStart?: string; careType?: 'full-time' | 'part-time'; notes?: string;
  }>(c);
  if (!b.familyId) throw badRequest('Which family is waiting?');
  try {
    return wlJoin({
      familyId: b.familyId,
      childId: b.childId || null,
      programId: b.programId || null,
      desiredStart: b.desiredStart || null,
      careType: b.careType || null,
      notes: b.notes || null,
    }, actorOf(c));
  } catch (err) {
    if (err instanceof WaitlistError) throw badRequest(err.message);
    throw err;
  }
});

router.post('/api/v1/waitlist/:id/offer', (c) => {
  c.require('registration:write');
  const b = requireBody<{ expiresInDays?: number }>(c);
  try {
    return wlOffer(c.params.id!, actorOf(c), c.user!.id,
      b.expiresInDays ?? DEFAULT_OFFER_DAYS);
  } catch (err) {
    if (err instanceof WaitlistError) throw badRequest(err.message);
    throw err;
  }
});

router.post('/api/v1/waitlist/:id/accept', (c) => {
  c.require('registration:write');
  const b = requireBody<{ reason?: string }>(c);
  try { return wlAccept(c.params.id!, actorOf(c), b.reason); }
  catch (err) {
    if (err instanceof WaitlistError) throw badRequest(err.message);
    throw err;
  }
});

router.post('/api/v1/waitlist/:id/decline', (c) => {
  c.require('registration:write');
  const b = requireBody<{ reason?: string; keepWaiting?: boolean }>(c);
  try { return wlDecline(c.params.id!, b.reason ?? '', actorOf(c), b.keepWaiting === true); }
  catch (err) {
    if (err instanceof WaitlistError) throw badRequest(err.message);
    throw err;
  }
});

router.post('/api/v1/waitlist/:id/contact', (c) => {
  c.require('registration:write');
  const b = requireBody<{ note?: string }>(c);
  try { wlContact(c.params.id!, actorOf(c), b.note); return { ok: true }; }
  catch (err) {
    if (err instanceof WaitlistError) throw badRequest(err.message);
    throw err;
  }
});

router.get('/api/v1/progression', (c) => {
  c.require('classroom:read');
  return progressionSummary();
});

/**
 * Every child and the room their age says they belong in — including the ones
 * already in the right place, because "everyone is fine" is only believable if
 * the ones who are fine are shown too.
 */
router.get('/api/v1/placement', (c) => {
  c.require('classroom:read');
  const rows = placementPlan();
  const count = (v: string) => rows.filter((r) => r.verdict === v).length;
  return {
    rows: plainAll(rows as unknown as Record<string, unknown>[]),
    // Every open room, so any child's room can be changed from this screen and
    // not only the ones the age ladder has an opinion about. A child moves for
    // reasons the CRM cannot see — a friend, a key worker, a parent's request.
    rooms: plainAll(many(
      `SELECT r.id, r.name, p.name AS program_name, r.capacity,
              (SELECT COUNT(*) FROM children ch
                WHERE ch.classroom_id = r.id AND ch.status = 'enrolled') AS enrolled
         FROM classrooms r LEFT JOIN programs p ON p.id = r.program_id
        WHERE r.active = 1 ORDER BY p.sort_order, r.name`)),
    summary: {
      total: rows.length,
      correct: count('correct'),
      move: count('move'),
      unplaced: count('unplaced'),
      noRoomForAge: count('no-room-for-age'),
      noBirthday: count('no-birthday'),
    },
  };
});

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

// -------------------------------------------------------------------- logbook

const LOG_KINDS = ['purchase', 'supply', 'task', 'note'];

function logbook<T>(work: () => T): T {
  try { return work(); }
  catch (err) {
    if (err instanceof LogbookError) throw badRequest(err.message);
    throw err;
  }
}

/** Reads a sentence and says what it understood, plus what it still needs. */
/**
 * One sentence, several purchases. The model decides only where one purchase
 * ends and the next begins; the amounts and dates in what it returns are
 * re-read by the same regexes used everywhere else, and nothing is written
 * until a person presses save.
 */
router.post('/api/v1/logbook/ai-split', async (c) => {
  c.require('logbook:write');
  const b = requireBody<{ text?: string; today?: string }>(c);
  const text = (b.text ?? '').trim().slice(0, 1000);
  if (!text) throw badRequest('Say what you bought first');
  // Same reason as /parse: the browser knows the local date, the server only
  // knows UTC, and this is a ledger.
  const today = b.today && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : nowIso().slice(0, 10);
  const r = await splitUtterance(text, today, aiProvider());
  return { ...r, drafts: r.drafts.map((d) => ({ draft: d, gaps: gapsIn(d) })), today };
});

router.post('/api/v1/logbook/parse', (c) => {
  c.require('logbook:write');
  const b = requireBody<{ text?: string; today?: string }>(c);
  const text = (b.text ?? '').trim();
  if (!text) throw badRequest('Say what happened and I will write it down');
  if (text.length > 2000) throw badRequest('That is longer than this is meant for');

  // The caller supplies its own idea of today, because the browser knows the
  // local date and the server only knows UTC — "yesterday" at 6pm in Alberta is
  // a different day from "yesterday" in UTC, and this is a ledger.
  const today = b.today && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : nowIso().slice(0, 10);

  const draft = parseUtterance(text, today);
  return { draft, gaps: gapsIn(draft), today };
});

router.post('/api/v1/logbook', (c) => {
  c.require('logbook:write');
  const b = requireBody<Partial<LogDraft> & { text?: string }>(c);
  const rawText = (b.rawText ?? b.text ?? '').trim();
  if (!rawText) throw badRequest('rawText is required — keep what was actually said');
  if (b.kind && !LOG_KINDS.includes(b.kind)) {
    throw badRequest(`kind must be one of ${LOG_KINDS.join(', ')}`);
  }
  if (b.amountCents !== undefined && b.amountCents !== null) {
    if (!Number.isInteger(b.amountCents) || b.amountCents < 0) {
      throw badRequest('amountCents must be a whole number of cents, not a decimal');
    }
  }

  return logbook(() => logRecord({
    kind: (b.kind as LogKind) ?? 'note',
    happenedOn: b.happenedOn,
    summary: b.summary,
    vendor: b.vendor,
    amountCents: b.amountCents ?? null,
    category: b.category,
    classroomId: b.classroomId ?? null,
    rawText,
    source: b.source === 'voice' ? 'voice' : 'typed',
  }, actorOf(c)));
});

router.patch('/api/v1/logbook/:id', (c) => {
  c.require('logbook:write');
  const b = requireBody<Partial<LogDraft>>(c);
  return logbook(() => logUpdate(c.params.id!, b, actorOf(c)));
});

router.get('/api/v1/logbook', (c) => {
  c.require('logbook:read');
  const filter = {
    from: c.query.get('from') ?? undefined,
    to: c.query.get('to') ?? undefined,
    kind: (c.query.get('kind') as LogKind) ?? undefined,
    category: c.query.get('category') ?? undefined,
  };
  const q = c.query.get('q')?.trim();
  return {
    entries: q ? logRecall(q, 50) : logList(filter),
    totals: logTotals(filter),
    query: q ?? null,
  };
});

/**
 * The workbook, base64 in JSON.
 *
 * Same shape as the CSV export: the router speaks JSON, and a spreadsheet is
 * not worth teaching it binary for. The client turns it back into a file.
 */
router.get('/api/v1/logbook/workbook', (c) => {
  c.require('logbook:read');
  const filter = {
    from: c.query.get('from') ?? undefined,
    to: c.query.get('to') ?? undefined,
    kind: (c.query.get('kind') as LogKind) ?? undefined,
  };
  const buf = logWorkbook(filter);
  logAccess(c.user!.id, 'export_logbook', 'logbook', filter.from ?? 'all');
  return {
    filename: `tiny-stars-logbook-${nowIso().slice(0, 10)}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: buf.toString('base64'),
    bytes: buf.length,
  };
});

/**
 * Remove an entry. POST rather than DELETE because the router speaks GET, POST
 * and PATCH — and because this is reversible, which DELETE would imply it is not.
 */
router.post('/api/v1/logbook/:id/remove', (c) => {
  c.require('logbook:write');
  return logbook(() => logRemove(c.params.id!, actorOf(c)));
});

router.post('/api/v1/logbook/:id/restore', (c) => {
  c.require('logbook:write');
  return logbook(() => logRestore(c.params.id!, actorOf(c)));
});

/** The bin, so a removed entry can be found again rather than only regretted. */
router.get('/api/v1/logbook/removed', (c) => {
  c.require('logbook:read');
  return { removed: logRemoved() };
});

// ------------------------------------------------------ setting the register up

/**
 * Everything needed to get from an empty register to a working one, on one
 * screen: the rooms, the children not yet in one, and the ratios.
 */
router.get('/api/v1/classrooms/setup', (c) => {
  const user = c.require('classroom:read');
  // Staff names are only sent to someone who can actually assign them. An
  // educator reading this screen has no need for a roster of their colleagues.
  const mayAssign = can(user, 'classroom:write');
  return {
    classrooms: listClassrooms(user),
    unplaced: unplacedChildren(),
    programs: programsWithRatios(),
    assignable: mayAssign ? assignableStaff() : [],
    staff: mayAssign ? staffByClassroom() : {},
  };
});

router.post('/api/v1/classrooms', (c) => {
  c.require('classroom:write');
  const b = requireBody<{ name?: string; programId?: string | null; capacity?: number | null }>(c);
  if (!b.name) throw badRequest('name is required');
  return attendance(() => createClassroom(b.name!, {
    programId: b.programId ?? null,
    capacity: b.capacity ?? null,
  }, actorOf(c)));
});

router.patch('/api/v1/classrooms/:id', (c) => {
  c.require('classroom:write');
  const b = requireBody<{
    name?: string; programId?: string | null; capacity?: number | null; active?: boolean;
  }>(c);
  return attendance(() => updateClassroom(c.params.id!, b, actorOf(c)));
});

/** Place a child in a room, and enrol them, in one go. */
router.patch('/api/v1/children/:id/placement', (c) => {
  c.require('child:write');
  const b = requireBody<{ classroomId?: string | null; status?: string }>(c);
  return attendance(() => assignChild(c.params.id!, b, actorOf(c)));
});

/**
 * Put a child back where they were, for the click that was a mistake.
 *
 * A new placement rather than an erasure: the log keeps both the move and the
 * undo, because "who moved this child, and when" has to stay answerable.
 */
router.post('/api/v1/children/:id/placement/undo', (c) => {
  c.require('child:write');
  return attendance(() => undoLastPlacement(c.params.id!, c.user!, actorOf(c)));
});

router.patch('/api/v1/programs/:id/ratio', (c) => {
  c.require('classroom:write');
  const b = requireBody<{ childrenPerStaff?: number | null; source?: string }>(c);

  if (b.childrenPerStaff === null) {
    // Removing a ratio is a real choice, not a failure: the room goes back to
    // reporting "not measured", which is the honest state.
    return { cleared: clearRatio(c.params.id!, actorOf(c)) };
  }
  if (typeof b.childrenPerStaff !== 'number') {
    throw badRequest('childrenPerStaff must be a number, or null to remove the rule');
  }
  return attendance(() => setRatio(
    c.params.id!, b.childrenPerStaff!, b.source ?? null, actorOf(c)));
});
