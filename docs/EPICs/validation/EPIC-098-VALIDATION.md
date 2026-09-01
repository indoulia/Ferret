# EPIC-098 — Retrieval Quality Harness · Validation Evidence

**Assessed against:** working tree on top of `594d858`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, the golden corpus indexed end to end.

## The measurement

Ferret's retrieval quality, measured for the first time. Dataset `1.0.0`,
checksum `cbcb9d98…6790`, 8 labelled queries over 11 corpus files, k = 10.

| metric | value |
| --- | --- |
| mean precision@10 | **0.32** |
| mean recall | **0.75** |
| mean reciprocal rank | **0.56** |
| mean nDCG@10 | **0.61** |
| false positives on absence labels | **0** |

Per query:

| label | returned | p@10 | recall | RR | nDCG |
| --- | --- | --- | --- | --- | --- |
| `exact-invoice-path` | 2 | 0.50 | 1.00 | 1.00 | 1.00 |
| `exact-login-path` | 2 | 0.50 | 1.00 | 1.00 | 1.00 |
| `text-invoice` | 4 | 0.25 | 0.50 | 0.33 | 0.41 |
| `text-authentication` | 1 | 0.00 | 0.00 | 0.00 | 0.00 |
| `text-refund` | 3 | 0.33 | 1.00 | 0.50 | 0.63 |
| `text-onboarding` | 3 | 0.33 | 1.00 | 0.50 | 0.63 |
| `absent-kubernetes` | 0 | — | — | — | — |
| `absent-graphql` | 0 | — | — | — | — |

Before this Epic, the honest statement about Ferret's retrieval was that nobody
knew. That statement is now a number.

## Why `text-authentication` scored zero

Not ranking. **Measured**, by recording which entity kinds each text query
reaches:

```
text-invoice        "invoice"      reached: commit, commit, file, file_version
text-authentication "authenticate" reached: commit
text-refund         "refund"       reached: commit, file, file_version
text-onboarding     "onboarding"   reached: commit, file, file_version
absent-kubernetes   "kubernetes"   reached: (nothing)
```

`authenticate` appears in a commit message and in no file path. Ferret does not
index file *bodies* — that is EPIC-087 — so text retrieval has no route from a
term in a commit message to the file that commit touched. The label expects the
file; retrieval can only offer the commit. `text-invoice` loses half its recall
the same way: `invoice.ts` matches on path, `tax.ts` does not.

**The labels were not adjusted to suit the result.** A label rewritten to expect
what already scores well is a label shaped by the answer, and a golden dataset
does not survive that. The low precision is a missing capability, measured.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 metrics pure and correct | MET | `retrieval-quality.test.ts` — every expected value hand-computed in the comment beside it, including the nDCG arithmetic |
| AC-2 nDCG uses graded relevance | MET | *"falls when the same answers are ranked worse"*: same set, reversed order, 1.00 → 0.797, while precision is identical for both |
| AC-3 no metric reads a score | MET | The stub returns `score: 0` for every hit and the figures are still correct; `src/retrieval/query.ts:150` records why |
| AC-4 per-query and aggregate report | MET | 8 queries measured against real PostgreSQL, table above |
| AC-5 absence counted, not scored | MET | *"counts a false positive when an absence label returns something"*; absence labels carry `undefined` for every scored metric |
| AC-6 report cites the dataset | MET | `report.dataset.checksum` asserted equal to the loaded dataset's |
| AC-7 real store, real PostgreSQL | MET | `tests/integration/evaluation/golden-dataset.test.ts`, over the indexed corpus |
| AC-8 no writes, no storage import | MET | `MeasurableRetrieval` is a two-method port `RetrievalStore` satisfies structurally; `quality.ts` imports only `retrieval/` and `./dataset.js` |
| AC-9 a figure is recorded | MET | This document |
| AC-10 the harness can report failure | MET | *"scores zero across the board when retrieval returns nothing"* — recall, RR and nDCG all 0 |
| AC-11 never NaN | MET | Unit cases for empty expectations and empty results; the integration suite scans every reported number |

## The threshold, decided with data

EPIC-096 §4 deferred this here on the grounds that "the first measurement is what
makes a threshold arguable". The decision, recorded in EPIC-098 §16 and
implemented in the integration suite:

**Gate the absence count at zero. Gate nothing else yet.** A result returned for a
term that appears nowhere in the corpus is a defect under any floor anyone would
later choose. The four scored means are not gated: 8 labels over 11 files is too
small a sample to become a requirement, and one figure is depressed by a missing
capability rather than by ranking. Freezing 0.32 as a floor would enshrine a
number nobody argued for — the exact failure EPIC-096 refused in advance.

A real threshold becomes arguable when file content is indexed (EPIC-087) and the
corpus is large enough for a figure to move meaningfully.

## One EPIC-096 test re-aimed

`golden-dataset.test.ts` asserted that the `evaluation` **barrel** exported
exactly three functions, as EPIC-096 AC-12 ("the dataset computes no metric").
Adding this harness alongside it broke that assertion — so a barrel-level test
would have made the intended next Epic a build failure.

Re-aimed at `src/evaluation/dataset.ts` itself, which still exports exactly those
three, plus a new assertion that the dataset imports neither `quality.js` nor
`metrics.js`. That is what AC-12 was protecting: the harness reads the dataset and
the dataset must never read the harness, because a cycle would let a label be
shaped by what scored well. EPIC-096's own validation record is left unedited — it
was true when written.

## What is not demonstrated

- **Parser, provider and security quality** — EPIC-097, 099 and 100. Each owns a
  harness over the same dataset; none exists yet.
- **Ranking is measured, not improved.** EPIC-056/057 are P1 and untouched.
  Measuring and fixing in one change would make the measurement unfalsifiable.
- **The figures are for this corpus.** 11 files and 8 labels. They are a baseline
  to move, not a characterisation of Ferret at scale.
- **Semantic retrieval is unmeasured** — no embedding provider ships, so the
  dataset carries no semantic labels.

## Run

`npm run verify` green: 103 files, 2272 passed, 3 skipped. Suites bearing on this
Epic: `retrieval-quality.test.ts` (22 unit, no database) and the EPIC-098 blocks
of `tests/integration/evaluation/golden-dataset.test.ts` (real PostgreSQL).
