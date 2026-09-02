# EPIC-063 — Query Explanation · Validation Evidence

**Assessed against:** working tree on top of `c5b2bc6`
**Date:** 2026-09-02
**Environment:** real MCP protocol over an in-memory transport; unit coverage
over hand-built plans and hits.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-063 — Query Explanation — P1" — and from the three
> Epics that built the signals and deferred the explaining.

## What was actually broken

Every signal existed and none of it was reachable. `QueryPlan` recorded the
shape, the reason and each strategy's outcome; EPIC-056 and EPIC-057 put
`relevance`, `contributors`, `subsumed`, `standing` and `why` on each hit;
`WithheldReport` counted what permission removed. **`describeHit` emitted none of
the ranking**, so a client got an opaque `score` and no way to ask why one hit
beat another.

Governance §18 requires Ferret to explain why evidence was "included, excluded,
considered authoritative, considered stale, or considered conflicting". Four of
the five were recorded somewhere and none was said.

The sharpest case, and the one the tests are written around: a **tombstoned hit
that matched better** and ranked second. A naive explanation reaches for the key
below — "a weaker text match" — which is false. The explanation names `standing`,
because that is the first ordering key on which the pair differ.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 question, shape, recorded reason | **MET** | unit "names the question, the shape and the recorded reason"; integration over the protocol |
| AC-2 every strategy with what it returned | **MET** | unit "reports every strategy with what it returned"; integration asserts a non-empty list |
| AC-3 skipped reason verbatim | **MET** | unit "repeats a skipped reason verbatim rather than paraphrasing it" — the recorded sentence is asserted identical in structure and in rendered text |
| AC-4 `partial` stated | **MET** | unit "says the answer may be short when a strategy was skipped" |
| AC-5 first differing key, both values | **MET** | four unit tests, one per key — standing, relevance, authority, recency — each asserting the key named *and* that the key below it is not |
| AC-6 determinism tail reported as identity | **MET** | unit "reports the determinism tail as identity, never as a judgement" |
| AC-7 multi-contributor hits say which | **MET** | unit "says which contributors built a relevance"; integration asserts `['content','entity']` through the protocol |
| AC-8 folded constituents reported | **MET** | unit "says how many parts were folded into a hit"; integration asserts `folded: 1` |
| AC-9 standing sentence verbatim | **MET** | unit "carries a standing sentence verbatim" |
| AC-10 no breakdown reported unexplained | **MET** | unit "reports a hit with no breakdown as unexplained rather than reconstructing one" |
| AC-11 exact answer explained as exact | **MET** | unit "explains an exact answer as exact, claiming no ranking" |
| AC-12 withheld by reason, no value | **MET** | unit "reports counts by reason and no value", and "says plainly when nothing was withheld" |
| AC-13 no attribute value, statement or highlight | **MET** | unit "names fields and kinds, never attribute values or highlights"; **integration** takes every indexed value the hits carried — two highlights, a commit message, a path — and asserts none reached the rendered explanation, with a positive assertion so the check is not vacuous |
| AC-14 `explainQuery` is pure | **MET** | unit "returns the same explanation for the same inputs" and "freezes what it returns"; `tests/security/retrieval-scope.test.ts` asserts the module has no `await`, no `sql`, and no `storage/` import |
| AC-15 `ferret_explain` registered, read-only | **MET** | integration "is not offered without a planner, and is offered with one", "declares itself read-only and deliberately carries no content notice"; `mcp-destructive-tools.test.ts` continues to pass, which is what enforces `readOnlyHint` from the source |
| AC-16 `describeHit` emits `ranking` | **MET** | integration "emits the ranking breakdown on a search hit" |
| AC-17 renderer stable | **MET** | unit purity test; integration renders the same query twice and compares |

Seventeen of seventeen MET.

## Tests

- **Unit** — `tests/unit/query-explanation.test.ts`, 22 tests.
- **Integration** — `tests/integration/mcp/tools.test.ts`, 6 tests added on a
  fourth server wired with a planner, separate for the reason the
  evidence-wired one is: the *absence* of the tool without a planner is itself
  asserted.
- **Security** — `tests/security/retrieval-scope.test.ts`: `explain.ts` cannot
  read, and cannot reach `.highlight`, `.attributes` or `.statement` — the
  structural half of AC-13.
- **Regression** — `npm run verify` green: 128 files, 2660 passed, 3 skipped.

## Decisions worth recording

**`ferret_explain` carries no content notice, deliberately.** Every other tool's
description ends with `CONTENT_NOTICE`, and the tools test asserts that
invariant. An explanation contains no repository text, so there is nothing for a
notice to govern — and a notice on a document that needs none teaches a reader to
ignore notices. The integration test asserts the absence *and* asserts AC-13,
so the claim that makes the absence safe is the claim under test.

**It re-runs the query rather than accepting a result set.** A handed result set
is unverifiable input, and explaining one would mean describing rows the caller
may not be allowed to see. Costs one search; recorded in §8.5.

**"Why is this below that" is a fact about the comparator.** Walking EPIC-057
§8.3's key order and naming the first difference makes the answer checkable
rather than rhetorical, which is what let every AC-5 case be a unit test with a
known right answer.

## Limitations, recorded

- **`ferret_search` does not return prose inline** — it returns `plan` and now
  `ranking`, and a caller wanting sentences calls `ferret_explain`. Bundling a
  paragraph into every search would spend a client's context on an explanation it
  did not ask for, which is what EPIC-061 exists to prevent.
- **"Considered conflicting" is the one Governance §18 verb not served.** That is
  EPIC-047, unbuilt. A conflict is reported where EPIC-062 recorded one and
  invented nowhere else.
- **An explanation cannot say why something was *not* found.** Nothing records the
  absence. Every explanation states this in its own `limits`, rather than leaving
  a caller to assume otherwise — and it would need a "why did this miss"
  capability that no registry entry owns today.
- **Folded parts are reported as a count, not as kinds.** `RankBreakdown.subsumed`
  records ids; naming the kinds would need a second lookup, and reporting a kind
  the breakdown does not carry would be the explanation inventing a detail.
  §8.1's rule applied to its own output.
