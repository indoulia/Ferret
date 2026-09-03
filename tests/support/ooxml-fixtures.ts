/**
 * OOXML documents built rather than checked in — EPIC-027 §10.
 *
 * The same argument as `pdf-fixtures.ts`: a binary fixture is unreviewable, and
 * building the file is the only way to produce a *deliberately* malformed one.
 *
 * The ZIP is written with stored (uncompressed) entries, which every OOXML
 * reader accepts and which keeps this file to arithmetic rather than to a
 * compressor.
 */

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
