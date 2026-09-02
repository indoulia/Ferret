# EPIC-097 — Parser Quality Harness

**Status: APPROVED | Priority: P0 | Domain: Evaluation & Quality**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> The sibling of EPIC-098, which did this for retrieval; the shape is
> deliberately the same so the two measurements can be read together.

## 1. Objective

Measure what Ferret's parser actually extracts, against an authored
expectation, so "parsing works" is a number.

## 2. Problem

Governance §19 names parsing and retrieval in one sentence:

> Golden datasets must be used to measure retrieval precision, recall, ranking,
> evidence correctness, and completeness. **"Perfect" parsing** or retrieval is
> not an acceptable quality claim without measurable validation.

Retrieval got its number in EPIC-098 — precision@10 0.32, and the gap that
explained it. Parsing has none. `tests/unit/code-parser.test.ts` asserts that
specific constructs parse, which is a set of examples somebody chose; nothing
scores the parser over a corpus, and nothing would notice a language quietly
losing a declaration form.

**A parser gap is not a parser-shaped problem.** Symbols are what
`ferret_find` searches and what EPIC-034 indexes, so a declaration the parser
does not see is a declaration retrieval cannot return. The 0.32 above is
downstream of this.

## 3. Scope

1. **An authored expectation** — per file, the symbols a correct parser should
   extract, written from the source rather than from what Ferret produces.
2. **A harness** that runs the parser over the corpus and scores symbol
   precision, symbol recall, span validity and parse agreement.
3. **Fixtures that can fail.** EPIC-096's golden corpus is eleven small,
   well-formed files; a first run over it alone scores 1.00 on everything, which
   measures the corpus. This Epic adds nested scopes, overloads, a syntax error,
   and a second and third language.
4. **Gate only on what the data supports**, and print the rest.

## 4. Non-scope

- **Changing the parser, or fixing what the harness finds.** A finding is filed
  against EPIC-025 or EPIC-034. A harness that repaired what it measured would
  make its own numbers unreproducible.
- **Modifying EPIC-096's golden corpus.** It is read, so a parsing figure and a
  retrieval figure describe the same files. New fixtures live in this Epic's own
  directory.
- **Grammar or language coverage decisions** — EPIC-025. This measures the
  languages Ferret claims, and does not argue for more.
- **Non-code parsers** — EPIC-026 to EPIC-029.
- **Ranking, retrieval or embedding quality** — EPIC-098, EPIC-054.
- **A performance budget for parsing** — EPIC-101.
- **Shipping the fixtures in the package.** The golden corpus ships because a
  provider author's conformance run needs it; these are Ferret's own
  measurement.

## 5. Inputs

`ParserFramework`, `buildCodeSymbols` and `CodeSymbol` (EPIC-024, EPIC-033,
EPIC-034); EPIC-096's corpus, read-only; EPIC-098's harness for the shape.

## 6. Outputs

- `datasets/parsing/` — labels and this Epic's fixtures.
- `loadParsingDataset`, `measureParsingQuality`, and a report.
- An integration test that prints every figure and gates on two.

## 7. Dependencies

EPIC-024, EPIC-025, EPIC-033, EPIC-034, EPIC-096 — all VALIDATED or
IMPLEMENTED. Nothing here changes an acceptance criterion of any of them.

## 8. Contracts

### The expectation is authored from the source, never from the output

The discipline EPIC-098 stated and kept: *"a label rewritten to expect what
already scores well is a label shaped by the answer."* A label here says what a
correct parser should extract, read from the file. If Ferret disagrees, the
score falls and the finding is filed.

### A corpus that cannot fail is not a corpus

Measured: over EPIC-096's eleven files the parser scores 1.00 on precision,
recall and span validity. That is a true statement about eleven small
well-formed TypeScript files and says nothing about the parser. Fixtures exist
to make the number capable of moving.

### Span validity needs no label, and is therefore the threshold

A reported span either contains the symbol it names or it does not, and the
file is the authority. It is a correctness invariant rather than a quality
target, which is why it is gated at 1 while precision and recall are printed.

### Parse agreement is a fact, not an opinion

The label says which files a parser should claim. A `.md` claimed by the code
parser, or a `.py` silently unparsed, is a product fact and is gated at zero.

## 9. Acceptance criteria

- **AC-1** Every labelled file is measured, and the report says how many.
- **AC-2** Symbol precision and recall are computed and reported, with missing
  and unexpected symbols named per file.
- **AC-3** The dataset carries a checksum, and every figure cites it.
- **AC-4** Parse agreement is zero: no file is claimed that should not be, and
  none is unparsed that should be.
- **AC-5** Span validity is 1: every reported span contains the symbol it names.
- **AC-6** No aggregate is `NaN`, and every ratio is within 0..1.
- **AC-7** The corpus can fail — it includes at least one construct, one
  malformed file and one additional language beyond the golden corpus.
- **AC-8** No precision or recall floor is asserted. The figures are printed and
  recorded; freezing the first run as a requirement is the mistake EPIC-098
  named.
- **AC-9** EPIC-096's dataset is unmodified — its checksum is unchanged.

## 10. Test requirements

One integration test, running the real parser with real grammars over both
corpora. Every figure printed; AC-4, AC-5 and AC-6 asserted. A dataset test that
the labels cover every file and expect at least one symbol from every file they
say has a parser.

## 11. Security requirements

The harness reads fixtures this repository authored and runs the parser over
them. It adds no credential and no network call. Fixture content is Ferret's
own, so EPIC-084's containment is not in play — but the fixtures must contain no
credential-shaped string, which the packaging scan already enforces over the
tree.

## 12. Observability

Every figure printed per file and in aggregate, with missing and unexpected
symbols named. A score with no per-file detail tells nobody what to fix.

## 13. Performance constraints

Grammars load once per process and are cached. The harness parses sixteen small
files and must not add materially to the suite.

## 14. Definition of Done

Acceptance criteria satisfied with evidence; `npm run verify` green; a
validation document carrying the figures; the registry updated; anything the
harness finds filed against its owning Epic.

## 15. Governance alignment

§19 (the sentence this Epic exists for), §6 (a printed figure over an asserted
one), §13 and §22 (measurable validation before a quality claim).

## 16. Raised, not absorbed

- **The harness will find defects and must not fix them.** It already has; see
  the validation record.
- **The fixture set is small.** Sixteen files is enough to make the number move
  and nowhere near enough to characterise a parser. Recorded as a floor rather
  than presented as coverage.
- **Overloads collapse to one symbol.** Three `format` signatures produce one
  `CodeSymbol`. Arguably correct — `CodeSymbol` carries an `overload` field —
  so it is recorded rather than labelled a defect, and the label expects the
  name once.
