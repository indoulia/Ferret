# EPIC-031 — Validation Evidence

**Epic:** EPIC-031 — Incremental Indexing
**Branch:** `feat/epic-031-incremental-indexing`
**Recorded:** 2026-08-31

> **Specification note.** EPIC-031 had no specification file. It was written
> first, to the approved standard. **The acceptance criteria below are ones this
> work authored.**

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | A first run writes a connected graph | **PASS** | `repository-indexer.test.ts` → "writes a connected graph on the first run" — all seven entity kinds asserted by SQL against the real database. |
| AC-2 | A second run over unchanged content adds **no rows** | **PASS** | "does not grow the database when nothing changed" — row counts before and after are compared, not outcomes. See §3.1. |
| AC-3 | A second run reads less, and says it was incremental | **PASS** | "reads only what is new on the second run". |
| AC-4 | `--full` re-reads everything and writes nothing new | **PASS** | "re-reads everything when asked for a full run". |
| AC-5 | A branch switch is history: one open checkout per worktree | **PASS** | "records a branch switch as history rather than as a contradiction". |
| AC-6 | Cancellation leaves no watermark it did not earn | **PASS** | "stops when cancelled, without leaving a watermark it did not earn". |
| AC-7 | Concurrent indexers never produce two open intervals for one edge | **PASS** | "runs two indexers over one repository without corrupting the graph" — three concurrent runs, asserted by SQL `GROUP BY … HAVING count(*) FILTER (WHERE valid_to IS NULL) > 1`. See §3.2. |
| AC-8 | `ferret index` selects its source by capability | **PASS** | `assertSupported(runtime.providers.supports(Capability.SOURCE_REPOSITORY))`; the command is the only file that constructs a Git provider. |
| AC-9 | The core reaches no storage module | **PASS** | `boundaries.test.ts`, unchanged and still passing with `indexing/` in the core graph — the ports design holds. |

**9 / 9 PASS.**

---

## 2. Tests

`npm run verify` — **1,147 passed, 3 skipped** across 46 files against live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**.

---

## 3. Two real defects, both in storage, both found here

### 3.1 Unbounded growth for content that never changed

EPIC-018 recorded this as its most important limitation and named this Epic as
the owner. Relationship identity includes `validFrom`, so an indexer running
hourly produced a *different id* every hour for the same unchanged edge, and
deduplication by id never fired. A repository nobody touched would have gained a
row per edge per run for ever.

Fixed in EPIC-007's store rather than in the indexer: every provider that
re-observes an unchanged edge needs it, and one that forgot would grow the
database silently. An **open interval already says "true since then, and not yet
ended"** — seeing it again confirms the existing fact rather than creating a new
one, which is what `last_indexed_at` records.

For an exclusive type the consequence was worse than growth: reconciliation would
have closed the old interval and opened a new one, making an unchanged checkout
look like the developer switching to the same branch every hour.

### 3.2 Write skew on the fix for 3.1

The deduplication is itself a read-decide-write, and it had no lock. Three
concurrent indexers all read "nothing open", all inserted, and — because each run
carries its own instant — all three succeeded. **Three open intervals for one
edge**: precisely the contradiction the deduplication was added to prevent.

The advisory lock is now taken for **every** assert, not only for exclusive types,
keyed at the granularity each needs: `(from, type)` for exclusivity, the whole
edge for deduplication. The narrower key for the common case keeps a bulk index
from serialising on a repository's own id.

**And then a third time**, because the fix was still ordering-dependent. Two
indexers started milliseconds apart carry different instants; if the one with the
*earlier* instant commits second, its `validFrom` precedes the open interval and
the match was rejected — opening a second interval anyway. It passed in isolation
and failed under load, which is the signature of every ordering bug.

There is no ordering of two concurrent observations in which two open intervals
is the right answer, so ordering was removed from the match. What an earlier
observation legitimately says — that the fact began before Ferret thought it did
— is recorded as an `updated` outcome; moving an interval's start backwards is
EPIC-076's, which is where reconciling out-of-order observations belongs.

**Since resolved, and not by EPIC-076.** The start *does* move backwards: the
row is deleted and replaced (`relationships.ts:204`), because `validFrom` is
part of relationship identity and editing in place would leave an id that no
longer derives from the row it names. That landed with the "what did this
repository contain at noon" defect. EPIC-076 verified it by test rather than
inheriting the paragraph.

---

## 4. Dogfooding: Ferret indexed its own repository

Run against a live PostgreSQL 17 + pgvector, on this repository, with the
`ferret` binary built from `dist/`.

```
$ ferret index .
repository        github.com/indoulia/Ferret
mode              full
read              61 commits, 278 files, 5 branches, 1 worktrees
entities          638 new, 0 changed, 280 unchanged
relationships     1403 new, 0 changed, 278 unchanged
evidence          347 recorded, 0 already known
took              17312ms

$ ferret index .
mode              incremental
read              1 commits, 278 files, 5 branches, 1 worktrees
entities          0 new, 0 changed, 577 unchanged
relationships     0 new, 0 changed, 584 unchanged
evidence          0 recorded, 287 already known
took              9279ms
```

Row counts are **identical** after the second and third runs — 638 entities,
1,226 relationships, 347 evidence records — and

```sql
SELECT count(*) FROM (
  SELECT from_id, type, to_id FROM ferret.relationship
   WHERE valid_to IS NULL GROUP BY 1,2,3 HAVING count(*) > 1) x;
-- 0
```

### What Ferret can now answer about itself

```
 kind         | count        which files change most            | commits
--------------+-------       ---------------------------------- +--------
 file         |   291        docs/EPICs/README.md               |      19
 file_version |   278        src/index.ts                       |      12
 commit       |    61        README.md                          |       9
 branch       |     5        src/cli/exit-codes.ts              |       8
 worktree     |     1        src/errors/codes.ts                |       8
 developer    |     1
 repository   |     1
```

Those answers are correct and non-obvious: `docs/EPICs/README.md` changes every
Epic because that is where status is recorded, and `src/index.ts` changes almost
as often because every Epic adds exports. Ferret worked that out from the graph.

Provenance survives the round trip:

```
 method  | producer          | producer_version | field                | statement
---------+-------------------+------------------+----------------------+---------------------------------
 observed| ferret.source.git | 0.1.0            | attributes.name      | "Ferret"
 observed| ferret.source.git | 0.1.0            | attributes.remoteUrl | "https://github.com/indoulia/…"
```

### A third defect, found only by dogfooding

Running `ferret init` with an incomplete configuration produced a **log line
strictly worse than the terminal output** of the same error:

```json
"message": "…missing database: …missing database: …missing database",
"stack":   "\ncaused by: \ncaused by: "
```

`sanitize()` had already produced a redacted plain object with its cause chain,
and pino's own `err` serializer then ran over it as well — concatenating every
cause's message and synthesising a stack from objects that have none. Governance
§20 asks structured logging to make an operator's life easier, and this made it
harder.

Fixed with an identity `err` serializer, and covered by a regression test. **No
test would have found this**: every existing logging assertion checked fields
that were correct. It took reading real output.

---

## 5. Concurrency

| Property | Proof |
| --- | --- |
| Three concurrent indexers over one repository | No edge has more than one open interval, asserted by SQL |
| Repeated under load | Three consecutive full-suite runs after the ordering fix |
| Exclusive relationships under concurrent writers | Inherited from EPIC-007's advisory-lock suite, still passing unchanged |

---

## 6. Performance

| Measurement | Observed | Budget |
| --- | --- | --- |
| First index of Ferret (61 commits, 278 files) | 17.3 s | — |
| Second, incremental | 9.3 s | must be cheaper than the first |
| Test fixture, 16 commits | ~4 s first, less on the second | 60 s |

---

## 7. Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **The file tree is read in full on every run.** Only history is incremental. | The second run is cheaper but not cheap: 9.3 s against 17.3 s on this repository. A tree hash comparison against the watermark would make an unchanged revision nearly free. | ~~EPIC-032~~ **unassigned** — see Owner correction |
| ~~**An out-of-order observation does not move an interval's start backwards.**~~ | **No longer true — verified by EPIC-076.** `relationships.ts:204` deletes and replaces the row when an earlier observation arrives, so the start *does* move backwards and exactly one interval stays open. Proved by `tests/integration/indexing/incremental-sync.test.ts` — "moves an interval start backwards for an earlier observation". The fix landed with the noon-query defect and nobody struck this row. | **Resolved** |
| Indexing is one repository at a time, sequentially, with no back-pressure. | Correct and slow. Parallelism across repositories is a scheduling decision. | ~~EPIC-032~~ **EPIC-078** — see Owner correction |
| No untracked working-directory state. | Everything indexed is committed state. "What am I working on right now" is a different read. | ~~EPIC-032~~ **unassigned** — see Owner correction |
| ~~The watermark is per repository, not per branch.~~ | **No longer true — verified by EPIC-076.** `watermarkScopeId` derives the scope from the repository *and* the revision (issue #19), so `HEAD` and a feature branch hold separate cursors. Proved by `incremental-sync.test.ts` — "keeps one cursor per revision, so neither skips the other". The row announced a real correctness gap that had already been closed. | **Resolved** |
| A failed run repeats rather than resumes. | Deliberate: resuming from a position never reached would leave a permanent gap. Costly for a very large first index. | ~~EPIC-032~~ — accepted, see Owner correction |
| `--since` re-reads the boundary second. | Documented; the alternative risks losing history. On a fast runner an entire small history can be created inside one second, in which case an "incremental" run legitimately re-reads all of it — which is why the test asserts that the second run *writes* nothing rather than that it *reads* less. | — |

---

## Owner correction — 2026-09-02

**Rows above whose Owner read `EPIC-032` have had that owner struck.** The
limitations themselves are unchanged and still true; only the assignment was
wrong, and it is struck rather than overwritten so the original claim stays
readable.

EPIC-032 — Index Lifecycle & Tombstones — is VALIDATED, and its scope never
covered any of this. Its §4 (Non-scope) says so directly: "**Scheduled or
unattended indexing.** Not this Epic and not this registry entry; EPIC-075/076
own synchronization." Nine rows across four validation documents were parked on
it anyway, and EPIC-076 added one more while assigning the file tree back to
EPIC-032 — two closed Epics pointing at each other over live work.

This is the class of defect EPIC-076 named and did not have scope to fix:
"Nothing sweeps limitation tables for records the code has outgrown, so the next
stale one will also wait for an Epic to be pointed at it."

**Nothing was absorbed into EPIC-032.** Each row was re-read and given the owner
its own recorded reasoning implies, and where that reasoning does not determine
one, it says `unassigned` rather than guessing:

| row | new owner | why |
| --- | --- | --- |
| rate limiter is per-process | **EPIC-078** | the row's own parenthetical read "EPIC-032 *(scheduling)*" — it was naming the scheduling Epic by the wrong number, and Periodic Reconciliation is that Epic |
| no circuit breaker | **EPIC-078** | "Suppressing work across operations is a scheduling decision, not a provider one" — which also rules out EPIC-014 |
| no incremental repository discovery | **EPIC-077** | "It needs a filesystem watcher", and Event & Webhook Ingestion is where event-driven sources belong |
| indexing is sequential, no back-pressure | **EPIC-078** | "Parallelism across repositories is a scheduling decision" |
| offset paging is O(offset) | *none — accepted* | the row's own Impact settles it: "The read that matters for a running Ferret is the incremental one (`since`)." An accepted cost, not parked work |
| a failed run repeats rather than resumes | *none — accepted* | "Deliberate: resuming from a position never reached would leave a permanent gap." A design decision, recorded as one |
| a merge commit's changes are absent | **unassigned** | "choosing which is a modelling decision" — commit modelling is EPIC-020, which is closed, so this is a new criterion and needs governance |
| the file tree is read in full every run | **unassigned** | EPIC-076 assigned it here; EPIC-032's non-scope assigns synchronization to EPIC-075/076. Both are closed and neither claims it |
| no untracked working-directory state | **unassigned** | "'What am I working on right now' is a different read." No Epic in the registry covers it |

The three `unassigned` rows are tracked in
[#117](https://github.com/indoulia/Ferret/issues/117). They are **not** new P0
scope: no P0 acceptance criterion depends on any of them, which is why they were
parked rather than built.
