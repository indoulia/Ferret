# EPIC-097 — Parser Quality Harness · Validation Evidence

**Assessed against:** working tree on top of `f4e0c39`
**Date:** 2026-09-02
**Environment:** Windows 11, real tree-sitter grammars, sixteen files across two corpora.

## The measurement

Ferret's parser quality, measured for the first time. Dataset `1.0.0`, sixteen
labelled files — EPIC-096's eleven, read unmodified, plus five fixtures this
Epic authored.

| metric | value |
| --- | --- |
| files measured | 16 |
| files parsed | 12 |
| files unparsed | 4 (all `.md`, all expected) |
| **symbol precision** | **1.00** |
| **symbol recall** | **0.96** |
| **span validity** | **1.00** |
| **parse disagreements** | **0** |

Per file:

```
src/auth/login.ts            expected=1 found=1 matched=1 spans=1/1
src/auth/session.ts          expected=2 found=2 matched=2 spans=2/2
src/auth/password-reset.ts   expected=1 found=1 matched=1 spans=1/1
src/billing/invoice.ts       expected=2 found=2 matched=2 spans=2/2
src/billing/tax.ts           expected=1 found=1 matched=1 spans=1/1
src/billing/refund.ts        expected=1 found=1 matched=1 spans=1/1
src/reporting/monthly.ts     expected=1 found=1 matched=1 spans=1/1
README.md                    parsed=false  (no parser — expected)
docs/architecture.md         parsed=false  (no parser — expected)
docs/onboarding.md           parsed=false  (no parser — expected)
docs/decisions/0001-…md      parsed=false  (no parser — expected)
nested.ts                    expected=6 found=6 matched=6 spans=6/6
overloads.ts                 expected=2 found=1 matched=1 spans=1/1  missing=[arrow]
broken.ts                    expected=2 found=2 matched=2 spans=2/2
module.py                    expected=3 found=3 matched=3 spans=3/3
helpers.js                   expected=3 found=3 matched=3 spans=3/3
```

## The first run scored 1.00 on everything, and that was the finding

Over EPIC-096's eleven files alone: precision 1.00, recall 1.00, span validity
1.00. A true statement about eleven small, well-formed TypeScript files, and
nothing at all about the parser.

Governance §19 says in as many words that *"'Perfect' parsing … is not an
acceptable quality claim without measurable validation"*. A harness whose corpus
cannot fail is the shape of exactly that claim. So five fixtures were added
before any figure was recorded: nested scopes and a namespace, overload
signatures and an arrow function, a file with a syntax error between two
declarations, and a Python and a JavaScript module.

The score moved on the first run over them. That is the difference between a
harness and a formality.

## The defect it found

**An arrow function assigned to a `const` produces no symbol.** `export const
arrow = (a: number): number => a + 1;` is absent from the outline entirely —
confirmed directly against the parser, not inferred from the score:

```json
[{"title":"format","kind":"function"}]
```

`format`, declared three times as overloads, is there. `arrow` is not.

Not an edge case: `const x = () => {}` is the dominant way functions are written
in modern TypeScript and JavaScript. Every React component, most handlers, most
utility modules. Ferret's symbol index misses all of them, which is upstream of
EPIC-098's retrieval figures.

Filed as **#106** against EPIC-025 or EPIC-034, and deliberately not fixed here:
a harness that repaired what it measured would make its own numbers
unreproducible.

## Two observations recorded rather than filed

- **Overloads collapse to one symbol.** Three `format` signatures produce one
  `CodeSymbol`. Arguably correct — `CodeSymbol` carries an `overload` field —
  so it is recorded and the label expects the name once, rather than being
  claimed as a defect on a judgement call.
- **Error recovery works.** `broken.ts` has a syntax error between two
  functions and both are still extracted, with valid spans. Worth stating
  because it is the behaviour most people assume a parser lacks.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 every labelled file measured | MET | 16 of 16, reported |
| AC-2 precision and recall, with per-file detail | MET | table above; `missing` and `unexpected` named per file |
| AC-3 the dataset carries a checksum every figure cites | MET | SHA-256 over the labels, line-endings normalised; asserted present in the report |
| AC-4 parse agreement is zero | MET | asserted; four `.md` unparsed as labelled, twelve claimed as labelled |
| AC-5 span validity is 1 | MET | asserted; 20 of 20 spans contain the symbol they name |
| AC-6 no `NaN`, every ratio in 0..1 | MET | asserted over the aggregate |
| AC-7 the corpus can fail | MET | it did — recall 0.96 |
| AC-8 no precision or recall floor asserted | MET | printed and recorded only |
| AC-9 EPIC-096's dataset unmodified | MET | its checksum covers corpus + `history.json` + `labels.json`; none was touched, and its recorded `cbcb9d98…6790` is unchanged |

## Verification

`npm run test:unit` 1 546 passed; `npm run test:security` 74 passed;
`npm run verify` green. New: `datasets/parsing/`, `src/evaluation/parsing.ts`,
`tests/integration/evaluation/parsing-quality.test.ts` (6 checks).

## Raised, not absorbed

- **Sixteen files is a floor, not coverage.** Enough to make the number move,
  nowhere near enough to characterise a parser across three languages. Stated
  plainly so 0.96 is not read as "the parser is 96% correct" — it is "the parser
  found 24 of the 25 symbols this small set expects".
- **Recall will fall when the corpus grows**, and that is the harness working.
  Nothing here should be tuned to keep the number high.
- **The measurement has no production caller.** It runs in the test suite, which
  is the right place for now — but EPIC-094 found `EvidenceStore.verify` correct,
  tested and reachable from nothing, and this has the same shape. Recorded.
- **Kind is labelled but not asserted.** The expectation carries a `kind` and the
  harness matches on name and qualified name only. Comparing kinds means
  agreeing a mapping between tree-sitter's vocabulary and Ferret's, which is
  EPIC-033's, and disagreeing with it here would report a mapping opinion as a
  parser defect.
