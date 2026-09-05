# EPIC-109 — Session & Memory Persistence: validation evidence

**Status: VALIDATED** · four tables, one migration, one store, no domain change.

## Why this record is late

The registry's [Specification files](../README.md#specification-files) rule says
an Epic's specification and the work that satisfies it are authored together and
reviewed in the same pull request, and each validation document states that
plainly. EPIC-109 shipped in [#156](https://github.com/indoulia/Ferret/pull/156)
with a specification and no validation record, and so did EPIC-110, EPIC-111 and
EPIC-112 after it. The Definition of Done's last clause — *validation evidence is
recorded* — was therefore unmet on four merged Epics, and the registry catalog
did not list them at all.

This record is written **after** the merge, which is a deviation from that rule
and is recorded rather than smoothed over. What follows is measured on the merged
tree at `22d9255`, not reconstructed from the pull request.

## Environment

| | |
| --- | --- |
| Tree | `22d9255` (`main`) |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | Real PostgreSQL 17 + pgvector, local container |
| Date | 2026-09-05 |

## What the Epic does

EPIC-039 through EPIC-043 modelled a session, captured it, checkpointed it,
extracted what it decided and orchestrated recovery — and every one of them
excluded persistence by name. `SessionRecoveryPort` had exactly one
implementation and it was a test double.

Migration `0015_session_store.sql` adds four tables in the `ferret` schema —
`session`, `session_capture`, `session_checkpoint`, `engineering_memory` —
`src/storage/schema/sessions.ts` declares them, and `SessionStore`
(`src/storage/sessions.ts`, 12 methods) implements the port. The store derives no
identifier and computes no hash: reads reconstruct through the domain
constructors, so the domain stays the only definition of what a session is.

## Acceptance criteria

Measured run: `tests/integration/storage/sessions.test.ts` — **28 tests passed,
991 ms**, against real PostgreSQL.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 a session round-trips, with optional scope and lineage | PASS | `returns what was written, including optional scope and lineage`; `omits optional scope rather than inventing it — EPIC-039 AC-3`; `is undefined when nothing was recorded` |
| AC-2 lifecycle persists; a terminal session cannot be amended | PASS | `advances an active session`; `records an ending`; `refuses a write that would amend a session that has ended`; `accepts an unchanged replay of a terminal session`. Enforced in the table by `session_status_known` and `session_ended_with_status` |
| AC-3 captures persist; a taken sequence is rejected by the table | PASS | `round-trips a turn with its kind, hash and metadata`; `orders a transcript by sequence, not by insertion`; `rejects a second turn claiming a taken sequence`; `refuses a capture for a session that was never recorded`. The refusal is the constraint `session_capture_sequence_unique`, not application logic |
| AC-4 checkpoint sequences are unique per session | PASS | `returns the newest by sequence`; `rejects a reused checkpoint sequence`; `is undefined for a session that never checkpointed`. Constraint `session_checkpoint_sequence_unique` |
| AC-5 memories persist with origin, evidence and supersession | PASS | `round-trips an explicit memory`; `round-trips an extracted memory with the captures behind it`; `re-recording the same memory does not duplicate it — EPIC-042`; `keeps both halves of a supersession`; `refuses an extracted memory with no evidence, whatever built it`. Constraints `engineering_memory_extracted_has_evidence` and `engineering_memory_not_self_superseding` carry EPIC-042's rules into the table |
| AC-6 `SessionStore` satisfies `SessionRecoveryPort`; `recoverSession` runs unmodified | PASS | `assembles a checkpoint and memories from what was recorded`; `walks a real lineage across sessions`; `drops superseded memories and says how many — EPIC-043`; `reports an empty recovery as empty rather than as context`; `ends a lineage at a parent that is not on record`. No EPIC-043 source was changed |
| AC-7 a checkpoint written with an offset verifies after the round trip | PASS | `a checkpoint written with an offset still verifies when read back`, plus one unit case in `session-checkpoint.test.ts`. See the defect below |
| AC-8 the tables participate in migration and compatibility machinery | PASS | `compatibility.test.ts` — **30 tests passed, 5 825 ms**, including `upgrades a database at version 0 to the current version`, `upgrades a database at version 3 to the current version` and `reaches an identical schema however many steps it took`. `schema-agreement.test.ts` — **5 tests**, 149 columns compared |
| AC-9 storage failures classify as Ferret errors | PASS | `reports a Ferret error rather than a driver error` — through `classifyDatabaseError`, not a bare driver throw |
| AC-10 every write method proved idempotent or declared exempt | PASS | `idempotence.test.ts` — **15 tests passed**. The EPIC-080 sweep now names `sessions.ts:save`, `sessions.ts:saveCheckpoint` and `sessions.ts:recordMemory` in its write-method list |

Two further cases beyond the criteria — `counts the sessions on record` and
`lists an actor's sessions, newest first` — cover the reads EPIC-110 and
EPIC-111 later built on.

## The latent defect persistence exposed

`SessionCheckpoint.contentHash` hashed `checkpointedAt` **as the caller spelled
it**. Nothing had ever stored a checkpoint, so nothing had ever round-tripped one
through `timestamptz` — and the first that did would have come back with a
different spelling of the same instant and been reported as tampered. Every
non-UTC checkpoint, on the first read.

This is precisely what `canonicalInstant` was written for; `entity.ts`,
`evidence.ts` and `relationship.ts` all canonicalise through it, and
`session-checkpoint.ts` did not. Fixed by the established pattern rather than a
new one. The same change collapses the checkpoint's two copies of its hashed
field list into one — the write path and the verify path were separate
implementations of a single hash, the arrangement EPIC-094 caught drifting in
`evidence.ts`.

**No stored data was affected, because there was none.** The defect was reachable
only through the store this Epic introduced.

## Governance controls answered rather than moved

- **EPIC-080 — every write method idempotent or exempt.** Three proofs added. A
  replayed checkpoint is *rejected* rather than absorbed, and still writes
  nothing new: a checkpoint's id derives from its session and sequence but not
  its summary, so a second write at a taken sequence is ambiguous and storage
  refuses instead of guessing.
- **EPIC-089 — every table exported or declared excluded.** All four are
  excluded, with the loss stated in the manifest. A scoped export narrows by
  entity id and a session is not an entity, so carrying sessions in a full export
  while dropping them from a scoped one would be the exact silence F-45 was
  about. `pg_dump` is the stated recovery, which is what EPIC-089 §8.1 already
  assigns it. The decision this defers is tracked as
  [ROADMAP EPIC-116](../ROADMAP.md), still `PRODUCT DECISION REQUIRED`.
- **EPIC-101 — the index-count pin.** Raised from 28 to 32, with the review the
  pin exists to force.

## Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Sessions are excluded from `ferret export`.** Recorded above; the manifest states the loss rather than exporting partially. | A portable export does not carry session history. `pg_dump` does. | ROADMAP EPIC-116 — blocked on a product decision |
| **No write path over MCP.** EPIC-111 exposed recall only. | An MCP client can read what a prior session decided and cannot record what this one decided. | ROADMAP EPIC-117 — blocked on a product decision |
| **Validated on PostgreSQL 17 only.** The declared minimum major is 14. | Inherited from EPIC-002, not introduced here. | ROADMAP EPIC-114 |
| **Validation recorded after the merge.** Stated at the top of this document. | The record is measured, but it was not reviewed alongside the change. | This record |

## Governance alignment

| Rule | How EPIC-109 satisfies it |
| --- | --- |
| §6 Evidence before inference | Every criterion above cites a named test that was run on this tree, and the two criteria that depend on machinery outside this Epic cite that machinery's own run |
| §12 Security | Redaction of session content is EPIC-112's, declared non-scope here rather than half-built |
| §19 Testing and quality | Integration against real PostgreSQL, never a mock store; no unit test re-tests the domain through the store |
| §21 Versioning | Migration `0015` participates in the existing compatibility machinery, proved from version 0 and from version 3 |
| AI Rule §3 Epic scope is a contract | The command surface, the MCP surface and retention are each another Epic's, and none was started here |
| AI Rule §9 No fake completion | The late record, the deferred export and the two blocked follow-ons are stated above rather than omitted |
