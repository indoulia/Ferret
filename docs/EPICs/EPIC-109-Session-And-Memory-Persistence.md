# EPIC-109 — Session & Memory Persistence

**Status:** IMPLEMENTED  
**Priority:** P0  
**Domain:** Session & Agent Memory  
**Classification:** CONTINUATION

## Outcome

Give the Session & Agent Memory domain somewhere to live, so a session's
checkpoint and what it decided survive the process that produced them and a
later session can recover them.

## Why this Epic exists

EPIC-039 to EPIC-043 modelled a session, captured it, checkpointed it, extracted
what it decided and orchestrated recovery — and each of them excluded
persistence *by name*. EPIC-041 assigned it explicitly:

> **Non-scope:** Database tables, retention policy, or encryption
> implementation; those belong to storage/security Epics.

No storage Epic was ever written. The consequence was visible from three places
in the tree at once: `SessionRecoveryPort` had a single implementation and it
was a test double; `ferret session` exited `5` with `E_NOT_IMPLEMENTED`; and
`planned.ts` said in as many words that "no store persists it". A session that
ended still took its context with it, which is the failure EPIC-043 exists to
prevent.

This Epic is the deferred half, and nothing more.

## Scope

- Migration `0015_session_store.sql` — `session`, `session_capture`,
  `session_checkpoint`, `engineering_memory` in the `ferret` schema.
- `src/storage/schema/sessions.ts` — Drizzle declarations for the query layer.
- `src/storage/sessions.ts` — `SessionStore`, implementing `SessionRecoveryPort`.
- The export contract's answer for the four new tables.

## Non-scope

- The `ferret session` command — EPIC-110.
- MCP surfacing — EPIC-111.
- Retention and redaction of session rows — EPIC-112.
- Carrying sessions in `ferret export` — EPIC-116, which needs a decision this
  Epic does not have. The tables are declared excluded, with the loss stated.
- Changes to the domain model, beyond the defect below that persistence exposed.

## The defect persistence exposed

`SessionCheckpoint.contentHash` covered `checkpointedAt` **as the caller spelled
it**. Stored in a `timestamptz`, `2026-09-01T14:30:00+05:30` reads back as
`2026-09-01T09:00:00.000Z` — the same instant, different bytes — so the hash
could not be recomputed from the stored row and `verifySessionCheckpointIntegrity`
would have reported every non-UTC checkpoint as tampered.

This is the defect `canonicalInstant` was written for: EPIC-094 hit it on
entities and evidence, where it reported 135 commits, 14 files and 16
relationships as corrupt when nothing was. `entity.ts`, `evidence.ts` and
`relationship.ts` canonicalise the instant before hashing; `session-checkpoint.ts`
did not, because nothing had ever stored a checkpoint.

Fixed by the established pattern, not a new one. The same commit collapses the
checkpoint's two copies of its hashed field list into one — the write path and
the verify path were separate implementations of one hash, which is the exact
arrangement EPIC-094 found drifting in `evidence.ts`.

No stored data was affected: there was none.

## Design

**Four tables, not one.** A session, its transcript, its checkpoints and what it
decided have different lifetimes and different value. EPIC-042 separated them in
the domain for that reason and collapsing them here would undo it.

**The store derives nothing.** No ids, no hashes, no policy. The domain is the
authority on what these values mean and a second opinion would be a second
definition. Reconstruction on read is structural rather than through the domain
constructors, because `createSession` always yields an *active* session and
running it on read would silently resurrect every session that had ended; the
invariants it would have enforced are enforced by the table's constraints
instead.

**Instants are `timestamptz` and hashes canonicalise.** The alternative —
storing the spelling — keeps the bytes and loses every temporal query, which is
the wrong trade for tables retention will have to sweep.

**Two links are deliberately not foreign keys.** `parent_session_id`, because
`recoverSession` already treats an unresolvable parent as the end of a lineage
and a constraint would refuse to record a continuation whose parent was pruned;
and memory supersession, because the two halves can be written in either order.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A session round-trips, with optional scope and lineage | `sessions.test.ts` — "a session round-trips" |
| 2 | Lifecycle persists; a terminal session cannot be amended | "lifecycle persists and terminal sessions are immutable" |
| 3 | Captures persist; a taken sequence is rejected by the table | "captures persist and a sequence is not reusable" |
| 4 | Checkpoint sequences are unique per session | "rejects a reused checkpoint sequence" |
| 5 | Memories persist with origin, evidence and supersession | "memories persist with origin, evidence and supersession" |
| 6 | `SessionStore` satisfies `SessionRecoveryPort` and `recoverSession` runs unmodified | "recoverSession runs unmodified against the store" |
| 7 | A checkpoint written with an offset verifies after the round trip | "a checkpoint written with an offset still verifies when read back" |
| 8 | The tables participate in migration and compatibility machinery | `compatibility.test.ts` upgrades from every prior version; `schema-agreement.test.ts` |
| 9 | Storage failures classify as Ferret errors | "storage failures classify" |
| 10 | Every write method is proved idempotent or declared exempt | `idempotence.test.ts` — three proofs added |

## Tests

28 integration cases in `tests/integration/storage/sessions.test.ts` against real
PostgreSQL, plus three idempotence proofs, one unit case for the hashing defect,
and the four tables registered with the schema-agreement and backup contracts.

Unit coverage was deliberately not added for the domain: it is already covered by
five suites, and re-testing it through the store would assert the store's opinion
of the domain rather than the domain.

## Dependencies

EPIC-039, EPIC-040, EPIC-041, EPIC-042, EPIC-043, EPIC-086.

## Definition of done

All acceptance criteria implemented and tested against a real server; the export
contract answers for every new table; documentation current; merged through
normal governance.
