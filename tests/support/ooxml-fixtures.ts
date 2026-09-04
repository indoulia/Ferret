/**
 * OOXML documents built rather than checked in — EPIC-027 §10.
 *
 * The same argument as `pdf-fixtures.ts`: a binary fixture is unreviewable, and
 * building the file is the only way to produce a *deliberately* malformed one.
 *
 * `buildZip` writes stored (uncompressed) entries, which every OOXML reader
 * accepts and which keeps most of this file to arithmetic rather than to a
 * compressor. `buildDeflatedZip` exists because stored entries cannot express a
 * decompression attack at all — neither an entry that expands enormously nor a
 * central directory that lies about how far it expands — and a generator that
 * can only produce well-formed archives is why a bound checked against the
 * archive's own declared size passed every test.
 */

import { deflateRawSync } from 'node:zlib';

/** CRC-32, the one thing a ZIP entry cannot be written without. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

export interface ZipEntry {
  readonly name: string;
  readonly content: string;
}

/** A ZIP archive with stored entries, in the order given. */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.content);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04_03_4b_50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date — 1980-01-01, so the bytes are stable
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    Buffer.from(name).copy(local, 30);
    Buffer.from(data).copy(local, 30 + name.length);
    locals.push(local);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02_01_4b_50, 0); // central directory header
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    Buffer.from(name).copy(header, 46);
    central.push(header);

    offset += local.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/**
 * A ZIP with **deflated** entries and a declared size the caller chooses.
 *
 * `declared` overrides the uncompressed size written into both headers. Left
 * out, it is the truth — so the same helper writes an honest archive and a
 * lying one, and a test can show which of the two a bound is reading.
 */
export function buildDeflatedZip(
  entries: readonly (ZipEntry & { readonly declared?: number })[],
): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = encoder.encode(entry.content);
    const data = new Uint8Array(deflateRawSync(raw));
    const crc = crc32(raw);
    const declared = entry.declared ?? raw.length;

    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    Buffer.from(name).copy(local, 30);
    Buffer.from(data).copy(local, 30 + name.length);
    locals.push(local);

    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02_01_4b_50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10); // deflated
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(declared, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    Buffer.from(name).copy(header, 46);
    central.push(header);

    offset += local.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/** A `.docx` whose `word/document.xml` inflates to `body`, deflated on disk. */
export function buildDeflatedDocx(body: string): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`;
  return buildDeflatedZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: PACKAGE_RELS },
    { name: 'word/document.xml', content: document },
  ]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** One paragraph: a style name, then the text. `Heading1` becomes an `h1`. */
export interface DocxParagraph {
  readonly style?: string;
  readonly text: string;
}

export interface DocxFixtureOptions {
  readonly paragraphs: readonly DocxParagraph[];
  /** Rows of a single trailing table, if any. */
  readonly table?: readonly (readonly string[])[];
}

function paragraphXml(paragraph: DocxParagraph): string {
  const style =
    paragraph.style === undefined
      ? ''
      : `<w:pPr><w:pStyle w:val="${paragraph.style}"/></w:pPr>`;
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(paragraph.text)}</w:t></w:r></w:p>`;
}

function tableXml(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map(
      (row) =>
        `<w:tr>${row
          .map((cell) => `<w:tc><w:p><w:r><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`)
          .join('')}</w:tr>`,
    )
    .join('');
  return `<w:tbl>${body}</w:tbl>`;
}

/** A readable, uncompressed `.docx`. */
export function buildDocx(options: DocxFixtureOptions): Uint8Array {
  const body = [
    ...options.paragraphs.map((paragraph) => paragraphXml(paragraph)),
    options.table === undefined ? '' : tableXml(options.table),
  ].join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`;

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: PACKAGE_RELS },
    { name: 'word/document.xml', content: document },
  ]);
}

/** A ZIP that is not an OOXML package: the parts a reader needs are absent. */
export function buildMalformedDocx(): Uint8Array {
  return buildZip([{ name: 'notes.txt', content: 'This is a zip, not a document.' }]);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/* ------------------------------------------------------------------------- *
 * SpreadsheetML — EPIC-028.
 * ------------------------------------------------------------------------- */

export interface XlsxSheetFixture {
  readonly name: string;
  /** Rows of cells. A `number` is written as a number, a `Date` as a date. */
  readonly rows: readonly (readonly (string | number | Date | boolean | undefined)[])[];
  /** 1-based row numbers, when the sheet should skip rows. */
  readonly rowNumbers?: readonly number[];
}

/**
 * A readable, uncompressed `.xlsx`.
 *
 * Strings go inline rather than into the shared table by default, and one
 * fixture opts into shared strings so both paths are exercised: the shared
 * table is what a real authoring application writes, and the inline form is
 * what a generator writes.
 */
export function buildXlsx(
  sheets: readonly XlsxSheetFixture[],
  options: { readonly sharedStrings?: boolean } = {},
): Uint8Array {
  const shared: string[] = [];
  const useShared = options.sharedStrings === true;

  const sheetParts = sheets.map((sheet, index) => ({
    path: `xl/worksheets/sheet${String(index + 1)}.xml`,
    content: sheetXml(sheet, useShared ? shared : undefined),
  }));

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`,
    )
    .join('')}</sheets>
</workbook>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${String(index + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(index + 1)}.xml"/>`,
    )
    .join('')}
</Relationships>`;

  // Style 1 carries built-in number format 14 (a date); style 0 is General.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

  const strings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${String(shared.length)}" uniqueCount="${String(shared.length)}">
${shared.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join('')}
</sst>`;

  return buildZip([
    { name: '[Content_Types].xml', content: SHEET_CONTENT_TYPES },
    { name: '_rels/.rels', content: SHEET_PACKAGE_RELS },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/_rels/workbook.xml.rels', content: rels },
    { name: 'xl/styles.xml', content: styles },
    ...(useShared ? [{ name: 'xl/sharedStrings.xml', content: strings }] : []),
    ...sheetParts.map((part) => ({ name: part.path, content: part.content })),
  ]);
}

const SHEET_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`;

const SHEET_PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

/** `A`, `B`, … `AA`. */
export function columnName(index: number): string {
  let name = '';
  let value = index;
  do {
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return name;
}

/** Days since the 1900 epoch, with the leap-year bug every spreadsheet keeps. */
export function excelSerial(date: Date): number {
  return Math.round((date.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function sheetXml(sheet: XlsxSheetFixture, shared: string[] | undefined): string {
  const rows = sheet.rows
    .map((cells, index) => {
      const number = sheet.rowNumbers?.[index] ?? index + 1;
      const written = cells
        .map((value, column) => cellXml(`${columnName(column)}${String(number)}`, value, shared))
        .filter((cell) => cell.length > 0)
        .join('');
      return `<row r="${String(number)}">${written}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rows}</sheetData>
</worksheet>`;
}

function cellXml(
  reference: string,
  value: string | number | Date | boolean | undefined,
  shared: string[] | undefined,
): string {
  if (value === undefined) return '';
  if (value instanceof Date) {
    return `<c r="${reference}" s="1"><v>${String(excelSerial(value))}</v></c>`;
  }
  if (typeof value === 'number') return `<c r="${reference}"><v>${String(value)}</v></c>`;
  if (typeof value === 'boolean') {
    return `<c r="${reference}" t="b"><v>${value ? '1' : '0'}</v></c>`;
  }
  if (shared === undefined) {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }
  let index = shared.indexOf(value);
  if (index === -1) index = shared.push(value) - 1;
  return `<c r="${reference}" t="s"><v>${String(index)}</v></c>`;
}

/** A workbook part that is present but is not a workbook. */
export function buildMalformedXlsx(): Uint8Array {
  return buildZip([{ name: 'xl/notes.txt', content: 'A zip, but not a workbook.' }]);
}
