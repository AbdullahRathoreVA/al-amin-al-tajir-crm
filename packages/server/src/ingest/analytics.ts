/**
 * Website analytics ingestion.
 *
 * Separate from the registration pipeline on purpose: this is high-volume,
 * creates no family records, and must never raise a task or an alert. Nobody
 * needs a notification because someone looked at a page.
 *
 * A batch is upserted against its session, so a tab that sends three batches
 * over ten minutes produces one session row with accumulating totals rather
 * than three orphans.
 */
import { one, run, tx } from '../db/index.ts';
import { newId, nowIso } from '../core/util.ts';
import type { AnalyticsBatch } from '@crm/shared';

export interface AnalyticsResult {
  kind: 'analytics';
  status: 'processed' | 'duplicate';
  eventId: string;
  sessionId: string;
  hitsRecorded: number;
}

/** Events that mean this visit turned into something. */
const CONVERSION_EVENTS = new Set([
  'enrollment_complete', 'tour_flow_complete', 'waitlist_complete',
]);

export function ingestAnalytics(eventId: string, batch: AnalyticsBatch, country?: string): AnalyticsResult {
  const now = nowIso();

  const recorded = tx(() => {
    const existing = one<{ id: string; engaged_ms: number; pageviews: number; event_count: number; converted: number }>(
      'SELECT id, engaged_ms, pageviews, event_count, converted FROM web_sessions WHERE id = ?',
      batch.sessionId,
    );

    if (!existing) {
      run(
        `INSERT INTO web_sessions (id, first_seen, last_seen, landing_path, referrer_host,
           utm_source, utm_medium, utm_campaign, device, country, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        batch.sessionId, now, now, batch.landingPath ?? null, batch.referrerHost ?? null,
        batch.utmSource ?? null, batch.utmMedium ?? null, batch.utmCampaign ?? null,
        batch.device ?? null, country ?? null, now,
      );
    }

    let pageviews = 0;
    let engaged = 0;
    let converted = false;
    let n = 0;

    for (const hit of batch.hits) {
      run(
        `INSERT INTO web_events (id, session_id, name, path, props_json, engaged_ms, occurred_at, received_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        newId(), batch.sessionId, hit.name, hit.path ?? null,
        hit.props ? JSON.stringify(hit.props) : null,
        hit.engagedMs ?? null, hit.at, now,
      );
      if (hit.name === 'page_view') pageviews++;
      engaged += hit.engagedMs ?? 0;
      if (CONVERSION_EVENTS.has(hit.name)) converted = true;
      n++;
    }

    run(
      `UPDATE web_sessions SET
         last_seen = ?,
         pageviews = pageviews + ?,
         event_count = event_count + ?,
         engaged_ms = engaged_ms + ?,
         converted = MAX(converted, ?)
       WHERE id = ?`,
      now, pageviews, n, engaged, converted ? 1 : 0, batch.sessionId,
    );

    return n;
  });

  return { kind: 'analytics', status: 'processed', eventId, sessionId: batch.sessionId, hitsRecorded: recorded };
}
