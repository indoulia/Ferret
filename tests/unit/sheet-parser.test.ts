import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { OutlineKind, ParserFramework, ParserSupport, SegmentKind } from '../../src/index.js';
import {
  CSV_MEDIA_TYPE,
  MAX_CSV_ROWS,
  MAX_SHEETS,
  MAX_SHEET_CELLS,
  MAX_ZIP_INFLATED_BYTES,
  SHEET_PARSER_ID,
  TSV_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
  createSheetParserProvider,
  readXlsx,
  readZip,
} from '../../src/parsers/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import {
  buildMalformedXlsx,
  buildXlsx,
  buildZip,
  columnName,
} from '../support/ooxml-fixtures.js';
import type { ParseOutcome, ParsedContent } from '../../src/index.js';

/**
 * EPIC-028. Spreadsheets, and the condition §4 attached to this Epic.
 *
 * The `.xlsx` reader is Ferret's own — §8.1 — so these tests carry more weight
 * than they would over a library: there is no upstream suite behind them.
 */

const parser = createSheetParserProvider();
const framework = new ParserFramework({ parsers: [parser] });

async function parse(bytes: Uint8Array, path: string): Promise<ParseOutcome> {
  return framework.parse({ path, bytes }, createTestOperationContext());
}

async function parsed(bytes: Uint8Array, path: string): Promise<ParsedContent> {
  const outcome = await parse(bytes, path);
  if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}: ${outcome.detail}`);
  return outcome;
}

const encoder = new TextEncoder();

const WORKBOOK = buildXlsx(
  [
    {
      name: 'Findings',
      rows: [
        ['Name', 'Owner', 'Opened', 'Score', 'Done'],
        ['Ferret', 'Platform', new Date(Date.UTC(2023, 2, 15)), 42, true],
        ['Badger', 'Data & "Ops" <team>', new Date(Date.UTC(2024, 0, 1)), 7.5, false],
      ],
    },
    { name: 'Notes', rows: [[undefined, 'A cell that skips column A']], rowNumbers: [2] },
  ],
  { sharedStrings: true },
);

describe('sheet parser — claims', () => {
  it('claims spreadsheets and delimited text, and nothing else — AC-1', () => {
    const target = { path: 'a.xlsx', mediaType: XLSX_MEDIA_TYPE, binary: true, sizeBytes: 10 };
    expect(parser.supports(target)).toBe(ParserSupport.NATIVE);
    expect(parser.supports({ ...target, mediaType: CSV_MEDIA_TYPE })).toBe(ParserSupport.NATIVE);
    expect(parser.supports({ ...target, mediaType: TSV_MEDIA_TYPE })).toBe(ParserSupport.NATIVE);
    expect(parser.supports({ ...target, mediaType: 'application/zip' })).toBe(ParserSupport.NONE);
    expect(
      parser.supports({
        ...target,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(ParserSupport.NONE);
  });
});

describe('sheet parser — a workbook', () => {
  it('makes each sheet an outline node, in workbook order — AC-2', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    expect(outcome.outlineKind).toBe(OutlineKind.DOCUMENT);
    expect(outcome.outline.map((node) => node.title)).toStrictEqual(['Findings', 'Notes']);
    expect(outcome.outline.every((node) => node.kind === 'sheet')).toBe(true);
    expect(outcome.attributes['sheetNames']).toStrictEqual(['Findings', 'Notes']);
  });

  it('makes each row one segment, labelled by sheet and row — AC-3', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    expect(outcome.segments.every((segment) => segment.kind === SegmentKind.TABLE)).toBe(true);
    expect(outcome.segments.map((segment) => segment.label)).toStrictEqual([
      'Findings!1',
      'Findings!2',
      'Findings!3',
      'Notes!2',
    ]);
  });

  it('declares a row unit and keeps the file own row numbers — AC-4', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    expect(outcome.spanUnit).toBe('row');
    // The Notes sheet starts at row 2. Renumbering it to 1 would produce a
    // locator that opens the wrong cell.
    expect(outcome.segments.map((segment) => segment.span.startLine)).toStrictEqual([1, 2, 3, 2]);
  });

  it('keeps every span inside the file — AC-5', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    for (const segment of outcome.segments) {
      expect(segment.span.startByte).toBe(0);
      expect(segment.span.endByte).toBe(WORKBOOK.byteLength);
    }
  });

  it('reads shared strings, booleans and numbers — AC-6', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    expect(outcome.segments[1]?.text).toContain('Ferret\tPlatform');
    expect(outcome.segments[1]?.text).toContain('\t42\tTRUE');
    expect(outcome.segments[2]?.text).toContain('7.5\tFALSE');
    // Entities decoded: a shared string carries `&amp;`, `&quot;` and `&lt;`.
    expect(outcome.segments[2]?.text).toContain('Data & "Ops" <team>');
  });

  it('reads inline strings as well as shared ones — AC-6', async () => {
    const inline = buildXlsx([{ name: 'S', rows: [['Inline value']] }]);
    const outcome = await parsed(inline, 'inline.xlsx');
    expect(outcome.segments[0]?.text).toBe('Inline value');
  });

  it('reads a formula result rather than the formula — AC-6, §8.4', () => {
    // `<f>` beside `<v>`: the file already holds what the author saw, and an
    // expression engine could disagree with it.
    const bytes = buildZip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      {
        name: 'xl/workbook.xml',
        content: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="A1"><f>SUM(B1:B2)</f><v>49.5</v></c></row></sheetData></worksheet>',
      },
    ]);
    const extraction = readXlsx(bytes);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['49.5']);
  });

  it('renders a date cell as a date — AC-7', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    // Nobody searches for 45000. §8.3.
    expect(outcome.segments[1]?.text).toContain('2023-03-15');
    expect(outcome.segments[2]?.text).toContain('2024-01-01');
  });

  it('keeps a skipped column as a gap — AC-8', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    // `Notes!2` has B but not A. Collapsing the gap would shift every value in
    // the row one column left.
    expect(outcome.segments[3]?.text).toBe('\tA cell that skips column A');
  });

  it('counts what it read', async () => {
    const outcome = await parsed(WORKBOOK, 'book.xlsx');
    expect(outcome.attributes['sheetCount']).toBe(2);
    expect(outcome.attributes['cellCount']).toBe(16);
  });
});

describe('sheet parser — refusals', () => {
  it('refuses a ZIP that is not a workbook, naming the part — AC-9', async () => {
    const outcome = await parse(buildMalformedXlsx(), 'not.xlsx');
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    expect(outcome.detail).toContain('xl/workbook.xml');
    expect(outcome.parserId).toBe(SHEET_PARSER_ID);
  });

  it('fails on bytes that are not an archive — AC-10', async () => {
    const outcome = await parse(encoder.encode('not a zip at all'), 'bad.xlsx');
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.detail).toContain('end-of-central-directory');
  });

  it('drops a sheet whose part is missing, and says so', () => {
    const bytes = buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          '<workbook><sheets><sheet name="Gone" sheetId="1" r:id="rId9"/></sheets></workbook>',
      },
      { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships/>' },
    ]);
    const extraction = readXlsx(bytes);
    expect(extraction.sheets).toStrictEqual([]);
    expect(extraction.warnings.map((warning) => warning.code)).toContain('unresolved-sheet');
  });
});

describe('sheet parser — delimited text', () => {
  const CSV = 'Name,Owner\nFerret,Platform\n"Quoted, comma",Data\n';

  it('reads a CSV as rows, on lines — AC-4', async () => {
    const outcome = await parsed(encoder.encode(CSV), 'list.csv');
    expect(outcome.spanUnit).toBe('line');
    expect(outcome.segments.map((segment) => segment.text)).toStrictEqual([
      'Name\tOwner',
      'Ferret\tPlatform',
      'Quoted, comma\tData',
    ]);
    expect(outcome.attributes['columnCount']).toBe(2);
  });

  it('has no outline, because a header row is a guess', async () => {
    const outcome = await parsed(encoder.encode(CSV), 'list.csv');
    expect(outcome.outline).toStrictEqual([]);
  });

  it('reads a ragged CSV and reports it as ragged — AC-11', async () => {
    // TECHNOLOGY-DECISIONS §4: "Both CSV readers accept corrupt CSV without
    // complaint… CSV ingestion therefore needs Ferret-side validation."
    const outcome = await parsed(encoder.encode('a,b,c\n1,2\n3,4,5,6\n'), 'ragged.csv');
    expect(outcome.segments).toHaveLength(3);
    expect(outcome.attributes['raggedRows']).toBe(2);
    const warning = outcome.warnings.find((entry) => entry.code === 'ragged-rows');
    expect(warning?.detail).toContain('delimiter');
  });

  it('splits a TSV on tabs, without guessing — AC-12', async () => {
    const outcome = await parsed(encoder.encode('a\tb\n1\t2\n'), 'data.tsv');
    expect(outcome.attributes['language']).toBe('tsv');
    expect(outcome.segments.map((segment) => segment.text)).toStrictEqual(['a\tb', '1\t2']);
    expect(outcome.attributes['raggedRows']).toBe(0);
  });

  it('does not treat a comma in a TSV as a delimiter', async () => {
    const outcome = await parsed(encoder.encode('one,two\tthree\n'), 'data.tsv');
    expect(outcome.segments[0]?.text).toBe('one,two\tthree');
  });
});

describe('sheet parser — bounds', () => {
  it('stops at the cell cap and says so — AC-13', async () => {
    const bounded = new ParserFramework({ parsers: [createSheetParserProvider({ maxCells: 3 })] });
    const outcome = await bounded.parse(
      { path: 'big.xlsx', bytes: WORKBOOK },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(outcome.warnings.map((warning) => warning.code)).toContain('cell-limit');
  });

  it('stops at the sheet cap and says so — AC-13', async () => {
    const bounded = new ParserFramework({ parsers: [createSheetParserProvider({ maxSheets: 1 })] });
    const outcome = await bounded.parse(
      { path: 'big.xlsx', bytes: WORKBOOK },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(outcome.attributes['sheetCount']).toBe(1);
    expect(outcome.warnings.map((warning) => warning.code)).toContain('sheet-limit');
  });

  it('stops at the CSV row cap and says so — AC-13', async () => {
    const bounded = new ParserFramework({ parsers: [createSheetParserProvider({ maxRows: 2 })] });
    const rows = Array.from({ length: 10 }, (_, index) => `${String(index)},x`).join('\n');
    const outcome = await bounded.parse(
      { path: 'long.csv', bytes: encoder.encode(rows) },
      createTestOperationContext(),
    );
    if (!outcome.parsed) throw new Error(`expected a parse, got ${outcome.reason}`);
    expect(outcome.truncated).toBe(true);
    expect(outcome.segments).toHaveLength(2);
  });

  it('declares bounds a reader can reason about', () => {
    expect(MAX_SHEET_CELLS).toBe(200_000);
    expect(MAX_SHEETS).toBe(100);
    expect(MAX_CSV_ROWS).toBe(50_000);
    expect(MAX_ZIP_INFLATED_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('the ZIP reader', () => {
  it('refuses an entry that declares more than the bound, before inflating — AC-14', () => {
    // A megabyte of zeroes compresses to almost nothing. The declared size is
    // what the bound is checked against, so the allocation never starts —
    // TECHNOLOGY-DECISIONS §4 lists decompression amplification as a tested
    // adversarial case, and a bound applied after the allocation is not a bound.
    const payload = new Uint8Array(1024 * 1024);
    const bytes = deflatedZip('big.bin', payload);
    expect(() => readZip(bytes, { maxInflatedBytes: 1024 })).toThrow(/exceed/u);
    // The same archive is fine when the bound allows it, which is what proves
    // the refusal was the bound rather than a broken reader.
    expect(readZip(bytes).get('big.bin')?.byteLength).toBe(payload.byteLength);
  });

  it('refuses a compression method it does not recognise', () => {
    const bytes = deflatedZip('x.bin', encoder.encode('hello'), 99);
    expect(() => readZip(bytes)).toThrow(/compression method 99/u);
  });

  it('refuses an archive with no end-of-central-directory record', () => {
    expect(() => readZip(encoder.encode('PK not really'))).toThrow(/end-of-central-directory/u);
  });

  it('reads stored entries, which is what the fixtures write', () => {
    const bytes = buildZip([{ name: 'a.txt', content: 'stored' }]);
    expect(new TextDecoder().decode(readZip(bytes).get('a.txt'))).toBe('stored');
  });

  it('reads only the entries a caller wants', () => {
    const bytes = buildZip([
      { name: 'keep.txt', content: 'keep' },
      { name: 'skip.txt', content: 'skip' },
    ]);
    const entries = readZip(bytes, { wanted: (name) => name === 'keep.txt' });
    expect([...entries.keys()]).toStrictEqual(['keep.txt']);
  });
});

describe('column arithmetic', () => {
  it('names columns the way a spreadsheet does', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
  });

  it('places a cell by its reference, not by its position in the row', () => {
    // `<c r="C1">` alone must land in the third column.
    const bytes = buildZip([
      {
        name: 'xl/workbook.xml',
        content: '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>third</t></is></c></row></sheetData></worksheet>',
      },
    ]);
    expect(readXlsx(bytes).sheets[0]?.rows[0]?.cells).toStrictEqual(['', '', 'third']);
  });
});

/** A ZIP with one deflated entry, for the bounds tests. */
function deflatedZip(name: string, content: Uint8Array, method = 8): Uint8Array {
  const encodedName = encoder.encode(name);
  const data = method === 8 ? new Uint8Array(deflateRawSync(content)) : content;
  const crc = 0; // Not verified by the reader; the bound is what is under test.

  const local = Buffer.alloc(30 + encodedName.length + data.length);
  local.writeUInt32LE(0x04_03_4b_50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  Buffer.from(encodedName).copy(local, 30);
  Buffer.from(data).copy(local, 30 + encodedName.length);

  const central = Buffer.alloc(46 + encodedName.length);
  central.writeUInt32LE(0x02_01_4b_50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  central.writeUInt32LE(0, 42);
  Buffer.from(encodedName).copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);

  return new Uint8Array(Buffer.concat([local, central, end]));
}
