# EPIC-007 — Validation Evidence

**Epic:** EPIC-007 — Relationship & Temporal Model
**Branch:** `feat/epic-007-relationship-and-temporal-model`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Relationships are typed, queryable, and source-traceable | **PASS** | 26 built-in types, each declaring the entity kinds it may connect. Every relationship carries `sourceSystem` and an optional `sourceId`, so the *observation* is traceable independently of its endpoints. Queryable in both directions and by type: `relationship-store.test.ts` → "traversal" (4 cases), including an `EXPLAIN` assertion that lookup uses an index. |
| AC-2 | Historical relationships can coexist with current relationships | **PASS** | `validFrom`/`validTo` intervals; closing never deletes. `relationship-store.test.ts` → "an exclusive relationship over time" (6 cases): a branch that moved keeps both intervals, `outgoing({ at })` answers what was true then, and `includeHistorical` lists the whole timeline. |
| AC-3 | Relationship updates are idempotent | **PASS** | Identity is derived from `(fromId, type, toId, validFrom)` and enforced by a unique index, so a replayed event conflicts rather than duplicating. `relationship-store.test.ts` → "duplicate events" (2 cases): five replays leave one row; a metadata change updates in place. Under concurrency: `concurrency.test.ts` → 8 simultaneous identical assertions leave one row. |
| AC-4 | Branch and worktree relationships remain distinct | **PASS** | Enforced structurally: `REPOSITORY_CONTAINS_BRANCH` cannot end at a worktree, and `WORKTREE_CHECKS_OUT_BRANCH` cannot start at a branch. `relationship.test.ts` → "type constraints" asserts both rejections. Governance §9 forbids conflating the two, and a rule beats a convention. |
| AC-5 | Relationships can connect entities from different providers | **PASS** | Endpoints are canonical ids, which carry no provider within them. `relationship-store.test.ts` → "cross-source relationships" connects a **GitHub** pull request to a **Jira** issue, with the relationship traceable to `ferret` — the system that made the connection, which is neither endpoint's system. |
| AC-6 | Temporal queries can distinguish observed time from indexed time | **PASS** | Four timestamps, two clocks: `valid_from`/`valid_to` say when the fact was true in the world; `first_indexed_at`/`last_indexed_at` say when Ferret learned and last confirmed it. Asserted in the schema-drift test and exercised throughout — the "as of" queries use valid time, while a replayed event moves only `last_indexed_at`. |

**6 / 6 PASS.**

---

## 2. Required tests

The Epic names six test areas. All six exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Create / update / delete / tombstone | PASS | `relationship-store.test.ts` → assert (opened/updated/unchanged), `retire` closes the interval and keeps the row |
| Duplicate events | PASS | `relationship-store.test.ts` → "duplicate events" (2 cases); `concurrency.test.ts` → 8 simultaneous duplicates |
| Out-of-order events | PASS | `relationship-store.test.ts` → "out-of-order events" (3 cases), including a late event landing **between** two known intervals |
| Historical queries | PASS | `relationship-store.test.ts` → point-in-time `at`, `includeHistorical`, `history()` |
| Cross-source relationships | PASS | `relationship-store.test.ts` → GitHub PR ↔ Jira issue |
| Concurrent updates | PASS | `relationship-store.test.ts` → 8 racers on an exclusive type; `concurrency.test.ts` → 10 racers plus a no-overlap assertion over the whole table |

### Coverage beyond the required list

- **Timeline consistency as a whole-table invariant** — a self-join asserts that
  no two intervals of an exclusive type ever overlap, for any entity.
- **Contention is scoped** — four branches asserting simultaneously do not wait
  on one another, so ingestion does not serialize globally.
- **Self-loops rejected** — a commit is not its own parent, and a self-loop
  produces traversals that never terminate.
- **Dangling edges impossible** — foreign keys with cascade; a relationship to a
  non-existent entity is refused.
- **Half-open intervals** — asserted at the exact instant of a handover, where a
  closed-interval model would return two answers to a question with one.
- **Schema/code drift** — `information_schema` introspection compares the applied
  columns, types and nullability to the Drizzle declaration.

---

## 3. Two defects these tests caught

### F-1 — Write skew left an exclusive relationship open eight times

Eight concurrent assertions on `branch_points_to_commit` each read a snapshot in
which no *other* relationship was open, so none closed the others and **all eight
remained open**. A branch would have appeared to point at eight commits at once.
This is textbook write skew under PostgreSQL's default READ COMMITTED isolation,
and it is invisible to single-threaded testing.

Fixed with a **transaction-scoped advisory lock keyed on `(fromId, type)`** —
serializing exactly the writers that conflict and nothing else, released on
commit or rollback without an unlock call. A partial unique index was considered
and rejected: it would be table-wide, and would wrongly forbid a commit from
having several open `commit_modifies_file` relationships.

### F-2 — The fix exposed a deeper ordering problem

With the lock in place the count fell from eight to **two**, not one. The reason
was more interesting than the first bug: `#closeOthers` closed only intervals
starting at or before the new one — correct, because an older observation must
not close a newer interval — but that left two open when events arrived out of
order.

The real requirement is interval *reconciliation*, and it takes two rules:

1. **Truncate whatever covered this instant**, including already-closed
   intervals. Inserting Jan 5 between an existing Jan 3–Jan 8 would otherwise
   leave two intervals covering the same days; "close whatever is open" misses it
   because Jan 3 is already closed.
2. **Bound the new interval by its successor.** A late-arriving older event
   becomes history rather than being dropped or wrongly becoming current.

The invariant is now: exactly one interval open — the one with the greatest
start — and none overlapping, whatever order events arrive in. Nothing is
discarded, which Governance §15 requires. Covered by "inserts a late event
between two known intervals without overlapping either" and by the whole-table
no-overlap assertion.

---

## 4. A connection-safety defect found while completing this Epic

Not part of EPIC-007's scope, but found by its test run and fixed here because
it is a live crash.

**`pg` attaches its pool-level error handler only to *idle* clients.** A client
checked out for a transaction has no handler, so if PostgreSQL terminates that
backend — an administrator command, a failover, a restart — the resulting
`FATAL 57P01` arrives as an unhandled `error` event and **Node ends the
process**. Every Drizzle transaction and the whole of a migration hold a checked-
out client, so a routine server restart would have killed the user's AI session
rather than failing one query.

The full test run had been reporting exactly this as an unhandled error while
still passing, which is precisely the shape of a defect that gets ignored.

Fixed in `createPool` with a `pool.on('connect')` handler that attaches an error
listener to every client for its whole life — covering borrowers inside Drizzle
that Ferret never sees. Reproduced deterministically in `concurrency.test.ts` →
"does not take the process down", which leaves a client idle *inside a
transaction* so the FATAL is not absorbed by a pending query, and asserts both
that no uncaught exception occurred and that the fault was logged.

The whole suite now completes with **zero unhandled errors**.

---

## 5. Concurrency and connection safety

Node runs one JavaScript thread, so safety here means two distinct things.
`tests/integration/storage/concurrency.test.ts` (13 cases) tests both.

| Property | How it is achieved | Test |
| --- | --- | --- |
| Exclusive relationships stay exclusive | Transaction-scoped advisory lock on `(fromId, type)` | 10 racers leave one open interval |
| No overlapping intervals, ever | Interval reconciliation on every assert | Whole-table self-join finds zero overlaps |
| Contention does not serialize globally | The lock key includes the entity | Four branches assert in parallel within 5 s |
| Duplicate entity ingestion creates one row | Derived id + `ON CONFLICT` | 12 racers, one row |
| A reader never sees a half-written entity | Entity and external ids commit together | 10 writers interleaved with 30 readers |
| A connection failing in use does not crash | `pool.on('connect')` error listener | Backend terminated mid-transaction |
| A dead connection does not commit half a transaction | PostgreSQL, surfaced honestly | Success implies stored; failure implies absent |
| Bursts queue rather than fail | Pool of 8 serving 24 callers | All 24 succeed |
| Connections are returned | — | `idleCount > 0`, `waitingCount === 0` |

Ferret's other concurrency points were already covered and remain so: the
migration advisory lock (EPIC-002, 8 racing processes) and the configuration
file lock (EPIC-003, 8 racing OS processes).

---

## 6. Performance

Ingesting a repository's history asserts one relationship per commit parent, per
changed file and per author, so per-assertion cost is multiplied by the size of
the history.

| Measurement | Budget |
| --- | --- |
| Assert a relationship (p95 of 30) | 300 ms |
| Traverse from one entity (p95 of 50) | 100 ms |
| Directional lookup uses an index | asserted via `EXPLAIN` |

A partial index on `(from_id, type) WHERE valid_to IS NULL` serves the hottest
lookup in ingestion — finding the currently-open relationship an exclusive type
must close.

---

## 7. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Schema documented | **PASS** | `src/storage/schema/relationships.ts` and migration `0003`, both with the reasoning inline; `docs/Architecture/EPIC-007-DECISIONS.md`. |
| Invariants documented and validated | **PASS** | One open interval per exclusive `(entity, type)`; no overlaps; no self-loops; no dangling edges. Each asserted, the first two at whole-table level. |
| Traversal primitives | **PASS** | `outgoing`, `incoming`, `neighbours`, `history`, each with type and point-in-time filters. EPIC-050 owns traversal beyond one hop. |
| Temporal semantics | **PASS** | Half-open valid intervals, separate index time, point-in-time queries, out-of-order reconciliation — documented in §3 and in the module. |
| Automated tests | **PASS** | 29 unit + 28 integration + 13 concurrency. Total suite: 637 passing, 3 skipped. |

---

## 8. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| Reconciliation bounds an interval by the successor **known at insert time**. A later insertion fixes its own neighbourhood but does not re-derive the whole timeline. | The invariants hold after every insert; the cost is that intervals are not recomputed globally. No overlap has been produced by any ordering tested. | EPIC-007 follow-up if a source is found that needs it |
| Traversal is one hop. | "Which release contains the fix for FER-12" needs several hops, which a caller must currently walk itself. | **EPIC-050** — Relationship Traversal |
| No relationship-level provenance beyond `sourceSystem`/`sourceId`. | Ferret can say which system asserted a relationship, not what evidence supports it. | **EPIC-008** — Evidence & Provenance |
| No confidence on inferred relationships. | A `commit_resolves_issue` parsed from a commit message is stored with the same standing as one from an API. | **EPIC-046** — Confidence & Completeness |
| `retire` closes the most recent open interval for an edge, not an arbitrary one. | An event retiring a specific historical interval cannot be expressed. | EPIC-007 follow-up if a provider needs it |
| No traversal depth or cycle protection, because traversal is one hop. | Must be addressed before multi-hop traversal exists. | **EPIC-050** |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005. | **EPIC-105** |
