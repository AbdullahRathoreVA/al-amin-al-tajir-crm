/**
 * ===========================================================================
 *  TINY STARS  <->  COMMAND CENTER  :  SHARED EVENT CONTRACT   (v1)
 * ---------------------------------------------------------------------------
 *  SOURCE OF TRUTH. This exact file is copied verbatim into the public website
 *  repo (tiny-stars-ai) at src/lib/crm/contract.ts. It has ZERO dependencies so
 *  both an Astro site and a Node server can use the identical code — there is
 *  one schema, not two that drift apart.
 *
 *  If you change this file, copy it to the website repo in the same commit and
 *  bump CONTRACT_VERSION. Old versions must keep validating (see API.md).
 * ===========================================================================
 */

export const CONTRACT_VERSION = 1 as const;

/** Events the website is allowed to emit. Voice events are declared now so the
 *  contract does not have to break later, but nothing emits them yet. */
export const EVENT_TYPES = [
  'registration.created',
  'registration.updated',
  'tour.requested',
  'contact.created',
  'waitlist.requested',
  // Reserved — Phase 10. Declared, deliberately not implemented.
  'call.received',
  'voice.summary',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const AGE_BANDS = [
  'Under 12 months', '12-18 months', '18 months - 3 years',
  '3-5 years', '5-6 years', '6-12 years',
] as const;

export const SOURCES = [
  'website', 'phone', 'email', 'referral', 'social',
  'walk-in', 'google-sheets', 'excel', 'voice-agent', 'manual',
] as const;

// --------------------------------------------------------------------- types

export interface EventEnvelope<T = unknown> {
  /** Client-generated UUID. THE idempotency key — resending the same eventId is
   *  a no-op, not a duplicate record. See spec 31 / 199. */
  eventId: string;
  type: EventType;
  version: number;
  /** ISO-8601. When it happened at the source, not when we received it. */
  occurredAt: string;
  source: (typeof SOURCES)[number];
  data: T;
}

export interface GuardianInput {
  fullName: string;
  relationship?: string;
  email?: string;
  phone?: string;
  preferredContact?: 'email' | 'phone' | 'either';
}

export interface ChildInput {
  firstName: string;
  lastName?: string;
  /** ISO date. Optional by design — the website's early steps deliberately do
   *  not ask for a DOB, only a band. Do not make this required. */
  dateOfBirth?: string;
  ageBand?: (typeof AGE_BANDS)[number];
}

export interface RegistrationData {
  guardian: GuardianInput;
  child: ChildInput;
  programInterest?: string;
  desiredStart?: string;
  /** Free-text from the parent. */
  notes?: string;
  /** How far through the multi-step form they got. */
  completedSteps?: number;
  totalSteps?: number;
  consent?: { contactByEmail?: boolean; contactByPhone?: boolean };
}

export interface TourRequestData {
  guardian: GuardianInput;
  child?: ChildInput;
  programInterest?: string;
  /** Parent's preference, not a booking. Staff confirm in the CRM. */
  preferredDates?: string[];
  notes?: string;
}

export interface ContactData {
  guardian: GuardianInput;
  subject?: string;
  message: string;
}

// ---------------------------------------------------------------- validation

export interface ValidationError { path: string; message: string }
export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

const MAX = { short: 120, medium: 400, long: 4000 } as const;

/**
 * Control characters, stripped. Form input is untrusted. (spec 172)
 *
 * Two variants on purpose. Single-line fields (a name, an email, a date) have
 * no business containing a newline, so everything goes. Free text a parent
 * actually wrote keeps newlines and tabs: stripping those turns two paragraphs
 * into one run-on sentence and quietly mangles the thing they took the trouble
 * to type.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const CONTROL_CHARS_KEEP_BREAKS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function str(
  v: unknown, path: string, errs: ValidationError[],
  opts: { required?: boolean; max?: number; oneOf?: readonly string[]; multiline?: boolean } = {},
): string | undefined {
  const max = opts.max ?? MAX.short;
  if (v === undefined || v === null || v === '') {
    if (opts.required) errs.push({ path, message: 'is required' });
    return undefined;
  }
  if (typeof v !== 'string') { errs.push({ path, message: 'must be a string' }); return undefined; }
  const clean = opts.multiline
    // Normalise CRLF first so a Windows browser leaves no stray carriage return.
    ? v.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_KEEP_BREAKS, '')
        // Cap runs of blank lines: a parent leaning on Enter is not a layout
        // instruction, and it wrecks the timeline.
        .replace(/\n{3,}/g, '\n\n').trim()
    : v.replace(CONTROL_CHARS, '').trim();
  if (clean.length > max) { errs.push({ path, message: `must be at most ${max} characters` }); return undefined; }
  if (opts.oneOf && !opts.oneOf.includes(clean)) {
    errs.push({ path, message: `must be one of: ${opts.oneOf.join(', ')}` });
    return undefined;
  }
  return clean || undefined;
}

/** Deliberately permissive. Rejecting unusual-but-valid addresses loses a family;
 *  a bad address surfaces in the CRM's data-quality view instead. (spec 64) */
export function isEmailish(s: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s) && s.length <= 254;
}
/** Length-based, so international numbers are not rejected. */
export function isPhoneish(s: string): boolean {
  const d = s.replace(/[^\d]/g, '');
  return d.length >= 7 && d.length <= 15;
}
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}
export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function guardian(v: unknown, base: string, errs: ValidationError[], required = true): GuardianInput {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const g: GuardianInput = { fullName: str(o.fullName, `${base}.fullName`, errs, { required }) ?? '' };
  const rel = str(o.relationship, `${base}.relationship`, errs);
  if (rel) g.relationship = rel;
  const email = str(o.email, `${base}.email`, errs, { max: 254 });
  if (email) {
    if (!isEmailish(email)) errs.push({ path: `${base}.email`, message: 'is not a valid email address' });
    else g.email = email.toLowerCase();
  }
  const phone = str(o.phone, `${base}.phone`, errs);
  if (phone) {
    if (!isPhoneish(phone)) errs.push({ path: `${base}.phone`, message: 'is not a valid phone number' });
    else g.phone = phone;
  }
  const pc = str(o.preferredContact, `${base}.preferredContact`, errs, { oneOf: ['email', 'phone', 'either'] });
  if (pc) g.preferredContact = pc as GuardianInput['preferredContact'];
  // A lead with no way to reach it is not a lead. (spec 64)
  if (required && !g.email && !g.phone) {
    errs.push({ path: base, message: 'needs at least an email address or a phone number' });
  }
  return g;
}

function child(v: unknown, base: string, errs: ValidationError[], required = true): ChildInput {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
  const c: ChildInput = { firstName: str(o.firstName, `${base}.firstName`, errs, { required }) ?? '' };
  const ln = str(o.lastName, `${base}.lastName`, errs);
  if (ln) c.lastName = ln;
  const dob = str(o.dateOfBirth, `${base}.dateOfBirth`, errs, { max: 40 });
  if (dob) {
    if (!isIsoDate(dob)) errs.push({ path: `${base}.dateOfBirth`, message: 'must be an ISO date (YYYY-MM-DD)' });
    else c.dateOfBirth = dob.slice(0, 10);
  }
  const band = str(o.ageBand, `${base}.ageBand`, errs, { oneOf: AGE_BANDS });
  if (band) c.ageBand = band as ChildInput['ageBand'];
  return c;
}

export function validateRegistration(raw: unknown): Validated<RegistrationData> {
  const errs: ValidationError[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const value: RegistrationData = {
    guardian: guardian(o.guardian, 'guardian', errs),
    child: child(o.child, 'child', errs),
  };
  const pi = str(o.programInterest, 'programInterest', errs); if (pi) value.programInterest = pi;
  const ds = str(o.desiredStart, 'desiredStart', errs, { max: 40 }); if (ds) value.desiredStart = ds;
  const n = str(o.notes, 'notes', errs, { max: MAX.long, multiline: true }); if (n) value.notes = n;
  if (typeof o.completedSteps === 'number') value.completedSteps = Math.max(0, Math.trunc(o.completedSteps));
  if (typeof o.totalSteps === 'number') value.totalSteps = Math.max(0, Math.trunc(o.totalSteps));
  if (typeof o.consent === 'object' && o.consent !== null) {
    const c = o.consent as Record<string, unknown>;
    value.consent = { contactByEmail: c.contactByEmail === true, contactByPhone: c.contactByPhone === true };
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, value };
}

export function validateTourRequest(raw: unknown): Validated<TourRequestData> {
  const errs: ValidationError[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const value: TourRequestData = { guardian: guardian(o.guardian, 'guardian', errs) };
  if (o.child !== undefined) value.child = child(o.child, 'child', errs, false);
  const pi = str(o.programInterest, 'programInterest', errs); if (pi) value.programInterest = pi;
  const n = str(o.notes, 'notes', errs, { max: MAX.long, multiline: true }); if (n) value.notes = n;
  if (Array.isArray(o.preferredDates)) {
    const dates = o.preferredDates.slice(0, 5)
      .map((d, i) => str(d, `preferredDates[${i}]`, errs, { max: 40 }))
      .filter((d): d is string => !!d && isIsoDate(d));
    if (dates.length) value.preferredDates = dates;
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true, value };
}

export function validateContact(raw: unknown): Validated<ContactData> {
  const errs: ValidationError[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const value: ContactData = {
    guardian: guardian(o.guardian, 'guardian', errs),
    message: str(o.message, 'message', errs, { required: true, max: MAX.long, multiline: true }) ?? '',
  };
  const s = str(o.subject, 'subject', errs, { max: MAX.medium }); if (s) value.subject = s;
  return errs.length ? { ok: false, errors: errs } : { ok: true, value };
}

/** Validates the envelope, then dispatches to the right payload validator. */
export function validateEnvelope(raw: unknown): Validated<EventEnvelope> {
  const errs: ValidationError[] = [];
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const eventId = str(o.eventId, 'eventId', errs, { required: true, max: 64 });
  if (eventId && !isUuid(eventId)) errs.push({ path: 'eventId', message: 'must be a UUID' });
  const type = str(o.type, 'type', errs, { required: true, oneOf: EVENT_TYPES });
  const source = str(o.source, 'source', errs, { required: true, oneOf: SOURCES });
  const occurredAt = str(o.occurredAt, 'occurredAt', errs, { required: true, max: 40 });
  if (occurredAt && !isIsoDate(occurredAt)) errs.push({ path: 'occurredAt', message: 'must be an ISO-8601 timestamp' });
  const version = typeof o.version === 'number' ? o.version : CONTRACT_VERSION;
  if (version > CONTRACT_VERSION) {
    errs.push({ path: 'version', message: `contract v${version} is newer than this server understands (v${CONTRACT_VERSION})` });
  }
  if (errs.length) return { ok: false, errors: errs };

  let data: Validated<unknown>;
  switch (type as EventType) {
    case 'registration.created':
    case 'registration.updated': data = validateRegistration(o.data); break;
    case 'tour.requested':
    case 'waitlist.requested':  data = validateTourRequest(o.data); break;
    case 'contact.created':     data = validateContact(o.data); break;
    default:
      return { ok: false, errors: [{ path: 'type', message: `event type '${type}' is declared but not implemented yet` }] };
  }
  if (!data.ok) {
    return { ok: false, errors: data.errors.map((e) => ({ path: `data.${e.path}`, message: e.message })) };
  }
  return {
    ok: true,
    value: {
      eventId: eventId!, type: type as EventType, version,
      occurredAt: occurredAt!, source: source as EventEnvelope['source'], data: data.value,
    },
  };
}
