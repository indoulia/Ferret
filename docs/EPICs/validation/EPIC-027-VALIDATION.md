# EPIC-027 — Office Document Intelligence — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-027](../EPIC-027-Office-Document-Intelligence.md), AC-1 to AC-16.

`detect.ts` has recognised the WordprocessingML media type since EPIC-023 and
nothing claimed it. Every `.docx` in every indexed repository — a design
document, a runbook, a review — was recorded `no-parser`.

## What was built

- **`src/parsers/office/document.ts`** — the `mammoth` binding: the conversion,
  the image policy, the message cap and the bounds.
- **`src/parsers/office/html.ts`** — the block tokeniser over `mammoth`'s own
  bounded tag set. Not an HTML parser, and §8.4 says why.
- **`src/parsers/office/provider.ts`** — the parser contract, the outline, and
  the paragraph span unit.
- **`src/providers/contracts/parser.ts`** — `SpanUnit.PARAGRAPH`, the third
  member; absent still means `line`.
- **`tests/support/ooxml-fixtures.ts`** — a ZIP writer with stored entries and
  CRC-32, and a WordprocessingML body built from readable parts.
- **`tests/unit/docx-parser.test.ts`** — 23 tests.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `claims WordprocessingML and nothing else` — `NATIVE` for the Word type; `NONE` for `application/zip`, `.xlsx` and `.pptx`. Every OOXML file is a ZIP, so claiming the container would route a spreadsheet into a reader that refuses it a layer down with a worse message. |
| AC-2 | **MET** | `separates headings from paragraphs, in order` — `heading, text, heading, text`, and `headingCount: 2`. `extractRawText` would have produced the same characters and lost exactly this. |
| AC-3 | **MET** | `nests the outline by heading level` — one root, `Findings` beneath it, `outlineKind: document`. A companion test asserts a skipped level attaches to the nearest shallower heading rather than inventing the missing one. |
| AC-4 | **MET** | `declares a paragraph unit, and the spans are block indices` — `spanUnit` is `paragraph`; spans are `[1, 2, 3, 4, 5]`. |
| AC-5 | **MET** | `keeps every span inside the file` — the framework returned a parse, which is `validate()` accepting it. |
| AC-6 | **MET** | `keeps a table as a table` — one `table` segment, `Name\tOwner\nFerret\tPlatform`. EPIC-026 §4 refused this for a PDF because a grid recovered from alignment is inference; `w:tbl` is a declaration. |
| AC-7 | **MET** | `keeps a list item per segment`. |
| AC-8 | **MET** | `reports the library messages as warnings` and `caps the messages` — 25 reported plus a `message-limit` warning at 35. |
| AC-9 | **MET** | `refuses a ZIP that is not a document, with the library sentence` — "Could not find main document part…". This is what TECHNOLOGY-DECISIONS §4 selected `mammoth` for. |
| AC-10 | **MET** | `fails on bytes that are not an archive at all` and `fails on a document part that is not XML`. |
| AC-11 | **MET** | `names the library version without parsing` — `1.0.0+mammoth@1.12.2`, read from the manifest. |
| AC-12 | **MET** | `stops at the block cap` and `stops at the character cap` — `truncated`, two of four blocks, and the matching warning. |
| AC-13 | **MET** | `is the only graph that carries an OOXML reader` in `boundaries.test.ts`. |
| AC-14 | **MET** | `never lets an image become a data URI` — the policy is `drop`, the source passes `convertImage: IMAGE_HANDLER`, and `images.dataUri` appears nowhere outside a comment. |
| AC-15 | **MET** | `leaves a parser that declares no unit reporting lines` — the text parser's `spanUnit` is still `undefined` with a third member in the enumeration. |
| AC-16 | **MET** | `parser-composition.test.ts` — the composed runtime registers four parsers, each selectable by capability. |

## The decision this Epic had to make

**HTML, not raw text.** `mammoth` offers both, and `extractRawText` is the
smaller change: paragraphs separated by blank lines, nothing to tokenise. It
also throws away which paragraphs were headings, which is the only thing that
makes a Word document navigable and the only thing an outline could be built
from without inferring structure from font sizes.

**A paragraph, not a page.** A `.docx` has no pages until something lays it out,
and pagination depends on the renderer, the page size and the fonts installed. A
page number Ferret reported would be one Word disagreed with. The block index is
what the format can honestly say, and EPIC-026's `SpanUnit` existed to say it —
which is the second time that field has cost one line rather than a migration.

## Found while building

**A cell's paragraph would have been reported twice.** `mammoth` wraps every
cell's content in `<p>`, so scanning paragraphs before tables reports each cell
as a paragraph *and* as part of the table. Tables come out first and their
region is blanked.

**The image handler could not be exported.** `mammoth`'s `ImageConverter` type
is not nameable from the declaration build, and `tsc` said so with TS4023 — the
parser subpath's boundary, enforced by the compiler rather than by a test. The
handler stayed private and the policy is what is exported.

**`&amp;` decodes last.** `&amp;lt;` is a literal `&lt;`, not a `<`.

## What this does not claim

- **`.pptx` and `.doc` are unowned.** §16. A presentation is where a decision
  gets presented, so the gap is real and is now named rather than implied by an
  absent parser.
- **Footnotes, comments and tracked changes are reported as lost, not read.**
  Whether a comment is a fact about the document or about a conversation is a
  modelling question this Epic does not answer.
- **Paragraph indices are stable only within one extraction.** An edit
  renumbers every block after it — as it does line numbers in a source file, and
  EPIC-031 re-parses on content change for the same reason.
