import { randomUUID, createHash } from 'node:crypto';

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

export function daysFromNow(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

/** Start/end of a local calendar day, as ISO. "Today's tours" must mean the
 *  operator's today, not UTC's today. */
export function dayBounds(date = new Date()): { start: string; end: string } {
  const s = new Date(date); s.setHours(0, 0, 0, 0);
  const e = new Date(date); e.setHours(23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Matching keys. Lowercased email; digits-only phone keeping the last 10 so
 *  +1 (416) 555-0134 and 4165550134 are the same person. */
export function normEmail(e?: string | null): string | null {
  const v = (e ?? '').trim().toLowerCase();
  return v ? v : null;
}
export function normPhone(p?: string | null): string | null {
  const d = (p ?? '').replace(/[^\d]/g, '');
  if (d.length < 7) return null;
  return d.slice(-10);
}

export function splitName(full: string): { first: string; last: string | null } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: 'Unknown', last: null };
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

/** "Rivera family" from a guardian name. Falls back to the first name so we
 *  never render "undefined family" in the UI. */
export function familyNameFrom(guardianFullName: string): string {
  const { first, last } = splitName(guardianFullName);
  return `${last ?? first} family`;
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Plain object copy. node:sqlite returns null-prototype rows, which break
 *  structuredClone and confuse JSON.stringify in some paths. */
export function plain<T extends object>(row: T | undefined): T | undefined {
  return row ? ({ ...row } as T) : undefined;
}
export function plainAll<T extends object>(rows: T[]): T[] {
  return rows.map((r) => ({ ...r }) as T);
}
