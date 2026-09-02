# EPIC-026 — PDF Intelligence

**Status: VALIDATED | Priority: P1 | Domain: Content Understanding**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Content Understanding.

## 1. Objective

Read the text, the structure and the document properties out of a PDF — and
say so, out loud, when there is no text to read.

## 2. Value

A PDF is where an organisation's decisions go to be forgotten. Specifications,
contracts, architecture reviews and vendor evaluations are checked into
repositories as PDFs, and today `detect.ts` recognises `application/pdf`, no
parser claims it, and EPIC-024 records `no-parser` — an honest refusal that
leaves the content invisible to search, to context packs and to evidence.

The technology decision is already made and is not this Epic's to revisit:

> **TECHNOLOGY-DECISIONS §4** — "PDF | `pdfjs-dist` 6.3.289 (Apache-2.0) |
> `pdf-parse` (unmaintained) | Mozilla-maintained, published 2026-08-29;
> 2.7× faster than pypdf", with a **mandatory** security condition.

Three places in the codebase already name this Epic's shape without having it:

- **`providers/contracts/parser.ts`, on `ContentSpan`** — "a span into a PDF's
  extracted text names a position in a string nobody can see."
- **`domain/evidence.ts`** — "a page in a PDF" as a locator kind.
- **`COMPATIBILITY.md` §7** — `ferret.parser.pdf` named as a producer whose
  identity must be recorded.

## 3. Scope

- **`ferret.parser.pdf`** — a parser provider claiming `application/pdf`
  natively, in `src/parsers/pdf/`.
- **One segment per page** carrying that page's text in reading order.
- **The document's own outline** — its bookmarks — resolved to page numbers.
- **Document properties** as a `metadata` segment and as attributes.
- **`producerIdentity()`** naming the `pdfjs` build, so EPIC-031 re-extracts
  when the library moves and EPIC-008's derived artefacts stay attributable.
- **The mandatory security configuration**, as a test rather than a comment.
- **Three refusals**: encrypted, malformed, and no text layer.
- **A span unit**, because a PDF has pages where the contract has lines.

## 4. Non-scope

- **OCR.** A scanned PDF is an image, and reading it needs a model, a licence
  decision and a confidence contract none of which exist. §8.4 reports the
  absence instead, which is the honest half and the half that is free.
- **Layout reconstruction.** Columns, headers and footers are visual facts, and
  recovering reading order across them is inference this Epic does not make. The
  order is the order `pdfjs` reports.
- **Tables.** A PDF has no table structure — only text at coordinates. Emitting
  `SegmentKind.TABLE` from aligned whitespace would be a claim about content of
  exactly the kind EPIC-029 §8.3 refused for `.txt`.
- **Forms and annotations.** XFA is disabled by §8.3, and an annotation is a
  layer over the document rather than the document.
- **Images and figures.** Extracting them is a binary-blob store, and nothing
  downstream consumes one.
- **Rendering.** Ferret never rasterises a page: a canvas dependency is exactly
  the native artefact TECHNOLOGY-DECISIONS §4 selected WASM to avoid.

## 5. Inputs

`ParseRequest` — the PDF's bytes. `request.text` is absent, because a PDF is
binary and `detect.ts` says so.

## 6. Outputs

`src/parsers/pdf/`, exported from `@indoulia/ferret/parsers`, and one additive
field on the parser contract (§8.1).

## 7. Dependencies

EPIC-024 (the framework, the contract and `validate`), EPIC-023 (detection),
EPIC-029 (the precedent for declaring what a field means rather than letting a
consumer assume), EPIC-008 (producer identity on a derived artefact).

## 8. Contracts

### 8.1 A page is not a line, and the parser says which it is

`ContentSpan` has `startLine` and `endLine` because every parser before this one
read a text file. A PDF has pages. Three ways out were available and two are
wrong:

- **Report line numbers within the extracted text.** They index a string that
  exists only inside Ferret, so an evidence quote would point at a position no
  human can open. The contract comment already refuses this in as many words.
- **Report `1` for everything.** Truthful and useless: it discards the one
  locator a PDF actually has, and `evidence.ts` names "a page in a PDF" as a
  first-class locator kind.
- **Declare the unit.** `ParseOutput.spanUnit` — `line` when absent, `page` when
  the parser says so.

The third, because EPIC-029 §8.4 had this exact problem and solved it this exact
way. An outline was being read as a symbol table by a consumer that could not
tell prose from declarations, and the fix was not to change the field but to make
the parser **declare what its field means**. `outlineKind` and `spanUnit` are the
same contract twice: *absent means the old meaning*, so every existing parser
stays correct without being touched, and a consumer that ignores it is wrong in
a way a test can see.

### 8.2 The byte span is the file's, because a page's offset is not knowable here

`pdfjs` does not expose the file offset of a page's content stream, and it could
not usefully: a page's text may be spread over several stream objects, each of
them compressed, and none of them contiguous with the glyphs a reader sees.

So every PDF segment's byte span is the file — `0 … sizeBytes`, which is true —
and the page goes in `startLine`/`endLine` under §8.1's declared unit, which is
the locator that means something. A fabricated byte range would pass `validate()`
while being precisely the "quote of bytes that do not exist" that function was
written to stop.

### 8.3 The security configuration is mandatory and is a test

TECHNOLOGY-DECISIONS §4 requires `isEvalSupported: false` against
**GHSA-hq66-cqwq-w95j** — arbitrary JavaScript execution on opening a malicious
PDF. Ferret indexes untrusted repository content (Governance §12), so the flag
is a requirement rather than a preference, and a requirement that lives only in
a comment is one refactor away from gone.

Five settings, and the parser exports them so a test can assert them:

| Setting | Value | Why |
|---|---|---|
| `isEvalSupported` | `false` | GHSA-hq66-cqwq-w95j. Mandated. |
| `enableXfa` | `false` | XFA is an XML application inside the PDF. |
| `useSystemFonts` | `false` | A repository file must not read host fonts. |
| `disableFontFace` | `true` | Nothing is rendered; §4. |
| `useWorkerFetch` | `false` | No fetch during a parse. |

Font and CMap data are resolved to `file:` URLs inside the installed
`pdfjs-dist`, so extraction of a standard-14 or CJK-encoded document is correct
without the library reaching the network for either.

### 8.4 A PDF with no text layer is reported, not silently empty

This is the most common PDF in a repository: a scan, or an export from a design
tool, with pages and no extractable characters. A parse that returned zero
segments would be indistinguishable from an empty document, and the difference
is the whole answer to "why is this contract not in search results".

So a PDF whose pages yield no characters returns a `no-text-layer` warning and
`hasTextLayer: false`, and the page count still says how many pages were looked
at. That the answer is "this needs OCR, which Ferret does not do" is a better
answer than silence.

### 8.5 An encrypted PDF is declined without an attempt

`pdfjs` raises `PasswordException` before any page is read. The parser reports
`encrypted` and stops. It does not try the empty password twice, does not read a
password from configuration, and does not keep what a partial decrypt leaves
behind. Ferret has no credential store for document passwords, and inventing one
here would be another Epic's decision made quietly.

### 8.6 Bounds belong to the parser

A page cap and a per-document character cap, both the parser's own and both
reported through `truncated` — EPIC-024's contract says a parser's bounds are
its own, and the code parser's `MAX_SEGMENTS` is the precedent. A 4 000-page
scanned appendix must not be able to hold an indexing pass open.

### 8.7 The bytes are copied before `pdfjs` sees them

`pdfjs` **detaches** the `Uint8Array` it is given: after `getDocument`, the
caller's buffer has `byteLength === 0`. `ParseRequest.bytes` is the framework's
buffer, shared with everything else in the content stage, so handing it over
directly would empty a buffer the caller still owns. Measured, not assumed —
§17.

### 8.8 The loading task is always destroyed

`loadingTask.destroy()`, in a `finally`. Not `document.destroy()`, which does not
exist — §17. A long-running `ferret mcp` parses PDFs for the life of the process,
and a leak per document only shows up in the deployment nobody restarts.

### 8.9 The outline is the document's own, and it is a document outline

PDF bookmarks are a real, authored structure, unlike anything a heuristic could
recover — so they are the outline, resolved through `getPageIndex` to the page
each one points at. `OutlineKind.DOCUMENT`, explicitly, for EPIC-029 §8.4's
reason: a bookmark is a section, and `buildCodeSymbols` must never see it.

A destination that does not resolve is dropped with a warning rather than
guessed at, and a document with no bookmarks has an empty outline rather than
one invented from font sizes.

## 9. Acceptance criteria

- **AC-1** The provider claims `application/pdf` as `NATIVE` and claims nothing
  else, without reading content.
- **AC-2** A two-page PDF yields one segment per page, each carrying that page's
  text.
- **AC-3** `spanUnit` is `page`, and each segment's line numbers are its page.
- **AC-4** Every segment's byte span is within the file — `validate()` accepts
  the output.
- **AC-5** Document properties appear as a `metadata` segment and as attributes.
- **AC-6** The document's bookmarks become a `DOCUMENT` outline with page spans.
- **AC-7** A PDF with no text layer reports `no-text-layer` and
  `hasTextLayer: false`, and does not fail.
- **AC-8** An encrypted PDF is declined with `encrypted`, and no page is read.
- **AC-9** Malformed bytes fail as a parse failure with the reason, not a crash.
- **AC-10** `isEvalSupported: false` and the other four §8.3 settings are what
  the parser passes — asserted against the exported configuration.
- **AC-11** `producerIdentity()` names the `pdfjs` version and build, and does
  not parse.
- **AC-12** The caller's `bytes` are not detached by a parse.
- **AC-13** The page cap and the character cap set `truncated`.
- **AC-14** `pdfjs-dist` is reachable from `parsers/index.ts` and from neither
  `index.ts` nor `cli/main.ts` — the EPIC-025 boundary, extended.
- **AC-15** An existing parser that sets no `spanUnit` is unchanged, and the
  framework reads its absence as `line`.
- **AC-16** A parse destroys its loading task, on the failure paths too.

## 10. Test requirements

**Unit** — every acceptance criterion, against PDFs built by a fixture
generator rather than checked-in binaries: a generator is reviewable, and it is
the only way to produce the malformed and encrypted cases deliberately.

**Boundary** — AC-14 in `boundaries.test.ts`.

**Regression** — EPIC-024's framework suite and EPIC-029's parser suite
unchanged, which is what proves AC-15.

## 11. Security requirements

§8.3, as tests. A PDF is the most likely hostile input Ferret will ever read: it
is a container format with an embedded scripting engine, a font engine and a
decompressor. The parse runs with no network, no host fonts, no JS engine and no
XFA, and is bounded in pages and characters.

## 12. Observability

Warnings carry the reason and the page they concern. `hasTextLayer`, `pageCount`
and `encrypted` are attributes, so "how many PDFs in this repository are scans"
is answerable without re-reading any of them.

## 13. Performance constraints

Text extraction only, one pass, page by page, with `page.cleanup()` after each —
`pdfjs` caches per page, and a 4 000-page document that never releases is the
memory profile this avoids.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 with evidence in
`validation/EPIC-026-VALIDATION.md`; `npm run verify` green; the registry
updated; the parser contract's `ContentSpan` comment amended to point at §8.1
rather than at an unsolved problem.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.4: an absent text layer is reported;
  §8.9: an unresolved bookmark is dropped rather than guessed.
- **§12 Untrusted Input** — §8.3, and it is the reason this Epic has a threat
  model at all.
- **§21 Reproducibility** — §8.1 and AC-11: a result is attributable to a
  library build.
- **§5 Reuse Before Reinvent** — §8.1 reuses EPIC-029's answer rather than
  inventing a second way to declare what a field means.

## 16. Raised, not absorbed

- **OCR is unowned.** §4 defers it and no Epic claims it. A scanned PDF is now
  *visible* as a scanned PDF, which is what makes the gap countable, and the
  count is the argument a future Epic will need.
- **Reading order across columns is `pdfjs`'s.** A two-column paper extracts in
  whatever order the content stream holds, which is usually but not always the
  reading order. Fixing it needs coordinate clustering, which is a claim about
  layout this Epic does not make.
- **`spanUnit` has only the two members this Epic needs.** EPIC-028's unit is a
  cell, and naming it here would be specifying an Epic that has not been
  written.
- **No PDF is tested at scale.** The fixtures are small by construction. A
  1 000-page document's memory profile is asserted by `page.cleanup()` and not
  by measurement.

## 17. Recorded during implementation

**`pdfjs` detaches the buffer it is given.** After `getDocument`, the caller's
`Uint8Array` has `byteLength === 0` — the array is transferred, not read.
`ParseRequest.bytes` belongs to the framework's content stage, which still holds
it after a parse returns, so handing it over directly would have emptied a
buffer somebody else owned. Measured with a probe before a line of the parser
was written, which is why §8.7 is a contract rather than a bug report.

**`document.destroy` does not exist.** The obvious cleanup call is on the
*loading task*, not on the document proxy, and calling the wrong one throws a
`TypeError` — inside a `finally`, where it would have replaced whatever error
was already travelling. Also found by probe.

**The properties segment would have been unconditional.** `pdfjs` reports a
`PDFFormatVersion` for every document, so a "Document properties" block would
have appeared on documents that declare no properties at all. The version is a
fact about the container rather than content to retrieve, so it stayed an
attribute and left the segment. Found by the test that asserted the segment was
absent, which is the test that only exists because §8.7's probe made writing
tests first feel worth it.

**The boundary graph records specifiers, not packages.** `boundaries.test.ts`
walks static imports and records what is written, so
`pdfjs-dist/legacy/build/pdf.mjs` was not `pdfjs-dist` and AC-14 failed while
being true. Keeping the raw specifier is right — a subpath policy has to stay
visible — so the gate gained a normaliser for the assertions that ask what would
be *installed*, and the raw set is still there for the ones that ask what is
imported.

**EPIC-099's harness caught the new provider immediately**, exactly as designed:
a provider that nothing runs the conformance suite against is a failing build.
It then caught a second thing, which was that the entry had been added to
`RUNNABLE` while the import had not — a factory that throws is reported as
`contract.registers` failing, so the harness's own catch-all did the work its
comment says it exists to do.

Full evidence in [validation](validation/EPIC-026-VALIDATION.md).
