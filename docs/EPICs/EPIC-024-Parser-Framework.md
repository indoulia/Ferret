# EPIC-024 — Parser Framework

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-024-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry and
> Governance §4, §6, §8, §12, §13 and §22, following the Epic Specification
> Standard. It introduces no parser for any specific format: code parsing is
> EPIC-025, PDF EPIC-026, Office EPIC-027, spreadsheets EPIC-028, text and
> Markdown EPIC-029.

## 1. Objective

Turn a file's bytes into one uniform, addressable extraction result, choosing
the parser by capability and surviving every way a parser can misbehave.

## 2. Value

EPIC-022 and EPIC-023 give Ferret the files and their identity, and stop
deliberately at the byte boundary — nothing yet opens one. Everything after this
point needs the same thing from a file and must not each invent it: retrieval
needs addressable text spans, context packs need an outline to cut on token
budget, evidence needs a locator precise enough to quote, and incremental
indexing needs to know when a re-parse is required because the *parser* changed
rather than the file.

Defining that once is the difference between five parsers and five extraction
models. And a parser is the most dangerous thing Ferret runs: it is handed
attacker-controlled bytes from a repository. A framework that bounds size,
honours cancellation and isolates failure is what keeps one malformed file from
stopping an index.

## 3. Scope

- the `parser` capability contract: what a parser is asked, and what it returns;
- a uniform extraction result — ordered segments with spans, an optional
  outline, parser-declared attributes, and warnings;
- routing-level content detection: binary vs text, encoding, and a media type
  derived from the path and a magic-byte sniff;
- parser selection by capability and declared media type, with deterministic
  precedence and an explicit fallback;
- safety bounds: maximum input size, cancellation, and isolation of a parser
  that throws;
- credential redaction of extracted text before it leaves the framework;
- provenance: which parser produced a result, at which version, so a parser
  change is detectable.

## 4. Non-scope

- any concrete parser — EPIC-025 through EPIC-029;
- the AST model and symbol index — EPIC-033, EPIC-034;
- rich file metadata beyond what routing needs — EPIC-030;
- storing extraction results — EPIC-031 and EPIC-087;
- chunking for embeddings, which is a retrieval decision — EPIC-054;
- running a parser in a separate process or sandbox. The framework bounds a
  parser; it does not contain one.

## 5. Inputs

- EPIC-011 capability contracts and EPIC-013 selection;
- EPIC-022/023 tree entries: path, kind, size, content hash;
- EPIC-082 secret detection;
- file bytes, supplied by the caller — the framework opens nothing itself.

## 6. Outputs

- `src/providers/contracts/parser.ts`: `ContentParser`, `ParseRequest`,
  `ParseOutput`, `ContentSegment`, `ContentSpan`, `OutlineNode`, `ParseWarning`;
- `detectContent()`: media type, binary verdict, encoding;
- `ParserFramework.parse()`: selection, bounds, isolation, redaction,
  provenance;
- `UNPARSED_REASONS`, the stable set of reasons a file yielded no extraction.

## 7. Dependencies

EPIC-011, EPIC-013, EPIC-022, EPIC-023, EPIC-082.

## 8. Contracts

### One extraction result

A parser returns ordered `ContentSegment`s. Each carries its text, a byte range
into the original content, a line range, and a kind the parser chose. Spans are
into the *original bytes*, not into the extracted text, because evidence has to
be able to point at the file a human will open.

An `OutlineNode` tree is optional and hierarchical, so a context pack can cut on
structure rather than on character count.

### Selection is by capability, then media type

The framework asks the registry for `parser` providers, in registration order,
and takes the first that claims the media type natively. A parser claiming it as
a fallback is used only when no native parser exists. Nothing scores; order is
composition, which is visible at the call site (EPIC-011's rule).

### Every file gets an answer

A file with no parser, one too large, one that is binary, or one whose parser
failed produces a result marked unparsed with a stable reason — never a silent
absence. Governance §6 forbids "no result" and "nothing there" looking the same.

### A parser cannot stop an index

A parser that throws, rejects, or returns a malformed result is reported as a
failure for that file and nothing more. The framework enforces the size bound
before calling a parser and passes the caller's abort signal through.

### Extracted text is redacted before it leaves

Every segment's text passes through EPIC-082 redaction. A parser is not trusted
to do it, and doing it here means a parser added later cannot forget.

### Provenance is part of the result

Every result names the parser and its version. EPIC-031 re-parses when either
changes; without this, a parser fix would never reach files already indexed.

## 9. Acceptance criteria

- **AC-1** A parser declaring a media type natively is selected for it, and
  registration order decides between two that both claim it.
- **AC-2** A fallback claim is used only when no native parser claims the media
  type.
- **AC-3** A file no parser claims yields an unparsed result with reason
  `no-parser`, not an error.
- **AC-4** Content over the size bound is not passed to a parser, and yields
  reason `too-large`.
- **AC-5** Binary content is detected and yields reason `binary` unless a parser
  claims binary input explicitly.
- **AC-6** A parser that throws yields reason `parser-failed`, the failure is
  reported, and other files are unaffected.
- **AC-7** A parser that returns a malformed result — a segment without text, a
  span outside the content — is rejected the same way.
- **AC-8** A credential in file content does not appear in any returned segment,
  and the result says how many were redacted.
- **AC-9** Every result carries the parser id and version, and an unparsed
  result carries the reason instead.
- **AC-10** An aborted signal stops the framework before it calls a parser, and
  is passed to a parser that has already started.
- **AC-11** Media type detection identifies common text formats by extension, and
  a mislabelled binary by its bytes rather than its name.
- **AC-12** Segment byte and line ranges are consistent with the content they
  came from.

## 10. Test requirements

- unit tests for selection: native, fallback, both, neither, and order;
- unit tests for every unparsed reason;
- a throwing parser, a hanging parser under abort, and a parser returning each
  malformed shape;
- credential content proving redaction and the reported count;
- detection tests: extension mapping, a NUL-byte binary named `.txt`, UTF-8 with
  a BOM, and an empty file;
- span consistency checked against the original content;
- an architecture test that the framework imports no concrete parser.

## 11. Security requirements

Parser input is attacker-controlled: a repository can contain any bytes. The
framework enforces the size bound *before* a parser sees the content, so a
decompression or allocation attack cannot start. Extracted text is redacted
before it is returned, at the framework boundary rather than in each parser.
Detection must never execute content, and a media type must never be taken from
inside the file in a way that changes what code runs — the type selects a
parser, and every parser is already trusted, registered code.

## 12. Observability

Every result carries the parser chosen, the media type, the segment count and
the redaction count, or — when nothing was parsed — a reason from a stable set.
The framework writes no log of its own; it returns data its caller logs, so
"how much of this repository is unparsed, and why" is a query rather than an
investigation.

## 13. Performance constraints

Detection reads at most the first 8 KiB. The default size bound is 4 MiB, and a
file over it is not read into a parser at all. The framework adds one pass over
the extracted text for redaction and no other copy of the content.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, exports,
documentation and validation evidence. No concrete parser behaviour is claimed
here.

## 15. Governance alignment

- **§4 Provider-First Architecture** — parsers are providers, selected by
  capability; the framework names none of them.
- **§6 Evidence Before Inference** — an unparsed file says why, and every
  segment can be pointed at.
- **§8 Files Are First-Class** — one extraction model for every format.
- **§12 Security** — bounded input, redacted output, no execution of content.
- **§13 Reliability** — one bad file cannot stop an index.
- **§22 Change Management** — stays within the approved Parser Framework
  capability.
