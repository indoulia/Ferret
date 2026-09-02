# EPIC-080 — Idempotent Ingestion · Validation Evidence

**Assessed against:** working tree on top of `19788d1`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17.

## What was and was not already true

Governance §10 — *"Ingestion must be incremental and idempotent. Reprocessing
unchanged content must not create duplicate logical entities."*

Ferret gets this right, and several Epics assert a piece of it. **Nothing
asserted it across the write surface, and nothing enumerated that surface.**
There are sixteen write methods in the storage layer:

```
[EPIC-080] write methods: compatibility.ts:assertSafeToWrite, compatibility.ts:recordArtifact,
compatibility.ts:markStale, content.ts:store, embeddings.ts:record, entities.ts:upsert,
entities.ts:upsertMany, evidence.ts:record, evidence.ts:markStale, lifecycle.ts:retire,
lifecycle.ts:reinstate, relationships.ts:assert, relationships.ts:retire, runs.ts:start,
runs.ts:finish, symbols.ts:indexFileSymbols
```

Each is now proved idempotent or declared exempt with a reason, and the set is
read from the source — so the seventeenth fails until it is one or the other.

That this matters is not hypothetical. EPIC-094 found `content_hash` was a
function of a timestamp's *spelling* rather than its value: an idempotence
defect in the mechanism idempotence rests on, invisible because nothing
recomputed a hash from a stored row.

## What the enumeration surfaced

Three methods my first proof list did not cover — which is the enumeration doing
exactly its job:

- **`compatibility.markStale`** — idempotent in *state*, not in bytes. A second
  call matches the same rows, and they end `stale` both times; `last_checked_at`
  moves, which is that column's entire purpose. Proved, with the distinction
  stated rather than glossed.
- **`relationships.retire`** — a second call finds nothing open to close and
  returns `undefined`. Asserted with a *later* timestamp on the repeat, because
  the property that matters is that a retry does not move the moment a fact
  stopped being true.
- **`evidence.markStale`** — declared exempt. It is a state transition on
  append-only data and EPIC-008 owns proving it; asserting it second-hand here
  would be this Epic taking another's evidence.

Writing those tests also caught two mistakes in my own fixtures — a relationship
retired *before* its `validFrom`, and a raw query returning a timestamp as a
string — neither of which is a product defect, both of which would have made a
passing test meaningless.

## `upsertMany`, stated

The two EPIC-006 records asked what its batch semantics are. They are:

- **Validation is atomic for the batch.** Every entity is validated before any
  is written, so a partial batch can never contain invalid data. Asserted.
- **Application is per entity.** A mid-batch database failure leaves earlier
  entities applied.

**And that is sufficient, because the batch is idempotent.** A partial batch
plus a retry equals a complete batch — asserted directly: three entities,
`created ×3` then `unchanged ×3`, with no new rows. Atomicity would buy
tidiness at the cost of a longer lock on large batches, which is EPIC-006's
trade to make deliberately rather than one to fall into here.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 every write method proved or declared | MET | 16 enumerated; 13 proved, 3 exempt with reasons |
| AC-2 enumerated from source, fails closed | MET | scans `src/storage/*.ts`; asserts at least eight found |
| AC-3 `upsert` twice is unchanged, byte-identical | MET | outcome `unchanged`, row count static, content hash equal |
| AC-4 the other stores report their no-op outcome | MET | `assert`, `record`, `store`, `recordArtifact` each asserted with a row count either side |
| AC-5 a second index writes no new row | **PARTIAL** | asserted per store rather than end to end; see Raised |
| AC-6 `upsertMany` semantics stated and tested | MET | both halves above, each with a test |
| AC-7 the EPIC-006 records discharged | MET | both restated with what the evidence supports |
| AC-8 an exemption needs a reason | MET | asserted non-trivial in length, so a bare name cannot pass |

## Verification

`npm run verify` green: 120 files, 2 527 passed, 3 skipped. New:
`tests/integration/storage/idempotence.test.ts` (12 checks).

## Raised, not absorbed

- **AC-5 is partial and was not padded to look complete.** Every store is proved
  idempotent individually, and `tests/integration/indexing/content-indexing.test.ts`
  already asserts a second run skips unchanged files. What is *not* here is a
  single test that indexes a repository twice and counts every table. It would
  be worth having; it needs a repository fixture and an index run, and the
  per-store proofs plus the existing second-run test cover the same ground less
  directly. Recorded rather than claimed.
- **No non-idempotent path was found.** §16 said one would be filed against its
  owning Epic rather than fixed here. There was nothing to file, which is a
  better outcome than the last four Epics produced and worth stating plainly.
- **`upsertMany` computes each entity twice.** It validates the batch by calling
  `createEntity` on every input, discards the results (`void canonical`), and
  then calls `upsert`, which validates and hashes again. Harmless and wasteful;
  EPIC-006 owns the store, and changing it is not this Epic's scope. Noted
  because the discarded variable reads like an unfinished intention.
- **The exemption list is an escape hatch.** It requires a reason and the reason
  is length-checked, which stops a bare name but not a bad one. The real control
  is that adding to it is visible in a diff.

---

## Addendum — 2026-09-02

**AC-5 is now MET. The row above is not rewritten** — it was true when written,
and Governance §12 and the project's rule on historical evidence both forbid
tidying a record to match today.

What was missing was named precisely: "a single test that indexes a repository
twice and counts every table." EPIC-076 built it two merges later, in
`tests/integration/indexing/incremental-sync.test.ts` — *"writes no new row on a
second run over an unchanged repository"*. It indexes an unchanged repository
twice and counts `entity`, `relationship` and `evidence` before and after, which
is AC-5 as written:

> **AC-5** A second `ferret index` over an unchanged repository writes no new
> entity, relationship or evidence row — proved by counting, not by reading a
> report.

Checked rather than assumed on two points. The test composes the indexer with
content **off**, which is `ferret index`'s default (`--content` is opt-in,
`index-command.ts`), so the three tables the criterion names are the three a
default run touches. And the counts are taken from `SELECT count(*)`, not from
`IndexReport` — the distinction AC-5 insists on.

One residue, stated rather than glossed: the test drives `RepositoryIndexer`
directly rather than spawning the CLI. The composition is the same one
`index-command.ts` builds, and EPIC-080 §10 asked for this to extend an existing
suite rather than add a fixture, which is what happened.

Also new since this document: `lifecycle.ts:retireBranch`, added by EPIC-032
AC-7, is enumerated by AC-1's write-surface scan and proved idempotent in
`tests/integration/indexing/index-lifecycle.test.ts` — *"changes nothing on the
run after the retirement"*. The enumeration caught it on the commit that added
it, which is what AC-1 exists to do.
