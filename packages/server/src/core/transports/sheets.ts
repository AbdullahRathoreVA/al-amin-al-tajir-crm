/**
 * Google Sheets transport.
 *
 * ---------------------------------------------------------------------------
 * NOT YET VERIFIED AGAINST THE REAL API.
 *
 * Every other line in this repository has been run against real data. This one
 * has not, because it needs a Google Cloud project, an OAuth consent screen and
 * a refresh token, none of which can be created from here. The batching, the
 * backoff, the dead-letter and the `no_sync` rule all live in `../sync.ts` and
 * are tested against a fake transport; what is untested is precisely this file:
 * two HTTP calls and the shape of Google's replies.
 *
 * It is therefore inert unless all three credentials are present, and the first
 * real run should be watched rather than trusted. Said here rather than in a
 * commit message because this is where someone debugging it will be looking.
 * ---------------------------------------------------------------------------
 *
 * No credential is stored in the database. They are read from the environment,
 * which on Fly means `fly secrets set`. A refresh token in a table is a refresh
 * token in every backup, and backups get copied around.
 */
import type { OutboxRow, SyncTarget, Transport } from '../sync.ts';
import { mappingFor, toRow } from '../sync.ts';
import { safeJson } from '../util.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const TIMEOUT_MS = 15_000;

function creds(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken };
}

/** Cached until shortly before it expires; Google's are typically an hour. */
let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  const c = creds();
  if (!c) throw new Error('Google credentials are not configured');
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = await res.text();
  if (!res.ok) {
    // The body can contain the client_secret echoed back in some error shapes,
    // so only Google's short error code is surfaced.
    const code = safeJson<{ error?: string }>(body, {}).error ?? `HTTP ${res.status}`;
    throw new Error(`Google refused the refresh token: ${code}`);
  }
  const parsed = safeJson<{ access_token?: string; expires_in?: number }>(body, {});
  if (!parsed.access_token) throw new Error('Google returned no access token');

  cached = {
    token: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/** Exported so a test can prove a failed exchange is not cached. */
export function forgetToken(): void { cached = null; }

export const sheetsTransport: Transport = {
  channel: 'google-sheets',

  notReadyReason(target: SyncTarget | null): string | null {
    if (!creds()) {
      return 'Google is not connected. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and '
           + 'GOOGLE_REFRESH_TOKEN as platform secrets.';
    }
    if (!target) return 'No Google Sheets target has been created yet.';
    if (!target.enabled) return 'The Google Sheets target is switched off.';
    if (!target.external_id) return 'The Google Sheets target has no spreadsheet id.';
    return null;
  },

  async send(target: SyncTarget, rows: OutboxRow[]): Promise<{ sent: number; detail?: string }> {
    const mapping = mappingFor(target);
    // One request for the whole batch. The API's per-minute write quota is
    // spent per request, not per row, so a request per row is how a normal
    // morning turns into a 429.
    const values = rows.map((r) => toRow(safeJson<unknown>(r.payload_json, {}), mapping));

    const tab = target.tab_name?.trim() || 'Sheet1';
    const range = `${encodeURIComponent(tab)}!A1`;
    const url = `${SHEETS_API}/${encodeURIComponent(target.external_id!)}/values/${range}`
              + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ values }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const message = safeJson<{ error?: { message?: string } }>(detail, {}).error?.message
                   ?? `HTTP ${res.status}`;
      // Throwing marks the batch retryable; sync.ts applies the backoff. A 429
      // is therefore handled by the same path as a 500, which is what we want.
      throw new Error(`Sheets append failed: ${message}`);
    }

    return { sent: rows.length, detail: `Appended ${rows.length} row(s) to ${tab}` };
  },
};
