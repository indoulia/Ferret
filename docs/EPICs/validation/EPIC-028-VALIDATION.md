# EPIC-028 — Spreadsheet Intelligence — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-028](../EPIC-028-Spreadsheet-Intelligence.md), AC-1 to AC-17.

This Epic had a blocking condition attached to it before a line could be
written, and settling that condition is the first piece of evidence.

## The condition

TECHNOLOGY-DECISIONS §4 selected `exceljs` **conditionally**: *"before
EPIC-027/EPIC-028 are implemented, either replace `exceljs` or obtain explicit
governance acceptance of the unlicensed transitive."*

It was **re-measured before being acted on**, because the evaluation is dated.
On a clean install of `exceljs@4.4.0` on 2026-09-03:

| Recorded in §4 | Measured | Command |
|---|---|---|
| last published 2024-12-20 | `time.modified = '2024-12-20T09:47:37.162Z'`, `4.4.0` still `latest` | `npm view exceljs version time.modified` |
| `buffers@0.1.1` declares no licence | `buffers@0.1.1 NO LICENSE` — the only one of 80 packages | scan of every `package.json` in the tree |
| two moderate CVEs | `{"moderate":2,"total":2}`, both `uuid` | `npm audit --json` |

Every recorded problem still held, so the condition was live. EPIC-028 took the
**replace** branch — with nothing. `src/parsers/sheet/` reads `.xlsx` directly:
a bounded ZIP reader over `node:zlib` and a SpreadsheetML reader. **No
dependency was added for it.**

`csv-parse@6.2.1` was measured too: one package, MIT, zero dependencies. Kept.

Struck with dated notes in three places, because three documents carried it:
TECHNOLOGY-DECISIONS §4, `EPIC-005` §"Conditions carried forward", and
`EPIC-001-DECISIONS.md`'s licence note.

## What was built

- **`src/parsers/sheet/zip.ts`** — the archive reader, with the decompression
  bound §4's adversarial testing asks for.
- **`src/parsers/sheet/xlsx.ts`** — workbook, relationships, shared strings,
  styles and worksheets.
- **`src/parsers/sheet/csv.ts`** — `csv-parse` plus the Ferret-side validation
  §4 measured the need for.
- **`src/parsers/sheet/provider.ts`** — one provider, three media types.
- **`SpanUnit.ROW`** — the third member; absent still means `line`.
- **`tests/unit/sheet-parser.test.ts`** — 30 tests.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `claims spreadsheets and delimited text, and nothing else` — `NATIVE` for `.xlsx`, `.csv`, `.tsv`; `NONE` for `application/zip` and `.docx`. |
| AC-2 | **MET** | `makes each sheet an outline node, in workbook order` — `['Findings', 'Notes']`, kind `sheet`, `outlineKind: document`. |
| AC-3 | **MET** | `makes each row one segment, labelled by sheet and row` — `Findings!1`…`Notes!2`. |
| AC-4 | **MET** | `declares a row unit and keeps the file own row numbers` — `spanUnit: row`, spans `[1, 2, 3, 2]`; the Notes sheet starts at row 2 and stays there. The CSV case asserts `line`. |
| AC-5 | **MET** | `keeps every span inside the file` — the framework returned a parse, which is `validate()` accepting it. |
| AC-6 | **MET** | `reads shared strings, booleans and numbers`, `reads inline strings as well as shared ones`, and `reads a formula result rather than the formula` — `49.5`, not `SUM(B1:B2)`. |
| AC-7 | **MET** | `renders a date cell as a date` — `2023-03-15` and `2024-01-01` from serial numbers. |
| AC-8 | **MET** | `keeps a skipped column as a gap` — `\tA cell that skips column A`; and `places a cell by its reference, not by its position in the row` for the general case. |
| AC-9 | **MET** | `refuses a ZIP that is not a workbook, naming the part` — the message names `xl/workbook.xml`, shaped after `mammoth`'s for EPIC-027 §8.5's reason. |
| AC-10 | **MET** | `fails on bytes that are not an archive`. |
| AC-11 | **MET** | `reads a ragged CSV and reports it as ragged` — three rows read, `raggedRows: 2`, and a warning naming the delimiter as a possible cause. |
| AC-12 | **MET** | `splits a TSV on tabs, without guessing`, and `does not treat a comma in a TSV as a delimiter`. |
| AC-13 | **MET** | Cell, sheet and CSV-row caps each set `truncated` with their own warning. |
| AC-14 | **MET** | `refuses an entry that declares more than the bound, before inflating` — a megabyte of zeroes in a tiny archive is refused at a 1 KiB bound and read at the default, which is what proves the refusal was the bound rather than a broken reader. |
| AC-15 | **MET** | `never carries a spreadsheet library` in `boundaries.test.ts` — neither `exceljs` nor `xlsx` in any graph; `csv-parse` in the parser graph and not the core. |
| AC-16 | **MET** | The cross-check below. |
| AC-17 | **MET** | `parser-composition.test.ts` — five parsers registered. |

## AC-16 — the cross-check

A reader written from a specification and tested only against its own writer
proves that the writer and the reader agree. So a workbook was written by
`exceljs@4.4.0` in a throwaway directory outside the project and read by this
parser. It carried a header row, two data rows, a date column, a numeric column,
booleans, a formula with a cached result, a string with `&`, `"` and `<` in it, a
cell that skips column A, and a cell with an embedded newline.

Every value matched:

| Written by `exceljs` | Read by Ferret |
|---|---|
| `new Date(Date.UTC(2023, 2, 15))` | `2023-03-15` |
| `new Date(Date.UTC(2024, 0, 1))` | `2024-01-01` |
| `{ formula: 'SUM(D2:D3)', result: 49.5 }` | `49.5` |
| `true` / `false` | `TRUE` / `FALSE` |
| `Data & "Ops" <team>` | `Data & "Ops" <team>` |
| `B2` with no `A2` | `["", "A cell that skips column A"]` |
| `Line one\nLine two` | `Line one\nLine two` |
| sheets `Findings`, `Notes` | same names, same order |

`exceljs` was not added to the project to do this, and is refused by
`boundaries.test.ts` if it ever is.

## Found while building

**A colon cannot be escaped under the `u` flag.** `name.replace(':', '\\:')` in
the attribute matcher threw `SyntaxError: Invalid escape` on the first `r:id`.
The word boundary was doing the real work all along.

**A cell's column comes from its reference, not its position.** A worksheet
writes only the cells that hold values, so `<c r="C1">` can be the first element
in its row. Placing by position would have shifted a whole sheet left.

## What this does not claim

- **`.xlsm`, shared formulas and pivot caches are unread.** `exceljs` handles
  them; this reader does not. None is text a person wrote.
- **A CSV's line and its row diverge** when a quoted field contains a newline —
  the reported unit is `line` and the number is the record's, so the locator
  drifts in that one case. §16.
- **A custom date format built only from `m` is read as a number**, because `m`
  alone is indistinguishable from minutes.
- **`.ods` and `.xls` are unowned.**
- **Streaming is not implemented**, and cannot be needed while the framework
  refuses anything over 4 MiB before a parser is called.
