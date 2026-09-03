# EPIC-027 — Office Document Intelligence

**Status: VALIDATED | Priority: P1 | Domain: Content Understanding**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Content Understanding.

## 1. Objective

Read a Word document the way it was written — headings, paragraphs and tables —
rather than as a bag of characters, and say what was lost.

## 2. Value

`detect.ts` has recognised
`application/vnd.openxmlformats-officedocument.wordprocessingml.document` since
EPIC-023 and nothing has ever claimed it. A `.docx` in a repository is a design
document, a runbook, a review or a contract, and until this Epic every one of
them was recorded `no-parser`.

The technology decision is made and is not this Epic's to revisit:

> **TECHNOLOGY-DECISIONS §4** — "DOCX | `mammoth` 1.12.2 (BSD-2-Clause) |
> `docx4js`, `python-docx` | Raises on malformed input where python-docx returns
> empty text".

That last clause is the whole reason for the selection, and §8.5 is where it is
spent: a library that returns empty text for a damaged file makes "this document
is empty" and "this document could not be read" the same answer.

## 3. Scope

- **`ferret.parser.docx`** — a parser provider claiming the WordprocessingML
  media type natively, in `src/parsers/office/`.
- **Headings, paragraphs, lists and tables** as segments, with their kinds.
- **An outline built from the heading levels**, nested as they nest.
- **`mammoth`'s own messages** as warnings, because they are the document
  saying what could not be carried across.
- **A paragraph span unit**, extending EPIC-026's `SpanUnit`.
- **`producerIdentity()`** naming the `mammoth` version.

## 4. Non-scope

- **`.doc`** — the pre-2007 binary format. A different format with a different
  reader, and no library for it was evaluated in §4.
- **`.pptx`** — a presentation is not a document, `mammoth` does not read one,
  and TECHNOLOGY-DECISIONS §4 selected nothing for it. Claiming it here would be
  choosing a library outside the evaluation that produced every other choice.
- **Spreadsheets.** EPIC-028's, with its own conditional selection and its own
  unresolved dependency question.
- **Images.** Not extracted, and §8.7 goes further: the converter is configured
  so no base64 data URI is ever built, because `mammoth`'s default is to inline
  every embedded image into the output string.
- **Tracked changes, comments and footnotes.** `mammoth` reports what it cannot
  carry, and §8.3 records that rather than inventing a representation for it.
- **Styling.** Bold, colour and font are presentation. Ferret indexes what a
  document says.

## 5. Inputs

`ParseRequest.bytes` — a ZIP. `request.text` is absent: `detect.ts` classifies
OOXML as binary, and the ZIP signature is checked before the extension is
trusted.

## 6. Outputs

`src/parsers/office/`, exported from `@indoulia/ferret/parsers`, and one member
added to `SpanUnit`.

## 7. Dependencies

EPIC-024 (framework and contract), EPIC-023 (detection), EPIC-026 (`SpanUnit`,
and the pattern for a parser whose unit is not a line), EPIC-029 (a heading is a
section, not a declaration).

## 8. Contracts

### 8.1 The extraction is `mammoth`'s HTML, not its raw text

`mammoth` offers both. `extractRawText` returns every paragraph's characters
separated by blank lines, and throws away the one thing that makes a Word
document navigable: which of those paragraphs were headings.

`convertToHtml` returns semantic elements — `h1`…`h6`, `p`, `ul`, `table` — from
the document's own paragraph styles. That is the structure the author wrote, and
it is what an outline can be built from without inferring anything from font
sizes.

The output is tokenised over `mammoth`'s bounded tag set (§8.4) rather than
parsed as general HTML: Ferret does not need an HTML parser to read a string it
generated itself, and adding one would widen the dependency set for a format
this Epic already controls.

### 8.2 A Word document's unit is a paragraph, not a page and not a line

A `.docx` has no pages. Pagination is produced when the document is laid out,
and it depends on the renderer, the page size and the fonts installed — so a
page number Ferret reported would be a number Word disagreed with.

What it does have is an ordered sequence of block elements. `SpanUnit.PARAGRAPH`
names that, and the block's 1-based index goes in `startLine`/`endLine` under
EPIC-026 §8.1's rule: **absent means `line`**, so this changes nothing that
existed before it. The byte span is the file's, for EPIC-026 §8.2's reason — the
text lives inside compressed ZIP entries, and an offset into the extraction
would name a position in a string nobody can open.

The locator a reader actually uses is the heading, and that is what the outline
and the segment labels carry.

### 8.3 `mammoth`'s messages are warnings, not noise

`mammoth` reports what it could not carry: a style it did not recognise, an
element with no HTML equivalent, an image it skipped. Discarding those would
make a partial extraction indistinguishable from a complete one, which is the
same failure §8.5 exists to prevent one level down.

They are reported as `document-message` warnings with the library's own wording,
capped so a document with a thousand unrecognised styles cannot turn a parse
result into a log file.

### 8.4 The tag set is bounded, and an unknown tag is prose

`mammoth` emits a fixed vocabulary. The tokeniser recognises the block elements
it cares about — headings, paragraphs, list items, table rows — and treats
anything else as text rather than dropping it. Dropping is how a converter
silently loses a paragraph; treating it as prose is how it loses only a label.

Inline elements (`strong`, `em`, `a`) contribute their text and nothing else,
which is §4's position on styling.

### 8.5 A file that is not a document is refused with the library's sentence

A ZIP with no main document part raises, and the message —
*"Could not find main document part. Are you sure this is a valid .docx file?"*
— is carried through rather than replaced. This is the behaviour
TECHNOLOGY-DECISIONS §4 selected `mammoth` *for*: `python-docx` returns empty
text, and an empty extraction that means "unreadable" is a lie a search index
cannot recover from.

### 8.6 Bounds belong to the parser

A block cap and a character cap, both reported through `truncated`, as EPIC-026
§8.6 and EPIC-025's `MAX_SEGMENTS`.

### 8.7 No image is ever converted

`mammoth`'s default converts every embedded image to a base64 data URI inside
the output string, so a document with a 3 MB screenshot produces a 4 MB string
of which none is text. The converter is given an image handler that emits
nothing, so the encoding never happens — a bound enforced by configuration
rather than by discarding the result afterwards.

### 8.8 A table is a table, and this is where EPIC-026 could not say that

EPIC-026 §4 refused to emit `SegmentKind.TABLE` for a PDF because a PDF has no
table structure — only text at coordinates, and recovering a grid from alignment
is inference. WordprocessingML has `w:tbl`, `w:tr` and `w:tc`: the structure is
declared by the author, so the segment kind is a fact rather than a guess.

Cells are joined with tabs and rows with newlines, which is the smallest
rendering that keeps a row readable as a row.

## 9. Acceptance criteria

- **AC-1** The provider claims the WordprocessingML media type as `NATIVE`, and
  claims neither `.pptx` nor `.xlsx` nor `application/zip`.
- **AC-2** Headings become `heading` segments and paragraphs become `text`
  segments, in document order.
- **AC-3** The outline nests by heading level, and its kind is `DOCUMENT`.
- **AC-4** `spanUnit` is `paragraph`, and each segment's span is its block
  index.
- **AC-5** Every span is within the file — `validate()` accepts the output.
- **AC-6** A table becomes one `table` segment with rows and cells preserved.
- **AC-7** A list becomes segments, one per item, with the text intact.
- **AC-8** `mammoth`'s messages appear as warnings, capped.
- **AC-9** A ZIP that is not a document fails with the library's own sentence.
- **AC-10** Malformed bytes fail as a parse failure, not a crash.
- **AC-11** `producerIdentity()` names the `mammoth` version and does not parse.
- **AC-12** The block cap and the character cap set `truncated`.
- **AC-13** `mammoth` is reachable from `parsers/index.ts` and from neither
  `index.ts` nor `cli/main.ts`.
- **AC-14** No image handler that produces a data URI is configured.
- **AC-15** A parser that declares no `spanUnit` is unchanged — EPIC-026 AC-15
  still holds with a third member in the enumeration.
- **AC-16** The composed runtime registers four parsers, and each claims what it
  claims without displacing another.

## 10. Test requirements

**Unit** — every acceptance criterion, against `.docx` files built by a fixture
generator: a ZIP writer with stored entries and a WordprocessingML body, so the
malformed case can be produced deliberately.

**Boundary** — AC-13 in `boundaries.test.ts`.

**Regression** — EPIC-026's suite unchanged, which is what proves AC-15.

## 11. Security requirements

A `.docx` is a ZIP of XML, which is two attack surfaces: an archive and a
parser. The framework's 4 MiB bound applies before `mammoth` is called, §8.7
stops the one path that turns a small file into a large string, and §8.6 bounds
the output. `mammoth` parses XML with `@xmldom/xmldom`, which does not resolve
external entities.

## 12. Observability

Warnings carry the library's wording. `blockCount`, `headingCount` and
`tableCount` are attributes, so "which documents have tables" is answerable
without re-reading any of them.

## 13. Performance constraints

One conversion per document. The HTML is tokenised in a single pass.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 with evidence in
`validation/EPIC-027-VALIDATION.md`; `npm run verify` green; the registry
updated.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.3: what was lost is reported; §8.8: a
  table is a table only because the format declares one.
- **§12 Untrusted Input** — §11 and §8.7.
- **§5 Reuse Before Reinvent** — §8.2 extends EPIC-026's `SpanUnit` rather than
  inventing a second way to say what a span counts.
- **§21 Reproducibility** — AC-11.

## 16. Raised, not absorbed

- **`.pptx` is unowned.** §4 declines it and no Epic claims it; a presentation
  is where a decision gets *presented*, so this is a real gap and it is now a
  named one.
- **`.doc` is unowned**, and probably should stay that way until a repository is
  found that has one worth reading.
- **Footnotes, comments and tracked changes are reported as lost, not read.**
  `mammoth` can be configured to include some of them; each is a modelling
  question — is a comment a fact about the document or a fact about a
  conversation? — that this Epic does not answer.
- **Paragraph indices are stable only within one extraction.** Editing a
  document renumbers every block after the edit, so a stored locator does not
  survive a revision. So does a line number in a source file, and EPIC-031
  re-parses on content change for the same reason.

## 17. Recorded during implementation

**A cell's paragraph would have been reported twice.** `mammoth` wraps every
table cell's content in `<p>`, so a block scan that took paragraphs before
tables reported each cell as a paragraph of its own *and* as part of the table.
Tables are extracted first and the region they occupied is blanked, which is the
one ordering constraint in the tokeniser and is why it is commented there.

**The image handler could not be exported.** `mammoth`'s `ImageConverter` type
is not nameable from Ferret's declaration build, so exporting the handler failed
`tsc -p tsconfig.build.json` with TS4023 — the parser subpath exists precisely
so a consumer needs none of `mammoth`'s types, and the error was that boundary
being enforced by the compiler. The handler is module-private and the *policy*
is exported; AC-14 asserts it against this file's own source, the way
`boundaries.test.ts` asserts what a graph imports. A behavioural test would need
a document with a real embedded image and would still pass if the encoding
happened and the result were thrown away.

**`&amp;` has to be decoded last.** `&amp;lt;` is a literal `&lt;` in the
document, not a `<`. Decoding ampersands first turns one into the other, and the
test that catches it is two lines.

Full evidence in [validation](validation/EPIC-027-VALIDATION.md).
