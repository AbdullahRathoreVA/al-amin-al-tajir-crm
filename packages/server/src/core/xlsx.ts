/**
 * A small XLSX writer, with colour.
 *
 * There is no spreadsheet library here for the same reason there is no web
 * framework: this server has zero runtime dependencies, and a system holding
 * children's records is better off with 400 lines we own than a transitive tree
 * we have to keep patched. An .xlsx file is a ZIP of XML documents, and Node
 * ships both `zlib` and enough string handling to write one.
 *
 * What it deliberately does NOT do: formulas, charts, merged cells, images,
 * multiple fonts per cell. Those are where a hand-rolled writer stops being
 * cheaper than a library. It does headers, freeze panes, column widths, zebra
 * striping, currency and date formats, and a different accent colour per sheet
 * — which is the whole brief.
 */
import { deflateRawSync } from 'node:zlib';

// --------------------------------------------------------------------- types

export type CellValue = string | number | null | undefined;

/** Which of the built-in formats a column is rendered with. */
export type ColumnFormat = 'text' | 'number' | 'money' | 'date' | 'integer';

export interface Column {
  header: string;
  /** Key into each row object. */
  key: string;
  format?: ColumnFormat;
  /** Character width. Sensible defaults per format when omitted. */
  width?: number;
}

/** The accent a sheet's header row is filled with. */
export type Accent = 'violet' | 'ember' | 'teal' | 'amber' | 'rose' | 'slate';

export interface Sheet {
  name: string;
  accent: Accent;
  columns: Column[];
  rows: Record<string, CellValue>[];
  /** Rendered bold under a rule, for sums. Keys must match the columns. */
  totals?: Record<string, CellValue>;
  /** Shown above the table in a muted italic. One line. */
  caption?: string;
}

// ------------------------------------------------------------------ escaping

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/**
 * Escapes XML and strips the control characters XML 1.0 cannot represent.
 *
 * Stripping matters more than it looks: a parent's note pasted from a phone can
 * carry a stray 0x0B, and Excel refuses to open the entire workbook rather than
 * skipping the cell. Tab, newline and carriage return are kept.
 */
export function xmlEscape(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 && ch !== '\t' && ch !== '\n' && ch !== '\r') continue;
    if (code === 0xfffe || code === 0xffff) continue;
    out += XML_ESCAPES[ch] ?? ch;
  }
  return out;
}

// ------------------------------------------------------------------- geometry

/** 0 -> A, 25 -> Z, 26 -> AA. Excel's column names are base-26 with no zero. */
export function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Excel counts days from 1899-12-30. Dates are stored as that number. */
export function excelSerialDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / 86_400_000) + 25_569;
}

// --------------------------------------------------------------------- styles

/**
 * Accent colours, one per sheet, plus the pale tint its rows are striped with.
 * Chosen to stay legible in Excel's default light theme rather than to match
 * the CRM's dark UI, because this file is opened in Excel, not in the CRM.
 */
const ACCENTS: Record<Accent, { head: string; stripe: string }> = {
  violet: { head: 'FF5B3B8C', stripe: 'FFF2ECFA' },
  ember:  { head: 'FFC2410C', stripe: 'FFFDEEE7' },
  teal:   { head: 'FF0F766E', stripe: 'FFE6F4F2' },
  amber:  { head: 'FF92600A', stripe: 'FFFDF3DF' },
  rose:   { head: 'FF9F1239', stripe: 'FFFCE9EE' },
  slate:  { head: 'FF334155', stripe: 'FFEEF1F5' },
};

const ACCENT_ORDER: Accent[] = ['violet', 'ember', 'teal', 'amber', 'rose', 'slate'];

/** numFmt ids above 163 are custom; Excel reserves the ones below. */
const FMT_MONEY = 164;
const FMT_DATE = 165;

const FORMAT_TO_NUMFMT: Record<ColumnFormat, number> = {
  text: 0, number: 2, integer: 1, money: FMT_MONEY, date: FMT_DATE,
};

const DEFAULT_WIDTH: Record<ColumnFormat, number> = {
  text: 22, number: 12, integer: 10, money: 14, date: 12,
};

/**
 * Style indices are positional, so this builds them in a fixed order and the
 * lookup helpers below must agree with it. Getting these out of step produces a
 * file that opens but renders every cell as a date, which is a memorable
 * afternoon.
 */
function stylesXml(): string {
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  for (const a of ACCENT_ORDER) {
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${ACCENTS[a].head}"/><bgColor indexed="64"/></patternFill></fill>`);
  }
  for (const a of ACCENT_ORDER) {
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${ACCENTS[a].stripe}"/><bgColor indexed="64"/></patternFill></fill>`);
  }

  const xfs: string[] = [];
  // 0: default
  xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  // 1..6: headers, one per accent
  for (let i = 0; i < ACCENT_ORDER.length; i++) {
    xfs.push(`<xf numFmtId="0" fontId="1" fillId="${2 + i}" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`);
  }
  // Body cells: for each format, a plain and a striped variant.
  const formats: ColumnFormat[] = ['text', 'number', 'integer', 'money', 'date'];
  for (const f of formats) {
    xfs.push(`<xf numFmtId="${FORMAT_TO_NUMFMT[f]}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`);
  }
  for (let a = 0; a < ACCENT_ORDER.length; a++) {
    for (const f of formats) {
      xfs.push(`<xf numFmtId="${FORMAT_TO_NUMFMT[f]}" fontId="0" fillId="${2 + ACCENT_ORDER.length + a}" borderId="0" xfId="0" applyNumberFormat="1" applyFill="1"/>`);
    }
  }
  // Totals: bold, ruled above.
  for (const f of formats) {
    xfs.push(`<xf numFmtId="${FORMAT_TO_NUMFMT[f]}" fontId="2" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>`);
  }
  // Caption: muted italic.
  xfs.push('<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="${FMT_MONEY}" formatCode="&quot;$&quot;#,##0.00"/>
<numFmt numFmtId="${FMT_DATE}" formatCode="yyyy\\-mm\\-dd"/>
</numFmts>
<fonts count="4">
<font><sz val="11"/><name val="Calibri"/><color theme="1"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><color theme="1"/></font>
<font><i/><sz val="10"/><name val="Calibri"/><color rgb="FF6B7280"/></font>
</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="3">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>
<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
</styleSheet>`;
}

const FORMAT_INDEX: Record<ColumnFormat, number> = {
  text: 0, number: 1, integer: 2, money: 3, date: 4,
};
const HEADER_XF = (accent: Accent) => 1 + ACCENT_ORDER.indexOf(accent);
const BODY_BASE = 1 + ACCENT_ORDER.length;
const PLAIN_XF = (f: ColumnFormat) => BODY_BASE + FORMAT_INDEX[f];
const STRIPE_XF = (accent: Accent, f: ColumnFormat) =>
  BODY_BASE + 5 + ACCENT_ORDER.indexOf(accent) * 5 + FORMAT_INDEX[f];
const TOTAL_XF = (f: ColumnFormat) => BODY_BASE + 5 + ACCENT_ORDER.length * 5 + FORMAT_INDEX[f];
const CAPTION_XF = BODY_BASE + 5 + ACCENT_ORDER.length * 5 + 5;

// ------------------------------------------------------------------ worksheet

function cell(ref: string, value: CellValue, format: ColumnFormat, xf: number): string {
  if (value === null || value === undefined || value === '') {
    return `<c r="${ref}" s="${xf}"/>`;
  }
  if (format === 'date' && typeof value === 'string') {
    const serial = excelSerialDate(value);
    // A date we cannot parse is written as the text it actually is, rather than
    // being dropped or turned into 1899. A wrong date is worse than a string.
    if (serial === null) {
      return `<c r="${ref}" s="${PLAIN_XF('text')}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }
    return `<c r="${ref}" s="${xf}"><v>${serial}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}" s="${xf}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" s="${xf}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const cols = sheet.columns;
  const widths = cols.map((c, i) => {
    const fmt = c.format ?? 'text';
    const width = c.width ?? Math.max(DEFAULT_WIDTH[fmt], Math.min(42, c.header.length + 4));
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
  }).join('');

  const rows: string[] = [];
  let r = 1;

  if (sheet.caption) {
    rows.push(`<row r="${r}"><c r="A${r}" s="${CAPTION_XF}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(sheet.caption)}</t></is></c></row>`);
    r++;
    rows.push(`<row r="${r}"/>`); // a blank line, so the caption is not mistaken for a header
    r++;
  }

  const headerRow = r;
  rows.push(`<row r="${r}" ht="22" customHeight="1">` + cols.map((c, i) =>
    `<c r="${columnName(i)}${r}" s="${HEADER_XF(sheet.accent)}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(c.header)}</t></is></c>`,
  ).join('') + '</row>');
  r++;

  for (const [n, row] of sheet.rows.entries()) {
    const striped = n % 2 === 1;
    rows.push(`<row r="${r}">` + cols.map((c, i) => {
      const fmt = c.format ?? 'text';
      const xf = striped ? STRIPE_XF(sheet.accent, fmt) : PLAIN_XF(fmt);
      return cell(`${columnName(i)}${r}`, row[c.key], fmt, xf);
    }).join('') + '</row>');
    r++;
  }

  if (sheet.totals) {
    rows.push(`<row r="${r}">` + cols.map((c, i) => {
      const fmt = c.format ?? 'text';
      return cell(`${columnName(i)}${r}`, sheet.totals![c.key], fmt, TOTAL_XF(fmt));
    }).join('') + '</row>');
    r++;
  }

  const lastCol = columnName(Math.max(cols.length - 1, 0));
  const lastRow = Math.max(r - 1, headerRow);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

/** Excel rejects these characters in a tab name, and 31 is its hard limit. */
export function safeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` ${n++}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// ------------------------------------------------------------------------ zip

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface Entry { name: string; data: Buffer; deflated: Buffer; crc: number; offset: number }

/**
 * A minimal ZIP, deflated, with no data descriptors and no ZIP64.
 *
 * ZIP64 is the one real limit: past 4 GB or 65,535 entries this would need it.
 * A daycare's logbook is neither, and refusing to write a broken file is better
 * than silently producing one, so the caller is told rather than guessed at.
 */
function zip(files: { name: string; content: string }[]): Buffer {
  const entries: Entry[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.from(f.content, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(f.name, 'utf8');

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);      // version needed
    header.writeUInt16LE(0, 6);       // flags
    header.writeUInt16LE(8, 8);       // deflate
    header.writeUInt16LE(0, 10);      // mod time
    header.writeUInt16LE(0x0021, 12); // mod date: 1980-01-01, so the file is byte-identical run to run
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(deflated.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    entries.push({ name: f.name, data, deflated, crc, offset });
    chunks.push(header, nameBuf, deflated);
    offset += header.length + nameBuf.length + deflated.length;
  }

  const cdStart = offset;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x0021, 14);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.deflated.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(e.offset, 42);
    chunks.push(cd, nameBuf);
    offset += cd.length + nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- the workbook

export function buildWorkbook(sheets: Sheet[]): Buffer {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet');
  if (sheets.length > 200) throw new Error('Too many sheets for this writer');

  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: safeSheetName(s.name, taken) }));

  const sheetEntries = named.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    content: sheetXml(s),
  }));

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) =>
    `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rootRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/styles.xml', content: stylesXml() },
    ...sheetEntries,
  ]);
}
