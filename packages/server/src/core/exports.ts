/**
 * Exports that a person can actually read.
 *
 * A CSV of every family is one flat sheet with a repeated family name down the
 * left, no formatting, and dates that Excel reinterprets on open. It is fine
 * for feeding another system and poor for the thing people actually do with an
 * export, which is print it, sit in a meeting and point at it.
 *
 * So the same data also comes out as a real workbook, built on the same writer
 * the logbook already uses: a sheet per question, frozen headers, filters,
 * currency and dates formatted, and colour that means something.
 *
 * Colour is semantic, not decoration. Each sheet's accent says what kind of
 * thing it holds, and status columns are left as words rather than being
 * turned into a colour a colourblind reader cannot see. Where a number has not
 * been measured the cell says so instead of showing a confident zero.
 */
import { many, one } from '../db/index.ts';
import { buildWorkbook, type Sheet, type CellValue } from './xlsx.ts';

/**
 * Excel treats a leading =, +, - or @ as a formula, so a child called
 * "-Ana" or a note pasted from elsewhere becomes executable when the file is
 * opened. Every text cell that leaves this system goes through here.
 *
 * The tab and carriage return are in the pattern because Excel strips leading
 * whitespace before deciding, so "\t=cmd" is still a formula.
 */
export function deFormula(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const clean = (row: Record<string, unknown>): Record<string, CellValue> => {
  const out: Record<string, CellValue> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'number' ? v : deFormula(v);
  }
  return out;
};

/** SQL COUNT() comes back as unknown; the writer wants a real number. */
const num = (v: unknown): number => Number(v ?? 0);

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Every family, guardian and child, as four sheets.
 *
 * `sensitive` decides whether dates of birth appear at all. The column is
 * dropped rather than blanked, so a file handed on cannot have a birthday
 * recovered from a hidden column — which is exactly what "blank it in the UI"
 * gets wrong.
 */
export function familiesWorkbook(opts: { sensitive: boolean }): Buffer {
  const families = many<Record<string, unknown>>(
    `SELECT f.name AS family, f.status, f.source,
            (SELECT COUNT(*) FROM children ch WHERE ch.family_id = f.id) AS children,
            (SELECT COUNT(*) FROM guardians g WHERE g.family_id = f.id) AS guardians,
            g.first_name || COALESCE(' ' || g.last_name, '') AS primary_contact,
            g.email, g.phone,
            CASE WHEN f.local_only = 1 THEN 'local only'
                 WHEN f.no_sync = 1 THEN 'never sync'
                 WHEN f.no_ai = 1 THEN 'never AI'
                 ELSE 'standard' END AS privacy,
            f.created_at, f.updated_at
       FROM families f
       LEFT JOIN guardians g ON g.family_id = f.id AND g.is_primary = 1
      ORDER BY f.created_at DESC`);

  const children = many<Record<string, unknown>>(
    `SELECT f.name AS family,
            ch.first_name, ch.last_name, ch.age_band,
            ${opts.sensitive ? 'ch.date_of_birth,' : ''}
            ch.status, p.name AS program, r.name AS room, ch.created_at
       FROM children ch
       JOIN families f ON f.id = ch.family_id
       LEFT JOIN programs p ON p.id = ch.program_id
       LEFT JOIN classrooms r ON r.id = ch.classroom_id
      ORDER BY f.name, ch.first_name`);

  const guardians = many<Record<string, unknown>>(
    `SELECT f.name AS family, g.first_name, g.last_name, g.relationship,
            g.email, g.phone,
            CASE WHEN g.is_primary = 1 THEN 'primary' ELSE '' END AS is_primary
       FROM guardians g JOIN families f ON f.id = g.family_id
      ORDER BY f.name, g.is_primary DESC, g.first_name`);

  const byStatus = many<Record<string, unknown>>(
    `SELECT status, COUNT(*) AS families FROM families GROUP BY status ORDER BY COUNT(*) DESC`);
  const byProgram = many<Record<string, unknown>>(
    `SELECT COALESCE(p.name, 'No program yet') AS program,
            COUNT(*) AS children,
            SUM(CASE WHEN ch.status = 'enrolled' THEN 1 ELSE 0 END) AS enrolled
       FROM children ch LEFT JOIN programs p ON p.id = ch.program_id
      GROUP BY p.name ORDER BY COUNT(*) DESC`);

  const overview: Sheet = {
    name: 'Overview', accent: 'violet',
    caption: `Tiny Stars — exported ${today()}. ${families.length} families, `
      + `${children.length} children, ${guardians.length} guardians.`
      + (opts.sensitive ? '' : ' Dates of birth are not included in this export.'),
    columns: [
      { header: 'Measure', key: 'measure', width: 34 },
      { header: 'Count', key: 'count', format: 'integer' },
    ],
    rows: [
      { measure: 'Families', count: families.length },
      { measure: 'Children', count: children.length },
      { measure: 'Guardians', count: guardians.length },
      { measure: '', count: null },
      ...byStatus.map((r) => ({ measure: `Families — ${String(r.status)}`, count: num(r.families) })),
      { measure: '', count: null },
      ...byProgram.map((r) => ({
        measure: `${String(r.program)} — ${num(r.enrolled)} enrolled of ${num(r.children)}`,
        count: num(r.children),
      })),
    ],
  };

  const sheets: Sheet[] = [
    overview,
    {
      name: 'Families', accent: 'teal',
      caption: 'One row per family. Contact shown is the primary guardian.',
      columns: [
        { header: 'Family', key: 'family', width: 26 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Children', key: 'children', format: 'integer' },
        { header: 'Guardians', key: 'guardians', format: 'integer' },
        { header: 'Primary contact', key: 'primary_contact', width: 24 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Privacy', key: 'privacy', width: 13 },
        { header: 'Source', key: 'source', width: 13 },
        { header: 'Added', key: 'created_at', format: 'date' },
      ],
      rows: families.map(clean),
      totals: { family: 'Total', children: families.reduce((n, f) => n + num(f.children), 0) },
    },
    {
      name: 'Children', accent: 'amber',
      caption: opts.sensitive
        ? 'Includes dates of birth. This file identifies children — handle it accordingly.'
        : 'Dates of birth are omitted: your role cannot export them.',
      columns: [
        { header: 'Family', key: 'family', width: 24 },
        { header: 'First name', key: 'first_name', width: 16 },
        { header: 'Last name', key: 'last_name', width: 16 },
        ...(opts.sensitive
          ? [{ header: 'Date of birth', key: 'date_of_birth', format: 'date' as const }]
          : []),
        { header: 'Age group', key: 'age_band', width: 20 },
        { header: 'Status', key: 'status', width: 13 },
        { header: 'Program', key: 'program', width: 20 },
        { header: 'Room', key: 'room', width: 18 },
        { header: 'Added', key: 'created_at', format: 'date' },
      ],
      rows: children.map(clean),
    },
    {
      name: 'Guardians', accent: 'rose',
      caption: 'Every guardian on record, primary contact first within each family.',
      columns: [
        { header: 'Family', key: 'family', width: 24 },
        { header: 'First name', key: 'first_name', width: 16 },
        { header: 'Last name', key: 'last_name', width: 16 },
        { header: 'Relationship', key: 'relationship', width: 16 },
        { header: 'Email', key: 'email', width: 30 },
        { header: 'Phone', key: 'phone', width: 18 },
        { header: 'Primary', key: 'is_primary', width: 10 },
      ],
      rows: guardians.map(clean),
    },
  ];

  return buildWorkbook(sheets);
}

/**
 * The admissions funnel and where enquiries came from.
 *
 * Separate from the families workbook because the audiences differ: this is
 * the one that goes into a meeting, and it holds no child's name at all.
 */
export function admissionsWorkbook(): Buffer {
  const stages = many<Record<string, unknown>>(
    `SELECT s.label AS stage, COUNT(l.id) AS leads
       FROM lead_stages s LEFT JOIN leads l ON l.stage_id = s.id
      GROUP BY s.id ORDER BY s.sort_order`);

  const sources = many<Record<string, unknown>>(
    `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS leads
       FROM leads GROUP BY source ORDER BY COUNT(*) DESC`);

  const tours = many<Record<string, unknown>>(
    `SELECT f.name AS family, t.status, t.scheduled_for, t.created_at, t.notes
       FROM tours t JOIN families f ON f.id = t.family_id
      ORDER BY COALESCE(t.scheduled_for, t.created_at) DESC`);

  const registrations = many<Record<string, unknown>>(
    `SELECT f.name AS family, r.status, r.submitted_at, r.created_at
       FROM registrations r JOIN families f ON f.id = r.family_id
      ORDER BY r.created_at DESC`);

  const waitlist = many<Record<string, unknown>>(
    `SELECT f.name AS family, w.status, w.added_at, w.notes
       FROM waitlist w JOIN families f ON f.id = w.family_id
      ORDER BY w.added_at`);

  return buildWorkbook([
    {
      name: 'Funnel', accent: 'violet',
      caption: `Admissions pipeline as at ${today()}. Counts are of leads currently at each stage, `
        + 'not of everyone who has ever passed through one.',
      columns: [
        { header: 'Stage', key: 'stage', width: 26 },
        { header: 'Leads', key: 'leads', format: 'integer' },
      ],
      rows: stages.map(clean),
      totals: { stage: 'Total', leads: stages.reduce((n, r) => n + num(r.leads), 0) },
    },
    {
      name: 'Where they came from', accent: 'teal',
      caption: 'Source as recorded on the lead. "unknown" means nobody set one.',
      columns: [
        { header: 'Source', key: 'source', width: 22 },
        { header: 'Leads', key: 'leads', format: 'integer' },
      ],
      rows: sources.map(clean),
    },
    {
      name: 'Tours', accent: 'amber',
      caption: 'Every tour requested or booked, most recent first.',
      columns: [
        { header: 'Family', key: 'family', width: 26 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Scheduled for', key: 'scheduled_for', format: 'date' },
        { header: 'Requested', key: 'created_at', format: 'date' },
        { header: 'Notes', key: 'notes', width: 44 },
      ],
      rows: tours.map(clean),
    },
    {
      name: 'Registrations', accent: 'rose',
      caption: 'Registrations received, including the ones a parent started and did not finish.',
      columns: [
        { header: 'Family', key: 'family', width: 26 },
        { header: 'Status', key: 'status', width: 16 },
        { header: 'Submitted', key: 'submitted_at', format: 'date' },
        { header: 'Started', key: 'created_at', format: 'date' },
      ],
      rows: registrations.map(clean),
    },
    {
      name: 'Waitlist', accent: 'slate',
      caption: 'In the order they joined, which is the order that matters.',
      columns: [
        { header: 'Family', key: 'family', width: 26 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Added', key: 'added_at', format: 'date' },
        { header: 'Notes', key: 'notes', width: 44 },
      ],
      rows: waitlist.map(clean),
    },
  ]);
}

export interface ExportCounts {
  families: number; children: number; guardians: number;
  leads: number; tours: number; registrations: number; waitlist: number;
}

/** Row counts, so the UI can say what a file will contain before downloading it. */
export function exportCounts(): ExportCounts {
  const n = (sql: string) => Number(one<{ n: number }>(sql)?.n ?? 0);
  return {
    families: n('SELECT COUNT(*) n FROM families'),
    children: n('SELECT COUNT(*) n FROM children'),
    guardians: n('SELECT COUNT(*) n FROM guardians'),
    leads: n('SELECT COUNT(*) n FROM leads'),
    tours: n('SELECT COUNT(*) n FROM tours'),
    registrations: n('SELECT COUNT(*) n FROM registrations'),
    waitlist: n('SELECT COUNT(*) n FROM waitlist'),
  };
}
