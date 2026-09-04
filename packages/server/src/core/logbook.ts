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

  // The currency often comes after the number — "50 usd", "40 cad", "12
  // dollars" — and without this "50 usd" fell through to the bare-decimal rule
  // and could be read as a completely different number.
  const withWord = /([0-9][0-9,]*)(?:[.,]([0-9]{1,2}))?\s*(?:dollars?|bucks|cad|usd)\b/i.exec(text);
  if (withWord) return toCents(withWord[1]!, withWord[2]);

  // A bare decimal reads as money: "84.32" in this context is not a count.
  const bareDecimal = /(?:^|\s)([0-9][0-9,]*)[.,]([0-9]{2})(?=\s|$)/.exec(text);
  if (bareDecimal) return toCents(bareDecimal[1]!, bareDecimal[2]);

  // A bare number straight after a spending verb IS money: "spent 30 on
  // snacks", "paid 45 for wipes". Those lost their amount entirely and became
  // entries with no cost in them.
  //
  // Only immediately after the verb, and deliberately not after "bought",
  // because "bought 3 boxes of gloves" is a count and reading it as $3 would
  // be worse than reading nothing.
  const afterVerb = /\b(?:spent|spend|paid|pay|cost)\s+\$?([0-9][0-9,]*)(?:[.,]([0-9]{1,2}))?\b/i.exec(text);
  if (afterVerb) return toCents(afterVerb[1]!, afterVerb[2]);

  // Written out: "eighty dollars", "twenty five dollars", "a hundred bucks".
  //
  // Only with a currency word after it, for the same reason a bare "2" is not
  // money: "two boxes of gloves" is a quantity, not two dollars.
  //
  // The words are collected by walking BACKWARDS from the currency word rather
  // than by a regex reaching forwards, which would capture "i bought eighty"
  // out of "I bought eighty dollars of milk" and fail to read a number from it.
  const currency = /\b(?:dollars?|bucks|cad|usd)\b/i.exec(text);
  if (currency) {
    const before = text.slice(0, currency.index).toLowerCase()
      .replace(/-/g, ' ').split(/\s+/).filter(Boolean);
    const spelled: string[] = [];
    for (let i = before.length - 1; i >= 0; i--) {
      const w = before[i]!;
      if (NUMBER_WORDS[w] !== undefined
          || w === 'hundred' || w === 'thousand' || w === 'and' || w === 'a' || w === 'an') {
        spelled.unshift(w);
      } else break;
    }
    const n = spelled.length ? wordsToNumber(spelled.join(' ')) : null;
    if (n !== null) return Math.round(n * 100);
  }

  return null;
}

/**
 * Numbers written as words: "eighty dollars", "twenty five", "a hundred".
 *
 * People say what they spent, they do not spell it in digits — "I bought eighty
 * dollars of milk from Imtiaz" is an ordinary sentence and was reading as no
 * amount at all, which then made it a note rather than a purchase and left it
 * out of every total.
 *
 * Deliberately small: units, teens, tens, hundred and thousand. Anything more
 * elaborate than "two thousand three hundred and fifty" is rare enough in a
 * nursery's petty cash that asking is better than guessing.
 */
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function wordsToNumber(text: string): number | null {
  const tokens = text.toLowerCase().replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  let total = 0, current = 0, seen = false;

  for (const t of tokens) {
    if (t === 'and' && seen) continue;
    if (t === 'a' || t === 'an') { current = current || 1; seen = true; continue; }
    const unit = NUMBER_WORDS[t];
    if (unit !== undefined) { current += unit; seen = true; continue; }
    if (t === 'hundred') { current = (current || 1) * 100; seen = true; continue; }
    if (t === 'thousand') { total += (current || 1) * 1000; current = 0; seen = true; continue; }
    // Any other word ends the number. "eighty dollars of milk" stops at
    // "dollars" and does not wander into the rest of the sentence.
    if (seen) break;
  }
  if (!seen) return null;
  const value = total + current;
  return value > 0 ? value : null;
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

/**
 * What kind of thing this was, so it does not have to be picked from a menu.
 *
 * The money rule at the end is the important one. "I put fuel in the car, $60"
 * contains no purchase verb at all and was filed as a note — which then left
 * it out of every total, silently. If a sentence names an amount of money and
 * is not obviously a job that got done, somebody spent money.
 */
export function parseKind(text: string, hasAmount = false): LogKind {
  if (/\b(bought|buy|purchas|paid|spent|spend|order(?:ed)?|invoice|receipt|topped up|filled up|refill(?:ed)?)\b/i.test(text)) return 'purchase';
  if (/\b(ran out|running low|need more|restock|out of|low on)\b/i.test(text)) return 'supply';
  if (/\b(fixed|cleaned|repaired|done|finished|completed|sorted|tidied)\b/i.test(text)) return 'task';
  // Fuel is always bought, even when the sentence never says so. "Put fuel in
  // the car" carries no verb this recognises and often no amount at all, and
  // was filed as a note that then sat outside every total.
  if (/\b(fuel|petrol|diesel|gasoline)\b/i.test(text)) return 'purchase';
  // "put fuel in the car, $60" — money named, no verb this knows.
  if (hasAmount) return 'purchase';
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
  // Read the amount first: whether money was named is itself evidence of what
  // kind of entry this is.
  const amountCents = parseMoney(trimmed);
  return {
    kind: parseKind(trimmed, amountCents !== null),
    happenedOn: parseDay(trimmed, today) ?? undefined,
    vendor: parseVendor(trimmed) ?? undefined,
    amountCents,
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
      WHERE logbook_fts MATCH ? AND e.deleted_at IS NULL
      ORDER BY e.happened_on DESC LIMIT ?`, match, limit));
}

export interface ListFilter { from?: string; to?: string; kind?: LogKind; category?: string }

export function list(filter: ListFilter = {}, limit = 500): Record<string, unknown>[] {
  // Removed entries are excluded here, in the one query every read goes
  // through, rather than in each caller. A total that quietly included a
  // deleted row is the exact failure this is meant to prevent.
  const where: string[] = ['e.deleted_at IS NULL'];
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
      WHERE ${where.join(' AND ')}
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

// -------------------------------------------------------------------- remove

/**
 * Take an entry out of the book.
 *
 * The row stays; it is marked and disappears from every read — the list, the
 * totals, search and the spreadsheet all go through queries that exclude it.
 * A ledger whose rows can evaporate is a ledger whose total silently stops
 * matching the receipts, and "I'm sure I entered that" becomes unanswerable.
 *
 * The event log records what it said at the moment it was removed, so the
 * deletion is as legible afterwards as the entry was.
 */
export function remove(id: string, actor: Actor): Record<string, unknown> {
  const entry = plain(one<Record<string, unknown>>(
    'SELECT * FROM logbook_entries WHERE id = ?', id));
  if (!entry) throw new LogbookError('No such logbook entry');
  if (entry.deleted_at) throw new LogbookError('That entry was already removed');

  const now = nowIso();
  let after!: Record<string, unknown>;
  tx(() => {
    run('UPDATE logbook_entries SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?',
      now, actor.id, now, id);
    // Out of the search index too: finding a removed entry and being unable to
    // open it is worse than not finding it.
    run('DELETE FROM logbook_fts WHERE entry_id = ?', id);

    after = plain(one<Record<string, unknown>>('SELECT * FROM logbook_entries WHERE id = ?', id))!;
    recordEvent({
      entityType: 'logbook', entityId: id, type: 'deleted', actor,
      summary: `Removed from the logbook: ${String(entry.summary)}`
             + (entry.amount_cents ? ` (${money(Number(entry.amount_cents))})` : ''),
      before: entry, after: null,
    });
  });
  return after;
}

/** Put it back. What people want about four seconds after pressing delete. */
export function restore(id: string, actor: Actor): Record<string, unknown> {
  const entry = plain(one<Record<string, unknown>>(
    'SELECT * FROM logbook_entries WHERE id = ?', id));
  if (!entry) throw new LogbookError('No such logbook entry');
  if (!entry.deleted_at) throw new LogbookError('That entry is not removed');

  let after!: Record<string, unknown>;
  tx(() => {
    run('UPDATE logbook_entries SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ?',
      nowIso(), id);
    after = plain(one<Record<string, unknown>>('SELECT * FROM logbook_entries WHERE id = ?', id))!;
    run('DELETE FROM logbook_fts WHERE entry_id = ?', id);
    run('INSERT INTO logbook_fts (entry_id, body) VALUES (?,?)', id,
      [after.summary, after.vendor, after.category, after.raw_text].filter(Boolean).join(' '));
    recordEvent({
      entityType: 'logbook', entityId: id, type: 'restored', actor,
      summary: `Put back into the logbook: ${String(after.summary)}`,
      before: null, after,
    });
  });
  return after;
}

/** What has been removed, so it can be found again rather than only regretted. */
export function removed(limit = 50): Record<string, unknown>[] {
  return plainAll(many<Record<string, unknown>>(
    `SELECT e.*, u.name AS deleted_by_name
       FROM logbook_entries e LEFT JOIN users u ON u.id = e.deleted_by
      WHERE e.deleted_at IS NOT NULL
      ORDER BY e.deleted_at DESC LIMIT ?`, limit));
}

// ---------------------------------------------------------- several at once

/**
 * "I bought milk for $12 and nappies for $30 at Costco on September 2."
 *
 * One sentence, several purchases. The rule-based parser reads exactly one
 * entry out of a sentence and is right about it; splitting a sentence into
 * three is genuinely a language problem, so this is where a model earns its
 * place.
 *
 * What does NOT change: nothing is written. The model proposes drafts, the
 * amounts and dates in those drafts are re-read by the SAME deterministic
 * parsers used everywhere else, and a person presses save. An amount is
 * exactly specified — a regex is right every time and a model is not — so the
 * model is only trusted to decide where one purchase ends and the next begins.
 */
export interface SplitResult {
  drafts: LogDraft[];
  /** 'ai' when a model split it, 'rules' when it fell back to one entry. */
  splitBy: 'ai' | 'rules';
  note: string;
}

export async function splitUtterance(
  text: string, today: string, ai: { name: string; complete(p: string, o?: { maxTokens?: number }): Promise<string | null> } | null,
): Promise<SplitResult> {
  const trimmed = text.trim();
  const single = () => [parseUtterance(trimmed, today)];

  if (!ai) {
    return {
      drafts: single(), splitBy: 'rules',
      note: 'Read as one entry. Turn on an AI provider to split a sentence with several purchases in it.',
    };
  }

  const prompt = [
    'Split this into separate purchases. Reply with ONLY a JSON array, no prose.',
    'Each item: {"summary": "what it was", "amount": "the amount exactly as written or null", "vendor": "shop or null", "date": "the date exactly as written or null"}',
    'One item per thing bought. If it is a single purchase, return one item.',
    'Copy amounts and dates verbatim from the sentence. Do not calculate, convert or invent anything.',
    '',
    `Sentence: ${trimmed}`,
  ].join('\n');

  const raw = await ai.complete(prompt, { maxTokens: 500 });
  const parsed = parseJsonArray(raw);
  if (!parsed.length) {
    return {
      drafts: single(), splitBy: 'rules',
      note: 'The AI could not split that, so it was read as one entry.',
    };
  }

  const drafts: LogDraft[] = parsed.slice(0, 20).map((item) => {
    // Re-read the amount and date from the model's own words with the same
    // regexes used everywhere else. The model chooses the split; the rules
    // still decide what the numbers mean.
    const piece = [item.summary, item.amount, item.vendor, item.date]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '').join(' ');
    const base = parseUtterance(piece, today);
    return {
      ...base,
      kind: 'purchase',
      summary: typeof item.summary === 'string' && item.summary.trim()
        ? item.summary.trim().slice(0, 200) : base.summary,
      // A date named once for the whole sentence applies to every line in it.
      happenedOn: base.happenedOn ?? parseDay(trimmed, today) ?? undefined,
      vendor: base.vendor ?? parseVendor(trimmed) ?? undefined,
      rawText: trimmed,
    };
  });

  return {
    drafts, splitBy: 'ai',
    note: `${ai.name} split this into ${drafts.length} entr${drafts.length === 1 ? 'y' : 'ies'}. Check each one — nothing is saved yet.`,
  };
}

/** A model asked for JSON often wraps it in prose or a code fence. */
function parseJsonArray(raw: string | null): Record<string, unknown>[] {
  if (!raw) return [];
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const v = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
  } catch { return []; }
}
