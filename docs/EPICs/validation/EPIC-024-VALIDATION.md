# EPIC-024 — Parser Framework: validation evidence

**Status: VALIDATED** · no new runtime dependency. Detection is a byte sniff and
a table; the framework is dispatch, bounds and redaction. The boundary test
proves both.

## What the framework does

`ParserFramework.parse({ path, bytes }, context)` detects what the content is,
chooses a parser by capability, enforces the size bound before the parser sees
anything, isolates a parser that misbehaves, validates what comes back, redacts
credentials out of it, and stamps the result with the parser and its version.

Every file gets an answer. A file with no parser, one too large, one that is
binary, one that is empty, or one whose parser failed produces an
`UnparsedContent` with a stable reason — never a silent absence.

## Acceptance criteria

All rows are `tests/unit/parser-framework.test.ts` unless stated.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 native selection, order decides | PASS | `selects a parser that claims the media type natively`; `lets registration order decide between two native claims` |
| AC-2 fallback only when nothing claims natively | PASS | `prefers a native claim over a fallback registered earlier` — the fallback is registered *first* and still loses; `uses a fallback when nothing claims the type natively` |
| AC-3 no parser yields `no-parser` | PASS | `reports no-parser rather than failing` |
| AC-4 over the bound, parser never called | PASS | `does not hand a parser content over the size bound` asserts the parser mock ran zero times |
| AC-5 binary detected; a parser may claim it | PASS | `reports binary content no parser claims`; `lets a parser claim binary input explicitly` |
| AC-6 a throwing parser costs one file | PASS | `reports a throwing parser without failing the call`; `leaves the next file unaffected` |
| AC-7 malformed results rejected | PASS | five cases in one table: missing text, span past the end, backwards span, line below one, no segments array |
| AC-8 credentials never reach a segment | PASS | `keeps a credential out of every segment, and counts it`; `redacts even when the parser did not`; `reports nothing redacted for clean content` |
| AC-9 provenance, or a reason | PASS | `names the parser and its version`; `gives an unparsed result a reason instead of a parser` |
| AC-10 cancellation | PASS | `stops before calling a parser when already aborted` (mock ran zero times); `hands the signal to a parser that has started` |
| AC-11 detection by extension and by bytes | PASS | `maps common extensions to media types`; `detects a mislabelled binary by its bytes`; `treats a NUL byte as binary whatever the name says`; `knows extensionless files that are conventionally text`; `has no answer for an unknown extension, rather than guessing` |
| AC-12 spans consistent with content | PASS | `accepts a result whose spans are consistent with the content` |

`tests/unit/boundaries.test.ts` adds the architectural half: the parsing graph
reaches `providers/contracts/parser.ts` and `security/secrets.ts`, reaches no
`parsing/parsers/` module, no storage, no CLI, and adds no dependency beyond the
core set — including none matching `tree-sitter`, `pdfjs`, `mammoth` or
`exceljs`.

## Design decisions worth recording

**Spans point into the original bytes, not into the extracted text.** This is
the whole reason the span type exists. A span into a PDF's extracted string
names a position nobody can see; a byte range in the file is something a human
can open and a diff can survive.

**Bytes decide, the name informs.** A PNG named `.txt` is a PNG. Detection
checks signatures first, then a NUL byte, then strict UTF-8 decoding, and only
consults the extension for the *label*. Where the two contradict — binary bytes
under a text extension — the extension is discarded and the type is
`application/octet-stream`, because reporting `text/plain` would route a file
full of NULs to a text parser.

**An unknown extension gets `undefined`, not a guess.** `mediaTypeForPath` says
nothing when it knows nothing; `detectContent` then decides from the bytes.
Guessing at the name layer would put an invented type in front of the evidence.

**Strict decoding.** `TextDecoder` runs with `fatal: true`, so invalid bytes
mean "this is not text" rather than a string full of replacement characters that
a parser would happily segment.

**Redaction is at the framework boundary.** A parser is not trusted to redact,
and a parser written in two years cannot forget. The boundary test asserts the
import, because losing it would silently move the responsibility back to every
parser author.

**Validation rejects a span past the end.** That one matters more than the
others: it survives as far as evidence, where it becomes a quote of bytes that
do not exist. One comparison per segment buys every downstream consumer the
right to trust a span without re-deriving it.

**`fallback` is a claim strength, not a priority number.** Nothing scores.
Registration order decides among equals, which is EPIC-011's rule and is visible
at the call site rather than in a heuristic nobody can predict.

**A parser whose `supports` throws is skipped, not failed.** It has not been
asked to parse anything yet, and one parser's broken predicate must not decide
the file's outcome.

## Limitations

- **No sandbox.** A parser runs in-process with full privileges. The framework
  *bounds* a parser — size, cancellation, failure isolation — which is a
  different and weaker claim than containing one. Out-of-process parsing is not
  in this Epic and is not planned by it.
- **No timeout of its own.** Cancellation is the caller's `AbortSignal`. A
  parser that ignores the signal and spins is not stopped, because stopping it
  would require the sandbox above.
- **Detection reads 8 KiB.** A file whose first 8 KiB are clean text and whose
  remainder is binary is treated as text. This is the standard trade and it is
  wrong for deliberately crafted input.
- **No encoding detection beyond BOMs and UTF-8.** Legacy single-byte encodings
  decode as invalid UTF-8 and are reported binary. That is honest but it is not
  the same as support.
- **Redaction is EPIC-082's precision, inherited whole.** A credential in a
  format nobody listed survives into a segment.
- **No parser exists yet.** Every acceptance criterion here is proven against
  fixtures. The first real parser is EPIC-025, and it is what will show whether
  the segment model fits.
- **The size bound counts bytes, not expansion.** A 3 MiB file that a parser
  expands into 300 MiB of segments is under the bound the whole way.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 32 files, 859 passed.
