import { describe, expect, it } from 'vitest';

import { XLSX_MEDIA_TYPE, XlsxReadError, createSheetParserProvider, readXlsx } from '../../src/parsers/index.js';
import { ParserFramework } from '../../src/index.js';
import { createTestOperationContext } from '../../src/providers/sdk/testing.js';
import { buildXlsx, buildZip } from '../support/ooxml-fixtures.js';
import type { ParseOutcome } from '../../src/index.js';

/**
 * F-23. A corrupt worksheet part read as an empty sheet.
 *
 * The reader finds rows by regex, so a part that is not a worksheet at all —
 * truncated mid-file, replaced by an error page, or holding some other XML —
 * matches nothing and is reported as a sheet with no rows. "Empty" and
 * "unreadable" are then the same answer, which is exactly what §8.5 forbids for
 * the workbook part and forbids for the same reason here.
 */

const parser = createSheetParserProvider();
const framework = new ParserFramework({ parsers: [parser] });

async function parse(bytes: Uint8Array, path: string): Promise<ParseOutcome> {
  return framework.parse({ path, bytes }, createTestOperationContext());
}

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Q1" sheetId="1" r:id="rId1"/></sheets></workbook>';

const RELS =
  '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';

/** A package whose single worksheet part holds whatever is given. */
function workbookWithSheet(content: string): Uint8Array {
  return buildZip([
    { name: 'xl/workbook.xml', content: WORKBOOK_XML },
    { name: 'xl/_rels/workbook.xml.rels', content: RELS },
    { name: 'xl/worksheets/sheet1.xml', content },
  ]);
}

const WORKSHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';

describe('sheet parser — a corrupt worksheet part', () => {
  it('warns and drops a part that is not a worksheet, rather than reporting no rows', () => {
    const extraction = readXlsx(workbookWithSheet('<html><body>504 Gateway Timeout</body></html>'));
    expect(extraction.warnings.map((warning) => warning.code)).toContain('unreadable-sheet');
    expect(extraction.sheets).toStrictEqual([]);
  });

  it('warns and drops a part whose bytes are not XML at all', () => {
    const extraction = readXlsx(workbookWithSheet('\x00\x01 not markup '));
    expect(extraction.warnings.map((warning) => warning.code)).toContain('unreadable-sheet');
    expect(extraction.sheets).toStrictEqual([]);
  });

  it('warns and drops an empty part', () => {
    const extraction = readXlsx(workbookWithSheet(''));
    expect(extraction.warnings.map((warning) => warning.code)).toContain('unreadable-sheet');
    expect(extraction.sheets).toStrictEqual([]);
  });

  it('warns that a part cut off mid-file is truncated, not empty', () => {
    const extraction = readXlsx(
      workbookWithSheet(`${WORKSHEET_HEAD}<row r="1"><c r="A1" t="inlineStr"><is><t>Ferr`),
    );
    expect(extraction.warnings.map((warning) => warning.code)).toContain('truncated-sheet');
    expect(extraction.sheets).toStrictEqual([]);
  });

  it('names the sheet in the warning, so the reader knows which one went', () => {
    const extraction = readXlsx(workbookWithSheet('<html/>'));
    expect(extraction.warnings[0]?.detail).toContain('Q1');
  });

  it('keeps the sheets it can read when one part beside them is corrupt', () => {
    const bytes = buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0"?><workbook xmlns:r="r"><sheets>' +
          '<sheet name="Good" sheetId="1" r:id="rId1"/>' +
          '<sheet name="Bad" sheetId="2" r:id="rId2"/>' +
          '</sheets></workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<Relationships>' +
          '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: `${WORKSHEET_HEAD}<row r="1"><c r="A1" t="inlineStr"><is><t>Ferret</t></is></c></row></sheetData></worksheet>`,
      },
      { name: 'xl/worksheets/sheet2.xml', content: '<html/>' },
    ]);

    const extraction = readXlsx(bytes);
    expect(extraction.sheets.map((sheet) => sheet.name)).toStrictEqual(['Good']);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['Ferret']);
    expect(extraction.warnings.map((warning) => warning.code)).toStrictEqual(['unreadable-sheet']);
  });

  it('accepts a namespace-prefixed worksheet root', () => {
    const extraction = readXlsx(
      workbookWithSheet(
        '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<x:sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Prefixed</t></is></c></row></x:sheetData>' +
          '</x:worksheet>',
      ),
    );
    expect(extraction.warnings).toStrictEqual([]);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['Prefixed']);
  });
});

describe('sheet parser — a legitimately empty sheet', () => {
  it('stays warning-free: no rows is an answer, not a failure', () => {
    const extraction = readXlsx(
      workbookWithSheet(`${WORKSHEET_HEAD}</sheetData></worksheet>`),
    );
    expect(extraction.warnings).toStrictEqual([]);
    expect(extraction.sheets).toStrictEqual([{ name: 'Q1', rows: [], cellCount: 0 }]);
  });

  it('stays warning-free through the built fixture, with no sheetData at all', () => {
    const extraction = readXlsx(
      workbookWithSheet(
        '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/></worksheet>',
      ),
    );
    expect(extraction.warnings).toStrictEqual([]);
    expect(extraction.sheets).toStrictEqual([{ name: 'Q1', rows: [], cellCount: 0 }]);
  });

  it('reads a real empty sheet built by the fixture builder without complaint', async () => {
    const outcome = await parse(buildXlsx([{ name: 'Blank', rows: [] }]), 'blank.xlsx');
    expect(outcome.parsed).toBe(true);
    if (!outcome.parsed) return;
    expect(outcome.warnings).toStrictEqual([]);
    expect(outcome.attributes['sheetCount']).toBe(1);
  });
});

describe('sheet parser — a corrupt workbook part', () => {
  it('refuses a workbook.xml that is present but is not a workbook', () => {
    const bytes = buildZip([
      { name: 'xl/workbook.xml', content: '<html><body>504 Gateway Timeout</body></html>' },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
    ]);
    expect(() => readXlsx(bytes)).toThrow(XlsxReadError);
    expect(() => readXlsx(bytes)).toThrow(/xl\/workbook\.xml/u);
  });

  it('refuses an empty workbook.xml rather than reporting a workbook with no sheets', () => {
    const bytes = buildZip([{ name: 'xl/workbook.xml', content: '' }]);
    expect(() => readXlsx(bytes)).toThrow(XlsxReadError);
  });

  it('surfaces the refusal through the parser framework, naming the part', async () => {
    const outcome = await parse(
      buildZip([{ name: 'xl/workbook.xml', content: '<html/>' }]),
      'corrupt.xlsx',
    );
    expect(outcome.parsed).toBe(false);
    if (outcome.parsed) return;
    expect(outcome.reason).toBe('parser-failed');
    expect(outcome.detail).toContain('xl/workbook.xml');
  });

  /**
   * The root check must not refuse a prefixed root.
   *
   * When this was written the `<sheet>` declarations *inside* it were still read
   * by a prefix-blind regex, and this asserted only that the structural guard
   * let the part through — the gap recorded as F-102. That gap is now closed;
   * the assertion below is unchanged and the prefixed cases are covered in full
   * by the F-102 block at the end of this file.
   */
  it('accepts a namespace-prefixed workbook root rather than refusing the file', () => {
    const bytes = buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="r">' +
          '<sheets><sheet name="Q1" sheetId="1" r:id="rId1"/></sheets></x:workbook>',
      },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: `${WORKSHEET_HEAD}<row r="1"><c r="A1" t="inlineStr"><is><t>Ok</t></is></c></row></sheetData></worksheet>`,
      },
    ]);
    const extraction = readXlsx(bytes);
    expect(extraction.warnings).toStrictEqual([]);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['Ok']);
  });
});

describe('sheet parser — the cached-artefact boundary', () => {
  it('carries a parser version past 1.0.0, so silent-empty artefacts are re-extracted', () => {
    const target = { path: 'a.xlsx', mediaType: XLSX_MEDIA_TYPE, binary: true, sizeBytes: 10 };
    expect(parser.supports(target)).toBeDefined();
    expect(parser.parserVersion).not.toBe('1.0.0');
    // F-102 moved it again, for the same reason: a prefixed workbook cached as
    // empty is replayed until the producer identity changes.
    expect(parser.parserVersion).not.toBe('1.1.0');
  });
});

/**
 * **A prefixed workbook is a workbook — F-102.**
 *
 * SpreadsheetML may bind the main namespace to a prefix, so
 * `<x:worksheet><x:sheetData><x:row>` is valid and not corrupt. F-23's guard
 * accepted a prefixed *root* for exactly that reason and every extractor beneath
 * it still matched `<sheet`, `<row`, `<c` with no prefix — so the guard said
 * "this is a valid worksheet" and the reader found nothing inside it.
 *
 * Measured before the fix: a fully prefixed workbook returned
 * `{"sheets":[],"warnings":[]}`; one with prefixed rows returned a sheet with
 * zero rows and no warning. F-23's own signature — real data, silently empty,
 * cached — on files that are not corrupt, and reached by ordinary content.
 */
describe('sheet parser — a namespace-prefixed workbook — F-102', () => {
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  /** The same one-cell workbook, written against a bound prefix throughout. */
  function prefixedPackage(): Uint8Array {
    return buildZip([
      {
        name: 'xl/workbook.xml',
        content:
          `<?xml version="1.0"?><x:workbook xmlns:x="${NS_MAIN}" xmlns:r="r">` +
          '<x:sheets><x:sheet name="Q1" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      },
      { name: 'xl/_rels/workbook.xml.rels', content: RELS },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          `<?xml version="1.0"?><x:worksheet xmlns:x="${NS_MAIN}"><x:sheetData>` +
          '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>REAL DATA</x:t></x:is></x:c></x:row>' +
          '</x:sheetData></x:worksheet>',
      },
    ]);
  }

  it('reads the rows of a fully prefixed workbook', () => {
    const extraction = readXlsx(prefixedPackage());

    expect(extraction.sheets, 'a prefixed workbook declared no sheets').toHaveLength(1);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['REAL DATA']);
    expect(extraction.warnings).toStrictEqual([]);
  });

  it('reads prefixed rows inside an unprefixed workbook', () => {
    // The mixed form, which is what a transform pipeline tends to emit.
    const extraction = readXlsx(
      workbookWithSheet(
        `<?xml version="1.0"?><x:worksheet xmlns:x="${NS_MAIN}"><x:sheetData>` +
          '<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>REAL DATA</x:t></x:is></x:c></x:row>' +
          '</x:sheetData></x:worksheet>',
      ),
    );

    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['REAL DATA']);
    expect(extraction.warnings).toStrictEqual([]);
  });

  it('gives a prefixed and an unprefixed workbook the same answer', () => {
    // The property, stated directly: a prefix is a spelling, not a difference.
    const prefixed = readXlsx(prefixedPackage());
    const plain = readXlsx(
      workbookWithSheet(
        `${WORKSHEET_HEAD}<row r="1"><c r="A1" t="inlineStr"><is><t>REAL DATA</t></is></c></row>` +
          '</sheetData></worksheet>',
      ),
    );

    expect(prefixed.sheets).toStrictEqual(plain.sheets);
  });

  it('does not let prefix tolerance swallow a different element — the over-reach control', () => {
    // A derived rule needs a control against its own reach: `<c` must not match
    // `<col`, `<sheet` must not match `<sheetData`, `<t` must not match
    // `<table`. Without the word boundary the tolerance would quietly widen
    // every pattern in the reader.
    const extraction = readXlsx(
      workbookWithSheet(
        `<?xml version="1.0"?><x:worksheet xmlns:x="${NS_MAIN}">` +
          '<x:cols><x:col min="1" max="1" width="9"/></x:cols>' +
          '<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>only</x:t></x:is></x:c></x:row></x:sheetData>' +
          '</x:worksheet>',
      ),
    );

    expect(extraction.sheets[0]?.rows).toHaveLength(1);
    expect(extraction.sheets[0]?.rows[0]?.cells).toStrictEqual(['only']);
  });

  it('still refuses a part that is genuinely not a worksheet — the control', () => {
    // F-23 must survive F-102: tolerance of a prefix is not tolerance of rubbish.
    const extraction = readXlsx(workbookWithSheet('<html><body>504</body></html>'));
    expect(extraction.warnings.map((warning) => warning.code)).toContain('unreadable-sheet');
  });
});
