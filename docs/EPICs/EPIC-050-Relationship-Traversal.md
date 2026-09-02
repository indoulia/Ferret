# EPIC-050 — Relationship Traversal

**Status: APPROVED | Priority: P1 | Domain: Knowledge Graph & Relationships**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Knowledge Graph &
> Relationships, where it has been named and prioritised since the registry was
> written; only the specification is new.

## 1. Objective

Answer a question that needs more than one hop — and return the path that
answered it, bounded, cycle-safe, and permission-checked at every step.

## 2. Value — five recorded limitations, all pointing here

- **EPIC-007's validation** — "Traversal is one hop. *Which release contains the
  fix for FER-12* needs several hops, which a caller must currently walk
  itself"; and "No traversal depth or cycle protection, because traversal is one
  hop. **Must be addressed before multi-hop traversal exists.**"
- **EPIC-049 §4** — "Traversal beyond one hop, depth limits and cycle
  protection — EPIC-050."
- **EPIC-060 §4** — "Relationship traversal to reach an indirect answer."
- **EPIC-035 §4** — "A transitive walk over reference edges is EPIC-050's
  traversal over this Epic's edges."
- **EPIC-007 §D-001** — "A table with indexes, not a graph database … **Revisit
  when EPIC-050 measures a traversal that PostgreSQL cannot serve.**"

So a caller wanting "which commit introduced the symbol this function calls"
must issue one query per hop, keep its own visited set, and invent its own
depth bound — and Ferret cannot tell it that a path exists but was truncated.
EPIC-035 has just produced 1,124 reference edges whose whole value is transitive.

This Epic also owes D-001 an answer, and §16 records it.

## 3. Scope

- **`traverse`**: multi-hop from one entity, with a depth bound, type and
  direction filters, and the point-in-time semantics `neighbours` already has.
- **Paths, not only nodes.** What reached a node is the answer to "how", and a
  flat node set throws it away.
- **Cycle protection**, so a cyclic graph terminates rather than hangs.
- **Permission at every hop** — §8.3, and the reason this is not a recursive
  CTE.
- **Honest truncation**: a walk stopped by a bound says so.
- **One MCP surface, extended rather than duplicated** — `ferret_neighbours`
  gains an optional depth.
- **A measured verdict on D-001.**

## 4. Non-scope

- **Shortest-path or arbitrary path finding between two named nodes.** The
  questions Ferret exists for are "what does this reach" and "what reaches
  this", both bounded and typed. A path-finding surface would need a cost model
  no Epic defines.
- **A graph database.** D-001 stands unless §16's measurement overturns it, and
  it does not.
- **Ranking paths** — EPIC-056/057 rank what retrieval returns; a traversal
  result is ordered by depth and then deterministically.
- **Inventing edges.** Only what EPIC-007/049 stored is walked; a transitive
  edge is *derived at read time* and never written.
- **A call-graph product surface.** This Epic makes the walk available;
  presenting a call graph is a client's business.
- **Recursion into evidence provenance** — EPIC-048's `provenanceOf` already
  walks that chain, and it is a different graph.

## 5. Inputs

`ferret.relationship` (EPIC-049), the entities at each end, `AccessContext`
(EPIC-058), and `TraversalQuery`'s existing shape.

## 6. Outputs

- `RetrievalPort.traverse` and a `TraversalPath` result.
- `ferret_neighbours` with an optional `depth`.
- No schema change; no new index.

## 7. Dependencies

EPIC-007 (the temporal model and the one-hop primitives), EPIC-049 (storage),
EPIC-058 (the access context this must honour at every hop), EPIC-035 (the
reference edges that make a transitive walk worth having).

## 8. Contracts

### 8.1 A traversal returns paths

Each reached entity comes back with the path that reached it: the ordered edge
types and the node ids in between, plus its depth. "Which release contains this
commit" is answered by *`commit → release_includes_commit → release`*, and a
caller handed only the release cannot tell whether Ferret walked the edge it
expected or a different one of the same kind.

One path per reached entity — the **first** one found, which under
breadth-first order is a shortest one. Enumerating every path between two nodes
is the path-finding §4 declines.

### 8.2 Breadth-first, bounded twice, and terminating

Breadth-first, so `depth` means what a reader expects and the first path found
is a shortest one. Two bounds, because one is not enough:

- **`depth`** — hops from the origin. Default 1, so an existing caller's
  behaviour is unchanged; maximum {@link MAX_TRAVERSAL_DEPTH}.
- **`limit`** — reached entities, through `boundedLimit` as everywhere else.

**Cycle protection is a visited set, not a path check.** A node reached once is
not expanded again: the graph is walked, not the set of walks. `A → B → A` gives
`B` at depth 1 and stops, rather than looping. Ferret's relationships are
genuinely cyclic — `commit_parent_of_commit` in a repository with merges,
`entity_supersedes_entity` after a rename that was undone — and EPIC-007's
validation made cycle protection a precondition of this Epic existing.

### 8.3 Permission is applied at every hop, which is why this is not a recursive CTE

A recursive CTE is the obvious implementation and it cannot be used, for a
reason that only appears once permissions exist.

`neighbours` filters twice: `scopePredicate` in SQL, and `visibleEntities` in
TypeScript for **the dimensions SQL cannot express** — worktree, session and
glob path exclusion. A recursive CTE can carry the first and not the second, so
a walk would expand *through* a node the caller may not see and return a node
beyond it. The result would be a caller learning that a relationship exists by
receiving what lies on the other side of it.

So the walk is an **iterative frontier**: one level at a time, each level
filtered through both predicates before it is expanded. This is the shape
`EvidenceStore.provenanceOf` and `dependentsOf` already use, and it costs one
query per level — bounded by `depth`, which is bounded by `MAX_TRAVERSAL_DEPTH`.

The invariant, stated so it can be tested: **every entity in a path is one the
caller could have reached with a one-hop `neighbours` call from the previous
node.** Nothing is reachable transitively that is not reachable directly.

### 8.4 Truncation is reported, never inferred

A walk stopped by `depth` or by `limit` sets `truncated`, with which bound did
it. Otherwise a caller cannot tell "nothing further exists" from "Ferret stopped
looking" — the distinction EPIC-059 and EPIC-062 both exist to preserve, and the
one a graph makes easiest to lose.

`withheld` carries the count that permission removed, as `neighbours` already
does. A node dropped at hop three is counted, not silently absent.

### 8.5 `ferret_neighbours` grows a depth rather than a sibling

The existing tool answers "what is next to this". With `depth` it answers "what
does this reach", which is the same question with a bound the caller chooses.
A second tool would duplicate its schema, its containment and its guard to
change one number, and a client would have to know which to call.

`depth: 1` is the default and is exactly today's behaviour, so no existing
caller changes.

## 9. Acceptance criteria

- **AC-1** A two-hop path is returned with both edge types in order and the
  intermediate node id.
- **AC-2** `depth: 1` returns exactly what `neighbours` returns.
- **AC-3** `depth` above `MAX_TRAVERSAL_DEPTH` is clamped, not rejected.
- **AC-4** A cyclic graph terminates and reports each node once.
- **AC-5** A node reachable by two paths is reported once, with a shortest path.
- **AC-6** Results are ordered by depth, then deterministically.
- **AC-7** A type filter applies at every hop.
- **AC-8** Direction applies at every hop, and `in` from a leaf reaches the root.
- **AC-9** The point-in-time filter applies at every hop: an edge that ended
  before `at` is not walked.
- **AC-10** A path never contains an entity the caller may not see, **including
  as an intermediate**, and the walk does not continue through it.
- **AC-11** Withheld counts are reported by reason.
- **AC-12** `truncated` is set when `depth` stopped the walk, and names it.
- **AC-13** `truncated` is set when `limit` stopped the walk, and names it.
- **AC-14** A walk over EPIC-035's reference edges answers "what does this
  function reach, transitively", to depth 3.
- **AC-15** `ferret_neighbours` accepts `depth`, defaults to 1, and its
  one-hop response is byte-identical to before.
- **AC-16** Every entity in every returned path is reachable by a one-hop
  `neighbours` from its predecessor — §8.3's invariant, asserted.

## 10. Test requirements

**Unit** — the frontier's bounds and cycle behaviour over a fake port: a cycle,
a diamond, a chain longer than the depth bound, an empty result, and the clamp.

**Integration (real PostgreSQL)** — AC-1 to AC-14 over a real indexed
repository, including a walk over EPIC-035's reference edges; a scoped
intermediate proving AC-10; the temporal case with an edge that ended.

**Security** — AC-10 and AC-16, and a structural check that the traversal
applies the same two filters `neighbours` does at every level.

**Failure** — an origin that does not exist; an origin with no edges; a depth of
zero.

**Performance** — the measurement D-001 asked for, recorded in the validation
document whichever way it comes out.

**Regression** — EPIC-007's, EPIC-049's and the MCP suites unchanged.

## 11. Security requirements

§8.3 is the security requirement: a multi-hop walk is the first read path that
could disclose a node's *existence* by returning what lies beyond it, and the
iterative design exists to close that. AC-10 and AC-16 are the tests; the
structural check keeps a later author from replacing the loop with a CTE that
silently drops the second filter.

## 12. Observability

Depth reached, nodes visited, and which bound stopped the walk, on the result
itself. No new metric: a traversal's cost is a property of the answer, and a
caller that can see it can bound its own next question.

## 13. Performance constraints

One query per level, each an indexed lookup on `from_id` or `to_id` over a
frontier bounded by `limit`. Total queries ≤ `depth`. The measurement in §16
records the observed cost on Ferret's own graph.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 satisfied with evidence in
`validation/EPIC-050-VALIDATION.md`; unit, integration, security, failure and
performance tests present and passing; `npm run verify` green; the registry
updated; EPIC-007's and EPIC-049's recorded limitations struck with dated notes;
D-001 answered with a measurement.

## 15. Governance alignment

- **§14 Lightweight Infrastructure** — §16's measurement is what D-001 asked
  for before any second datastore could be justified.
- **§12 Security** — §8.3 puts the authorization evaluation *before* information
  enters the result, at every hop rather than at the end.
- **§6 Evidence Before Inference** — §8.4: a truncated walk says so rather than
  presenting a bounded answer as a complete one.
- **§5 Reuse Before Reinvent** — the frontier shape `provenanceOf` already uses,
  the one-hop query already written, and one MCP tool rather than two.
- **§10 Time and History** — the point-in-time filter applies at every hop, so
  "what did this reach last Tuesday" is answerable.

## 16. Raised, not absorbed

- **D-001's verdict.** Recorded in the validation document from the measurement,
  not decided here in advance. The prediction is that PostgreSQL serves this
  comfortably, because the walk is typed and shallow — but the point of D-001's
  "revisit when" is that the number decides.
- **One path per node, not all paths.** A caller asking "every way this reaches
  that" is asking a path-finding question §4 declines, and the answer would be
  unbounded in a cyclic graph.
- **No transitive edge is stored.** A derived reachability table would be a
  cache with an invalidation policy no Epic defines — the write-only-subsystem
  shape EPIC-048 was written to correct.
- **Traversal does not rank.** Ordered by depth and then by identity. Which of
  five reached commits matters most is EPIC-056/057's question, and they rank
  what retrieval returns rather than what a graph walk found.

## 17. Recorded during implementation

- **The walk lives in `retrieval/traverse.ts`, not in the store**, and takes the
  filtered one-hop read as a parameter. Extracted so the bounds and the cycle
  behaviour are testable without a database — the same move EPIC-056 made for
  ranking — and it turned out to express §8.3 better than the comment did: the
  security property is now visible in the signature.
- **`neighbours` did not surface its withheld counts**, so AC-11 could not have
  been honest. The store's one-hop body was split into a private method that
  accepts a tally rather than reimplementing the filters in `traverse`, which
  §8.3 forbids. The public signature is unchanged.
- **D-001 stands.** Depth 6 exhausted Ferret's own graph in 21.6 ms without
  truncating; three queries for a two-hop walk. Recorded in the validation
  document with the reasoning about what the assertion does and does not claim.
