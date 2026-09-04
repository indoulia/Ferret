import { Capability, CAPABILITY_VERSIONS } from '../../providers/capabilities.js';
import {
  OutlineKind,
  ParserSupport,
  SegmentKind,
  SpanUnit,
  type ContentSegment,
  type ContentParser,
  type ContentSpan,
  type OutlineNode,
  type ParseOutput,
  type ParseRequest,
  type ParseTarget,
} from '../../providers/contracts/parser.js';
import { ProviderKind, type Provider } from '../../providers/contract.js';
import { BaseProvider } from '../../providers/sdk/base.js';
import type { ProviderOperationContext } from '../../providers/sdk/operation.js';

import { readCsv } from './csv.js';
import { readXlsx, type Sheet, type SheetRow } from './xlsx.js';

/**
 * Spreadsheets — EPIC-028.
 *
 * Three media types, one provider, because they are one question: a grid of
 * cells with a row number as its locator. `SpanUnit.ROW` is the third unit the
 * contract has needed and the third time EPIC-026 §8.1's rule has cost one line.
 */

export const SHEET_PARSER_ID = 'ferret.parser.sheet';
/**
 * 1.2.0 — F-23, then F-102.
 *
 * Not cosmetic, and the same argument twice. Until 1.1.0 a *corrupt* worksheet
 * part was extracted as a sheet with no rows; until 1.2.0 a perfectly valid
 * **namespace-prefixed** one was too. Both produce a cached artefact that is
 * indistinguishable from an empty spreadsheet, and EPIC-031 re-extracts only
 * when the producer identity moves — so moving it is the whole of what stops a
 * silently-empty sheet being replayed out of the store for the life of the
 * content. A fix to this reader that does not move this string leaves every
 * document already indexed exactly as wrong as it was.
 */
export const SHEET_PARSER_VERSION = '1.2.0';

export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MEDIA_TYPE = 'text/csv';
export const TSV_MEDIA_TYPE = 'text/tab-separated-values';

export const SHEET_MEDIA_TYPES: readonly string[] = Object.freeze([
  XLSX_MEDIA_TYPE,
  CSV_MEDIA_TYPE,
  TSV_MEDIA_TYPE,
]);

export interface SheetParserOptions {
  /** Overridden only by a test that needs to reach a bound — §8.7. */
  readonly maxCells?: number;
  readonly maxSheets?: number;
  readonly maxRows?: number;
}

export class SheetParserProvider extends BaseProvider implements Provider, ContentParser {
  readonly id = SHEET_PARSER_ID;
  readonly kind = ProviderKind.PARSER;
  readonly description = 'Spreadsheet and delimited-text cells, by sheet and row';
  readonly capabilities = [
    { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
  ];

  readonly parserId = SHEET_PARSER_ID;
  /**
   * No library suffix, unlike the PDF and Word parsers.
   *
   * There is no library. §8.1: the `.xlsx` reader is Ferret's own, so this
   * version *is* the producer identity, and EPIC-031 re-extracts when it moves.
   * `csv-parse` reads delimited text and does not shape the result.
   */
  readonly parserVersion = SHEET_PARSER_VERSION;

  readonly #options: SheetParserOptions;

  constructor(options: SheetParserOptions = {}) {
    super();
    this.#options = options;
  }

  supports(target: ParseTarget): ParserSupport {
    return SHEET_MEDIA_TYPES.includes(target.mediaType)
      ? ParserSupport.NATIVE
      : ParserSupport.NONE;
  }

  parse(request: ParseRequest, context: ProviderOperationContext): Promise<ParseOutput> {
    context.signal.throwIfAborted();
    return Promise.resolve(
      request.target.mediaType === XLSX_MEDIA_TYPE
        ? this.#workbook(request)
        : this.#delimited(request),
    );
  }

  #workbook(request: ParseRequest): ParseOutput {
    const extraction = readXlsx(request.bytes, {
      ...(this.#options.maxCells === undefined ? {} : { maxCells: this.#options.maxCells }),
      ...(this.#options.maxSheets === undefined ? {} : { maxSheets: this.#options.maxSheets }),
    });

    const size = request.target.sizeBytes;
    const segments: ContentSegment[] = [];
    const outline: OutlineNode[] = [];

    for (const sheet of extraction.sheets) {
      const first = sheet.rows[0]?.row ?? 1;
      const last = sheet.rows[sheet.rows.length - 1]?.row ?? first;
      outline.push({
        title: sheet.name,
        kind: 'sheet',
        span: { startByte: 0, endByte: Math.max(size, 0), startLine: first, endLine: last },
        children: [],
      });
      for (const row of sheet.rows) {
        segments.push(rowSegment(row, size, sheet.name));
      }
    }

    return {
      segments,
      outline,
      // A sheet is a section of a document, not a declaration — EPIC-029 §8.4.
      outlineKind: OutlineKind.DOCUMENT,
      spanUnit: SpanUnit.ROW,
      attributes: {
        language: 'xlsx',
        sheetCount: extraction.sheets.length,
        sheetNames: extraction.sheets.map((sheet) => sheet.name),
        cellCount: extraction.sheets.reduce((total, sheet) => total + sheet.cellCount, 0),
      },
      warnings: extraction.warnings,
      truncated: extraction.truncated,
    };
  }

  #delimited(request: ParseRequest): ParseOutput {
    const tab = request.target.mediaType === TSV_MEDIA_TYPE;
    const extraction = readCsv(request.text ?? '', {
      delimiter: tab ? '\t' : ',',
      ...(this.#options.maxRows === undefined ? {} : { maxRows: this.#options.maxRows }),
    });

    const size = request.target.sizeBytes;
    return {
      segments: extraction.rows.map((row) => rowSegment(row, size)),
      // No outline: a CSV has no sections, and a header row is a guess about
      // content — EPIC-029 §8.3 refused the same inference for plain text.
      outline: [],
      outlineKind: OutlineKind.DOCUMENT,
      // A CSV row *is* a line, and saying so keeps the locator a reader can
      // use in an editor. §8.6.
      spanUnit: SpanUnit.LINE,
      attributes: {
        language: tab ? 'tsv' : 'csv',
        rowCount: extraction.rows.length,
        columnCount: extraction.columns,
        raggedRows: extraction.raggedRows,
      },
      warnings: extraction.warnings,
      truncated: extraction.truncated,
    };
  }
}

/**
 * A row, as one segment.
 *
 * One per row rather than one per cell: a cell on its own is rarely a retrieval
 * hit worth having — `42` answers nothing — and a row keeps the value beside
 * the label in the column before it. Tab-separated for the same reason
 * EPIC-027 §8.8 gives.
 */
function rowSegment(row: SheetRow, sizeBytes: number, sheet?: string): ContentSegment {
  return {
    kind: SegmentKind.TABLE,
    text: row.cells.join('\t'),
    span: rowSpan(row.row, sizeBytes),
    ...(sheet === undefined ? {} : { label: `${sheet}!${String(row.row)}` }),
  };
}

/** §8.2: the row under the declared unit, the file as the byte range. */
function rowSpan(row: number, sizeBytes: number): ContentSpan {
  return { startByte: 0, endByte: Math.max(sizeBytes, 0), startLine: row, endLine: row };
}

/** Sheets, for a caller that wants the grid rather than the segments. */
export type { Sheet };

/** A fresh provider, for a runtime to register. */
export function createSheetParserProvider(options: SheetParserOptions = {}): SheetParserProvider {
  return new SheetParserProvider(options);
}
