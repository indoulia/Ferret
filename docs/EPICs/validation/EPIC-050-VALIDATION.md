# EPIC-050 — Relationship Traversal · Validation Evidence

**Assessed against:** working tree on top of `fc531d2`
**Date:** 2026-09-02
**Environment:** real PostgreSQL 17, real `git`, a real indexed repository.

> Specification and implementation were authored together, as
> `docs/EPICs/README.md` § "Specification files" requires. Scope was drawn from
> the registry entry — "EPIC-050 — Relationship Traversal — P1" — and from the
> five limitations EPIC-007, EPIC-049, EPIC-060 and EPIC-035 recorded against it.

## D-001's answer, which this Epic owed

EPIC-007 §D-001 chose "a table with indexes, not a graph database" and ended
**"Revisit when EPIC-050 measures a traversal that PostgreSQL cannot serve."**
Measured on Ferret's own graph:

```
[EPIC-050] depth=6 reached=3 paths=15 truncated=undefined elapsedMs=21.6
[EPIC-050] queries=3 for depth=2 limit=5 paths=5
```

**D-001 stands.** A walk to the maximum depth exhausted the reachable graph in
**21.6 ms** and did not need truncating. The prediction D-001 made — "the
traversals Ferret needs are shallow and typed … PostgreSQL answers those from an
index" — held, and the query count confirms the design: one indexed lookup per
frontier node, three for a two-hop walk.

The test asserts a 2-second ceiling rather than the observed figure. The claim
under test is D-001's — that PostgreSQL *can* serve this shape — not a
particular millisecond, and a walk that took seconds is the finding that would
overturn the decision. It fails if one ever does.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 two-hop path with both edges and the intermediate | **MET** | unit "returns each node with the path that reached it"; integration "reaches a file through its repository in two hops, with the path" |
| AC-2 `depth: 1` equals `neighbours` | **MET** | integration "returns exactly what neighbours returns at depth 1" — same ids, all at depth 1 |
| AC-3 depth clamped, not rejected | **MET** | unit "clamps beyond the maximum rather than rejecting" (999, 0, −3, 2.5); integration asserts `depthReached ≤ MAX_TRAVERSAL_DEPTH` |
| AC-4 cyclic graph terminates | **MET** | unit ×3 — a two-node cycle, a four-node cycle, and a self-edge; integration over `commit_parent_of_commit` on a real repository |
| AC-5 a node reached twice is reported once, shortest | **MET** | unit "reports a node reached two ways once, by a shortest path" over a diamond |
| AC-6 ordered by depth then deterministically | **MET** | unit "orders by depth, then by identity"; integration runs the same walk twice and compares |
| AC-7 type filter at every hop | **MET** | integration "applies the type filter at every hop" — every step carries the requested type, and nothing is reached beyond depth 1 |
| AC-8 direction at every hop | **MET** | integration "applies direction at every hop, and reaches the root from a leaf" |
| AC-9 point-in-time at every hop | **MET** | inherited by construction — the walk calls the one-hop read, which carries the temporal predicate; the historical case is asserted in "answers a question that needs two hops" |
| AC-10 no invisible entity in a path, including as an intermediate | **MET** | `permission.test.ts`, 4 tests: the chain is reachable when visible, **stops at an invisible intermediate**, never puts one in a step, and reports nothing from an invisible origin |
| AC-11 withheld counts reported | **MET** | the hop reader's tally is threaded through every level and attached to the result |
| AC-12 `truncated` names depth | **MET** | unit "says depth stopped it when the graph continues"; integration asserts it |
| AC-13 `truncated` names limit | **MET** | unit ×2, including which reason wins when both bounds apply |
| AC-14 a walk over EPIC-035's reference edges | **MET** | the reference edges are in the same table and the same walk reaches them; the fixture's graph is walked to depth 4 |
| AC-15 `ferret_neighbours` takes a depth | **MET** | `tools.test.ts`, 4 tests: the no-depth and `depth: 1` responses are **byte-identical**, `depth: 2` returns `reached` with paths, a depth beyond the bound is refused at the schema, and the parameter is discoverable |
| AC-16 every path reachable one hop at a time | **MET** | integration walks each returned path and asserts each step appears in a one-hop `neighbours` from its predecessor, under the same access context |

Sixteen of sixteen MET.

## The decision the Epic turns on

**An iterative frontier, not a recursive CTE — and it is a security decision.**

A recursive CTE is the obvious implementation. It cannot be used, and the reason
only appears once permissions exist: `neighbours` filters **twice** —
`scopePredicate` in SQL, and `visibleEntities` in TypeScript for the dimensions
SQL cannot express (worktree, session, glob path exclusion). A CTE carries the
first and not the second, so a walk would expand *through* a node the caller may
not see and return what lies beyond it. That is a caller learning a relationship
exists by receiving its far end.

So the walk takes the **filtered one-hop read as a function**. Every hop is
filtered by construction rather than by being reimplemented, and the invariant
is testable: AC-16 asserts that every entity in every returned path is reachable
by a one-hop `neighbours` from its predecessor. Nothing is reachable
transitively that is not reachable directly.

`tests/security/retrieval-scope.test.ts` adds the structural half — the walk
module contains no `sql`, no `storage/` import and no `RECURSIVE` — so a later
author cannot quietly swap the loop for a CTE and drop the second filter.

## Tests

- **Unit** — `tests/unit/traversal.test.ts`, 16 tests over hand-written graphs:
  every bound, three cycle shapes, a diamond, the query count per level, and
  three degenerate walks. Possible because the walk is pure and takes the hop
  reader as a parameter.
- **Integration (real PostgreSQL)** — `retrieval.test.ts`, 14 tests including
  the two D-001 measurements; `permission.test.ts`, 4 tests for AC-10.
- **MCP** — `tools.test.ts`, 4 tests for AC-15.
- **Security** — the two structural checks above.
- **Regression** — `npm run verify` green: 131 files, 2782 passed, 3 skipped.

## Recorded during implementation

**The walk moved out of the store.** It was written as a store method and
extracted to `src/retrieval/traverse.ts` so the bounds and the cycle behaviour
could be tested without a database — the same move EPIC-056 made for ranking.
Taking the hop reader as a parameter turned out to be the better expression of
§8.3 as well: the security property is now visible in the signature rather than
in a comment.

**`neighbours` did not surface its withheld counts**, so AC-11 could not have
been honest. Rather than reimplement the filters in `traverse` — which §8.3
forbids — the store's one-hop body was split into a private method that accepts
a tally, and the public `neighbours` signature is unchanged.

## Limitations, recorded

- **One path per reached node, not all paths.** A caller asking "every way this
  reaches that" is asking a path-finding question §4 declines, and the answer is
  unbounded in a cyclic graph.
- **No transitive edge is stored.** A reachability table would be a cache with an
  invalidation policy no Epic defines — the write-only-subsystem shape EPIC-048
  was written to correct.
- **Traversal does not rank.** Ordered by depth and then identity. Which of five
  reached commits matters most is EPIC-056/057's question.
- **`MAX_TRAVERSAL_DEPTH` is 6, chosen and not measured.** It is a bound on cost
  rather than a claim about graphs: the fixture's graph exhausts at depth 3, and
  no measurement here argues for a different ceiling. If a real question needs
  more, the number is one constant and the measurement above is how to justify
  changing it.
- **The withheld count is per walk, not per hop.** A caller learns how much was
  withheld, not at which depth. Reporting the depth would say where in the graph
  something protected sits, which is more than the count EPIC-058 deliberately
  discloses.
