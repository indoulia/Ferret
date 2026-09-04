import { readZip, ZipReadError } from './zip.js';

/**
 * SpreadsheetML, read directly — EPIC-028 §8.1.
 *
 * TECHNOLOGY-DECISIONS §4 selected `exceljs` **conditionally**, and made the
 * condition blocking on this Epic: *"before EPIC-027/EPIC-028 are implemented,
 * either replace `exceljs` or obtain explicit governance acceptance of the
 * unlicensed transitive."* Measured on 2026-09-03, every recorded problem still
 * held. This is the replacement, and it adds no dependency at all: a `.xlsx` is
 * a ZIP of XML, `node:zlib` inflates, and what Ferret needs from a spreadsheet
 * is its text.
 *
 * It is a reader, not a spreadsheet engine. No formula is evaluated — the file
 * carries the last computed value and that is what is reported. §8.4.
 */

/** How many cells are read across the workbook — EPIC-028 §8.7. */
export const MAX_SHEET_CELLS = 200_000;

/** How many sheets are read. */
export const MAX_SHEETS = 100;

export class XlsxReadError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'XlsxReadError';
  }
}

export interface SheetRow {
  /** 1-based, as the file declares it. Gaps are real: a sheet may skip rows. */
  readonly row: number;
  readonly cells: readonly string[];
}

export interface Sheet {
  readonly name: string;
  readonly rows: readonly SheetRow[];
  /** Cells that held a value, before any bound was applied. */
  readonly cellCount: number;
}

export interface XlsxExtraction {
  readonly sheets: readonly Sheet[];
  readonly truncated: boolean;
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
}

export interface XlsxReadOptions {
  readonly maxCells?: number;
  readonly maxSheets?: number;
}

const DECODER = new TextDecoder();

/** Read a workbook's text, sheet by sheet. */
export function readXlsx(bytes: Uint8Array, options: XlsxReadOptions = {}): XlsxExtraction {
  const maxCells = options.maxCells ?? MAX_SHEET_CELLS;
  const maxSheets = options.maxSheets ?? MAX_SHEETS;
  const warnings: { code: string; detail: string }[] = [];

  let entries: ReadonlyMap<string, Uint8Array>;
  try {
    entries = readZip(bytes, {
      // Only the parts this reader uses. A workbook's images and printer
      // settings are neither text nor small.
      wanted: (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        name === 'xl/sharedStrings.xml' ||
        name === 'xl/styles.xml' ||
        name.startsWith('xl/worksheets/'),
    });
  } catch (error) {
    throw new XlsxReadError(
      error instanceof ZipReadError ? error.message : `Not a readable archive: ${String(error)}`,
    );
  }

  const workbook = entries.get('xl/workbook.xml');
  if (workbook === undefined) {
    // §8.5, and `mammoth`'s sentence is the model: "empty" and "unreadable"
    // must not be the same answer.
    throw new XlsxReadError(
      'Could not find xl/workbook.xml. Are you sure this is a valid .xlsx file?',
    );
  }
  // F-23. Present is not the same as readable: an error page, a truncated
  // download or some other XML under this name parsed to zero `<sheet>`
  // elements and was reported as a workbook that simply had none.
  if (rootStructure(DECODER.decode(workbook), 'workbook') !== 'ok') {
    throw new XlsxReadError(
      'xl/workbook.xml is not a readable workbook part. Are you sure this is a valid .xlsx file?',
    );
  }

  const targets = relationshipTargets(entries.get('xl/_rels/workbook.xml.rels'));
  const strings = sharedStrings(entries.get('xl/sharedStrings.xml'));
  const dateFormats = dateStyles(entries.get('xl/styles.xml'));

  const sheets: Sheet[] = [];
  let cells = 0;
  let truncated = false;

  const declared = declaredSheets(workbook);
  for (const [index, declaration] of declared.entries()) {
    if (index >= maxSheets) {
      truncated = true;
      warnings.push({
        code: 'sheet-limit',
        detail: `Stopped after ${String(maxSheets)} of ${String(declared.length)} sheets.`,
      });
      break;
    }

    const target = declaration.id === undefined ? undefined : targets.get(declaration.id);
    const part =
      target === undefined
        ? undefined
        : (entries.get(`xl/${target}`) ?? entries.get(target.replace(/^\/?/u, '')));
    if (part === undefined) {
      // Dropped rather than guessed at, the way EPIC-026 §8.9 drops a bookmark
      // whose destination does not resolve.
      warnings.push({
        code: 'unresolved-sheet',
        detail: `"${declaration.name}" names a part that is not in the package.`,
      });
      continue;
    }

    // F-23, again, and this is where it bit: a worksheet part is read by regex,
    // so anything that is not one matches no `<row>` and arrives as a sheet with
    // no rows. That is the same answer a genuinely empty sheet gives.
    const structure = rootStructure(DECODER.decode(part), 'worksheet');
    if (structure !== 'ok') {
      warnings.push(
        structure === 'truncated'
          ? {
              code: 'truncated-sheet',
              detail: `"${declaration.name}" is cut off: its part never closes </worksheet>.`,
            }
          : {
              code: 'unreadable-sheet',
              detail: `"${declaration.name}" names a part that is not a worksheet.`,
            },
      );
      continue;
    }

    const parsed = readSheet(part, strings, dateFormats, maxCells - cells);
    cells += parsed.cellCount;
    if (parsed.truncated) {
      truncated = true;
      warnings.push({
        code: 'cell-limit',
        detail: `Stopped at ${String(maxCells)} cells, in "${declaration.name}".`,
      });
    }
    sheets.push({ name: declaration.name, rows: parsed.rows, cellCount: parsed.cellCount });
    if (parsed.truncated) break;
  }

  return { sheets, truncated, warnings };
}

/**
 * Whether a part is the document it claims to be — F-23.
 *
 * The opening tag alone is not enough. A download cut off mid-file still starts
 * with a correct root, and the difference between "this is not a worksheet" and
 * "this is a worksheet that did not finish arriving" is the difference between
 * two warnings a reader acts on differently. So the closing tag is checked too,
 * and only a self-closing root is excused from having one.
 *
 * The prefix group is what keeps `<x:worksheet>` legitimate: SpreadsheetML may
 * be written with the main namespace bound to a prefix, and rejecting that would
 * refuse real workbooks in the name of catching corrupt ones.
 */
function rootStructure(xml: string, root: string): 'ok' | 'unreadable' | 'truncated' {
  const opening = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${root}\\b[^>]*>`, 'u').exec(xml);
  if (opening === null) return 'unreadable';
  if (opening[0].endsWith('/>')) return 'ok';
  const closing = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${root}\\s*>`, 'u');
  return closing.test(xml.slice(opening.index)) ? 'ok' : 'truncated';
}

interface SheetDeclaration {
  readonly name: string;
  readonly id: string | undefined;
}

/** `<sheet name="Q1" sheetId="1" r:id="rId1"/>`, in workbook order. */
function declaredSheets(part: Uint8Array): readonly SheetDeclaration[] {
  const xml = DECODER.decode(part);
  const sheets: SheetDeclaration[] = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*)\/?>/gu)) {
    const attributes = match[1] ?? '';
    const name = attribute(attributes, 'name');
    if (name === undefined) continue;
    sheets.push({ name: decodeXml(name), id: attribute(attributes, 'r:id') });
  }
  return sheets;
}

function relationshipTargets(part: Uint8Array | undefined): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  if (part === undefined) return targets;
  for (const match of DECODER.decode(part).matchAll(/<Relationship\b([^>]*)\/?>/gu)) {
    const attributes = match[1] ?? '';
    const id = attribute(attributes, 'Id');
    const target = attribute(attributes, 'Target');
    if (id !== undefined && target !== undefined) targets.set(id, target);
  }
  return targets;
}

/**
 * The shared string table.
 *
 * A `<si>` may hold one `<t>` or several inside `<r>` runs — the runs are one
 * string that was formatted in pieces, so they are joined without a separator.
 * Splitting them would break a word wherever somebody bolded half of it.
 */
function sharedStrings(part: Uint8Array | undefined): readonly string[] {
  if (part === undefined) return [];
  const xml = DECODER.decode(part);
  const strings: string[] = [];
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)) {
    let text = '';
    for (const run of (item[1] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)) {
      text += decodeXml(run[1] ?? '');
    }
    strings.push(text);
  }
  return strings;
}

/**
 * Which style indices mean "this number is a date".
 *
 * A date in a spreadsheet is a number with a format applied — there is no date
 * type. Reporting the serial `45000` for a cell a reader sees as `2023-03-15`
 * would be true about the storage and useless about the content, so the style
 * table is read: built-in formats 14–22 and 45–47 are dates, and a custom format
 * is a date when its code contains a day, month or year token outside a literal.
 */
function dateStyles(part: Uint8Array | undefined): ReadonlySet<number> {
  const dates = new Set<number>();
  if (part === undefined) return dates;
  const xml = DECODER.decode(part);

  const custom = new Set<number>();
  for (const match of xml.matchAll(/<numFmt\b([^>]*)\/?>/gu)) {
    const attributes = match[1] ?? '';
    const id = Number(attribute(attributes, 'numFmtId'));
    const code = attribute(attributes, 'formatCode') ?? '';
    if (Number.isInteger(id) && isDateFormat(decodeXml(code))) custom.add(id);
  }

  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u.exec(xml);
  if (cellXfs === null) return dates;
  let index = 0;
  for (const match of (cellXfs[1] ?? '').matchAll(/<xf\b([^>]*)\/?>/gu)) {
    const id = Number(attribute(match[1] ?? '', 'numFmtId'));
    if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || custom.has(id)) dates.add(index);
    index += 1;
  }
  return dates;
}

/** A format code is a date's when a `y`, `d` or month token survives its literals. */
function isDateFormat(code: string): boolean {
  const withoutLiterals = code.replaceAll(/"[^"]*"/gu, '').replaceAll(/\\./gu, '');
  return /[yd]/iu.test(withoutLiterals) || /m{3,}/iu.test(withoutLiterals);
}

interface SheetParse {
  readonly rows: readonly SheetRow[];
  readonly cellCount: number;
  readonly truncated: boolean;
}

/** One worksheet's rows. */
function readSheet(
  part: Uint8Array,
  strings: readonly string[],
  dateFormats: ReadonlySet<number>,
  budget: number,
): SheetParse {
  const xml = DECODER.decode(part);
  const rows: SheetRow[] = [];
  let cellCount = 0;

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gu)) {
    const number = Number(attribute(rowMatch[1] ?? '', 'r'));
    const cells: string[] = [];
    let held = false;

    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      if (cellCount >= budget) return { rows, cellCount, truncated: true };
      const attributes = cellMatch[1] ?? '';
      const text = cellValue(attributes, cellMatch[2] ?? '', strings, dateFormats);
      // The column matters: a gap between B and D is two empty cells, and
      // collapsing it would shift every value in the row one place left.
      const column = columnIndex(attribute(attributes, 'r') ?? '');
      while (cells.length < column) cells.push('');
      cells.push(text);
      if (text.length > 0) {
        held = true;
        cellCount += 1;
      }
    }

    if (held) rows.push({ row: Number.isInteger(number) ? number : rows.length + 1, cells });
  }

  return { rows, cellCount, truncated: false };
}

/** `A1` → 0, `B1` → 1, `AA1` → 26. An unreadable reference goes to the end. */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/u.exec(reference)?.[1];
  if (letters === undefined) return Number.MAX_SAFE_INTEGER;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * A cell's text.
 *
 * `t` says what the value is: `s` indexes the shared table, `inlineStr` and
 * `str` carry their own text, `b` is a boolean, `e` is an error the file already
 * recorded. Anything else is a number, and a number with a date format applied
 * is rendered as a date — §8.3.
 */
function cellValue(
  attributes: string,
  body: string,
  strings: readonly string[],
  dateFormats: ReadonlySet<number>,
): string {
  const type = attribute(attributes, 't') ?? 'n';

  if (type === 's') {
    const index = Number(text(body, 'v'));
    return Number.isInteger(index) ? (strings[index] ?? '') : '';
  }
  if (type === 'inlineStr') {
    let inline = '';
    for (const run of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gu)) inline += decodeXml(run[1] ?? '');
    return inline;
  }
  if (type === 'str' || type === 'e') return decodeXml(text(body, 'v'));
  if (type === 'b') {
    const raw = text(body, 'v');
    return raw === '' ? '' : raw === '1' ? 'TRUE' : 'FALSE';
  }

  const raw = text(body, 'v');
  if (raw === '') return '';
  const style = Number(attribute(attributes, 's'));
  if (Number.isInteger(style) && dateFormats.has(style)) {
    const rendered = excelDate(Number(raw));
    if (rendered !== undefined) return rendered;
  }
  return raw;
}

/**
 * A serial number as an ISO date.
 *
 * Day 1 is 1900-01-01, and the format also contains a 1900-02-29 that never
 * existed — a bug in the original that every spreadsheet has reproduced since.
 * Serial 60 is that day; below it the epoch is shifted by one, which is why the
 * offset is not a single constant.
 */
function excelDate(serial: number): string | undefined {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return undefined;
  const days = Math.floor(serial);
  const epoch = Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const date = new Date(epoch + days * 86_400_000);
  const iso = date.toISOString().slice(0, 10);
  const fraction = serial - days;
  if (fraction === 0) return iso;
  const time = new Date(Math.round(fraction * 86_400_000)).toISOString().slice(11, 19);
  return `${iso}T${time}`;
}

function text(body: string, tag: string): string {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'u').exec(body)?.[1] ?? '';
}

/**
 * One attribute's value.
 *
 * The colon in `r:id` is not escaped, because a colon needs no escape and
 * escaping one is a `SyntaxError` under the `u` flag. The word boundary is what
 * keeps `Id` from matching inside `sheetId`.
 */
function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'u').exec(attributes)?.[1];
}

/**
 * The five entities SpreadsheetML writes, plus numeric escapes.
 *
 * `_x000D_` is a carriage return Excel encodes in a shared string; leaving it
 * would put a literal `_x000D_` in the middle of a searchable cell.
 */
function decodeXml(value: string): string {
  return value
    .replaceAll(/_x([0-9A-Fa-f]{4})_/gu, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll(/&#x([0-9A-Fa-f]+);/gu, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replaceAll(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
