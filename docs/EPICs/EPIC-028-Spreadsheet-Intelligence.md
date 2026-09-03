# EPIC-028 — Spreadsheet Intelligence

**Status: VALIDATED | Priority: P1 | Domain: Content Understanding**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Content Understanding.

## 1. Objective

Read a spreadsheet's cells — and settle the blocking condition
TECHNOLOGY-DECISIONS §4 attached to this Epic before anything could be built.

## 2. Value

`.xlsx`, `.csv` and `.tsv` are where an organisation keeps the things it counts:
inventories, dependency lists, budgets, migration plans, risk registers.
`detect.ts` has recognised all three since EPIC-023 and none has ever been read.

But this Epic could not start by writing a parser, because §4 does not let it:

> **TECHNOLOGY-DECISIONS §4, XLSX — conditional selection.** "`exceljs` is
> selected **with a mandatory follow-up**, because it is the single worst
> dependency in the tree despite winning its benchmark 2.8×… **Condition:**
> before EPIC-027/EPIC-028 are implemented, either replace `exceljs` or obtain
> explicit governance acceptance of the unlicensed transitive."

## 3. Scope

- **The condition, settled** — measured, then acted on. §8.1.
- **`ferret.parser.sheet`** — one provider for `.xlsx`, `.csv` and `.tsv`.
- **A `.xlsx` reader of Ferret's own**, in `src/parsers/sheet/`, with no
  dependency: a bounded ZIP reader over `node:zlib` and a SpreadsheetML reader.
- **Sheets as an outline**, rows as segments, cells joined by tab.
- **Dates rendered as dates**, because a spreadsheet stores them as numbers.
- **Ferret-side CSV validation**, which §4 measured the need for.
- **A row span unit**, the third member of EPIC-026's `SpanUnit`.

## 4. Non-scope

- **Formula evaluation.** A workbook carries the last computed value and that is
  what is reported. Recomputing would need an expression engine, a dependency
  graph and a definition of "correct" for a file whose author already has one.
- **Charts, pivot tables, images, macros.** None is text. A macro is a
  particularly clear no: the one part of a workbook that is executable is the
  one part this parser will not touch.
- **Cell formatting.** Colour, borders and conditional formatting are
  presentation, and EPIC-027 §4 took the same position for Word.
- **`.xls`** — the pre-2007 binary format, as EPIC-027 declines `.doc`.
- **`.ods`** — OpenDocument is a different schema in a different namespace, and
  no library for it was evaluated in §4.
- **Writing.** Ferret reads repositories.

## 5. Inputs

`ParseRequest.bytes` for `.xlsx`, which is a ZIP. `request.text` for `.csv` and
`.tsv`, which `detect.ts` classifies as text.

## 6. Outputs

`src/parsers/sheet/`, exported from `@indoulia/ferret/parsers`, one member added
to `SpanUnit`, and an amendment to TECHNOLOGY-DECISIONS §4 recording how the
condition was settled.

## 7. Dependencies

EPIC-024 (framework and contract), EPIC-023 (detection), EPIC-026 (`SpanUnit`),
EPIC-027 (the OOXML fixture generator, which this Epic extends).

## 8. Contracts

### 8.1 The condition is settled by replacement, and the measurement is recorded

§4 offers two ways out: replace `exceljs`, or obtain explicit governance
acceptance of an unlicensed transitive. The first step was neither — it was to
**check whether the condition still applies**, because the evaluation is dated
and npm moves.

Measured 2026-09-03, on a clean install of `exceljs@4.4.0`:

| Recorded in §4 | Still true |
|---|---|
| last published 2024-12-20 | **yes** — `4.4.0` is still latest, `time.modified` unchanged |
| `buffers@0.1.1` declares no licence | **yes** — present, and the only unlicensed package in the tree |
| two moderate CVEs from `uuid` | **yes** — `npm audit` reports 2 moderate, both `uuid` |
| 80 packages | **yes** |

So the condition is live, and this Epic takes the **replace** branch — with
nothing. A `.xlsx` is a ZIP of XML; `node:zlib` inflates; what Ferret needs from
a spreadsheet is its text, not a spreadsheet engine. The replacement adds **zero
dependencies**, and removes an unlicensed transitive from a redistributed
product rather than asking for permission to ship it.

This is a narrow exception to Governance §5, *Reuse Before Reinvent*, and the
exception is §4's own: the reusable option was assessed and found to carry a
distribution risk the evaluation called blocking. Reuse means reusing something
sound.

**What is given up** is stated rather than glossed: `exceljs` handles workbooks
this reader does not — shared formulas, pivot caches, `.xlsm` macro packages,
and the streaming reader a 200 MB workbook needs. Ferret's framework refuses
anything over 4 MiB before a parser is called, so the last of those cannot
arise; the rest are §16.

### 8.2 A spreadsheet's unit is a row

`Sheet1!7` is the locator every spreadsheet tool uses and every reader can find.
`SpanUnit.ROW`, and the row number is the file's own — a sheet may start at row
5 or skip rows, and renumbering them to be contiguous would produce a locator
that opens the wrong cell.

The byte span is the file's, for EPIC-026 §8.2's reason: the cells live in
compressed ZIP entries.

For `.csv` the unit is `line`, not `row`: a CSV row *is* a line of the file, and
saying `row` would discard the fact that a reader can go to it in an editor. A
quoted field containing a newline makes the two diverge, and §16 records it.

### 8.3 A date is rendered as a date

A spreadsheet has no date type: a date is a number with a format applied. So
`45000` and `2023-03-15` are the same cell, and reporting the number would be
true about the storage and useless about the content — nobody searches for
`45000`.

The style table is read: built-in formats 14–22 and 45–47 are dates, and a
custom format is a date when a `y`, `d` or `mmm` token survives the removal of
its quoted literals. The 1900 leap-year bug that every spreadsheet reproduces is
handled by shifting the epoch below serial 60, which is why that offset is not a
single constant.

### 8.4 No formula is evaluated

The `<v>` element holds the value the authoring application last computed, and
that is what is reported. A cell showing `49.5` is reported as `49.5`, not as
`SUM(D2:D3)`. Evaluating would mean writing an expression engine whose answers
could disagree with the file the user is looking at — the worst possible outcome
for a system whose purpose is to say what is there.

### 8.5 A ZIP that is not a workbook is refused, in EPIC-027's words

`Could not find xl/workbook.xml. Are you sure this is a valid .xlsx file?` —
deliberately the shape of `mammoth`'s sentence, because EPIC-027 §8.5 recorded
why it matters: an empty extraction that means "unreadable" is a lie a search
index cannot recover from.

### 8.6 CSV is validated by Ferret, because §4 measured that it must be

> *"Both CSV readers accept corrupt CSV without complaint — inherent to the
> format. CSV ingestion therefore needs Ferret-side validation, not parser-side
> trust."*

A row whose field count differs from the first row's is counted and reported as
`ragged-rows`. In a format with no schema that is the only available signal that
the delimiter was wrong or a quote was left open, and a parse that reported
nothing would have turned a mis-split file into confident nonsense.

The delimiter is never guessed: `text/csv` is a comma and
`text/tab-separated-values` is a tab, both from the media type `detect.ts`
already resolved.

### 8.7 Bounds belong to the parser, and one of them is a decompression bound

Cells, sheets and rows are capped and reported through `truncated`. The ZIP
reader carries one more: a total inflated-bytes bound, checked **before** each
entry is inflated. DEFLATE's ratio ceiling is about 1032:1, so a 4 MiB archive
could otherwise ask for four gigabytes — and §4 lists decompression
amplification among the adversarial cases it tested. A bound applied after the
allocation is not a bound.

### 8.8 A row is a segment; a cell is not

`42` on its own answers nothing. A row keeps a value beside the label in the
column before it, which is what makes a retrieval hit readable, and the sheet
name and row number are in the segment's label.

## 9. Acceptance criteria

- **AC-1** The provider claims `.xlsx`, `.csv` and `.tsv` natively and claims
  neither `.docx` nor `application/zip`.
- **AC-2** A workbook's sheets become outline nodes of kind `sheet`, in
  workbook order.
- **AC-3** Each row becomes one `table` segment labelled `Sheet!row`.
- **AC-4** `spanUnit` is `row` for a workbook and `line` for a CSV.
- **AC-5** Every span is within the file — `validate()` accepts the output.
- **AC-6** Shared strings, inline strings, booleans and formula results all
  read.
- **AC-7** A date cell is reported as an ISO date, not a serial number.
- **AC-8** A row that skips a column keeps the gap, so values stay in their
  columns.
- **AC-9** A ZIP that is not a workbook is refused with the named part.
- **AC-10** Malformed bytes fail as a parse failure, not a crash.
- **AC-11** A ragged CSV is read *and* reported as ragged.
- **AC-12** A `.tsv` is split on tabs, without guessing.
- **AC-13** The cell, sheet and row caps set `truncated`.
- **AC-14** The ZIP reader refuses an archive that declares more inflated bytes
  than its bound, before inflating.
- **AC-15** `exceljs` is not a dependency, and the parser graph adds only
  `csv-parse`.
- **AC-16** The workbook reader agrees with a file written by `exceljs` — the
  cross-check that a reader written against a specification needs.
- **AC-17** The composed runtime registers five parsers.

## 10. Test requirements

**Unit** — every acceptance criterion, against workbooks built by the fixture
generator EPIC-027 introduced, extended with SpreadsheetML parts.

**Cross-validation** — AC-16, recorded as evidence: a workbook written by
`exceljs` in a throwaway directory, read by this parser, with the values
compared by hand. `exceljs` is not added to the project to do it.

**Boundary** — AC-15 in `boundaries.test.ts`.

## 11. Security requirements

A `.xlsx` is an archive, so §8.7's decompression bound is a security control
rather than a performance one. The reader inflates only the five parts it uses,
refuses compression methods it does not recognise, and reads the central
directory rather than trusting local headers — a local header's declared sizes
may be zero with the truth in a trailing descriptor, and following them is how a
reader parses content as though it were structure.

No macro is read and no formula is evaluated.

## 12. Observability

`sheetCount`, `sheetNames`, `cellCount`, `rowCount`, `columnCount` and
`raggedRows` are attributes, so "which spreadsheets look mis-split" is
answerable without re-reading them.

## 13. Performance constraints

One pass per part. Only the five parts the reader uses are inflated.

## 14. Definition of Done

Scope implemented; AC-1 to AC-17 with evidence in
`validation/EPIC-028-VALIDATION.md`; `npm run verify` green; the registry
updated; **TECHNOLOGY-DECISIONS §4's XLSX condition struck with a dated note
recording how it was settled** — the condition names this Epic, so leaving it
open would leave a governance instruction that had in fact been carried out.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — §8.1 is a deliberate, argued exception, and
  §4's own condition is the argument.
- **§6 Evidence Before Inference** — §8.1 measures before acting; §8.6 reports
  what cannot be verified; §8.4 refuses to compute what the file already states.
- **§12 Untrusted Input** — §8.7 and §11.
- **§21 Reproducibility** — the parser version is the producer identity, because
  there is no library underneath it.

## 16. Raised, not absorbed

- **`.xlsm`, shared formulas and pivot caches are unread.** `exceljs` handles
  them and this reader does not. None is text a person wrote, so the loss is
  small, and it is a real loss rather than none.
- **A CSV's line and its row diverge when a quoted field contains a newline.**
  The reported unit is `line` and the number is the record's, so a file with
  embedded newlines reports a locator that drifts. Fixing it needs the parser to
  report source offsets, which `csv-parse` can be asked for and which is a
  larger change than this Epic.
- **A custom date format may be missed.** The heuristic reads `y`, `d` and `mmm`
  outside literals; a format built only from `m` for months is indistinguishable
  from minutes, and this reader calls it a number.
- **`.ods` is unowned**, like `.pptx` after EPIC-027.
- **Streaming is not implemented**, because the framework's 4 MiB bound means it
  cannot be needed. If that bound is ever raised for spreadsheets, this reader
  is where it would be felt first.

## 17. Recorded during implementation

**A colon cannot be escaped in a `u`-flagged regular expression.** Building the
attribute matcher as `\b${name.replace(':', '\:')}` threw
`SyntaxError: Invalid escape` on the first `r:id` — under `u`, an escape that
means nothing is an error rather than a literal. A colon needs no escape, and
the word boundary is what does the real work: it is what keeps `Id` from
matching inside `sheetId`.

**The cross-check found nothing, which is the result worth recording.** A reader
written from a specification and tested only against its own writer proves that
the writer and the reader agree. So a workbook was written by `exceljs` in a
throwaway directory — dates, a formula, a boolean, XML-hostile text, a skipped
column and an embedded newline — and read by this parser. Every value matched,
including the two dates rendered from serial numbers and the formula's cached
result. That is AC-16, and it is why §8.3's leap-year arithmetic can be trusted.

**The row is not the position in the row.** A worksheet writes only the cells
that hold values, so `<c r="C1">` may be the first element in its row. Placing
cells by their position would have put it in column A and shifted an entire
sheet left; placing them by parsing the reference is two lines and a test.

**The packaged size bound moved.** EPIC-101's non-grammar bound had 66 kB of
headroom and three document parsers landed in one day, so `packaging.test.ts`
refused the build at 2 537 837 against 2 530 000 — 0.31% over. Measured before
the number moved, as its own history requires: `dist/parsers/sheet` is 33 103
bytes, `pdf` 21 836, `office` 18 867, and nothing else grew. Raised to
2 840 000, the same 12% headroom the bound has carried twice before.

Worth recording what the largest of the three bought: EPIC-028's reader has no
dependency at all. 33 kB of Ferret's own code is what replaced a library with an
unlicensed transitive, and it is the only one of the three parsers whose
runtime cost to a consumer is zero.

Full evidence in [validation](validation/EPIC-028-VALIDATION.md).
