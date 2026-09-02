# EPIC-049 — Relationship Storage · Validation Evidence

**Assessed against:** `da06909`
**Date:** 2026-09-01
**Specification:** [`../EPIC-049-Relationship-Storage.md`](../EPIC-049-Relationship-Storage.md)

## 1. What this is

An **audit**, not an implementation. EPIC-049's capability was built as the
storage half of EPIC-007 and has never been assessed against its own criteria.
This document records the assessment.

Evidence is `tests/integration/domain/relationship-store.test.ts` — 28 tests
against a **real PostgreSQL 17 + pgvector**, run for this audit: **28 passed, 0
failed**. Named tests are quoted so each claim can be checked rather than taken
on trust.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** Stored with endpoints, type, source, validity interval; reads back identically | **MET** | *"matches what the Drizzle schema declares"* — the live table is compared against the declared schema, so the assertion is about the database rather than about the model's opinion of it. |
| **AC-2** Re-asserting adds no row | **MET** | *"records a replayed assertion once"*. Identity includes `validFrom`, so a replay conflicts on `relationship_assertion_idx` rather than inserting. |
| **AC-3** Changed metadata updates in place | **MET** | *"updates in place when the metadata changes, without adding a row"*. |
| **AC-4** Dangling endpoint refused | **MET** | *"refuses a relationship to an entity that does not exist"* — foreign keys on `from_id` and `to_id`. |
| **AC-5** Exclusive supersede closes and opens in one transaction | **MET** | *"closes the previous interval when the branch moves"*. |
| **AC-6** Closed interval kept | **MET** | *"keeps the closed interval, so the history stays answerable"*. |
| **AC-7** Point-in-time query, exactly one answer at handover | **MET** | Three tests: *"answers what was true at an earlier instant"*, *"returns exactly one answer at the instant of the handover"*, *"returns nothing before the first observation"*. The handover case is the one worth having — an off-by-one there returns two answers or none. |
| **AC-8** Late older observation does not overwrite; inserts without overlap | **MET** | *"does not let an older observation close a newer interval"* and *"inserts a late event between two known intervals without overlapping either"*. |
| **AC-9** Retire closes rather than deletes; refuses retiring before it began | **MET** | *"closes the interval rather than deleting the row"*, *"refuses to retire a relationship before it began"*, *"reports nothing when asked to retire something that was never asserted"*. |
| **AC-10** Endpoint and type lookups use an index | **MET** | *"uses an index rather than scanning"* asserts the query plan, not the result. Six indexes declared, including `relationship_open_idx` for the open-relationship lookup. |
| **AC-11** Cross-provider entities connectable | **MET** | *"connects entities that came from different providers"*. |
| **AC-12** Concurrent exclusive writers leave exactly one open | **MET** | *"leaves exactly one open relationship when 8 writers race an exclusive type"* and *"applies a duplicate assertion once under concurrency"*. This is the criterion the advisory lock exists for; without it eight concurrent writers each saw a snapshot with nothing open and all eight opened. |
| **AC-13** Removing an endpoint leaves no dangling edge | **MET** | *"cascades when an endpoint entity is removed, leaving no dangling edge"*. |

**Summary: 13 MET, 0 PARTIAL, 0 NOT MET. Nothing was changed.**

Two further tests exercise properties no criterion names but which the store
depends on: *"survives the server terminating every connection"* and
*"refuses two assertions claiming the same identity"*. Performance budgets for
assertion and one-hop traversal are asserted at p95 and pass.

## 3. Why the diff is empty

An audit that finds a requirement met changes nothing (Governance §7). The
temptation with an audit Epic is to produce a visible diff to look productive —
a duplicate test asserting what an existing one already asserts, or a rename that
makes the code "match" the new document. Both would be worse than nothing: the
first inflates the suite without adding coverage, the second rewrites working
code to flatter a document written after it.

EPIC-007's validation already assigned its five limitations to EPIC-050,
EPIC-008, EPIC-046 and EPIC-105 and **none to EPIC-049**, which was a strong
prior that this audit would find little. It was run anyway, because a prior is
not evidence.

## 4. Limitations — inherited, and owned elsewhere

None of these is an EPIC-049 gap; each is recorded so this document does not read
as a claim that relationship storage is complete in every sense.

| Limitation | Owner |
| --- | --- |
| Traversal is one hop; no depth or cycle protection. | **EPIC-050** |
| No relationship-level provenance beyond `sourceSystem`/`sourceId`. | **EPIC-008** |
| No confidence on an inferred relationship. | **EPIC-046** |
| No `permission_scope` on the table, so reads cannot be scope-filtered. | **EPIC-058** |
| No bulk assertion; the indexer asserts one edge at a time. | See below. |
| macOS unvalidated. | **EPIC-105** |

**On bulk assertion**, since it is the one item without an existing owner: there
is no `assertMany`. It is recorded as an observation rather than a gap, because
`EntityStore.upsertMany` — the symmetric method that does exist — is itself a
loop over `upsert`, so adding `assertMany` would create symmetry, not throughput.
A real batching change would need measurement first, and no criterion here asks
for one.

## 5. Definition of Done

**Criteria met.** Thirteen of thirteen, each demonstrated by an integration test
against a real PostgreSQL rather than by inspection. Limitations are recorded
with owners.

Marked IMPLEMENTED rather than VALIDATED: an Epic is not validated by its author.

## Addendum — 2026-09-02, after EPIC-050

**The traversal limitations recorded above are closed.** The table is left as
written.

They read: "Traversal is one hop. *Which release contains the fix for FER-12*
needs several hops, which a caller must currently walk itself", and "No
traversal depth or cycle protection, because traversal is one hop. **Must be
addressed before multi-hop traversal exists.**"

`RetrievalPort.traverse` walks to a bounded depth, returns each reached entity
with the path that reached it, protects against cycles with a visited set, and
reports which bound stopped it — so a caller can tell "nothing further exists"
from "Ferret stopped looking". `ferret_neighbours` gained an optional `depth`
rather than acquiring a sibling tool.

The decision worth knowing is why it is **not** a recursive CTE. `neighbours`
filters twice — `scopePredicate` in SQL and `visibleEntities` in TypeScript for
the dimensions SQL cannot express — and a CTE carries only the first, so a walk
would expand *through* a node the caller may not see and return what lies beyond
it. The walk therefore takes the filtered one-hop read as a function, and the
invariant is asserted: every entity in every path is reachable by a one-hop
`neighbours` from its predecessor.

**EPIC-007 §D-001 is answered.** It ended "Revisit when EPIC-050 measures a
traversal that PostgreSQL cannot serve." Depth 6 exhausted Ferret's own graph in
**21.6 ms**, with three queries for a two-hop walk. D-001 stands; no second
datastore is justified.

Evidence: `docs/EPICs/validation/EPIC-050-VALIDATION.md`.
