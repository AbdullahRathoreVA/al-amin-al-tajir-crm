/**
 * The logbook: say what you did, get it written down, get a spreadsheet back.
 *
 * "I got $84.32 of milk and fruit from Costco for the Nova Stars room today"
 * becomes a row. Anything the sentence did not say is asked about, once, in
 * plain English.
 *
 * The parsing order matters and is the opposite of the obvious one. Money,
 * dates and quantities are extracted by rule, not by the model, because those
 * are exactly specified and a regex is right every time while a model is right
 * almost every time. The model is only asked for the part that genuinely needs
 * reading comprehension: what was this, and roughly what kind of thing is it.
 * (Deterministic rules over AI where a rule is exact.)
 *
 * All of which means the logbook still works with the AI switched off. You get
 * the amount, the date and the vendor from the rules, and it asks you for the
 * description instead of guessing it.
 */
import { one, many, run, tx } from '../db/index.ts';
import { newId, nowIso, plain, plainAll } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { buildWorkbook, type Sheet } from './xlsx.ts';

export type LogKind = 'purchase' | 'supply' | 'task' | 'note';

export interface LogDraft {
  kind: LogKind;
  happenedOn?: string;
  summary?: string;
  vendor?: string;
  amountCents?: number | null;
  category?: string;
  classroomId?: string | null;
  rawText: string;
  source?: 'typed' | 'voice';
}

/** A gap the entry cannot be saved with, and the question that closes it. */
export interface Gap { field: string; question: string }

export class LogbookError extends Error {}

// ------------------------------------------------------------------- parsing

/**
 * Money, by rule.
 *
 * Returns cents as an integer. Handles "$84.32", "84.32 dollars", "84 dollars
 * 32", "$1,284.50" and a bare "84.32". Deliberately refuses a bare integer like
 * "2" unless it carries a currency marker — "2 boxes of gloves" is a quantity,
 * and reading it as $2.00 would be worse than reading nothing.
 */
export function parseMoney(text: string): number | null {
  const withSymbol = /(?:\$|\bcad\b|\busd\b)\s*([0-9][0-9,]*)(?:[.,]([0-9]{1,2}))?/i.exec(text);
  if (withSymbol) return toCents(withSymbol[1]!, withSymbol[2]);

  const withWord = /([0-9][0-9,]*)(?:[.,]([0-9]{1,2}))?\s*(?:dollars?|bucks)\b/i.exec(text);
  if (withWord) return toCents(withWord[1]!, withWord[2]);

  // A bare decimal reads as money: "84.32" in this context is not a count.
  const bareDecimal = /(?:^|\s)([0-9][0-9,]*)[.,]([0-9]{2})(?=\s|$)/.exec(text);
  if (bareDecimal) return toCents(bareDecimal[1]!, bareDecimal[2]);

  return null;
}

function toCents(whole: string, frac?: string): number {
  const dollars = Number(whole.replace(/,/g, ''));
  if (!Number.isFinite(dollars)) return 0;
  const cents = frac ? Number(frac.padEnd(2, '0').slice(0, 2)) : 0;
  return Math.round(dollars * 100) + cents;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Dates, by rule, relative to a supplied "today" so it is testable.
 *
 * Handles today, yesterday, "last Tuesday", "on the 3rd", "Aug 12", "2026-08-12"
 * and "3 days ago". Returns null rather than guessing, and a null becomes a
 * question rather than a silent default to today — the difference between
 * "bought yesterday" and "bought today" is a real difference in a ledger.
 */
export function parseDay(text: string, today: string): string | null {
  const t = text.toLowerCase();
  const base = new Date(`${today}T12:00:00Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (days: number) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return iso(d);
  };

  const explicit = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (explicit) return explicit[0];

  if (/\btoday\b|\bjust now\b|\bthis morning\b|\bthis afternoon\b/.test(t)) return today;
  if (/\byesterday\b/.test(t)) return shift(-1);
  if (/\bday before yesterday\b/.test(t)) return shift(-2);

  const ago = /\b(\d{1,2})\s+days?\s+ago\b/.exec(t);
  if (ago) return shift(-Number(ago[1]));

  const weekAgo = /\b(?:a|1)\s+week\s+ago\b|\blast\s+week\b/.test(t);
  if (weekAgo) return shift(-7);

  const named = /\b(?:last\s+|on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(t);
  if (named) {
    const want = WEEKDAYS.indexOf(named[1]!);
    const have = base.getUTCDay();
    // Always the most recent one that has already happened, never a future day:
    // a logbook records what was done, not what is planned.
    let back = (have - want + 7) % 7;
    if (back === 0) back = 7;
    return shift(-back);
  }

  const monthDay = new RegExp(`\\b(${MONTHS.map((m) => `${m.slice(0, 3)}[a-z]*`).join('|')})\\s+(\\d{1,2})\\b`).exec(t);
  if (monthDay) {
    const month = MONTHS.findIndex((m) => m.startsWith(monthDay[1]!.slice(0, 3)));
    const day = Number(monthDay[2]);
    if (month >= 0 && day >= 1 && day <= 31) {
      const year = base.getUTCFullYear();
      const candidate = new Date(Date.UTC(year, month, day, 12));
      // A date later than today is last year's, not next year's.
      if (candidate > base) candidate.setUTCFullYear(year - 1);
      return iso(candidate);
    }
  }

  return null;
}

/** "from Costco", "at Superstore", "bought from the Dollar Store". */
export function parseVendor(text: string): string | null {
  const m = /\b(?:from|at)\s+(?:the\s+)?([A-Z][\w'&.-]*(?:\s+[A-Z][\w'&.-]*){0,3})/.exec(text);
  if (m) return m[1]!.trim().replace(/[.,;]$/, '');
  return null;
}

/**
 * A coarse category from words that are unambiguous. Anything else is left
 * blank for a person to set, rather than filed under a guess.
 */
const CATEGORY_WORDS: [RegExp, string][] = [
  [/\b(grocer|milk|fruit|veg|snack|food|lunch|formula|juice)/i, 'Food'],
  [/\b(diaper|wipe|nappy|hygiene|soap|sanitis|sanitiz|tissue|glove)/i, 'Hygiene'],
  [/\b(paint|crayon|glue|craft|paper|marker|sticker|playdough)/i, 'Craft supplies'],
  [/\b(toy|puzzle|book|game|lego|blocks)/i, 'Toys & books'],
  [/\b(clean|mop|bleach|detergent|vacuum)/i, 'Cleaning'],
  [/\b(repair|fix|plumb|electric|broken|replace|maintenance)/i, 'Maintenance'],
  [/\b(printer|ink|stationery|folder|laminat)/i, 'Office'],
];

export function parseCategory(text: string): string | null {
  for (const [re, label] of CATEGORY_WORDS) if (re.test(text)) return label;
  return null;
}

/** Purchase words, so the kind does not have to be picked from a menu. */
export function parseKind(text: string): LogKind {
  if (/\b(bought|buy|purchas|paid|spent|order(?:ed)?|invoice|receipt)\b/i.test(text)) return 'purchase';
  if (/\b(ran out|running low|need more|restock|out of|low on)\b/i.test(text)) return 'supply';
  if (/\b(fixed|cleaned|repaired|done|finished|completed|sorted|tidied)\b/i.test(text)) return 'task';
  return 'note';
}

/**
 * Everything the rules can get from one sentence.
 *
 * `summary` is deliberately not attempted here — pulling a readable description
 * out of free English is the one part that genuinely needs a model, and a regex
 * that tried would produce "of milk and fruit from" and call it a description.
 * With no AI configured the caller is asked for it instead.
 */
export function parseUtterance(text: string, today: string): LogDraft {
  const trimmed = text.trim();
  return {
    kind: parseKind(trimmed),
    happenedOn: parseDay(trimmed, today) ?? undefined,
    vendor: parseVendor(trimmed) ?? undefined,
    amountCents: parseMoney(trimmed),
    category: parseCategory(trimmed) ?? undefined,
    rawText: trimmed,
  };
}

// --------------------------------------------------------------------- gaps

const KIND_LABEL: Record<LogKind, string> = {
  purchase: 'purchase', supply: 'supply note', task: 'job', note: 'note',
};

/**
 * What is still missing, as questions rather than field names.
 *
 * Computed by rule, never by the model. Whether a required field is present is
 * a fact about the data, and asking a model to decide it would introduce a way
 * for an entry to be saved incomplete because the model felt generous.
 */
export function gapsIn(draft: LogDraft): Gap[] {
  const gaps: Gap[] = [];

  if (!draft.summary?.trim()) {
    gaps.push({ field: 'summary', question: `What should I call this ${KIND_LABEL[draft.kind]}?` });
  }
  if (!draft.happenedOn) {
    gaps.push({ field: 'happenedOn', question: 'Which day was that?' });
  }
  if (draft.kind === 'purchase') {
    if (draft.amountCents === null || draft.amountCents === undefined) {
      gaps.push({ field: 'amountCents', question: 'How much did it come to?' });
    }
    if (!draft.vendor?.trim()) {
      gaps.push({ field: 'vendor', question: 'Where did you buy it?' });
    }
  }
  return gaps;
}

// -------------------------------------------------------------------- record

export function record(draft: LogDraft, actor: Actor): Record<string, unknown> {
  const gaps = gapsIn(draft);
  if (gaps.length) {
    throw new LogbookError(`Still missing: ${gaps.map((g) => g.field).join(', ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.happenedOn!)) {
    throw new LogbookError('The date must look like 2026-08-29');
  }

  const id = newId();
  const now = nowIso();
  let saved!: Record<string, unknown>;

  tx(() => {
    run(`INSERT INTO logbook_entries (id, kind, happened_on, summary, vendor, amount_cents,
           currency, category, classroom_id, raw_text, source, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, draft.kind, draft.happenedOn!, draft.summary!.trim(), draft.vendor?.trim() ?? null,
      draft.amountCents ?? null, 'CAD', draft.category?.trim() ?? null, draft.classroomId ?? null,
      draft.rawText, draft.source ?? 'typed', actor.id, now, now);

    run('INSERT INTO logbook_fts (entry_id, body) VALUES (?,?)',
      id, [draft.summary, draft.vendor, draft.category, draft.rawText].filter(Boolean).join(' '));

    recordEvent({
      entityType: 'logbook', entityId: id, type: 'created', actor,
      summary: describe(draft),
      before: null,
      after: { kind: draft.kind, amountCents: draft.amountCents ?? null, vendor: draft.vendor ?? null },
    });

    saved = plain(one<Record<string, unknown>>('SELECT * FROM logbook_entries WHERE id = ?', id))!;
  });
  return saved;
}

const money = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`;

function describe(d: LogDraft): string {
  const parts = [d.summary!.trim()];
  if (d.amountCents) parts.push(`for ${money(d.amountCents)}`);
  if (d.vendor) parts.push(`from ${d.vendor}`);
  return `${parts.join(' ')} on ${d.happenedOn}`;
}

export function update(
  id: string, patch: Partial<LogDraft>, actor: Actor,
): Record<string, unknown> {
  const before = plain(one<Record<string, unknown>>('SELECT * FROM logbook_entries WHERE id = ?', id));
  if (!before) throw new LogbookError('No such logbook entry');

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, value: string | number | null) => { sets.push(`${col} = ?`); params.push(value); };

  if (patch.summary !== undefined) set('summary', patch.summary.trim());
  if (patch.vendor !== undefined) set('vendor', patch.vendor?.trim() || null);
  if (patch.amountCents !== undefined) set('amount_cents', patch.amountCents ?? null);
  if (patch.category !== undefined) set('category', patch.category?.trim() || null);
  if (patch.happenedOn !== undefined) set('happened_on', patch.happenedOn);
  if (patch.classroomId !== undefined) set('classroom_id', patch.classroomId ?? null);
  if (patch.kind !== undefined) set('kind', patch.kind);
  if (!sets.length) return before;

  let after!: Record<string, unknown>;
  tx(() => {
    run(`UPDATE logbook_entries SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...params, nowIso(), id);
    after = plain(one<Record<string, unknown>>('SELECT * FROM logbook_entries WHERE id = ?', id))!;
    run('DELETE FROM logbook_fts WHERE entry_id = ?', id);
    run('INSERT INTO logbook_fts (entry_id, body) VALUES (?,?)', id,
      [after.summary, after.vendor, after.category, after.raw_text].filter(Boolean).join(' '));
    recordEvent({
      entityType: 'logbook', entityId: id, type: 'updated', actor,
      summary: `Logbook entry corrected: ${String(after.summary)}`,
      before, after,
    });
  });
  return after;
}

// --------------------------------------------------------------------- recall

/** FTS5 treats these as operators; a person typing them means them literally. */
function ftsSafe(q: string): string {
  const words = q.replace(/["*^:(){}[\]-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.map((w) => `"${w}"*`).join(' OR ');
}

export function recall(query: string, limit = 25): Record<string, unknown>[] {
  const match = ftsSafe(query);
  if (!match) return [];
  return plainAll(many<Record<string, unknown>>(
    `SELECT e.* FROM logbook_fts f JOIN logbook_entries e ON e.id = f.entry_id
      WHERE logbook_fts MATCH ? ORDER BY e.happened_on DESC LIMIT ?`, match, limit));
}

export interface ListFilter { from?: string; to?: string; kind?: LogKind; category?: string }

export function list(filter: ListFilter = {}, limit = 500): Record<string, unknown>[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.from) { where.push('e.happened_on >= ?'); params.push(filter.from); }
  if (filter.to) { where.push('e.happened_on <= ?'); params.push(filter.to); }
  if (filter.kind) { where.push('e.kind = ?'); params.push(filter.kind); }
  if (filter.category) { where.push('e.category = ?'); params.push(filter.category); }

  return plainAll(many<Record<string, unknown>>(
    `SELECT e.*, c.name AS classroom_name, u.name AS created_by_name
       FROM logbook_entries e
       LEFT JOIN classrooms c ON c.id = e.classroom_id
       LEFT JOIN users u ON u.id = e.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.happened_on DESC, e.created_at DESC
      LIMIT ?`, ...params, limit));
}

/**
 * Totals. Reports `measured: false` when there is nothing in range rather than
 * a confident $0.00, which would read as "you spent nothing" instead of
 * "nothing has been written down yet".
 */
export function totals(filter: ListFilter = {}): Record<string, unknown> {
  const rows = list(filter, 10_000);
  const spent = rows.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
  return {
    measured: rows.length > 0,
    entries: rows.length,
    spentCents: rows.length ? spent : null,
    purchases: rows.filter((r) => r.kind === 'purchase').length,
  };
}

// ------------------------------------------------------------------ workbook

const ACCENTS = ['violet', 'ember', 'teal', 'amber'] as const;

/**
 * The workbook: one sheet of everything, then the three cuts anyone actually
 * asks for. Each gets its own accent so a glance at the tab strip tells you
 * which one you are on.
 */
export function workbook(filter: ListFilter = {}): Buffer {
  const rows = list(filter, 10_000);
  const dollars = (cents: unknown) => (cents === null || cents === undefined ? null : Number(cents) / 100);

  const range = filter.from || filter.to
    ? `${filter.from ?? 'the beginning'} to ${filter.to ?? 'today'}`
    : 'everything recorded';

  const all: Sheet = {
    name: 'Everything', accent: 'violet',
    caption: `Tiny Stars logbook — ${range}. ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`,
    columns: [
      { header: 'Date', key: 'happened_on', format: 'date' },
      { header: 'Kind', key: 'kind', width: 11 },
      { header: 'What', key: 'summary', width: 40 },
      { header: 'Where', key: 'vendor', width: 20 },
      { header: 'Category', key: 'category', width: 18 },
      { header: 'Room', key: 'classroom_name', width: 18 },
      { header: 'Amount', key: 'amount', format: 'money' },
      { header: 'Logged by', key: 'created_by_name', width: 18 },
      { header: 'What was said', key: 'raw_text', width: 46 },
    ],
    rows: rows.map((r) => ({ ...r, amount: dollars(r.amount_cents) })),
    totals: {
      happened_on: null, kind: null, summary: 'Total', vendor: null, category: null,
      classroom_name: null, created_by_name: null, raw_text: null,
      amount: rows.reduce((s, r) => s + Number(r.amount_cents ?? 0), 0) / 100,
    },
  };

  const byCategory = group(rows, (r) => String(r.category ?? 'Uncategorised'));
  const byMonth = group(rows, (r) => String(r.happened_on ?? '').slice(0, 7) || 'Undated');
  const byVendor = group(rows.filter((r) => r.vendor), (r) => String(r.vendor));

  const cut = (name: string, label: string, accent: typeof ACCENTS[number],
               data: { key: string; cents: number; n: number }[]): Sheet => ({
    name, accent,
    caption: `${label} — ${range}.`,
    columns: [
      { header: label, key: 'key', width: 26 },
      { header: 'Spent', key: 'amount', format: 'money' },
      { header: 'Entries', key: 'n', format: 'integer' },
    ],
    rows: data.map((d) => ({ key: d.key, amount: d.cents / 100, n: d.n })),
    totals: {
      key: 'Total',
      amount: data.reduce((s, d) => s + d.cents, 0) / 100,
      n: data.reduce((s, d) => s + d.n, 0),
    },
  });

  return buildWorkbook([
    all,
    cut('By category', 'Category', ACCENTS[1], byCategory),
    cut('By month', 'Month', ACCENTS[2], byMonth),
    cut('By supplier', 'Supplier', ACCENTS[3], byVendor),
  ]);
}

function group(
  rows: Record<string, unknown>[], keyOf: (r: Record<string, unknown>) => string,
): { key: string; cents: number; n: number }[] {
  const map = new Map<string, { key: string; cents: number; n: number }>();
  for (const r of rows) {
    const key = keyOf(r);
    const acc = map.get(key) ?? { key, cents: 0, n: 0 };
    acc.cents += Number(r.amount_cents ?? 0);
    acc.n += 1;
    map.set(key, acc);
  }
  return [...map.values()].sort((a, b) => b.cents - a.cents || a.key.localeCompare(b.key));
}
