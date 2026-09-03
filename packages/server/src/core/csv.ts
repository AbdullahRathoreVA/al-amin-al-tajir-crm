/**
 * CSV parsing and import.
 *
 * The parser is hand-written because the correct behaviour is about 60 lines
 * (quoted fields, embedded commas, embedded newlines, doubled quotes, CRLF, a
 * BOM from Excel) and a dependency for that on a system holding children's
 * records is a poor trade. It is tested against the cases Excel and Sheets
 * actually produce.
 *
 * Import is deliberately a three-step conversation: parse and preview, map and
 * validate, then commit. Nothing is written until a person has seen the counts.
 * (spec 45 / 47 / 48)
 */
import { one, run, tx } from '../db/index.ts';
import { newId, nowIso, normEmail, normPhone, splitName, familyNameFrom } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { findFamilyMatches } from './match.ts';
import { indexEntity } from './search.ts';
import { AGE_BANDS, isEmailish, isPhoneish } from '../../../shared/src/contract.ts';
import { readXlsx, looksLikeXlsx } from './xlsx-read.ts';

// ------------------------------------------------------------------ parsing

export interface ParsedCsv { headers: string[]; rows: string[][]; truncated: boolean }

const MAX_ROWS = 5000;

/**
 * One spreadsheet, whatever shape it arrived in.
 *
 * A centre's roll lives in Excel, not in CSV, and "Save as CSV first" is a
 * step that loses every sheet but one and lets Excel reformat dates on the way
 * out. So an .xlsx is read directly and flattened to the same rows a CSV
 * produces — which means the mapping, validation, duplicate check and commit
 * downstream do not know or care which it was.
 *
 * `sheet` picks a tab by name. Without it the first tab wins, because that is
 * where a roll almost always is, and `sheetNames` comes back so a person can
 * choose a different one.
 */
export interface Tabular extends ParsedCsv {
  /** Every tab in the workbook, in Excel's own order. Absent for a CSV. */
  sheetNames?: string[];
  /** The tab these rows came from. */
  sheet?: string;
}

export function parseTabular(
  input: { csv?: string; xlsxBase64?: string; sheet?: string },
): Tabular {
  if (typeof input.xlsxBase64 === 'string' && input.xlsxBase64) {
    const buf = Buffer.from(input.xlsxBase64, 'base64');
    if (!looksLikeXlsx(buf)) {
      throw new Error('That does not look like an .xlsx file. If it is an old .xls, open it in Excel and save it as .xlsx or CSV.');
    }
    const sheets = readXlsx(buf);
    const chosen = (input.sheet && sheets.find((s) => s.name === input.sheet)) || sheets[0]!;
    const [headers = [], ...rows] = chosen.rows;
    return {
      headers: headers.map((h) => h.trim()),
      // A row that is entirely empty is Excel's formatting, not a record.
      rows: rows.filter((r) => r.some((cell) => cell !== '')).slice(0, MAX_ROWS),
      truncated: rows.length > MAX_ROWS,
      sheetNames: sheets.map((s) => s.name),
      sheet: chosen.name,
    };
  }

  if (typeof input.csv !== 'string' || !input.csv.trim()) {
    throw new Error('Send a CSV as { csv } or a spreadsheet as { xlsxBase64 }.');
  }
  return parseCsv(input.csv);
}

export function parseCsv(text: string): ParsedCsv {
  // Excel writes a UTF-8 BOM. Left in place it becomes part of the first header
  // name, and every mapping against that column then silently misses.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let truncated = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }  // doubled quote is a literal
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;                            // CRLF, handled by \n
    if (ch === '\n') {
      row.push(field); field = '';
      // Skip blank lines rather than importing an empty family.
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) { truncated = true; break; }
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }

  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows, truncated };
}

// ------------------------------------------------------------------ mapping

/** The fields an import can populate. Deliberately small. */
export const IMPORT_FIELDS = [
  'guardianName', 'guardianEmail', 'guardianPhone', 'guardianRelationship',
  'childFirstName', 'childLastName', 'childDob', 'childAgeBand',
  'program', 'desiredStart', 'notes', 'status',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_LABELS: Record<ImportField, string> = {
  guardianName: 'Parent / guardian name',
  guardianEmail: 'Parent email',
  guardianPhone: 'Parent phone',
  guardianRelationship: 'Relationship to child',
  childFirstName: "Child's first name",
  childLastName: "Child's surname",
  childDob: "Child's date of birth",
  childAgeBand: 'Age band',
  program: 'Program',
  desiredStart: 'Desired start',
  notes: 'Notes',
  status: 'Status',
};

/**
 * Header names really seen in nursery spreadsheets, lowercased and stripped.
 *
 * The Lillio names are in here deliberately. Lillio (formerly HiMama) publishes
 * no API — its own help pages point you at Reports -> Child Profile Report ->
 * Run Export, which produces a CSV. So the working path from Lillio into this
 * CRM is that export, and the least this can do is recognise its columns
 * without anybody mapping them by hand.
 *
 * If Lillio ever grants API access, the connector replaces this and the aliases
 * stay harmless. Until then, guessing the columns IS the integration.
 */
const ALIASES: Record<ImportField, string[]> = {
  guardianName: ['parentname', 'guardianname', 'parent', 'guardian', 'name', 'contactname', 'fullname', 'mother', 'father',
    // Lillio
    'primarycontact', 'primaryparent', 'parent1name', 'parentguardianname', 'guardian1'],
  guardianEmail: ['email', 'parentemail', 'guardianemail', 'emailaddress', 'contactemail', 'e-mail',
    'primarycontactemail', 'parent1email', 'guardianemailaddress'],
  guardianPhone: ['phone', 'parentphone', 'guardianphone', 'mobile', 'cell', 'telephone', 'contactnumber', 'phonenumber',
    'primarycontactphone', 'parent1phone', 'homephone', 'mobilephone'],
  guardianRelationship: ['relationship', 'relation', 'parenttype'],
  childFirstName: ['childname', 'childfirstname', 'child', 'firstname', 'childsname', 'kidname',
    'studentfirstname', 'studentname', 'childfirst'],
  childLastName: ['childlastname', 'lastname', 'surname', 'familyname',
    'studentlastname', 'childlast'],
  childDob: ['dob', 'dateofbirth', 'birthdate', 'birthday', 'childdob',
    'studentdateofbirth', 'childdateofbirth', 'birthdatemmddyyyy'],
  childAgeBand: ['ageband', 'age', 'agegroup', 'agerange'],
  program: ['program', 'programme', 'room', 'class', 'classroom', 'programinterest',
    'group', 'currentroom', 'enrolledroom', 'classroomname'],
  desiredStart: ['startdate', 'desiredstart', 'start', 'preferredstart', 'enrolmentdate', 'enrollmentdate',
    'enrollmentstartdate', 'startingdate', 'admissiondate'],
  notes: ['notes', 'note', 'comments', 'comment', 'questions', 'message'],
  status: ['status', 'stage', 'leadstatus', 'childstatus', 'enrollmentstatus', 'studentstatus'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best-effort column guess. Always shown to a person before anything is written. */
export function guessMapping(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const used = new Set<number>();

  // Exact alias matches first, so "email" does not get claimed by a fuzzy pass.
  for (const field of IMPORT_FIELDS) {
    const aliases = ALIASES[field];
    const idx = headers.findIndex((h, i) => !used.has(i) && aliases.includes(norm(h)));
    if (idx !== -1) { out[field] = idx; used.add(idx); }
  }
  for (const field of IMPORT_FIELDS) {
    if (out[field] !== undefined) continue;
    const aliases = ALIASES[field];
    const idx = headers.findIndex((h, i) =>
      !used.has(i) && aliases.some((a) => norm(h).includes(a) || a.includes(norm(h))));
    if (idx !== -1) { out[field] = idx; used.add(idx); }
  }
  return out;
}

// --------------------------------------------------------------- validation

export interface RowIssue { row: number; field: string; message: string; severity: 'error' | 'warning' }

export interface ImportPreview {
  totalRows: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  issues: RowIssue[];
  /** First few resolved rows, so a person can eyeball the mapping. */
  sample: { row: number; guardian: string; child: string; contact: string; action: string }[];
  truncated: boolean;
}

interface Resolved {
  rowNumber: number;
  guardianName: string; guardianEmail: string | null; guardianPhone: string | null;
  guardianRelationship: string | null;
  childFirstName: string | null; childLastName: string | null;
  childDob: string | null; childAgeBand: string | null;
  program: string | null; desiredStart: string | null; notes: string | null;
  action: 'create' | 'update' | 'skip';
  existingFamilyId: string | null;
  /** Set when an EARLIER row in the same file already claimed this contact.
   *  Resolution decides this once so the preview and the commit cannot
   *  disagree about how many families a file produces. */
  joinsRow: number | null;
}

const cell = (row: string[], idx: number | undefined): string =>
  idx === undefined ? '' : (row[idx] ?? '').trim();

/**
 * Excel hands dates over in whatever the author's locale used. Rather than
 * guess between 03/04 as March 4th or April 3rd, an ambiguous value is kept as
 * a warning and left unset: a wrong date of birth puts a child in the wrong
 * room and the wrong ratio.
 */
function parseDate(v: string, rowNumber: number, issues: RowIssue[]): string | null {
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (iso) return v.slice(0, 10);

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);
  if (slash) {
    const [, a, b, y] = slash;
    const year = y!.length === 2 ? `20${y}` : y!;
    if (Number(a) > 12) return `${year}-${b!.padStart(2, '0')}-${a!.padStart(2, '0')}`;  // unambiguous D/M
    if (Number(b) > 12) return `${year}-${a!.padStart(2, '0')}-${b!.padStart(2, '0')}`;  // unambiguous M/D
    issues.push({
      row: rowNumber, field: 'date', severity: 'warning',
      message: `"${v}" could be day/month or month/day. Left blank rather than guessed.`,
    });
    return null;
  }
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);

  issues.push({ row: rowNumber, field: 'date', severity: 'warning', message: `Could not read the date "${v}".` });
  return null;
}

function resolveRows(
  parsed: ParsedCsv, mapping: Partial<Record<ImportField, number>>,
): { resolved: Resolved[]; issues: RowIssue[] } {
  const issues: RowIssue[] = [];
  const resolved: Resolved[] = [];
  const seenInFile = new Map<string, number>();

  parsed.rows.forEach((row, i) => {
    const rowNumber = i + 2;  // 1-indexed, plus the header
    const guardianName = cell(row, mapping.guardianName);
    const rawEmail = cell(row, mapping.guardianEmail);
    const rawPhone = cell(row, mapping.guardianPhone);

    const r: Resolved = {
      rowNumber, guardianName,
      guardianEmail: null, guardianPhone: null,
      guardianRelationship: cell(row, mapping.guardianRelationship) || null,
      childFirstName: cell(row, mapping.childFirstName) || null,
      childLastName: cell(row, mapping.childLastName) || null,
      childDob: parseDate(cell(row, mapping.childDob), rowNumber, issues),
      childAgeBand: null,
      program: cell(row, mapping.program) || null,
      desiredStart: cell(row, mapping.desiredStart) || null,
      notes: cell(row, mapping.notes) || null,
      action: 'create', existingFamilyId: null, joinsRow: null,
    };

    if (!guardianName) {
      issues.push({ row: rowNumber, field: 'guardianName', severity: 'error', message: 'No parent name in this row.' });
      r.action = 'skip';
    }
    if (rawEmail) {
      if (isEmailish(rawEmail)) r.guardianEmail = rawEmail.toLowerCase();
      else issues.push({ row: rowNumber, field: 'guardianEmail', severity: 'warning', message: `"${rawEmail}" is not a valid email. Left blank.` });
    }
    if (rawPhone) {
      if (isPhoneish(rawPhone)) r.guardianPhone = rawPhone;
      else issues.push({ row: rowNumber, field: 'guardianPhone', severity: 'warning', message: `"${rawPhone}" is not a valid phone number. Left blank.` });
    }
    if (!r.guardianEmail && !r.guardianPhone && r.action !== 'skip') {
      issues.push({ row: rowNumber, field: 'contact', severity: 'error', message: 'No email and no phone, so this family could never be contacted.' });
      r.action = 'skip';
    }

    const band = cell(row, mapping.childAgeBand);
    if (band) {
      const match = AGE_BANDS.find((b) => norm(b) === norm(band))
        ?? AGE_BANDS.find((b) => norm(b).includes(norm(band)) || norm(band).includes(norm(b)));
      if (match) r.childAgeBand = match;
      else issues.push({ row: rowNumber, field: 'childAgeBand', severity: 'warning', message: `Age band "${band}" is not one we recognise. Left blank.` });
    }

    // Duplicates WITHIN the file, which spreadsheets are full of.
    const key = r.guardianEmail ?? (r.guardianPhone ? normPhone(r.guardianPhone) : null);
    if (key && r.action !== 'skip') {
      const firstSeen = seenInFile.get(key);
      if (firstSeen !== undefined) {
        // Not merely a warning: this row will NOT create a family, and the
        // preview has to say so or it lies about the count.
        r.joinsRow = firstSeen;
        r.action = 'update';
        issues.push({
          row: rowNumber, field: 'contact', severity: 'warning',
          message: `Same contact as row ${firstSeen}. It will be added to that family rather than creating a second one.`,
        });
      } else seenInFile.set(key, rowNumber);
    }

    // Duplicates against what is ALREADY in the CRM. Skipped when an earlier
    // row in this file already decided where this one goes.
    if (r.action !== 'skip' && r.joinsRow === null) {
      const matches = findFamilyMatches({
        fullName: guardianName,
        email: r.guardianEmail ?? undefined,
        phone: r.guardianPhone ?? undefined,
      });
      const link = matches.find((m) => m.decision === 'link');
      if (link) {
        r.action = 'update';
        r.existingFamilyId = link.familyId;
      } else if (matches.length) {
        issues.push({
          row: rowNumber, field: 'contact', severity: 'warning',
          message: `Resembles "${matches[0]!.familyName}" (${matches[0]!.reasons.join('; ')}). A separate family will be created and flagged.`,
        });
      }
    }

    resolved.push(r);
  });

  return { resolved, issues };
}

export function preview(parsed: ParsedCsv, mapping: Partial<Record<ImportField, number>>): ImportPreview {
  const { resolved, issues } = resolveRows(parsed, mapping);
  return {
    totalRows: resolved.length,
    willCreate: resolved.filter((r) => r.action === 'create').length,
    willUpdate: resolved.filter((r) => r.action === 'update').length,
    willSkip: resolved.filter((r) => r.action === 'skip').length,
    issues: issues.slice(0, 200),
    sample: resolved.slice(0, 8).map((r) => ({
      row: r.rowNumber,
      guardian: r.guardianName || '(none)',
      child: r.childFirstName ?? '(none)',
      // Named for what it is: whichever way we can reach them. `??` would
      // keep an empty string and show a blank where a phone number exists.
      contact: r.guardianEmail || r.guardianPhone || '(none)',
      action: r.action,
    })),
    truncated: parsed.truncated,
  };
}

// ------------------------------------------------------------------ commit

export interface ImportResult {
  batchId: string;
  created: number; updated: number; skipped: number;
  issues: RowIssue[];
}

export function commitImport(
  parsed: ParsedCsv, mapping: Partial<Record<ImportField, number>>,
  actor: Actor, sourceName: string,
): ImportResult {
  const { resolved, issues } = resolveRows(parsed, mapping);
  const batchId = newId();
  const now = nowIso();
  let created = 0, updated = 0, skipped = 0;

  // One transaction for the whole file. A half-imported spreadsheet is worse
  // than a rejected one: nobody can tell which half made it.
  // Families created earlier in THIS run, keyed by contact point.
  //
  // resolveRows only sees what is already in the database, so two rows sharing
  // an email both look new and both create a family. The preview warns that
  // they will be merged; without this map the commit would then do the
  // opposite, which is worse than either behaviour on its own.
  const createdThisBatch = new Map<string, string>();
  const contactKeys = (r: Resolved): string[] => {
    const keys: string[] = [];
    const e = normEmail(r.guardianEmail);
    const p2 = normPhone(r.guardianPhone);
    if (e) keys.push('e:' + e);
    if (p2) keys.push('p:' + p2);
    return keys;
  };

  tx(() => {
    for (const r of resolved) {
      if (r.action === 'skip') { skipped++; continue; }

      const keys = contactKeys(r);
      // resolveRows already decided this row joins an earlier one; look up the
      // family that row actually created.
      const earlier = keys.map((k) => createdThisBatch.get(k)).find(Boolean);
      if (earlier && !r.existingFamilyId) r.existingFamilyId = earlier;

      let familyId = r.existingFamilyId;
      if (!familyId) {
        familyId = newId();
        run(
          `INSERT INTO families (id, name, status, source, source_id, created_at, updated_at, created_by, updated_by)
           VALUES (?,?,'prospective','excel',?,?,?,?,?)`,
          familyId, familyNameFrom(r.guardianName), batchId, now, now, actor.id, actor.id,
        );
        created++;
        for (const k of keys) createdThisBatch.set(k, familyId);
      } else {
        updated++;
        for (const k of keys) if (!createdThisBatch.has(k)) createdThisBatch.set(k, familyId);
      }

      const email = normEmail(r.guardianEmail);
      const phone = normPhone(r.guardianPhone);
      const existingGuardian = (email || phone)
        ? one<{ id: string }>(
            `SELECT id FROM guardians WHERE family_id = ?
              AND ((email_norm IS NOT NULL AND email_norm = ?) OR (phone_norm IS NOT NULL AND phone_norm = ?)) LIMIT 1`,
            familyId, email, phone)
        : undefined;

      if (!existingGuardian) {
        const { first, last } = splitName(r.guardianName);
        run(
          `INSERT INTO guardians (id, family_id, first_name, last_name, relationship, email, phone,
             email_norm, phone_norm, is_primary, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          newId(), familyId, first, last, r.guardianRelationship,
          r.guardianEmail, r.guardianPhone, email, phone,
          r.existingFamilyId ? 0 : 1, now, now,
        );
      }

      if (r.childFirstName) {
        const dupChild = one<{ id: string }>(
          'SELECT id FROM children WHERE family_id = ? AND LOWER(first_name) = ? LIMIT 1',
          familyId, r.childFirstName.toLowerCase());
        if (!dupChild) {
          run(
            `INSERT INTO children (id, family_id, first_name, last_name, date_of_birth, age_band, status, created_at, updated_at)
             VALUES (?,?,?,?,?,?,'prospective',?,?)`,
            newId(), familyId, r.childFirstName, r.childLastName, r.childDob, r.childAgeBand, now, now,
          );
        }
      }

      if (r.notes) {
        run('INSERT INTO notes (id, entity_type, entity_id, body, author_id, created_at) VALUES (?,?,?,?,?,?)',
          newId(), 'family', familyId, `Imported from ${sourceName}:\n\n${r.notes}`, actor.id, now);
      }

      recordEvent({
        entityType: 'family', entityId: familyId,
        type: r.existingFamilyId ? 'updated' : 'created',
        actor: { ...actor, source: 'excel' },
        // The batch id is in the summary so an import can be found and undone
        // by eye, not only by querying. (spec 201)
        summary: `${r.existingFamilyId ? 'Updated' : 'Created'} from ${sourceName} (row ${r.rowNumber}, batch ${batchId.slice(0, 8)})`,
        after: { source: 'excel', batch: batchId, row: r.rowNumber },
      });

      const label = one<{ name: string }>('SELECT name FROM families WHERE id = ?', familyId)?.name ?? 'family';
      indexEntity('family', familyId, label,
        [r.guardianName, r.guardianEmail, r.guardianPhone, r.childFirstName].filter(Boolean).join(' '),
        familyId);
    }

    run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      `import:${batchId}`,
      JSON.stringify({ source: sourceName, created, updated, skipped, at: now, by: actor.id }),
      now);
  });

  return { batchId, created, updated, skipped, issues };
}
