# EPIC-130 — Retrieval Quality: validation evidence

**Status: VALIDATED** · four records saying one thing now return **one** hit
with the other three named. Measured on Ferret's own index, before and after.
**No migration. The golden dataset's metrics are unchanged.**

## Environment

| | |
| --- | --- |
| Tree | `31e392c` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | `ferret-dogfood`, PostgreSQL 17 + pgvector |
| Date | 2026-09-06 |

## The measurement, before and after

One question — *"macOS runner linux container"* — against the four real wordings
of one constraint this repository holds across `EPIC-105`, `EPIC-115`, the
roadmap and an agent memory file.

| | Before | After |
| --- | --- | --- |
| durable context hits | **4** | **1** |
| distinct statements among them | 2 | 1 |
| near-duplicates of a higher-ranked hit | **2** | **0** |
| folded and reported (`subsumed`) | **0** | **3** |
| relate edges the merger had recorded | 5 | 5 |

The edges were there the whole time. Four of ten result slots went to two
statements because nothing read them.

## The golden dataset is unchanged

This is the assertion that says nothing was traded:

```
{"measured":6,"meanPrecisionAtK":0.3611,"meanRecall":0.9167,
 "meanReciprocalRank":0.6806,"meanNdcg":0.7313,"falsePositives":0}
```

Identical before and after. The fold reaches durable context and nothing else —
no per-kind weight was added, no ranking constant changed, and files, commits
and symbols rank exactly as they did.

## What the fold refuses

| Case | Behaviour |
| --- | --- |
| Two statements that genuinely differ | both returned, `subsumed` empty |
| A contradiction | **both returned** — folding one would pick a winner Ferret has said it cannot pick |
| A current record against a better-matching retired restatement | the **current** one survives, the retired one is folded and named |
| A hit in no cluster | its own answer |

The third is the one worth dwelling on. The retired wording scored higher; the
survivor is chosen by the ordering the answer is sorted by, and standing leads
that ordering, so the live record wins. Choosing by score would have returned
the retired one.

## A defect found by running it

The first implementation returned **zero** durable context hits instead of one.

`foldEquivalents` chose the survivor and folded in a single pass, and spliced a
folded group out of the survivor list by index. A group that had never been
pushed returned `-1` from `indexOf`, and `splice(-1, 1)` removes the *last*
element — so each fold deleted an unrelated survivor. On the real index that
removed every durable context hit from the answer rather than the duplicates.

Rewritten as two passes: choose each cluster's survivor, then fold. The mistake
is not expressible in that shape. Caught by the measurement rather than the
suite, because the unit fixtures were too small to have an unrelated survivor to
lose.

## A security control objected, and was strengthened rather than relaxed

`tests/security/retrieval-scope.test.ts` asserts that authorization runs before
ranking — *"the order of two calls is a security property: filter, then rank"* —
by finding `visibleEntities(candidates` before `rank(permitted` in the source.
Clustering inserted a step between them and the assertion failed, because the
ranker was now handed a differently-named value.

**That is the control working.** A step inserted there is exactly what it exists
to notice.

It was not widened to `rank(` to accept the new name — that would let the ranker
be handed anything, which is the property being protected. It now asserts the
whole chain in order:

```
visibleEntities(candidates)  →  #equivalenceOf(permitted)
                             →  const clustered = permitted.map
                             →  rank(clustered)
```

So a cluster cannot be formed through a row the caller may not see, and a
withheld hit cannot reach one of the `limit` places by being folded into a
visible one.

**Proven against the unsafe shape.** Rewriting the two lines to cluster from
`candidates` — the pool *before* the permission filter — makes the control fail:

```
× filters, then clusters what survived, then ranks
```

## Boundedness

The equivalence query reads edges **between the ids already retrieved** — one
query over the page, never over the corpus. Two consequences:

- Cost does not grow with what Ferret holds.
- Transitive closure is bounded by the page, so a long chain of drifting
  statements cannot be collapsed across a corpus; only within one answer.

Clusters are formed **after** the permission filter, so a cluster can never be
formed through a record the caller may not see.

## Suites

| Suite | Result |
| --- | --- |
| `tests/unit/retrieval-rank.test.ts` | 25 passed |
| `tests/integration/retrieval/context-duplicates.test.ts` | 4 passed |
| `tests/integration/evaluation/golden-dataset.test.ts` | 15 passed, metrics unchanged |
| `tests/integration/retrieval/*` | 167 passed |
| `tests/security/*` | 153 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
