# EPIC-080 — Idempotent Ingestion

**Status: APPROVED | Priority: P0 | Domain: Synchronization & Reconciliation**

> **Specification note.** Two records park work here by name:
> `Checkpoints/EPIC-006.md:130` and `validation/EPIC-006-VALIDATION.md:136`,
> both about `upsertMany`'s batch semantics. Governance §10 states the property
> itself. Authored to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).

## 1. Objective

Prove that every ingestion write path is idempotent, and keep it that way — so
"re-indexing is safe" is a property with a test rather than a habit.

## 2. Problem

Governance §10:

> Ingestion must be incremental and idempotent. Reprocessing unchanged content
> must not create duplicate logical entities.

Ferret takes this seriously and mostly gets it right. Entities upsert on a
canonical key; relationships assert on identity; evidence deduplicates by
content hash; content blobs deduplicate by hash; the re-parse gate skips
unchanged files; the watermark makes a second run incremental. Several Epics
assert a piece of it — EPIC-087 AC-3, EPIC-094 AC-12, EPIC-031's second-run
tests.

**Each of those asserts its own path.** Nothing asserts the property across all
of them, and nothing enumerates the paths. There are at least nine write
methods across the storage layer, and a tenth added tomorrow is idempotent only
if its author remembered — which is precisely the shape of every defect
EPIC-100 was written for.

That this is not hypothetical was established three Epics ago. **EPIC-094 found
`content_hash` was a function of a timestamp's *spelling* rather than its
value** — an idempotence defect in the exact mechanism idempotence rests on,
undetected because nothing recomputed a hash from a stored row. The same class
of bug in a path nobody enumerated would be equally invisible.

`upsertMany` carries a known, recorded gap: it applies entities one transaction
at a time, so a mid-batch database failure leaves some applied. Recorded twice
by EPIC-006 and assigned here.

## 3. Scope

1. **An enumerated idempotence invariant**: every write method on the storage
   layer is either covered by a "twice writes nothing new" proof, or explicitly
   declared as not-idempotent-by-design with a reason.
2. **A second run over an unchanged source writes nothing**, proved end to end
   rather than per store.
3. **`upsertMany`'s batch semantics stated and tested** — whatever they are,
   they stop being an open question.
4. **The recorded gap discharged or restated** with what the evidence supports.

## 4. Non-scope

- **Making a non-idempotent path idempotent.** If the invariant finds one, it is
  filed against its owning Epic. This Epic measures and states.
- **Sync cursors and incremental synchronization** — EPIC-075, EPIC-076. This is
  about repeating a write safely, not about deciding what to read.
- **Retry and backoff** — EPIC-079, VALIDATED. A retry is *why* idempotence
  matters and is not this Epic's mechanism.
- **Making `upsertMany` one transaction.** That is a batch-atomicity change with
  lock-duration consequences, and EPIC-006 owns the store. This Epic states the
  semantics and tests them; changing them is a decision with an owner.
- **Deduplication of content** — EPIC-087, delivered.
- **Reconciliation and tombstones** — EPIC-032.

## 5. Inputs

The storage write methods (`EntityStore.upsert`/`upsertMany`,
`RelationshipStore.assert`, `EvidenceStore.record`, `SymbolStore.indexFileSymbols`,
`ContentStore.store`, `CompatibilityService.recordArtifact`,
`IndexRunStore.start`, `EmbeddingStore.record`); the outcome enums each returns;
the enumeration pattern from EPIC-100.

## 6. Outputs

- An enumerated invariant over the storage write surface.
- An end-to-end second-run proof.
- A stated batch semantic for `upsertMany`.

## 7. Dependencies

EPIC-006, EPIC-007, EPIC-008, EPIC-031, EPIC-034, EPIC-087, EPIC-094 — all
VALIDATED or IMPLEMENTED.

## 8. Contracts

### Idempotent means "writes nothing new", not "does not fail"

A method that runs twice without erroring is not idempotent if the second call
rewrites a row. Ferret's stores already say so: they return `created`,
`updated`, `unchanged`, `deduplicated`. The invariant is on the **outcome**, not
on the absence of an exception.

### Not every write should be idempotent, and those are named

`IndexRunStore.start` records an *attempt*; two runs are two rows, and
collapsing them would destroy the history EPIC-094 built. A path like that is
declared, with its reason, rather than excluded silently — an unexplained
exemption is how a real gap hides.

### The enumeration is read from the source

A hand-written list covers what its author remembered. The set of write methods
is read from the storage layer, so the tenth one fails the invariant until it is
either proved or declared.

## 9. Acceptance criteria

- **AC-1** Every public write method on the storage layer is either proved
  idempotent or declared exempt with a reason; a new one is neither and fails.
- **AC-2** The enumeration is read from the source and fails when it finds no
  write methods.
- **AC-3** `EntityStore.upsert` twice with identical input reports `unchanged`
  and leaves the row byte-identical.
- **AC-4** `RelationshipStore.assert`, `EvidenceStore.record`,
  `ContentStore.store`, `SymbolStore.indexFileSymbols` and
  `CompatibilityService.recordArtifact` each report their no-op outcome on a
  second identical call, and add no row.
- **AC-5** A second `ferret index` over an unchanged repository writes no new
  entity, relationship or evidence row — proved by counting, not by reading a
  report.
- **AC-6** `upsertMany`'s transaction semantics are stated in its own
  documentation and asserted by a test, whatever they are.
- **AC-7** The two EPIC-006 records naming this Epic are discharged or restated
  against what the evidence supports.
- **AC-8** An exempt path's reason is asserted present, so an exemption cannot be
  added as a bare name.

## 10. Test requirements

- **Integration, real PostgreSQL** — AC-3 to AC-5. Counting rows before and
  after, because a store's own report of "unchanged" is the thing under test and
  cannot also be the evidence.
- **Structural** — AC-1, AC-2, AC-8, enumerated from the source.
- **No new fixture for AC-5** where an existing suite already indexes a
  repository twice; extend rather than duplicate.

## 11. Security requirements

None beyond the existing paths: this Epic writes nothing new and reads what the
stores already expose. A test fixture adds no credential.

## 12. Observability

The outcome enums are the observability and already exist. This Epic adds no
field and no log line.

## 13. Performance constraints

The invariant is structural plus a small number of double-writes against a real
database. It must not add materially to the suite.

## 14. Definition of Done

Acceptance criteria satisfied; `npm run verify` green; a validation document;
the registry updated; anything found filed against its owning Epic.

## 15. Governance alignment

- **§10** — the sentence this Epic exists for.
- **§6** — an enumerated proof rather than an assertion that it has always
  worked.
- **§19** — measure the property; do not claim it.

## 16. Raised, not absorbed

- **This Epic may find a non-idempotent path.** If it does, it is filed, not
  fixed here — the fix belongs with the store's Epic, and a measurement that
  repairs what it measures cannot be trusted about what it found.
- **`upsertMany`'s gap may be stated rather than closed.** Making a batch one
  transaction lengthens lock duration for large batches, which is a trade
  EPIC-006 should make deliberately. Stating the current semantics precisely is
  worth more than changing them incidentally.
