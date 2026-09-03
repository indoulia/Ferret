import { parse } from 'csv-parse/sync';

import type { SheetRow } from './xlsx.js';

/**
 * Delimited text — EPIC-028 §8.6.
 *
 * TECHNOLOGY-DECISIONS §4 measured something this parser has to act on:
 *
 * > *"Both CSV readers accept corrupt CSV without complaint — inherent to the
 * > format. CSV ingestion therefore needs Ferret-side validation, not
 * > parser-side trust."*
 *
 * So the library reads and Ferret judges. A row whose width differs from the
 * first row's is reported, because in a format with no schema that is the only
 * signal that the delimiter was guessed wrong or a quote was left open.
 */

/** How many rows are read — EPIC-028 §8.7. */
export const MAX_CSV_ROWS = 50_000;

export class CsvReadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'CsvReadError';
  }
}

export interface CsvExtraction {
  readonly rows: readonly SheetRow[];
  readonly columns: number;
  /** Rows whose width differed from the first row's — §8.6. */
  readonly raggedRows: number;
  readonly truncated: boolean;
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}

export interface CsvReadOptions {
  readonly maxRows?: number;
  /** A tab for `.tsv`. Never guessed: the media type already said which. */
  readonly delimiter?: string;
}

export function readCsv(text: string, options: CsvReadOptions = {}): CsvExtraction {
  const maxRows = options.maxRows ?? MAX_CSV_ROWS;
  const warnings: { code: string; detail: string }[] = [];

  let records: string[][];
  try {
    records = parse(text, {
      delimiter: options.delimiter ?? ',',
      // Every row as it appears. `columns: true` would key on a header that may
      // not exist, and `skip_empty_lines` would silently renumber the rest.
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
      skip_empty_lines: false,
    });
  } catch (error) {
    throw new CsvReadError(error instanceof Error ? error.message : String(error));
  }

  const columns = records[0]?.length ?? 0;
  const rows: SheetRow[] = [];
  let ragged = 0;
  let truncated = false;

  for (const [index, record] of records.entries()) {
    if (rows.length >= maxRows) {
      truncated = true;
      warnings.push({
        code: 'row-limit',
        detail: `Stopped after ${String(maxRows)} of ${String(records.length)} rows.`,
      });
      break;
    }
    if (record.length !== columns) ragged += 1;
    if (record.some((cell) => cell.trim().length > 0)) {
      rows.push({ row: index + 1, cells: record });
    }
  }

  if (ragged > 0) {
    warnings.push({
      code: 'ragged-rows',
      detail: `${String(ragged)} row(s) do not have ${String(columns)} fields. The delimiter may be wrong or a quote may be unclosed.`,
    });
  }

  return { rows, columns, raggedRows: ragged, truncated, warnings };
}
