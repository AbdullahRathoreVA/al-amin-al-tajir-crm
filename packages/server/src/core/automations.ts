/**
 * The automation engine.
 *
 * Conditions and actions are a small fixed vocabulary evaluated by a switch,
 * never `eval` or a generated query. A rule is data a director can read and
 * change; it is not a place for arbitrary code to run against a database of
 * children.
 *
 * Three rules the engine holds to, all learned from automation going wrong
 * elsewhere:
 *   - it never sends anything to a parent. It can draft, assign and remind.
 *   - every run is recorded, INCLUDING the ones that did nothing, because
 *     "why didn't it fire?" is the question people actually ask.
 *   - every rule has a cap, so one bad import cannot generate a thousand tasks.
 * (spec 16 / 17 / 186 / 213)
 */
import { one, many, run as sql, tx } from '../db/index.ts';
import { newId, nowIso, safeJson, plainAll } from './util.ts';
import { createTask, notify } from './notify.ts';
import { recordEvent, SYSTEM, type Actor } from './events.ts';

export type Trigger =
  | 'registration.submitted' | 'registration.incomplete'
  | 'tour.requested' | 'tour.completed' | 'tour.upcoming'
  | 'lead.stalled' | 'task.overdue' | 'waitlist.joined' | 'family.created';

export const TRIGGERS: { id: Trigger; label: string; when: string; scheduled: boolean }[] = [
  { id: 'registration.submitted', label: 'A registration is submitted', when: 'The moment it arrives from the website', scheduled: false },
  { id: 'registration.incomplete', label: 'A registration is left unfinished', when: 'When a parent stops partway', scheduled: false },
  { id: 'tour.requested', label: 'A tour is requested', when: 'The moment a parent asks', scheduled: false },
  { id: 'tour.completed', label: 'A tour is marked completed', when: 'When staff close it out', scheduled: false },
  { id: 'tour.upcoming', label: 'A tour is coming up', when: 'Checked hourly', scheduled: true },
  { id: 'lead.stalled', label: 'A lead has gone quiet', when: 'Checked hourly', scheduled: true },
  { id: 'task.overdue', label: 'A task is overdue', when: 'Checked hourly', scheduled: true },
  { id: 'waitlist.joined', label: 'A family joins the waitlist', when: 'On joining', scheduled: false },
  { id: 'family.created', label: 'A new family is created', when: 'However they arrived', scheduled: false },
];

// ------------------------------------------------------------- conditions

export type Condition =
  | { type: 'hours_since'; field: 'created' | 'last_contact' | 'due'; moreThan: number }
  | { type: 'no_contact_logged' }
  | { type: 'no_open_task' }
  | { type: 'program_is'; value: string }
  | { type: 'stage_is'; value: string };

export type Action =
  | { type: 'create_task'; title: string; priority?: 'critical' | 'high' | 'normal' | 'low'; dueInHours?: number; reason?: string }
  | { type: 'notify'; tier?: 'critical' | 'high' | 'normal'; title: string }
  | { type: 'set_next_action'; text: string; dueInHours?: number; reason?: string }
  | { type: 'assign_owner'; userId: string }
  | { type: 'add_note'; body: string };

export interface AutomationRow {
  id: string; name: string; description: string | null; trigger: Trigger;
  conditions: string; actions: string;
  enabled: number; test_mode: number; max_per_run: number; built_in: number;
  run_count: number; last_run_at: string | null;
}

export interface Automation extends Omit<AutomationRow, 'conditions' | 'actions'> {
  conditions: Condition[];
  actions: Action[];
}

const hydrate = (r: AutomationRow): Automation => ({
  ...r,
  conditions: safeJson<Condition[]>(r.conditions, []),
  actions: safeJson<Action[]>(r.actions, []),
});

// -------------------------------------------------------------- built-ins

/**
 * The rules that were previously hard-coded in the ingestion pipeline, now
 * visible and editable. Seeded disabled where they would duplicate what the
 * pipeline already does directly, so nothing fires twice on day one.
 */
const BUILT_IN: Omit<Automation, 'run_count' | 'last_run_at'>[] = [
  {
    id: 'auto_tour_followup',
    name: 'Chase a tour that had no follow-up',
    description: 'Two days after a completed tour with nothing logged since, create a task.',
    trigger: 'tour.completed',
    conditions: [{ type: 'hours_since', field: 'created', moreThan: 48 }, { type: 'no_contact_logged' }],
    actions: [
      { type: 'create_task', title: 'Follow up after the tour', priority: 'high', dueInHours: 24,
        reason: 'A tour was completed two days ago and nothing has been logged since' },
      { type: 'set_next_action', text: 'Follow up after the tour', dueInHours: 24,
        reason: 'Tour completed, no follow-up recorded' },
    ],
    enabled: 1, test_mode: 0, max_per_run: 50, built_in: 1,
  },
  {
    id: 'auto_stalled_lead',
    name: 'Flag a lead nobody has touched',
    description: 'An open lead with no contact for five days gets a task and an alert.',
    trigger: 'lead.stalled',
    conditions: [{ type: 'hours_since', field: 'last_contact', moreThan: 120 }, { type: 'no_open_task' }],
    actions: [
      { type: 'create_task', title: 'This family has gone quiet', priority: 'normal', dueInHours: 24,
        reason: 'No contact logged for five days on an open enquiry' },
      { type: 'notify', tier: 'normal', title: 'A lead has gone quiet' },
    ],
    enabled: 1, test_mode: 0, max_per_run: 25, built_in: 1,
  },
  {
    id: 'auto_tour_reminder',
    name: 'Remind staff about tomorrow',
    description: 'A day before a confirmed tour, make sure somebody is expecting it.',
    trigger: 'tour.upcoming',
    conditions: [],
    actions: [
      { type: 'create_task', title: 'Tour tomorrow: confirm who is hosting', priority: 'high', dueInHours: 12,
        reason: 'A confirmed tour is happening within 24 hours' },
    ],
    enabled: 1, test_mode: 0, max_per_run: 25, built_in: 1,
  },
  {
    id: 'auto_unfinished_registration',
    name: 'Rescue an unfinished registration',
    description: 'Three days after a parent stopped partway, prompt someone to help them finish.',
    trigger: 'registration.incomplete',
    conditions: [{ type: 'hours_since', field: 'created', moreThan: 72 }, { type: 'no_open_task' }],
    actions: [
      { type: 'create_task', title: 'Offer to finish the registration by phone', priority: 'normal', dueInHours: 48,
        reason: 'A parent started a registration three days ago and did not finish it' },
    ],
    enabled: 1, test_mode: 0, max_per_run: 25, built_in: 1,
  },
];

export function seedAutomations(): number {
  const now = nowIso();
  let added = 0;
  for (const a of BUILT_IN) {
    if (one('SELECT id FROM automations WHERE id = ?', a.id)) continue;
    sql(
      `INSERT INTO automations (id, name, description, trigger, conditions, actions,
         enabled, test_mode, max_per_run, built_in, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, a.name, a.description, a.trigger,
      JSON.stringify(a.conditions), JSON.stringify(a.actions),
      a.enabled, a.test_mode, a.max_per_run, a.built_in, now, now,
    );
    added++;
  }
  return added;
}

export function listAutomations(): Automation[] {
  return plainAll(many<AutomationRow>('SELECT * FROM automations ORDER BY built_in DESC, name')).map(hydrate);
}

// -------------------------------------------------------------- evaluation

interface Subject {
  entityType: 'family' | 'lead' | 'tour' | 'registration' | 'task';
  entityId: string;
  familyId: string;
  familyName: string;
  leadId: string | null;
  createdAt: string;
  lastContactAt: string | null;
  dueAt: string | null;
  program: string | null;
  stage: string | null;
}

const hoursSince = (iso: string | null): number =>
  iso === null ? Number.POSITIVE_INFINITY : (Date.now() - new Date(iso).getTime()) / 36e5;

/** Returns null when it matches, or the reason it did not. */
function evaluate(conditions: Condition[], s: Subject): string | null {
  for (const c of conditions) {
    switch (c.type) {
      case 'hours_since': {
        const at = c.field === 'created' ? s.createdAt : c.field === 'last_contact' ? s.lastContactAt : s.dueAt;
        const h = hoursSince(at);
        if (!(h > c.moreThan)) {
          return `only ${Math.round(h)}h since ${c.field.replace('_', ' ')}, needs more than ${c.moreThan}h`;
        }
        break;
      }
      case 'no_contact_logged':
        if (s.lastContactAt && hoursSince(s.lastContactAt) < hoursSince(s.createdAt)) {
          return 'contact has been logged since';
        }
        break;
      case 'no_open_task': {
        const open = one<{ n: number }>(
          `SELECT COUNT(*) n FROM tasks WHERE related_id IN (?, ?) AND status IN ('open','doing')`,
          s.entityId, s.familyId);
        if (Number(open?.n ?? 0) > 0) return 'there is already an open task';
        break;
      }
      case 'program_is':
        if ((s.program ?? '').toLowerCase() !== c.value.toLowerCase()) {
          return `program is ${s.program ?? 'unset'}, not ${c.value}`;
        }
        break;
      case 'stage_is':
        if (s.stage !== c.value) return `stage is ${s.stage ?? 'unset'}, not ${c.value}`;
        break;
    }
  }
  return null;
}

function applyActions(actions: Action[], s: Subject, actor: Actor): string[] {
  const done: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'create_task': {
        const due = a.dueInHours ? new Date(Date.now() + a.dueInHours * 36e5).toISOString() : null;
        createTask({
          title: `${a.title}: ${s.familyName}`,
          priority: a.priority ?? 'normal', dueAt: due,
          relatedType: s.entityType, relatedId: s.entityId,
          source: 'automation', reason: a.reason,
          dedupeKey: `auto:${s.entityId}:${a.title}`,
        }, actor);
        done.push(`task "${a.title}"`);
        break;
      }
      case 'notify':
        notify({
          tier: a.tier ?? 'normal',
          title: `${a.title}: ${s.familyName}`,
          linkType: s.entityType, linkId: s.entityId,
          dedupeKey: `auto:${s.entityId}:${a.title}`,
        });
        done.push('alert');
        break;
      case 'set_next_action': {
        if (!s.leadId) { done.push('no lead to set a next action on'); break; }
        const due = new Date(Date.now() + (a.dueInHours ?? 24) * 36e5).toISOString();
        sql('UPDATE leads SET next_action = ?, next_action_due = ?, next_action_reason = ?, updated_at = ? WHERE id = ?',
          a.text, due, a.reason ?? null, nowIso(), s.leadId);
        done.push('next action set');
        break;
      }
      case 'assign_owner':
        sql('UPDATE families SET owner_id = ?, updated_at = ? WHERE id = ? AND owner_id IS NULL',
          a.userId, nowIso(), s.familyId);
        done.push('owner assigned');
        break;
      case 'add_note':
        sql('INSERT INTO notes (id, entity_type, entity_id, body, created_at) VALUES (?,?,?,?,?)',
          newId(), 'family', s.familyId, a.body, nowIso());
        done.push('note added');
        break;
    }
  }
  return done;
}

function record(
  automationId: string, s: Subject | null,
  outcome: 'acted' | 'skipped' | 'failed' | 'test',
  reason: string, actions: string[] | null, ms: number, error?: string,
): void {
  sql(
    `INSERT INTO automation_runs (id, automation_id, entity_type, entity_id, outcome, reason,
       actions_json, error, duration_ms, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId(), automationId, s?.entityType ?? null, s?.entityId ?? null,
    outcome, reason, actions ? JSON.stringify(actions) : null, error ?? null, ms, nowIso(),
  );
}

// -------------------------------------------------------------- subjects

/** Finds what a scheduled trigger should look at right now. */
function subjectsFor(trigger: Trigger, limit: number): Subject[] {
  const base = `
    SELECT f.id AS familyId, f.name AS familyName,
           (SELECT l.id FROM leads l JOIN lead_stages st ON st.id = l.stage_id
             WHERE l.family_id = f.id AND st.is_open = 1 ORDER BY l.created_at DESC LIMIT 1) AS leadId,
           (SELECT l.last_contact_at FROM leads l WHERE l.family_id = f.id ORDER BY l.created_at DESC LIMIT 1) AS lastContactAt`;

  switch (trigger) {
    case 'tour.completed':
      return many<Subject>(
        `SELECT t.id AS entityId, 'tour' AS entityType, t.completed_at AS createdAt,
                NULL AS dueAt, NULL AS program, NULL AS stage, ${base.slice(base.indexOf('f.id AS familyId'))}
           FROM tours t JOIN families f ON f.id = t.family_id
          WHERE t.status = 'completed' AND t.completed_at IS NOT NULL
          ORDER BY t.completed_at DESC LIMIT ?`, limit);

    case 'tour.upcoming': {
      const soon = new Date(Date.now() + 24 * 36e5).toISOString();
      return many<Subject>(
        `SELECT t.id AS entityId, 'tour' AS entityType, t.created_at AS createdAt,
                t.scheduled_for AS dueAt, NULL AS program, NULL AS stage, ${base.slice(base.indexOf('f.id AS familyId'))}
           FROM tours t JOIN families f ON f.id = t.family_id
          WHERE t.status IN ('scheduled','confirmed')
            AND t.scheduled_for BETWEEN ? AND ?
          ORDER BY t.scheduled_for LIMIT ?`, nowIso(), soon, limit);
    }

    case 'lead.stalled':
      return many<Subject>(
        `SELECT l.id AS entityId, 'lead' AS entityType, l.created_at AS createdAt,
                l.next_action_due AS dueAt, l.program_interest AS program, l.stage_id AS stage,
                f.id AS familyId, f.name AS familyName, l.id AS leadId, l.last_contact_at AS lastContactAt
           FROM leads l JOIN families f ON f.id = l.family_id
           JOIN lead_stages s ON s.id = l.stage_id
          WHERE s.is_open = 1
          ORDER BY COALESCE(l.last_contact_at, l.created_at) LIMIT ?`, limit);

    case 'registration.incomplete':
      return many<Subject>(
        `SELECT r.id AS entityId, 'registration' AS entityType, r.created_at AS createdAt,
                NULL AS dueAt, NULL AS program, NULL AS stage, ${base.slice(base.indexOf('f.id AS familyId'))}
           FROM registrations r JOIN families f ON f.id = r.family_id
          WHERE r.status = 'incomplete'
          ORDER BY r.created_at DESC LIMIT ?`, limit);

    case 'task.overdue':
      return many<Subject>(
        `SELECT t.id AS entityId, 'task' AS entityType, t.created_at AS createdAt,
                t.due_at AS dueAt, NULL AS program, NULL AS stage,
                COALESCE(f.id, t.related_id) AS familyId, COALESCE(f.name, 'a record') AS familyName,
                NULL AS leadId, NULL AS lastContactAt
           FROM tasks t LEFT JOIN families f ON f.id = t.related_id
          WHERE t.status IN ('open','doing') AND t.due_at IS NOT NULL AND t.due_at < ?
          ORDER BY t.due_at LIMIT ?`, nowIso(), limit);

    default:
      return [];
  }
}

// ------------------------------------------------------------------- run

export interface RunSummary { automation: string; acted: number; skipped: number; failed: number }

/** Runs one rule over everything it currently applies to. */
export function runAutomation(a: Automation, actor: Actor = SYSTEM): RunSummary {
  const summary: RunSummary = { automation: a.name, acted: 0, skipped: 0, failed: 0 };
  const subjects = subjectsFor(a.trigger, a.max_per_run);

  for (const s of subjects) {
    const started = Date.now();
    try {
      const why = evaluate(a.conditions, s);
      if (why) {
        record(a.id, s, 'skipped', why, null, Date.now() - started);
        summary.skipped++;
        continue;
      }
      if (a.test_mode) {
        record(a.id, s, 'test',
          `Would have run: ${a.actions.map((x) => x.type).join(', ')}`, null, Date.now() - started);
        summary.skipped++;
        continue;
      }
      const done = tx(() => applyActions(a.actions, s, actor));
      record(a.id, s, 'acted', `Conditions met for ${s.familyName}`, done, Date.now() - started);
      summary.acted++;
    } catch (err) {
      record(a.id, s, 'failed', 'The rule threw while running', null, Date.now() - started,
        err instanceof Error ? err.message : String(err));
      summary.failed++;
    }
  }

  sql('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', nowIso(), a.id);
  return summary;
}

/** Every enabled rule for the scheduled triggers. Called on a timer. */
export function runScheduled(actor: Actor = SYSTEM): RunSummary[] {
  const scheduled = new Set(TRIGGERS.filter((t) => t.scheduled).map((t) => t.id));
  return listAutomations()
    .filter((a) => a.enabled && scheduled.has(a.trigger))
    .map((a) => runAutomation(a, actor));
}

export function runsFor(automationId: string, limit = 50) {
  return plainAll(many(
    'SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?',
    automationId, limit));
}

export function recentRuns(limit = 100) {
  return plainAll(many(
    `SELECT r.*, a.name AS automation_name FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
      ORDER BY r.created_at DESC LIMIT ?`, limit));
}

// -------------------------------------------------------------- scheduler

let timer: NodeJS.Timeout | null = null;

export function startAutomationSchedule(intervalMinutes = 60): void {
  const tick = () => {
    try {
      const results = runScheduled();
      const acted = results.reduce((n, r) => n + r.acted, 0);
      if (acted > 0) console.log(`[crm] automations: ${acted} action(s) taken`);
    } catch (err) {
      console.error('[crm] automation sweep failed:', err instanceof Error ? err.message : err);
    }
  };
  timer = setInterval(tick, intervalMinutes * 60_000);
  timer.unref();
}

export function stopAutomationSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** The kill switch. One call stops everything. (spec 186) */
export function disableAll(actor: Actor = SYSTEM): number {
  const n = sql('UPDATE automations SET enabled = 0, updated_at = ? WHERE enabled = 1', nowIso()).changes;
  recordEvent({
    entityType: 'settings', entityId: 'automations', type: 'status_changed', actor,
    summary: `All automations disabled (${n} were running)`,
  });
  return n;
}
