# EPIC-076 — Incremental Source Synchronization

**Status: APPROVED | Priority: P0 | Domain: Synchronization & Reconciliation**

> **Specification note.** Two records park work here by name
> (`validation/EPIC-031-VALIDATION.md:81` and `:193`), and EPIC-075 delivered
> the cursor this Epic reads. Authored to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
>
> **Both parked records appear to be stale.** §2 says why, and verifying that
> rather than assuming it is most of this Epic's work.

## 1. Objective

Prove that a second run over an unchanged source reads less and writes nothing,
and make the record of what is *not* incremental true.

## 2. Problem, measured

Ferret's ingestion is incremental: history is read from the cursor, the
re-parse gate skips unchanged files, and every write path is idempotent
(EPIC-080). What is not established is the *end-to-end* property — that running
twice costs less the second time and changes nothing — and what is actively
wrong is the record of the gaps.

**Two limitations are parked on this Epic and both look already fixed.**

`validation/EPIC-031-VALIDATION.md:193` records:

> **An out-of-order observation does not move an interval's start backwards.**
> An earlier observation of an already-open fact reports `updated` but leaves
> `valid_from` where it was. → **EPIC-076**

`src/storage/relationships.ts:204` now reads:

```ts
if (new Date(canonical.validFrom) < stillOpen.validFrom) {
  await tx.delete(relationship).where(eq(relationship.id, stillOpen.id));
}
```

The row is deleted and replaced, so the start *does* move backwards. The comment
above it records how it was found — *"asking Ferret what this repository
contained at noon and getting back only files that had not been touched
since"* — which is a later fix that nobody went back to strike from the record.

The same file's table also records:

> **The watermark is per repository, not per branch.** … **This is a real
> correctness gap, not just a performance one.**

`watermarkScopeId` (`src/indexing/indexer.ts:856`) derives the scope from the
repository *and the revision*. Issue #19 closed that gap and the table still
announces it.

**A stale limitation is worse than an unrecorded one.** It sends the next person
to fix something twice, or to distrust a guarantee that holds. EPIC-094 found a
control that had never worked because nothing called it; this is the mirror
image — a defect record that outlived its defect.

**What is genuinely not incremental** is the file tree: it is listed in full on
every run. EPIC-031's table assigns that to EPIC-032, and it stays there.

## 3. Scope

1. **Verify each recorded synchronization limitation against the code**, by
   test rather than by reading, and correct or confirm the record.
2. **Prove the end-to-end property**: a second run over an unchanged repository
   writes no new entity, relationship or evidence row, and reads fewer commits.
3. **Prove per-revision cursors**: indexing two revisions keeps two cursors, so
   one does not skip what the other has not seen.
4. **State what is not incremental** and whose it is.

## 4. Non-scope

- **Making the file tree incremental** — EPIC-032, where EPIC-031's table
  already assigns it. A tree-hash comparison against the cursor is the shape,
  and it is not this Epic's.
- **Scheduling, timers, unattended runs** — EPIC-078.
  **Answered 2026-09-03 by [EPIC-078](EPIC-078-Periodic-Reconciliation.md):**
  `ferret reconcile` is the pass a scheduler runs, and Ferret still owns no
  timer — cron, a systemd timer and Task Scheduler each already survive a
  reboot and log when they ran.
- **Webhooks and event ingestion** — EPIC-077.
- **The cursor mechanism** — EPIC-075, delivered.
- **Parallelism across repositories** — EPIC-032.
- **Changing what a run reads.** This Epic measures and records; it adds no
  optimisation, because an optimisation without a measurement is a guess.

## 5. Inputs

`SyncCursorStore` (EPIC-075); the indexer's incremental path and `IndexReport`
(EPIC-031); `RelationshipStore.assert`'s out-of-order handling (EPIC-007);
EPIC-080's idempotence proofs.

## 6. Outputs

- Tests proving the end-to-end property and the per-revision cursor.
- The two EPIC-031 records corrected against what the code does.

## 7. Dependencies

EPIC-007, EPIC-031, EPIC-075, EPIC-080 — VALIDATED or IMPLEMENTED.

## 8. Contracts

### A second run reads less and writes nothing

Two separate claims, and both need proving. *Writes nothing* is idempotence and
EPIC-080 proved it per store; here it is proved for a whole run, by counting
rows. *Reads less* is incrementality, and is visible in the report: a second run
reports fewer commits read than the first.

### One cursor per revision, not per repository

Indexing `HEAD` and then a feature branch must not let either skip what the
other has not seen. The scope is derived from repository *and* revision, and a
test asserts two cursors exist rather than one.

### A record that no longer describes the code is corrected, not left

Governance §6 is about representing what is true. A limitation table is a claim
about the product, and a stale one is a false claim that happens to be
pessimistic. Correcting it requires evidence, which is why each is verified by
test before the record is touched.

## 9. Acceptance criteria

- **AC-1** A second index run over an unchanged repository creates no entity,
  relationship or evidence row, proved by counting.
- **AC-2** A second run reports fewer commits read than the first.
- **AC-3** An earlier observation of an already-open relationship moves
  `valid_from` backwards, and leaves exactly one open interval.
- **AC-4** Indexing two revisions of one repository produces two cursors, and
  neither advances the other.
- **AC-5** The two EPIC-031 records are corrected or confirmed, with the test
  that decided it named.
- **AC-6** What is not incremental — the file tree — is stated, with its owner.
- **AC-7** No change is made to what a run reads or writes.

## 10. Test requirements

Integration against real PostgreSQL and real `git`. AC-1 and AC-2 by indexing a
fixture twice; AC-3 against the relationship store directly, because
constructing an out-of-order observation through a Git fixture would be a test
of `git` rather than of the property; AC-4 by indexing two revisions.

## 11. Security requirements

None beyond the existing paths. The tests add no credential and no fixture
containing one.

## 12. Observability

`IndexReport.incremental` and `commitsRead` already carry the evidence; EPIC-075
made cursor age visible. This Epic adds no field.

## 13. Performance constraints

The second-run test indexes a small fixture twice and must stay inside the
existing suite budget.

## 14. Definition of Done

Acceptance criteria satisfied; `npm run verify` green; a validation document;
the registry updated; the EPIC-031 records corrected with evidence.

## 15. Governance alignment

- **§10** — incremental *and* idempotent, proved together rather than
  separately.
- **§6** — a limitation record must describe the product as it is.
- **§19** — measure the property; do not claim it.

## 16. Raised, not absorbed

- **This Epic may find a record is right after all.** If a limitation still
  holds, it is confirmed and left, with the test that shows it. Correcting a
  record because it looks stale would be the same error in the other direction.
- **The file tree stays non-incremental.** Recorded rather than fixed: a
  tree-hash comparison is EPIC-032's, and doing it here would take that Epic's
  scope on the strength of noticing it.
