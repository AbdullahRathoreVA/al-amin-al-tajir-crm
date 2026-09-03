/**
 * Reading a real .xlsx file.
 *
 * The import wizard only ever accepted CSV text, which meant anyone holding a
 * roll of two or three hundred children in Excel had to "Save as CSV" first —
 * once per sheet, losing every other tab, and with Excel's own habit of
 * mangling long numbers and dates on the way out. For the one job this CRM
 * exists to do, that is the wrong place to put the friction.
 *
 * So this reads the file itself. An .xlsx is a ZIP of XML, and Node ships
 * `zlib`, so the whole thing is the ZIP central directory plus enough XML
 * handling to walk a sheet — the mirror image of xlsx.ts, which already writes
 * one the same way. A parser dependency for this, on a system holding
 * children's records, would be a poor trade.
 *
 * What it deliberately does NOT do: evaluate formulas. A formula cell yields
 * its last cached value, and if there is no cached value it yields empty.
 * Imported spreadsheets are untrusted input, and running someone's formula is
 * how a spreadsheet becomes code execution.
 */
import { inflateRawSync } from 'node:zlib';

export interface XlsxSheet { name: string; rows: string[][] }

/** Excel's own cap is far higher; this is the same ceiling the CSV path uses. */
const MAX_ROWS = 5000;
const MAX_COLS = 200;

// ---------------------------------------------------------------------- zip

interface ZipEntry { name: string; data: Buffer }

/**
 * Reads a ZIP archive. Handles the two compression methods an .xlsx actually
 * uses — stored and deflate — and refuses anything else rather than returning
 * a plausible-looking empty sheet.
 */
function unzip(buf: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record is last, but may be followed by a
  // comment, so scan back for its signature rather than assuming the offset.
  let eocd = -1;
  const from = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a valid .xlsx (no ZIP directory found).');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (localAt + 30 <= buf.length && buf.readUInt32LE(localAt) === 0x04034b50) {
      // The local header repeats the name and extra lengths, and its extra
      // field is often a different length from the central one. Trust local.
      const lNameLen = buf.readUInt16LE(localAt + 26);
      const lExtraLen = buf.readUInt16LE(localAt + 28);
      const start = localAt + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      try {
        if (method === 0) out.set(name, raw);
        else if (method === 8) out.set(name, inflateRawSync(raw));
        // Anything else is left out rather than guessed at.
      } catch {
        // A corrupt member should not take the whole import down; the caller
        // reports the sheets it could read.
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------- xml

const AMP = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

function xmlUnescape(s: string): string {
  return s.replace(AMP, (m, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default:
        return e[0] === '#'
          ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
          : m;
    }
  });
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? xmlUnescape(m[1]!) : null;
};

/** "BC" -> 54. Column letters are base-26 with no zero. */
function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Concatenated <t> runs, so a cell with mixed formatting reads as one string. */
function textOf(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += xmlUnescape(m[1]!);
  return out;
}

// -------------------------------------------------------------------- dates

/**
 * Excel stores a date as a number and remembers it was a date only in the
 * cell's format. Without this, every date of birth in the file imports as
 * "45678" — which validates as a string, saves cleanly, and is wrong.
 *
 * Built-in formats 14-22 and 45-47 are dates and times. A custom format is a
 * date if its pattern mentions a day, month or year outside of quoted text.
 */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateStyleIds(styles: string | undefined): Set<number> {
  const isDate = new Set<number>();
  if (!styles) return isDate;

  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*\/>/g)) {
    const id = Number(attr(m[0], 'numFmtId'));
    const code = attr(m[0], 'formatCode') ?? '';
    if (Number.isFinite(id)) custom.set(id, code);
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let xf = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const id = Number(attr(m[0], 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(id)) isDate.add(xf);
    else {
      const code = custom.get(id);
      // Strip quoted literals and escapes first: a format like "Mth"\ 0 is not
      // a date just because it contains the letters.
      if (code && /[dmyhs]/i.test(code.replace(/"[^"]*"/g, '').replace(/\\./g, ''))) isDate.add(xf);
    }
    xf++;
  }
  return isDate;
}

/**
 * Excel's day 0 is 1899-12-30, not 1900-01-01: its calendar contains a
 * 29 February 1900 that never existed, kept for Lotus compatibility, and the
 * epoch is shifted back two days to absorb it.
 */
export function fromExcelSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  // Serial 60 IS the day that never existed. There is no right answer, and
  // silently returning the 28th or the 1st would put a child's birthday on a
  // day nobody typed.
  if (Math.floor(serial) === 60) return null;
  // Before the phantom date Excel is one day ahead of reality, so shift back
  // into the real calendar; from 1 March 1900 onwards the two agree.
  const adjusted = serial < 60 ? serial + 1 : serial;
  const d = new Date(Math.round((adjusted - 25_569) * 86_400_000));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ reading

/**
 * Every sheet in the workbook, in the order Excel shows them, each as the same
 * `string[][]` the CSV parser produces — so the import wizard's mapping,
 * validation, duplicate check and commit all work unchanged.
 */
export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = unzip(buf);

  const workbook = files.get('xl/workbook.xml')?.toString('utf8');
  if (!workbook) throw new Error('That file is not a spreadsheet the CRM can read (no workbook found).');

  // Shared strings: most text in an .xlsx is an index into this table.
  const shared: string[] = [];
  const sst = files.get('xl/sharedStrings.xml')?.toString('utf8');
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
      shared.push(m[1] ? textOf(m[1]) : '');
    }
  }

  const isDateStyle = dateStyleIds(files.get('xl/styles.xml')?.toString('utf8'));

  // A sheet's XML path comes from the relationship id, not from its position:
  // sheet1.xml is not reliably the first tab.
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relTarget = new Map<string, string>();
  // Both spellings, for the same reason as <sheet> below.
  for (const m of rels.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) relTarget.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const out: XlsxSheet[] = [];
  // `<sheet ... />` AND `<sheet ...></sheet>`. Excel writes the self-closing
  // form, so only that was handled — and then Lillio's enrolment export, which
  // writes the paired form, came back as "no readable sheets" on a file that
  // was perfectly valid. Both are legal XML and both appear in the wild.
  for (const m of workbook.matchAll(/<sheet\b[^>]*?\/?>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet ${out.length + 1}`;
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id');
    const path = rid ? relTarget.get(rid) : undefined;
    const xml = (path && files.get(`xl/${path}`))?.toString('utf8');
    if (!xml) continue;
    out.push({ name, rows: readSheet(xml, shared, isDateStyle) });
  }

  if (!out.length) throw new Error('That workbook has no readable sheets.');
  return out;
}

/** Exported so a single sheet's XML can be exercised directly, without having
 *  to build a whole workbook around it. */
export function readSheet(
  xml: string, shared: string[] = [], isDateStyle: Set<number> = new Set(),
): string[][] {
  const rows: string[][] = [];

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= MAX_ROWS) break;
    const cells: string[] = [];

    const rowXml = rowMatch[1]!;
    // Opening tags first, then the body up to the matching </c>. A single
    // regex cannot do both: `[^>]*` happily eats the slash of a self-closing
    // `<c r="B2"/>`, which then swallows the following cell and shifts every
    // value after the first empty column by one. An empty column is the normal
    // case in a real roll, so that is not an edge case, it is most files.
    for (const cm of rowXml.matchAll(/<c\b([^>]*)>/g)) {
      const rawTag = cm[1] ?? '';
      const selfClosing = rawTag.endsWith('/');
      const tag = selfClosing ? rawTag.slice(0, -1) : rawTag;
      const body = selfClosing
        ? ''
        : rowXml.slice(cm.index + cm[0].length, rowXml.indexOf('</c>', cm.index));
      const at = colIndex(attr(`<c ${tag}>`, 'r') ?? '');
      if (at >= MAX_COLS) continue;

      const type = attr(`<c ${tag}>`, 't') ?? 'n';
      let value = '';

      if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        if (type === 's') {
          value = shared[Number(raw)] ?? '';
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else if (type === 'e') {
          // An error cell (#REF!, #N/A) is not data. Empty is the honest read.
          value = '';
        } else if (type === 'str') {
          value = xmlUnescape(raw);
        } else {
          const n = Number(raw);
          const styleId = Number(attr(`<c ${tag}>`, 's') ?? '-1');
          value = (raw !== '' && Number.isFinite(n) && isDateStyle.has(styleId))
            ? (fromExcelSerial(n) ?? raw)
            : xmlUnescape(raw);
        }
      }

      // Cells are sparse — an empty column writes no <c> at all — so pad to
      // the position the reference actually names.
      while (cells.length < at) cells.push('');
      cells[at] = value.trim();
    }
    rows.push(cells);
  }

  // Trailing blank rows are Excel's formatting, not the operator's data.
  while (rows.length && rows[rows.length - 1]!.every((c) => !c)) rows.pop();
  return rows;
}

/** True when these bytes look like a ZIP, which is what an .xlsx is. */
export function looksLikeXlsx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);
}
