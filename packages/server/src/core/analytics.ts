/**
 * Website analytics reads.
 *
 * Same discipline as the rest of the dashboard: every figure is an aggregate
 * over real rows, and anything with no data returns null so the UI can say "not
 * measured" instead of "0". A brand-new install must not look like a website
 * nobody visited.
 */
import { one, many } from '../db/index.ts';
import { plainAll } from './util.ts';

export type Window = '24h' | '7d' | '30d' | '90d' | 'all';

const WINDOWS: Record<Window, number | null> = {
  '24h': 1, '7d': 7, '30d': 30, '90d': 90, all: null,
};

export function windowStart(w: Window): string {
  const days = WINDOWS[w];
  if (days === null) return '1970-01-01T00:00:00.000Z';
  return new Date(Date.now() - days * 864e5).toISOString();
}

export function isWindow(v: string | null): v is Window {
  return v !== null && v in WINDOWS;
}

const num = (sql: string, ...p: (string | number)[]): number =>
  Number(one<{ n: number }>(sql, ...p)?.n ?? 0);

export interface AnalyticsOverview {
  measured: boolean;
  sessions: number;
  pageviews: number;
  /** Average engaged time per session, in seconds. null when nothing measured. */
  avgEngagedSeconds: number | null;
  /** Sessions that reached a registration, tour or waitlist request. */
  conversions: number;
  conversionRate: number | null;
  /** Sessions with exactly one pageview and under 10s engaged. */
  bounceRate: number | null;
}

export function overview(w: Window): AnalyticsOverview {
  const since = windowStart(w);
  const sessions = num('SELECT COUNT(*) n FROM web_sessions WHERE first_seen >= ?', since);
  if (sessions === 0) {
    return {
      measured: false, sessions: 0, pageviews: 0, avgEngagedSeconds: null,
      conversions: 0, conversionRate: null, bounceRate: null,
    };
  }
  const pageviews = num('SELECT COALESCE(SUM(pageviews),0) n FROM web_sessions WHERE first_seen >= ?', since);
  const engagedTotal = num('SELECT COALESCE(SUM(engaged_ms),0) n FROM web_sessions WHERE first_seen >= ?', since);
  const conversions = num('SELECT COUNT(*) n FROM web_sessions WHERE first_seen >= ? AND converted = 1', since);
  const bounced = num(
    'SELECT COUNT(*) n FROM web_sessions WHERE first_seen >= ? AND pageviews <= 1 AND engaged_ms < 10000', since);

  return {
    measured: true,
    sessions,
    pageviews,
    avgEngagedSeconds: engagedTotal > 0 ? Math.round(engagedTotal / sessions / 1000) : null,
    conversions,
    conversionRate: conversions / sessions,
    bounceRate: bounced / sessions,
  };
}

export interface PageRow { path: string; views: number; sessions: number; avgEngagedSeconds: number | null }

export function topPages(w: Window, limit = 15): PageRow[] {
  const since = windowStart(w);
  return many<{ path: string; views: number; sessions: number; engaged: number }>(
    `SELECT path,
            COUNT(*) AS views,
            COUNT(DISTINCT session_id) AS sessions,
            COALESCE(SUM(engaged_ms), 0) AS engaged
       FROM web_events
      WHERE name = 'page_view' AND occurred_at >= ? AND path IS NOT NULL
      GROUP BY path ORDER BY views DESC LIMIT ?`, since, limit,
  ).map((r) => ({
    path: r.path,
    views: Number(r.views),
    sessions: Number(r.sessions),
    avgEngagedSeconds: Number(r.engaged) > 0 ? Math.round(Number(r.engaged) / Number(r.views) / 1000) : null,
  }));
}

export interface SourceRow { source: string; sessions: number; conversions: number; label: string }

/**
 * Where people came from. A UTM campaign wins over the referrer when present,
 * because that is the more specific answer. No referrer at all is "direct or
 * private", not "direct": a browser that strips the referrer is not the same
 * thing as someone typing the address in, and pretending otherwise inflates
 * whatever you attribute to direct traffic.
 */
export function topSources(w: Window, limit = 15): SourceRow[] {
  const since = windowStart(w);
  return many<{ source: string; sessions: number; conversions: number }>(
    `SELECT COALESCE(NULLIF(utm_source,''), NULLIF(referrer_host,''), '(direct or private)') AS source,
            COUNT(*) AS sessions,
            SUM(converted) AS conversions
       FROM web_sessions
      WHERE first_seen >= ?
      GROUP BY source ORDER BY sessions DESC LIMIT ?`, since, limit,
  ).map((r) => ({
    source: r.source,
    sessions: Number(r.sessions),
    conversions: Number(r.conversions ?? 0),
    label: r.source === '(direct or private)' ? 'Direct, or referrer hidden' : r.source,
  }));
}

export interface ClickRow { name: string; count: number; sessions: number }

/** Named interactions, not page views: the "how many clicks" question. */
export function topClicks(w: Window, limit = 20): ClickRow[] {
  const since = windowStart(w);
  return many<{ name: string; count: number; sessions: number }>(
    `SELECT name, COUNT(*) AS count, COUNT(DISTINCT session_id) AS sessions
       FROM web_events
      WHERE occurred_at >= ? AND name <> 'page_view'
      GROUP BY name ORDER BY count DESC LIMIT ?`, since, limit,
  ).map((r) => ({ name: r.name, count: Number(r.count), sessions: Number(r.sessions) }));
}

export interface DeviceRow { device: string; sessions: number }

export function devices(w: Window): DeviceRow[] {
  const since = windowStart(w);
  return many<{ device: string | null; sessions: number }>(
    `SELECT COALESCE(device,'unknown') AS device, COUNT(*) AS sessions
       FROM web_sessions WHERE first_seen >= ? GROUP BY device ORDER BY sessions DESC`, since,
  ).map((r) => ({ device: r.device ?? 'unknown', sessions: Number(r.sessions) }));
}

export interface DayRow { day: string; sessions: number; pageviews: number; conversions: number }

export function daily(w: Window): DayRow[] {
  const since = windowStart(w);
  return many<{ day: string; sessions: number; pageviews: number; conversions: number }>(
    `SELECT substr(first_seen, 1, 10) AS day,
            COUNT(*) AS sessions,
            COALESCE(SUM(pageviews),0) AS pageviews,
            COALESCE(SUM(converted),0) AS conversions
       FROM web_sessions WHERE first_seen >= ?
      GROUP BY day ORDER BY day`, since,
  ).map((r) => ({
    day: r.day, sessions: Number(r.sessions),
    pageviews: Number(r.pageviews), conversions: Number(r.conversions),
  }));
}

/**
 * The funnel from arrival to registration, measured on sessions rather than
 * events, so one person clicking the same button twice does not widen it.
 */
export interface FunnelStep { step: string; sessions: number; label: string }

export function funnel(w: Window): FunnelStep[] {
  const since = windowStart(w);
  const sessionsWith = (names: string[]): number => num(
    `SELECT COUNT(DISTINCT session_id) n FROM web_events
      WHERE occurred_at >= ? AND name IN (${names.map(() => '?').join(',')})`,
    since, ...names,
  );
  const total = num('SELECT COUNT(*) n FROM web_sessions WHERE first_seen >= ?', since);

  return [
    { step: 'visited', sessions: total, label: 'Visited the site' },
    { step: 'engaged', sessions: sessionsWith(['program_view', 'intent_selected', 'gallery_open', 'search_query']), label: 'Looked at a program or searched' },
    { step: 'intent', sessions: sessionsWith(['tour_cta_click', 'tour_flow_start', 'enrollment_start', 'waitlist_start']), label: 'Started a tour or registration' },
    { step: 'contact', sessions: sessionsWith(['phone_click', 'email_click', 'concierge_handoff']), label: 'Tried to make contact' },
    { step: 'completed', sessions: sessionsWith(['enrollment_complete', 'tour_flow_complete', 'waitlist_complete']), label: 'Completed a request' },
  ];
}

export function analyticsBundle(w: Window) {
  return {
    window: w,
    since: windowStart(w),
    overview: overview(w),
    topPages: topPages(w),
    topSources: topSources(w),
    topClicks: topClicks(w),
    devices: devices(w),
    daily: daily(w),
    funnel: funnel(w),
    recentSessions: plainAll(many(
      `SELECT id, first_seen, last_seen, landing_path, referrer_host, utm_source,
              device, country, pageviews, event_count, engaged_ms, converted
         FROM web_sessions ORDER BY first_seen DESC LIMIT 25`)),
  };
}
