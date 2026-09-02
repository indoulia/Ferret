# EPIC-057 — Freshness & Authority Ranking · Validation Evidence

**Assessed against:** working tree on top of `d3fd3f7`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, a repository indexed end to end.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-057 — Freshness & Authority Ranking — P1" — and from
> the five Epics that wrote down what they were leaving for it.

## What was actually broken

Nothing in the read path consulted `lifecycle`. EPIC-032 recorded the tombstone
and retrieval ignored it, so a search could answer "where is the retry policy"
with a file removed six months ago, ranked **above** the live one, whenever its
text matched slightly better. Proved against a real index rather than asserted:
marking the best-matching hit `deleted` moves it from first to last, with its
relevance unchanged, while every hit above it is live.

```
before  pool → [live file, …]                          the deleted file ranked 1st
after   pool → [… live hits …, removed file]           same set, same relevances
        why: "ranked below live results: the source reports this as removed"
```

The second half was one source outranking itself. `preferredEvidence` consulted
authority first, so a system's own January observation of a field beat its own
September observation of it — the limitation EPIC-045's validation recorded and
named this Epic for.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 deleted below every active | **MET** | unit "ranks a deleted hit below every live one even when it matches better"; integration "drops a tombstoned hit below every live one, and still returns it" against a real index |
| AC-2 superseded below deleted | **MET** | unit "ranks superseded below deleted…"; integration "ranks a superseded hit below a deleted one" |
| AC-3 unknown between active and deleted | **MET** | unit, same two tests; the band table asserted directly in "orders the four recorded states" |
| AC-4 unrecognised lifecycle is unassessed, no throw | **MET** | unit "treats an unrecognised lifecycle as unassessed and does not throw" — ranks with `unknown`, does not reject |
| AC-5 relevance decides within a band | **MET** | unit "never puts a lower-relevance hit before a higher one" and "does not let authority or recency overturn relevance" |
| AC-6 authority breaks a relevance tie, UNKNOWN unassessed | **MET** | unit "prefers the more authoritative of two equally relevant hits", "treats an absent authority as unassessed, not as weakest" |
| AC-7 recency breaks an authority tie; missing does not precede present | **MET** | unit "orders equally authoritative hits by recency", "does not let a missing timestamp precede a present one" |
| AC-8 total and deterministic | **MET** | unit "ranks a pool identically however it arrives" over a pool mixing all four bands; EPIC-056 AC-2's own test still passes |
| AC-9 the deleted hit is returned, not filtered | **MET** | unit "returns the deleted hit rather than filtering it" and "…alone when it is the only one"; integration asserts the result set is identical in size and membership |
| AC-10 breakdown names standing, `why` only when it moved | **MET** | unit "names the standing on every hit and explains only the ones it moved"; integration "says nothing about standing on a live hit" |
| AC-11 later record from the same system and field wins | **MET** | `tests/unit/source-authority.test.ts` "prefers the later of two records from the same system and field", and "…even when the earlier is more authoritative" |
| AC-12 different systems still decided by authority; ties still `undefined` | **MET** | four tests: different system, different field, missing `observedAt`, genuine tie |
| AC-13 UNKNOWN ordered as unassessed | **MET** | "orders unassessed authority above asserted and below derived", plus the rank's position asserted against the scale |
| AC-14 EPIC-062 unchanged | **MET** | its 23 tests pass against the shared helper, unmodified |
| AC-15 no retrieval-quality regression | **MET** | p@10 **0.3611**, MRR **0.6806**, nDCG **0.7313**, recall **0.9167**, `falsePositives` 0 — identical to EPIC-056's figures, asserted rather than printed |

Fifteen of fifteen MET. No criterion was restated.

## Tests

- **Unit** — `tests/unit/retrieval-freshness.test.ts`, 17 tests: every band, every
  ordering key, the unrecognised lifecycle, totality over a reversed mixed pool,
  the returned-not-filtered invariant, the explanation, and three malformed
  inputs (authority off the scale, an unparseable instant, an absent timestamp).
- **Unit** — `tests/unit/source-authority.test.ts`, 8 tests added for §8.4: the
  supersession rule and its four negatives, and the unassessed rank's position.
- **Integration (real PostgreSQL)** —
  `tests/integration/retrieval/retrieval.test.ts`, 3 tests, each restoring the
  lifecycle it changed so the shared fixture is unaffected.
- **Quality** — AC-15 in `tests/integration/evaluation/golden-dataset.test.ts`.
- **Security** — `tests/security/retrieval-scope.test.ts` extended: the freshness
  module is held to the same standard as the ranker it feeds — no `storage/`, no
  `sql`, no `await`.
- **Regression** — `npm run verify`: 127 files, 2631 passed, 3 skipped.

## Found while implementing

**`preferredEvidence` contradicted the file that documented its own intent.**
`SourceAuthority.UNKNOWN` has said since EPIC-045 that it is "deliberately *not*
the lowest rank in meaning, even though it is the lowest number", and named
`isUnknownAuthority` as how a caller tells the two apart. `preferredEvidence`
sorted on `b.authority - a.authority`, so every source Ferret had not yet
classified ranked **below a model's unverified claim**. EPIC-062 had noticed and
built `effectiveAuthority` for its own ordering; the two never met. That helper
now lives in `domain/authority.ts` beside the scale, and both orderings use it.

**`preferredEvidence` moved file.** It was in `evidence.ts` because evidence is
what it takes; it is now in `authority.ts` because authority is what it decides
with, and EPIC-045 owns that policy. The move was also forced: `authority.ts`
imports `EvidenceMethod` from `evidence.ts`, so importing the shared helper the
other way would have been a module cycle that fails at load rather than at
review. Exported under the same name from `domain/index.ts`; no caller changed.

## Limitations, recorded

- **A tombstone is not in the golden corpus**, so AC-15 is a no-regression check
  and the behavioural claims rest on the integration and unit tests. Adding a
  deleted file to EPIC-096's labelled corpus would measure freshness ranking
  properly; that is EPIC-096's decision.
- **`last_indexed_at` is still not on `CanonicalEntity`.** EPIC-006 §D-007
  separated it from `first_indexed_at` "because it is how staleness is measured
  (EPIC-057)", and it is the better signal for a source Ferret has stopped being
  able to reach. Exposing it changes EPIC-006's canonical envelope, so §16 raised
  it rather than taking it; the ordering does not need it.
- **No decay curve, by contract.** §8.2 is explicit that a file untouched for
  three years is not demoted for its age: age is not evidence that something
  stopped being true. If a corpus is later found where age *is* such evidence,
  that is a measurement to bring to this Epic, not a constant to add quietly.
- **Per-field ownership is still inexpressible.** EPIC-045 recorded that
  `systemOfRecord` is per provider, so §8.4's rule keys on `sourceSystem` and
  `field` together — as tight as the model allows and no tighter.
- **One flaky infrastructure failure, not a regression.**
  `relationship-store.test.ts`'s p95 assertion failed once in a full run with
  `PostgreSQL is not accepting work: Failed query: begin` — a connection refusal
  under 127 parallel test files — and passes in isolation and on re-run. Recorded
  because a green figure quoted from a run that had a red line in it should say
  which line.
