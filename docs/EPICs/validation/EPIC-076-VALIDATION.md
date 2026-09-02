# EPIC-076 — Incremental Source Synchronization · Validation Evidence

**Assessed against:** working tree on top of `43f6db7`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, real `git`.

## What changed

No production code. This Epic measures a property and corrects a record, and
§4 said it would add no optimisation, because an optimisation without a
measurement is a guess.

| before | now |
| --- | --- |
| every write path proved idempotent individually (EPIC-080) | a **whole run** proved to write nothing, by counting rows across `entity`, `relationship` and `evidence` |
| `IndexReport.incremental` and `commitsRead` reported but never asserted across runs | a second run asserted to read *fewer commits* than the first |
| two limitations parked on this Epic in EPIC-031's table | both **verified by test** and struck, each naming the test that decided it |

## The two parked records were stale, and that is the finding

Both looked already fixed from reading the code. **Looking is not evidence** —
§16 said a record must not be corrected because it *seems* stale, since that is
the same error as leaving a true one. So each got a test first.

**`EPIC-031-VALIDATION.md:193` — "an out-of-order observation does not move an
interval's start backwards".** It does. `relationships.ts:204` deletes and
replaces the row when an earlier observation arrives, because `validFrom` is
part of relationship identity and editing in place would leave an id that no
longer derives from the row it names. The fix landed with the *"asking Ferret
what this repository contained at noon and getting back only files that had not
been touched since"* defect, and nobody went back to strike the row.

**Same file — "the watermark is per repository, not per branch … a real
correctness gap".** It is not. `watermarkScopeId` derives the scope from the
repository *and* the revision; issue #19 closed it. The table went on
announcing a correctness gap in a product that no longer had one.

**A stale limitation is worse than an unrecorded one.** It sends the next person
to fix something twice, or to distrust a guarantee that holds. EPIC-094 found a
control that had never worked because nothing called it; this is the mirror
image — a defect record that outlived its defect. Two of them, in a VALIDATED
document, and the only reason they were caught is that an Epic was pointed at
them by name.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 a second run creates no entity, relationship or evidence row | MET | counted before and after, all three tables unchanged; `entities.created === 0`. Counted rather than read from the report, because the report saying `unchanged` is the thing under test |
| AC-2 a second run reads fewer commits | MET | `second.commitsRead < first.commitsRead`, and `incremental === true`. Distinct from AC-1: a run that re-read everything and wrote nothing would pass AC-1 and fail this |
| AC-3 an earlier observation moves `valid_from` backwards, one interval open | MET | asserted against the store; one row, `valid_from` at the earlier instant, `valid_to` null |
| AC-4 two revisions keep two cursors | MET | `HEAD` then `feature` leaves more than one additional cursor; the assertion that keeps issue #19 closed |
| AC-5 the EPIC-031 records corrected or confirmed | MET | both struck with the deciding test named, and the narrative paragraph corrected too — a struck table row above an uncorrected paragraph is still a false claim |
| AC-6 what is not incremental is stated with its owner | MET | the file tree, listed in full every run, assigned to EPIC-032 where EPIC-031's table already put it |
| AC-7 no change to what a run reads or writes | MET | no file under `src/` touched; the existing indexing suites pass unchanged |

## Judgements worth review

**AC-3 is tested against the store, not through a Git fixture.** Constructing an
out-of-order observation through `git` would test `git`'s ordering rather than
the property. The property is the one EPIC-031 parked here, so it is asserted
where it lives.

**AC-4 asserts "more than one more cursor", not an exact count.** The exact
number depends on how many scopes a run touches, which is EPIC-031's business
and not a fact this Epic should pin. What matters is that two revisions do not
share one cursor.

**The file tree stays non-incremental.** Recorded rather than fixed. A
tree-hash comparison against the cursor is the shape, and it is EPIC-032's —
doing it here would take that Epic's scope on the strength of noticing it.

## Verification

`npm run verify` green: 123 files, 2 549 passed, 3 skipped. New:
`tests/integration/indexing/incremental-sync.test.ts` (4).

## Raised, not absorbed

- **`commitsRead` decreasing is a proxy for cost, not cost.** It is the
  strongest signal the existing report carries, and asserting wall-clock time
  would be a flaky test of the machine rather than of Ferret. If EPIC-032 adds
  a read-cost metric, this assertion should move onto it.
- **Two records were stale in a VALIDATED document.** Nothing sweeps limitation
  tables for records the code has outgrown, so the next stale one will also wait
  for an Epic to be pointed at it. Worth an Epic of its own; not this one's, and
  not fixed by noticing it here.
