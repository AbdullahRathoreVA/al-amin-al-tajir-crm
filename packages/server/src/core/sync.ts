/**
 * Outbound sync.
 *
 * The CRM database is the source of truth and a spreadsheet is an integration
 * surface, not a database. Everything here follows from that: rows are queued
 * after the CRM write has committed, a failure to send never rolls back a
 * registration, and nothing outside is ever read back as authoritative.
 *
 * The transport is pluggable so the machinery — batching, backoff, the
 * dead-letter, `no_sync`, the run log — is testable without a network. That
 * matters more than it sounds: the interesting failures here are all in the
 * retry logic, and a test that needs Google to be reachable is a test nobody
 * runs.
 *
 * Nothing in this file holds a credential. See `transports/sheets.ts`.
 */
import { one, many, run, tx } from '../db/index.ts';
import { newId, nowIso, safeJson, plainAll } from './util.ts';

export interface OutboxRow {
  id: string;
  channel: string;
  payload_json: string;
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  family_id: string | null;
}

export interface SyncTarget {
  id: string;
  channel: string;
  label: string;
  external_id: string | null;
  tab_name: string | null;
  mapping_json: string;
  enabled: number;
  last_sync_at: string | null;
}

/**
 * What a transport must be able to do.
 *
 * `ready()` is separate from `send()` on purpose. "Not connected" and "tried
 * and failed" are different facts and must not share a code path: one is a
 * setup step nobody has done, the other is an incident.
 */
export interface Transport {
  channel: string;
  /** Why it is not ready, or null when it is. */
  notReadyReason(target: SyncTarget | null): string | null;
  /** Sends a batch. Throws to mark the whole batch failed and retryable. */
  /** `target` is null for channels that need no configured destination — email
   *  sends to whatever the queued row names. A transport that does need one
   *  says so in notReadyReason and will not be called without it. */
  send(target: SyncTarget | null, rows: OutboxRow[]): Promise<{ sent: number; detail?: string }>;
  /** Optional. Runs after every attempt, including the ones that did nothing,
   *  so a channel can reconcile its own records with what the queue did. */
  afterRun?(result: RunResult): void;
}

/** Channels the system knows about, whether or not they are connected yet.
 *  Lives here rather than in routes so the health check can read it without
 *  importing the router and creating a cycle. */
export const SYNC_CHANNELS = ['google-sheets', 'email'] as const;

const transports = new Map<string, Transport>();
export function registerTransport(t: Transport): void { transports.set(t.channel, t); }
export function transportFor(channel: string): Transport | undefined { return transports.get(channel); }

// ------------------------------------------------------------------ targets

export function targetFor(channel: string): SyncTarget | null {
  return one<SyncTarget>('SELECT * FROM sync_targets WHERE channel = ?', channel) ?? null;
}

export function listTargets(): Record<string, unknown>[] {
  return plainAll(many<Record<string, unknown>>('SELECT * FROM sync_targets ORDER BY channel'));
}

export function upsertTarget(
  channel: string,
  patch: { label?: string; externalId?: string | null; tabName?: string | null;
           mapping?: Record<string, string>; enabled?: boolean },
): SyncTarget {
  const now = nowIso();
  const existing = targetFor(channel);
  if (!existing) {
    run(`INSERT INTO sync_targets (id, channel, label, external_id, tab_name, mapping_json,
           enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      newId(), channel, patch.label ?? channel, patch.externalId ?? null, patch.tabName ?? null,
      JSON.stringify(patch.mapping ?? {}), patch.enabled ? 1 : 0, now, now);
    return targetFor(channel)!;
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.label !== undefined) { sets.push('label = ?'); params.push(patch.label); }
  if (patch.externalId !== undefined) { sets.push('external_id = ?'); params.push(patch.externalId); }
  if (patch.tabName !== undefined) { sets.push('tab_name = ?'); params.push(patch.tabName); }
  if (patch.mapping !== undefined) { sets.push('mapping_json = ?'); params.push(JSON.stringify(patch.mapping)); }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); params.push(patch.enabled ? 1 : 0); }
  if (sets.length) {
    run(`UPDATE sync_targets SET ${sets.join(', ')}, updated_at = ? WHERE channel = ?`,
      ...params, now, channel);
  }
  return targetFor(channel)!;
}

// ------------------------------------------------------------------ backoff

/** Bounded. After this many attempts a row is dead and a person must look. */
export const MAX_ATTEMPTS = 6;

/**
 * Exponential, with jitter.
 *
 * The jitter is not decoration: without it every row queued by the same burst
 * retries in the same instant, which is how a rate limit becomes a permanent
 * rate limit. Capped at an hour so a recovered service is picked up promptly.
 */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const base = Math.min(2 ** attempts * 1000, 3_600_000);
  return Math.round(base * (0.5 + rand() * 0.5));
}

// -------------------------------------------------------------------- queue

export function queue(channel: string, payload: unknown, familyId?: string | null): string {
  const id = newId();
  const now = nowIso();
  run(`INSERT INTO outbox (id, channel, payload_json, status, attempts, next_retry_at,
         family_id, created_at, updated_at) VALUES (?,?,?,'pending',0,?,?,?,?)`,
    id, channel, JSON.stringify(payload), now, familyId ?? null, now, now);
  return id;
}

/**
 * Rows that are due, excluding families that opted out.
 *
 * `no_sync` is enforced here, in the selection, because that is the only place
 * it cannot be forgotten. A check further down would depend on every future
 * caller remembering it.
 */
export function due(channel: string, now: string, limit = 100): OutboxRow[] {
  return many<OutboxRow>(
    `SELECT o.* FROM outbox o
      LEFT JOIN families f ON f.id = o.family_id
     WHERE o.channel = ?
       AND o.status = 'pending'
       AND (o.next_retry_at IS NULL OR o.next_retry_at <= ?)
       AND COALESCE(f.no_sync, 0) = 0
     ORDER BY o.created_at
     LIMIT ?`, channel, now, limit);
}

/** Queued rows held back purely because a family opted out. */
export function suppressed(channel: string): number {
  return Number(one<{ n: number }>(
    `SELECT COUNT(*) n FROM outbox o JOIN families f ON f.id = o.family_id
      WHERE o.channel = ? AND o.status = 'pending' AND f.no_sync = 1`, channel)?.n ?? 0);
}

// ---------------------------------------------------------------- the worker

export interface RunResult {
  channel: string;
  outcome: 'sent' | 'nothing_queued' | 'not_connected' | 'failed' | 'skipped';
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  detail: string | null;
}

/**
 * Drains one channel once.
 *
 * Every outcome is written to `sync_runs`, including the boring ones. A log
 * that records only successes cannot answer "why didn't it sync?", which is
 * the only question anyone ever asks of a sync.
 */
export async function runChannel(
  channel: string,
  opts: { now?: string; limit?: number; rand?: () => number } = {},
): Promise<RunResult> {
  const now = opts.now ?? nowIso();
  const runId = newId();
  const target = targetFor(channel);
  const transport = transportFor(channel);
  const held = suppressed(channel);

  const finish = (r: Omit<RunResult, 'channel'>): RunResult => {
    run(`INSERT INTO sync_runs (id, channel, started_at, finished_at, outcome,
           considered, sent, skipped, failed, detail) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      runId, channel, now, nowIso(), r.outcome, r.considered, r.sent, r.skipped, r.failed,
      r.detail);
    const result = { channel, ...r };
    // Never let a channel's own bookkeeping turn a completed run into a crash.
    try { transport?.afterRun?.(result); }
    catch (err) { console.error('[crm] afterRun failed:', err instanceof Error ? err.message : err); }
    return result;
  };

  if (!transport) {
    return finish({ outcome: 'not_connected', considered: 0, sent: 0, skipped: held, failed: 0,
      detail: `No transport is registered for "${channel}".` });
  }
  const notReady = transport.notReadyReason(target);
  if (notReady) {
    // Not an error. Nobody has connected it yet, and saying "failed" here would
    // put a red light on a setup step.
    return finish({ outcome: 'not_connected', considered: 0, sent: 0, skipped: held, failed: 0,
      detail: notReady });
  }

  const rows = due(channel, now, opts.limit ?? 100);
  if (!rows.length) {
    return finish({ outcome: 'nothing_queued', considered: 0, sent: 0, skipped: held, failed: 0,
      detail: held ? `${held} row(s) held back by a family's "never sync" setting.` : null });
  }

  try {
    const { sent, detail } = await transport.send(target, rows);
    const stamped = nowIso();
    tx(() => {
      for (const r of rows) {
        run(`UPDATE outbox SET status = 'sent', attempts = attempts + 1, last_error = NULL,
               next_retry_at = NULL, updated_at = ? WHERE id = ?`, stamped, r.id);
      }
      run('UPDATE sync_targets SET last_sync_at = ?, updated_at = ? WHERE channel = ?',
        stamped, stamped, channel);
    });
    return finish({ outcome: 'sent', considered: rows.length, sent, skipped: held, failed: 0,
      detail: detail ?? null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stamped = nowIso();
    let dead = 0;
    tx(() => {
      for (const r of rows) {
        const attempts = r.attempts + 1;
        // Bounded, then a person looks at it. An infinite retry is a queue that
        // never drains and an alert nobody believes.
        const isDead = attempts >= MAX_ATTEMPTS;
        if (isDead) dead++;
        run(`UPDATE outbox SET status = ?, attempts = ?, last_error = ?, next_retry_at = ?,
               updated_at = ? WHERE id = ?`,
          isDead ? 'dead' : 'pending', attempts, message.slice(0, 500),
          isDead ? null : new Date(Date.parse(stamped) + backoffMs(attempts, opts.rand)).toISOString(),
          stamped, r.id);
      }
    });
    return finish({
      outcome: 'failed', considered: rows.length, sent: 0, skipped: held, failed: rows.length,
      detail: dead ? `${message} (${dead} row(s) gave up after ${MAX_ATTEMPTS} attempts)` : message,
    });
  }
}

export function recentRuns(channel?: string, limit = 20): Record<string, unknown>[] {
  return plainAll(channel
    ? many<Record<string, unknown>>(
        'SELECT * FROM sync_runs WHERE channel = ? ORDER BY started_at DESC LIMIT ?', channel, limit)
    : many<Record<string, unknown>>(
        'SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT ?', limit));
}

/**
 * What /system should say about a channel.
 *
 * Distinguishes "queued with nowhere to go" from "queued and failing", because
 * the first is a setup step and the second is an incident, and showing both as
 * a warning is how a warning stops meaning anything.
 */
export function channelStatus(channel: string): Record<string, unknown> {
  const transport = transportFor(channel);
  const target = targetFor(channel);
  const notReady = transport ? transport.notReadyReason(target) : `No transport for "${channel}".`;
  const n = (sql: string) => Number(one<{ n: number }>(sql, channel)?.n ?? 0);

  return {
    channel,
    connected: !notReady,
    notConnectedReason: notReady,
    pending: n(`SELECT COUNT(*) n FROM outbox WHERE channel = ? AND status = 'pending'`),
    sent: n(`SELECT COUNT(*) n FROM outbox WHERE channel = ? AND status = 'sent'`),
    dead: n(`SELECT COUNT(*) n FROM outbox WHERE channel = ? AND status = 'dead'`),
    suppressed: suppressed(channel),
    lastSyncAt: target?.last_sync_at ?? null,
    lastRun: recentRuns(channel, 1)[0] ?? null,
  };
}

/** The mapping a target applies, with the documented default. */
export function mappingFor(target: SyncTarget | null): Record<string, string> {
  const saved = safeJson<Record<string, string>>(target?.mapping_json ?? '{}', {});
  return Object.keys(saved).length ? saved : { ...DEFAULT_MAPPING };
}

/** Column heading -> dotted path into the queued payload. (docs/GOOGLE-SHEETS.md) */
export const DEFAULT_MAPPING: Record<string, string> = {
  'Parent Name': 'guardian.fullName',
  'Email': 'guardian.email',
  'Phone': 'guardian.phone',
  'Child Name': 'child.firstName',
  'DOB': 'child.dateOfBirth',
  'Program': 'programInterest',
  'Start Date': 'desiredStart',
  'Notes': 'notes',
};

/** Reads a dotted path, returning '' rather than 'undefined' for a gap. */
export function pluck(source: unknown, path: string): string {
  let cur: unknown = source;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[part];
  }
  if (cur === null || cur === undefined) return '';
  return typeof cur === 'string' ? cur : JSON.stringify(cur);
}

/** Turns a queued row into the cells a sheet expects, in heading order. */
export function toRow(payload: unknown, mapping: Record<string, string>): string[] {
  return Object.values(mapping).map((path) => pluck(payload, path));
}

// ---------------------------------------------------------------- scheduling

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweeps every registered channel on a timer.
 *
 * A scheduled reconciliation, never a hot loop: the Sheets API bills quota per
 * request and a tight poll of an empty queue spends it on nothing. Failures are
 * swallowed here on purpose — they are already recorded in `sync_runs`, and an
 * unhandled rejection in a background timer would take the server down over a
 * spreadsheet being briefly unreachable.
 */
export function startSyncSchedule(intervalMinutes = 15): void {
  const sweep = () => {
    for (const channel of transports.keys()) {
      runChannel(channel).catch((err) => {
        console.error('[crm] sync sweep failed:', err instanceof Error ? err.message : err);
      });
    }
  };
  timer = setInterval(sweep, intervalMinutes * 60_000);
  timer.unref();
  sweep();
}

export function stopSyncSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
