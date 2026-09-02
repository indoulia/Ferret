# EPIC-026 — PDF Intelligence — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-026](../EPIC-026-PDF-Intelligence.md), AC-1 to AC-16.

`application/pdf` was the largest media type Ferret could recognise and not
read. `detect.ts` matched `%PDF-` from EPIC-023 onward, no parser claimed it,
and every PDF in every indexed repository was recorded as `no-parser` — an
honest refusal, and the reason a specification checked in as a PDF was invisible
to search, to context packs and to evidence.

## What was built

- **`src/parsers/pdf/document.ts`** — everything that knows what a PDF is: the
  mandatory configuration, the page loop, the bookmark resolution and the two
  refusals. One file to change when the library moves.
- **`src/parsers/pdf/provider.ts`** — the parser contract, and nothing about
  PDFs beyond turning pages into segments.
- **`src/providers/contracts/parser.ts`** — `SpanUnit`, additive, absent
  meaning `line`.
- **`tests/support/pdf-fixtures.ts`** — PDFs assembled from readable objects
  with real cross-reference tables, including the malformed and encrypted cases.
- **`tests/unit/pdf-parser.test.ts`** — 22 tests.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `claims application/pdf natively and nothing else` — `NATIVE` for `application/pdf`, `NONE` for Markdown, plain text and `application/octet-stream`. No fallback: a PDF's machinery must never run over bytes nobody said were a PDF. |
| AC-2 | **MET** | `yields one segment per page, in order` — a two-page document gives `Page 1`, `Page 2`, each carrying its own text. |
| AC-3 | **MET** | `declares its span unit, and the lines are pages` — `spanUnit` is `page`; line numbers are `[1, 2]`. |
| AC-4 | **MET** | `keeps every span inside the file` — the assertion is that the *framework* returned a parse at all: `validate()` rejects a span past the end with `invalid-result`, and the helper throws on that. |
| AC-5 | **MET** | `reports document properties as a segment and as attributes` — a `metadata` segment labelled `Document properties`, plus `title`, `author`, `pageCount`, `hasTextLayer`. |
| AC-6 | **MET** | `turns bookmarks into a document outline with page spans` — two bookmarks resolve to pages 1 and 3, `outlineKind` is `document`, every node's kind is `section`. |
| AC-7 | **MET** | `reports a missing text layer rather than an empty document` — two content-free pages give `hasTextLayer: false`, `pageCount: 2`, a `no-text-layer` warning naming OCR, and a successful parse. |
| AC-8 | **MET** | `declines an encrypted document without reading a page` — `parser-failed`, detail contains `encrypted`, and `pdfjs` raises before any page is fetched. |
| AC-9 | **MET** | `fails malformed bytes with the reason, not a crash` — `parser-failed`, detail contains `malformed`. A third test asserts the two details differ: one needs a password and one needs a file. |
| AC-10 | **MET** | `passes the mandated configuration` — all five §8.3 settings asserted against the exported object, plus `Object.isFrozen`. |
| AC-11 | **MET** | `names the library build without parsing` — `1.0.0+pdfjs-dist@6.3.289+1c8020a7d`, from module constants; no document is opened. |
| AC-12 | **MET** | `does not detach the caller-owned buffer` — `byteLength` unchanged and `bytes[0] === 0x25` after a parse. |
| AC-13 | **MET** | `stops at the page cap` and `stops at the character cap` — `truncated`, the matching warning, two of four pages kept, and `pageCount: 4` still reported so the bound is visible rather than hidden. |
| AC-14 | **MET** | `is the only graph that carries a PDF engine` in `boundaries.test.ts` — `pdfjs-dist` reachable from `parsers/index.ts`, from neither `index.ts` nor `cli/main.ts`. |
| AC-15 | **MET** | `leaves a parser that declares no unit reporting lines` — the text parser's `spanUnit` is `undefined` and its first span still starts at line 1. A companion test asserts `validate()` refuses an unrecognised unit. |
| AC-16 | **MET** | `releases the task on the failure path too` — three rounds of encrypted, malformed and successful reads interleaved, all succeeding in their own terms. |

## Measured before it was specified

Three of this Epic's contracts came from a probe rather than from reasoning, and
two of them would have been wrong the other way round.

**`pdfjs` detaches the buffer it is given.** A probe printed
`byteLength before 1013 after 0 detached true`. `ParseRequest.bytes` is the
content stage's buffer and outlives the parse, so the parser copies. §8.7.

**`document.destroy` is not a function.** The first probe ended
`TypeError: doc.destroy is not a function` — inside a `finally` in the real
parser, that would have replaced whatever error was already travelling. The
loading task owns the worker and the transferred buffer. §8.8.

**The refusals are distinguishable.** `PasswordException` for an encrypted
document, `InvalidPDFException` for garbage and for a truncated real file. Both
measured before either was relied on.

## Found by test

**The properties segment would have appeared on every document.** `pdfjs`
reports a `PDFFormatVersion` for all of them, so `describeProperties` was never
empty and a "Document properties" block would have been attached to documents
declaring none. The version is a fact about the container rather than content to
retrieve; it stayed an attribute.

## Found by the gates

**The boundary gate refused AC-14 while AC-14 was true.** `boundaries.test.ts`
records import specifiers, so `pdfjs-dist/legacy/build/pdf.mjs` is not
`pdfjs-dist`. Keeping the raw specifier is right — a subpath policy has to stay
visible — so the assertions that ask what would be *installed* now normalise, and
the ones that ask what is *imported* still do not.

**EPIC-099's conformance harness refused the provider on sight**, which is
precisely its contract: a provider nothing runs the suite against is a failing
build. It then refused it a second time, because the `RUNNABLE` entry had been
added and the import had not — reported as `contract.registers` failing, through
the catch-all whose comment says a factory that throws is a conformance failure
rather than an exception for the caller.

## What this does not claim

- **Nothing is OCRed.** A scanned PDF is now visible *as* a scanned PDF, with a
  page count and a named reason. Reading it is unowned — §16.
- **Reading order is `pdfjs`'s.** A two-column document extracts in content
  stream order, which is usually the reading order and is not guaranteed to be.
- **No PDF is tested at scale.** Every fixture is small by construction; the
  memory profile of a 1 000-page document rests on `page.cleanup()` and the page
  cap, not on measurement.
- **The byte span is the file's, deliberately.** §8.2. A PDF's evidence locator
  is its page, and the byte range is there because the contract requires one.
