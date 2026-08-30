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
| **The file tree is read in full on every run.** Only history is incremental. | The second run is cheaper but not cheap: 9.3 s against 17.3 s on this repository. A tree hash comparison against the watermark would make an unchanged revision nearly free. | **EPIC-032** |
| **An out-of-order observation does not move an interval's start backwards.** | An earlier observation of an already-open fact reports `updated` but leaves `valid_from` where it was. Never having two open intervals is worth more. | **EPIC-076** |
| Indexing is one repository at a time, sequentially, with no back-pressure. | Correct and slow. Parallelism across repositories is a scheduling decision. | **EPIC-032** |
| No untracked working-directory state. | Everything indexed is committed state. "What am I working on right now" is a different read. | **EPIC-032** |
| The watermark is per repository, not per branch. | Indexing `HEAD` then a feature branch advances one watermark, so a later `HEAD` run may skip commits it has not seen on that branch. **This is a real correctness gap, not just a performance one.** | **EPIC-032** |
| A failed run repeats rather than resumes. | Deliberate: resuming from a position never reached would leave a permanent gap. Costly for a very large first index. | **EPIC-032** |
| `--since` re-reads the boundary second. | Documented; the alternative risks losing history. On a fast runner an entire small history can be created inside one second, in which case an "incremental" run legitimately re-reads all of it — which is why the test asserts that the second run *writes* nothing rather than that it *reads* less. | — |
