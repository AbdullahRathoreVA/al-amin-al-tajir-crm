/**
 * Dashboard reads: today, attention, pipeline, health.
 *
 * Every number here is a COUNT over real rows. Where something genuinely has
 * not been measured, the field is null and the UI renders "not measured" —
 * never 0, which reads as "measured, and the answer is none". (spec 14 / 150)
 */
import { one, many } from '../db/index.ts';
import { channelStatus, SYNC_CHANNELS } from './sync.ts';
import { dayBounds, nowIso, plainAll } from './util.ts';
import { newestBackup } from './backup.ts';
import { outgrown } from './progression.ts';
import { provider as aiProvider } from './ai.ts';

const count = (sql: string, ...p: (string | number | null)[]): number =>
  Number(one<{ n: number }>(sql, ...p)?.n ?? 0);

// ------------------------------------------------------------------- today

export interface TodaySummary {
  toursToday: number;
  newLeads24h: number;
  registrations24h: number;
  tasksOverdue: number;
  tasksDueToday: number;
  unreadNotifications: number;
}

export function todaySummary(): TodaySummary {
  const { start, end } = dayBounds();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  return {
    toursToday: count(
      `SELECT COUNT(*) n FROM tours WHERE scheduled_for BETWEEN ? AND ?
        AND status IN ('scheduled','confirmed','requested')`, start, end),
    newLeads24h: count('SELECT COUNT(*) n FROM leads WHERE created_at >= ?', dayAgo),
    registrations24h: count('SELECT COUNT(*) n FROM registrations WHERE created_at >= ?', dayAgo),
    tasksOverdue: count(
      `SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND due_at IS NOT NULL AND due_at < ?`, nowIso()),
    tasksDueToday: count(
      `SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND due_at BETWEEN ? AND ?`, start, end),
    unreadNotifications: count(`SELECT COUNT(*) n FROM notifications WHERE state = 'unread'`),
  };
}

// --------------------------------------------------------------- attention

export type Severity = 'critical' | 'warning' | 'info';

export interface AttentionItem {
  id: string;
  severity: Severity;
  label: string;
  count: number;
  /** Where clicking goes. Every item opens a real filtered view. (spec 13/72) */
  link: string;
  detail: string;
}

/**
 * The attention radar. Only items with count > 0 are returned — an empty radar
 * is a real and good answer, and padding it with zeroes trains people to ignore
 * it.
 */
export function attention(): AttentionItem[] {
  const now = nowIso();
  const { start, end } = dayBounds();
  const items: AttentionItem[] = [];

  const push = (i: AttentionItem) => { if (i.count > 0) items.push(i); };

  // Children who have aged past their room. Nothing is moved automatically —
  // that depends on space, ratios and the parents — so it surfaces here for a
  // person to decide. Counted through the same function the screen uses, so
  // the number on the radar and the list behind it cannot disagree.
  push({
    id: 'children-outgrown', severity: 'warning',
    label: 'children have outgrown their room',
    count: outgrown().length,
    link: '/attendance?view=progression',
    detail: 'Old enough for the next room, and still in the last one',
  });

  push({
    id: 'followups-overdue', severity: 'critical',
    label: 'follow-ups overdue',
    count: count(`SELECT COUNT(*) n FROM leads WHERE next_action_due IS NOT NULL AND next_action_due < ?`, now),
    link: '/leads?filter=overdue',
    detail: 'Leads whose next action passed its due date',
  });
  push({
    id: 'tasks-overdue', severity: 'critical',
    label: 'tasks overdue',
    count: count(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND due_at < ?`, now),
    link: '/tasks?filter=overdue',
    detail: 'Assigned work past its due date',
  });
  push({
    id: 'registrations-incomplete', severity: 'warning',
    label: 'registrations incomplete',
    count: count(`SELECT COUNT(*) n FROM registrations WHERE status = 'incomplete'`),
    link: '/registrations?filter=incomplete',
    detail: 'A parent started a registration and stopped partway',
  });
  push({
    id: 'registrations-unreviewed', severity: 'warning',
    label: 'registrations awaiting review',
    count: count(`SELECT COUNT(*) n FROM registrations WHERE status = 'submitted'`),
    link: '/registrations?filter=submitted',
    detail: 'Submitted from the website, nobody has looked yet',
  });
  push({
    id: 'tours-today', severity: 'info',
    label: 'tours today',
    count: count(`SELECT COUNT(*) n FROM tours WHERE scheduled_for BETWEEN ? AND ?
                   AND status IN ('scheduled','confirmed')`, start, end),
    link: '/tours?filter=today',
    detail: 'Confirmed visits happening today',
  });
  push({
    id: 'tours-unconfirmed', severity: 'warning',
    label: 'tour requests unconfirmed',
    count: count(`SELECT COUNT(*) n FROM tours WHERE status = 'requested'`),
    link: '/tours?filter=requested',
    detail: 'A parent asked for a tour and has not been given a time',
  });
  push({
    id: 'duplicates', severity: 'warning',
    label: 'possible duplicate families',
    count: count(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND title LIKE 'Possible duplicate%'`),
    link: '/families?filter=duplicates',
    detail: 'Inbound records that resembled an existing family and were not merged',
  });
  push({
    id: 'sync-errors', severity: 'critical',
    label: 'integration events failed',
    // Only genuine failures. Rows queued for a channel nobody has connected
    // are not an incident and must not appear on the attention radar.
    count: count(`SELECT COUNT(*) n FROM outbox WHERE status IN ('failed','dead')`),
    link: '/system?tab=outbox',
    detail: 'Outbound syncs that could not be delivered',
  });
  push({
    id: 'ingest-failed', severity: 'critical',
    label: 'inbound events failed',
    count: count(`SELECT COUNT(*) n FROM ingest_events WHERE status = 'failed'`),
    link: '/system?tab=ingest',
    detail: 'Website submissions the CRM could not process',
  });
  push({
    id: 'leads-unowned', severity: 'info',
    label: 'leads with no owner',
    count: count(`SELECT COUNT(*) n FROM leads l JOIN lead_stages s ON s.id = l.stage_id
                   WHERE s.is_open = 1 AND l.owner_id IS NULL`),
    link: '/leads?filter=unowned',
    detail: 'Open leads nobody is responsible for',
  });

  const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

// ---------------------------------------------------------------- pipeline

export interface PipelineStage { id: string; label: string; sortOrder: number; count: number; isOpen: boolean }

export function pipeline(): PipelineStage[] {
  return many<{ id: string; label: string; sort_order: number; is_open: number; n: number }>(
    `SELECT s.id, s.label, s.sort_order, s.is_open, COUNT(l.id) AS n
       FROM lead_stages s LEFT JOIN leads l ON l.stage_id = s.id
      GROUP BY s.id ORDER BY s.sort_order`,
  ).map((r) => ({ id: r.id, label: r.label, sortOrder: r.sort_order, count: Number(r.n), isOpen: !!r.is_open }));
}

// ------------------------------------------------------------ program health

export interface ProgramHealth {
  id: string; name: string;
  /** null means the capacity was never recorded. Do not render as 0. */
  capacity: number | null;
  enrolled: number; waitlisted: number; inquiries: number;
  occupancy: number | null;
}

export function programHealth(): ProgramHealth[] {
  return many<{ id: string; name: string; capacity: number | null }>(
    'SELECT id, name, capacity FROM programs WHERE active = 1 ORDER BY sort_order, name',
  ).map((p) => {
    const enrolled = count(`SELECT COUNT(*) n FROM children WHERE program_id = ? AND status = 'enrolled'`, p.id);
    const waitlisted = count(`SELECT COUNT(*) n FROM waitlist WHERE program_id = ? AND status = 'waiting'`, p.id);
    const inquiries = count(
      `SELECT COUNT(*) n FROM leads l JOIN lead_stages s ON s.id = l.stage_id
        WHERE s.is_open = 1 AND l.program_interest = ?`, p.name);
    return {
      id: p.id, name: p.name, capacity: p.capacity, enrolled, waitlisted, inquiries,
      occupancy: p.capacity && p.capacity > 0 ? enrolled / p.capacity : null,
    };
  });
}

// ---------------------------------------------------------------- work lists

export function toursToday() {
  const { start, end } = dayBounds();
  return plainAll(many(
    `SELECT t.id, t.status, t.scheduled_for, t.notes, f.id AS family_id, f.name AS family_name,
            (SELECT g.phone FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS phone,
            (SELECT g.email FROM guardians g WHERE g.family_id = f.id ORDER BY g.is_primary DESC LIMIT 1) AS email
       FROM tours t JOIN families f ON f.id = t.family_id
      WHERE t.scheduled_for BETWEEN ? AND ? AND t.status NOT IN ('cancelled')
      ORDER BY t.scheduled_for`, start, end,
  ));
}

export function overdueFollowUps(limit = 50) {
  return plainAll(many(
    `SELECT l.id, l.next_action, l.next_action_due, l.next_action_reason, l.owner_id,
            f.id AS family_id, f.name AS family_name, s.label AS stage
       FROM leads l JOIN families f ON f.id = l.family_id JOIN lead_stages s ON s.id = l.stage_id
      WHERE l.next_action_due IS NOT NULL AND l.next_action_due < ?
      ORDER BY l.next_action_due LIMIT ?`, nowIso(), limit,
  ));
}

// -------------------------------------------------------------- data health

export interface DataHealth {
  score: number | null;
  measured: boolean;
  totalFamilies: number;
  issues: { id: string; label: string; count: number; link: string }[];
}

/**
 * A measured score, or nothing. With no families there is no denominator, so
 * the honest answer is `measured: false` rather than a flattering 100. (spec 65)
 */
export function dataHealth(): DataHealth {
  const totalFamilies = count('SELECT COUNT(*) n FROM families');
  const issues = [
    { id: 'no-contact', label: 'families with no email or phone',
      count: count(`SELECT COUNT(*) n FROM families f WHERE NOT EXISTS (
                      SELECT 1 FROM guardians g WHERE g.family_id = f.id
                        AND (g.email IS NOT NULL OR g.phone IS NOT NULL))`),
      link: '/families?filter=no-contact' },
    { id: 'no-children', label: 'families with no child recorded',
      count: count(`SELECT COUNT(*) n FROM families f WHERE NOT EXISTS (
                      SELECT 1 FROM children c WHERE c.family_id = f.id)`),
      link: '/families?filter=no-children' },
    { id: 'dupes', label: 'unresolved possible duplicates',
      count: count(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND title LIKE 'Possible duplicate%'`),
      link: '/families?filter=duplicates' },
    { id: 'stale-leads', label: 'open leads untouched for 30 days',
      count: count(`SELECT COUNT(*) n FROM leads l JOIN lead_stages s ON s.id = l.stage_id
                     WHERE s.is_open = 1 AND l.updated_at < ?`,
        new Date(Date.now() - 30 * 864e5).toISOString()),
      link: '/leads?filter=stale' },
    { id: 'unowned', label: 'open leads with no owner',
      count: count(`SELECT COUNT(*) n FROM leads l JOIN lead_stages s ON s.id = l.stage_id
                     WHERE s.is_open = 1 AND l.owner_id IS NULL`),
      link: '/leads?filter=unowned' },
  ].filter((i) => i.count > 0);

  if (totalFamilies === 0) {
    return { score: null, measured: false, totalFamilies, issues };
  }
  const problems = issues.reduce((s, i) => s + i.count, 0);
  const score = Math.max(0, Math.round(100 - (problems / totalFamilies) * 100));
  return { score, measured: true, totalFamilies, issues };
}

// ------------------------------------------------------------- system health

export type HealthState = 'good' | 'warning' | 'critical' | 'unknown';

export interface SystemCheck { id: string; label: string; state: HealthState; detail: string }

export function systemHealth(): SystemCheck[] {
  const checks: SystemCheck[] = [];

  const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check');
  const ok = integrity?.integrity_check === 'ok';
  checks.push({
    id: 'database', label: 'Database', state: ok ? 'good' : 'critical',
    detail: ok ? 'Integrity check passed' : `Integrity check returned: ${integrity?.integrity_check ?? 'no result'}`,
  });

  const failedOut = count(`SELECT COUNT(*) n FROM outbox WHERE status IN ('failed','dead')`);
  const pendingOut = count(`SELECT COUNT(*) n FROM outbox WHERE status = 'pending'`);
  // A queue with nowhere to go is a setup step, not a fault. Reporting it as a
  // warning for months - which is what happened, because nothing drained the
  // outbox - teaches people that this panel's warnings can be ignored.
  const unconnected = SYNC_CHANNELS
    .map(channelStatus)
    .filter((s) => !s.connected)
    .map((s) => String(s.channel));
  const parked = unconnected.length > 0 && failedOut === 0;
  checks.push({
    id: 'outbox', label: 'Outbound sync',
    state: failedOut > 0 ? 'critical' : parked ? 'unknown' : pendingOut > 0 ? 'warning' : 'good',
    detail: failedOut > 0 ? `${failedOut} failed, ${pendingOut} pending`
      : parked ? `${pendingOut} queued, waiting for ${unconnected.join(', ')} to be connected`
      : pendingOut > 0 ? `${pendingOut} queued, none failed`
      : 'Nothing queued or failed',
  });

  const failedIn = count(`SELECT COUNT(*) n FROM ingest_events WHERE status = 'failed'`);
  const totalIn = count('SELECT COUNT(*) n FROM ingest_events');
  checks.push({
    id: 'ingest', label: 'Website intake',
    state: failedIn > 0 ? 'critical' : totalIn > 0 ? 'good' : 'unknown',
    detail: failedIn > 0 ? `${failedIn} of ${totalIn} events failed`
      : totalIn > 0 ? `${totalIn} events received, none failed`
      : 'No events received yet - not measured',
  });

  // Deliberately 'unknown', not 'good'. Nothing has connected these yet, and a
  // green light for a thing that does not exist is a lie. (spec 137 / 218)
  //
  // The sync itself is built now, so the reason is no longer 'unimplemented'.
  // Ask the channel what is actually missing rather than restating a phase
  // number that stopped being true.
  const sheets = channelStatus('google-sheets');
  checks.push({
    id: 'google-sheets', label: 'Google Sheets',
    state: sheets.connected ? (Number(sheets.dead) > 0 ? 'critical' : 'good') : 'unknown',
    detail: sheets.connected
      ? `Connected. ${sheets.sent} row(s) sent, ${sheets.pending} queued`
      : String(sheets.notConnectedReason ?? 'Not connected'),
  });
  // Hard-coded to "Phase 4" long after the AI layer shipped, so the one screen
  // whose whole promise is "real states only" was reporting a stale one. It is
  // read from the actual provider now. Deliberately not the network check:
  // systemHealth() is synchronous, and "is it configured" is the question a
  // person is asking here anyway.
  const ai = aiProvider();
  checks.push({
    id: 'ai', label: 'AI assistant',
    state: ai ? 'good' : 'unknown',
    detail: ai
      ? `Using ${ai.name}. Summaries and briefings only — it can never send to a parent.`
      : 'Off. Everything works without it; set CRM_AI_PROVIDER to switch it on.',
  });
  const backup = newestBackup();
  checks.push({
    id: 'backup', label: 'Backup',
    state: !backup ? 'critical' : backup.ageHours > 48 ? 'warning' : 'good',
    detail: !backup
      ? 'No backup exists. Every family would be lost with the disk.'
      : `${backup.file} taken ${backup.ageHours}h ago, ${Math.round(backup.sizeBytes / 1024)}kB`,
  });

  return checks;
}
