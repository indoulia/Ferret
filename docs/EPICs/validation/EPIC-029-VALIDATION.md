# EPIC-029 — Text & Markdown Intelligence · Validation Evidence

**Assessed against:** working tree on top of `4fe9fbb`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, Ferret's own 619-file
repository for the measurement.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-029 — Text & Markdown Intelligence — P1" — and from
> the four Epics that deferred non-code parsing to EPIC-026 through EPIC-029.

## The measurement

Indexing Ferret's own repository, before and after:

| | parsed | unparsed | `no-parser` |
| --- | --- | --- | --- |
| before | 367 | 244 | 243 |
| **after** | **572** | **47** | **46** |

**205 more files parsed**, and `no-parser` fell from 243 to 46. What remains has
no Epic and §16 says so: 26 JSON, 17 SQL, 2 SVG, 1 YAML, and one `.wasm` that is
correctly `binary`. The three `.txt` files are now claimed by the fallback, which
is how 49 candidates become 46 refusals.

EPIC-097's harness, from the other side:

```
before  {"filesMeasured":16,"filesParsed":12,"filesUnparsed":4,...,"parseDisagreements":4}
after   {"filesMeasured":16,"filesParsed":16,"filesUnparsed":0,...,"parseDisagreements":0}
```

`symbolPrecision` 1, `symbolRecall` 0.96 and `spanValidity` 1 are **unchanged**,
so nothing about code parsing moved.

## The defect §8.4 prevented, measured

`runContentStage` built code symbols from **every** outline, and
`codeSymbolKindOf` maps an unrecognised kind to `CodeSymbolKind.UNKNOWN` rather
than refusing. So a Markdown outline would have become `code_symbol` entities —
a heading indexed as a declaration.

On the real repository, after the change:

```
symbols_from_markdown |  0
total_symbols         |  2055
```

**Zero.** Without `outlineKind` that would have been every heading in 206 files
of Epic specifications and validation records, filling EPIC-034's symbol index
with prose. The contract's default is the safe one: *absent means no code
symbols*, because a parser that has not said its outline is a symbol table has
not said it.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 ATX heading → segment and outline node | **MET** | `tests/unit/markdown-parser.test.ts` "reads an ATX heading…", plus the trailing-hash case |
| AC-2 setext heading, level by underline | **MET** | "reads a setext heading, level 1 for = and 2 for -", proved through a document that mixes both so the level shows in the nesting |
| AC-3 nesting, and a skipped level | **MET** | "nests by level" and "nests a skipped level under the nearest shallower heading" — real documents skip levels |
| AC-4 fence → `CODE` with its info string | **MET** | "reads a fence as code and records its info string"; the tilde form too |
| AC-5 no heading inside a fence | **MET** | "never reads a heading inside a fence" — a `#` in a shell sample is a comment in someone else's language |
| AC-6 unterminated fence ends at the file, reported | **MET** | "ends an unterminated fence at the file and says so" — with a warning, so a malformed document is diagnosable rather than mysteriously short |
| AC-7 table → one `TABLE` segment | **MET** | "reads a table as one segment"; a paragraph containing a pipe is not one |
| AC-8 front matter only at the start | **MET** | three tests: at the start it is `METADATA`, further down it is not, unterminated it is not |
| AC-9 prose in runs | **MET** | "groups a paragraph into one segment"; whitespace produces none |
| AC-10 spans name their own bytes | **MET** | "keeps every span inside the text, ordered, and naming its own bytes" decodes each span and compares it to the segment text; a second test proves it after a multi-byte em dash |
| AC-11 `outlineKind` set by both parsers | **MET** | the text parser sets `document`, the code parser `code`; the fakes in two suites had to say so too, which is the contract working |
| AC-12 a document creates no `code_symbol` | **MET** | integration "creates no code symbol for a document", **and 0 on the real repository**; a companion test proves code in the same run still does, so the first cannot pass by symbols being broken |
| AC-13 plain text as `FALLBACK` | **MET** | `supports` returns `FALLBACK` for `text/plain`; EPIC-099's conformance suite runs against the provider |
| AC-14 degenerate documents | **MET** | four tests: empty, one heading, only front matter, and the segment bound |
| AC-15 harness agrees with the labels | **MET** | `parseDisagreements: 0`, `README.md parsed=true` |
| AC-16 retrieval does not regress | **MET** | p@10 **0.3611**, recall **0.9167**, MRR **0.6806**, nDCG **0.7313**, `falsePositives` 0 — identical to EPIC-056/057's figures |
| AC-17 the 206 files are parsed | **MET** | measured above: 205 more files parsed, `no-parser` 243 → 46 |

Seventeen of seventeen MET.

## Three tests changed, and no acceptance criterion did

Each was a fact about the product changing, and each is worth naming because a
reader should be able to tell that from a criterion being relaxed.

- **`datasets/parsing/labels.json`** recorded `"unparsedReason": "no-parser"` for
  four Markdown files. A parser now claims them, so the label says
  `language: "markdown"` with `expected: []` — no symbols, because §8.4 makes a
  heading not one. EPIC-097's harness gates `parseDisagreements` on zero
  precisely so this cannot drift silently; the gate did its job.
- **EPIC-097's "at least one symbol from every file it says has a parser"** was
  true when every parser was a code parser. A document parser makes it false by
  design, so it now excludes Markdown — the narrowest change that keeps the
  assertion meaningful for the files it was written about.
- **EPIC-099's conformance gate refused the build** until the new provider was
  added to its runnable list. That is the gate working exactly as intended: a
  provider cannot reach `main` without facing the conformance suite. It passes.
- **Two content-stage suites** had fake code parsers returning an outline with no
  `outlineKind`, so they stopped producing symbols. Fixed by having the fakes say
  `code` — which is what the real parser does, and the contract's default
  refusing was the point.

## Tests

- **Unit** — `tests/unit/markdown-parser.test.ts`, 24 tests.
- **Integration** — `content-indexing.test.ts`, 4 tests including AC-12 and its
  companion; `parser-composition.test.ts` updated for two providers.
- **Quality** — EPIC-097's harness (AC-15) and EPIC-098's (AC-16).
- **Conformance** — EPIC-099's suite, against the new provider.
- **Regression** — `npm run verify` green: 132 files, 2810 passed, 3 skipped.

## Limitations, recorded

- **No inline parsing.** A Markdown link's target is text rather than a
  reference. Resolving `[a](./b.md)` to the `file` entity for `b.md` is a
  document link graph — EPIC-035's shape over a different edge type — with no
  owner, and it is the most valuable next increment here.
- **JSON, YAML and SQL have no Epic.** 26 + 17 + 1 files on Ferret's own
  repository. `.mjs` is different: 19 files that *are* JavaScript, which
  EPIC-025's grammar table simply does not list the extension for — a one-line
  fix in that Epic rather than a parser in this one.
- **Front matter is not interpreted.** A `METADATA` segment, and what its keys
  mean is a per-project convention no Epic defines. Nothing reads it as policy,
  which is Governance §12.
- **Plain-text spans are approximate at paragraph boundaries.** The blank line
  between paragraphs is counted as one byte rather than measured. Spans stay
  monotonic and inside the file; exact offsets for a format with no structure
  would be precision nobody reads. Markdown spans are exact, and AC-10 asserts
  it byte for byte.
- **The 206 figure is Ferret's own repository**, a measurement rather than a
  claim about repositories in general.
