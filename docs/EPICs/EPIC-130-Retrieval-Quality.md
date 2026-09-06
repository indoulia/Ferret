# EPIC-130 — Retrieval Quality

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

A question about durable context returns the smallest useful set of current
records, with everything it collapsed named rather than hidden.

## Problem, measured before anything changed

On Ferret's own index, one question — *"macOS runner linux container"* —
returned **four** durable context records saying **two** things:

```
of which durable context                          4
near-duplicates of a higher-ranked hit            2
distinct statements among them                    2
ranking already folded (subsumed)                 0
relate edges the merger recorded                  5
```

The merger had already decided these were restatements of one another and had
written five `context_relates_to_context` edges saying so. Retrieval never read
them. Four of ten result slots went to two statements, and the knowledge needed
to fix it was in the graph, unused — the same shape as EPIC-124's finding that
`proposeResolutions` and `externalIds` were *"built twice and joined neither
time"*.

## Design

**The fold already existed; it needed a second kind of equivalence.**
`rank` (EPIC-056) folds a *part* into its *whole* — a symbol into the file that
declares it — and reports every folded id in `subsumed`. EPIC-130 adds folding a
*restatement* into the record a reader should get, through the same mechanism.

**Equivalence is supplied, never inferred by ranking.** `RankSignals` gains an
optional `equivalenceKey`. A ranking that re-derived which statements are the
same would be a second opinion with no evidence behind it — ranking cannot read
the graph. `RetrievalStore` computes the keys from the edges the merger already
wrote.

**The survivor is chosen by the ordering the answer is sorted by**, not by
score. Standing leads that ordering, so a current record always survives a
better-matching retired restatement. Picking by score alone would return the
retired wording.

**A contradiction is emphatically not an equivalence.** Only
`context_relates_to_context` forms a cluster. Two records that disagree are two
answers, and folding one into the other would be Ferret picking a winner it has
already said it cannot pick.

**Bounded.** The edges are read *between the ids already retrieved* — one query
over the page, never over the corpus — so the cost does not grow with what
Ferret holds. Transitive closure is therefore also bounded by the page: a long
drift chain cannot form across a corpus, only within one answer.

## Scope

- `RankSignals.equivalenceKey`, and the fold in `rank`.
- `RetrievalStore` supplying keys from `context_relates_to_context`.
- Nothing else about ranking. No per-kind weights, no tuning, no change to how
  files, commits or symbols rank.

## Non-scope

- Filtering non-current context out of search. Standing already ranks it below
  live results, and removing it would destroy the access to history the Epic
  requires be preserved.
- Assembling a task package — EPIC-131.
- Re-tuning the golden dataset. Its metrics are unchanged by this Epic, which is
  the point: nothing here trades general relevance for a durable-context win.

## Acceptance criteria

- **AC-1** Four records saying one thing return one hit.
- **AC-2** Every folded id is reported, so nothing is hidden.
- **AC-3** Two statements that genuinely differ both return.
- **AC-4** A current record survives a better-matching retired restatement.
- **AC-5** A contradiction is never folded.
- **AC-6** A hit with no cluster is its own answer.
- **AC-7** A folded restatement's relevance is credited to the survivor.
- **AC-8** The golden dataset's measured metrics are unchanged.

## Test requirements

`tests/unit/retrieval-rank.test.ts` — 6 cases over the pure fold.
`tests/integration/retrieval/context-duplicates.test.ts` — 4 cases against real
PostgreSQL, where the edges are what carry the equivalence.
`tests/integration/evaluation/golden-dataset.test.ts` — unchanged, and asserted
to stay so.

## Security requirements

Clusters are formed **after** the permission filter, so a cluster can never be
formed through a record the caller may not see, and a hit is never folded into
one that was withheld. The fold moves relevance, never text: a folded hit's
highlight is not shown, which keeps this a ranking decision rather than a
disclosure.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; the before and
after measured on Ferret's own index in `validation/EPIC-130-VALIDATION.md`.
