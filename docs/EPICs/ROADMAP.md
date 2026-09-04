# Ferret — Reconstructed Engineering Roadmap

**Status: PROPOSED** · Base: `9bae9f2` · Reconstructed: 2026-09-05

## Why this document exists

Registry v3.0 closed 108 Epics: 107 `VALIDATED`, 1 `DONE`, 76/76 P0. It is a
delivery map for work that is finished, and it does not say what comes next.
This document derives the next roadmap **from the repository itself** — the
implementation, the tests, the Epic non-scope statements, the CLI surface and
the open issues — rather than from any external plan.

Nothing here is approved scope. Each entry carries a classification, and only
`CONTINUATION` and `HARDENING` entries may proceed autonomously. An entry marked
`PRODUCT DECISION REQUIRED` stops at the decision and names it.

## Method

Every entry below is anchored to evidence already in the tree. The strongest
class of evidence is an Epic that **excluded a capability by name** and assigned
it elsewhere: that is a deferral the repository made explicitly, and closing it
is continuation, not invention.

The two `(planned)` CLI rows are the repository's own statement of what it does
not yet do. `src/cli/commands/planned.ts` names them, exits `5` with
`E_NOT_IMPLEMENTED`, and cites the owning Epics.

## Status

| Priority | Epic | Classification | Status | Evidence | Dependencies | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | EPIC-109 — Session & Memory Persistence | CONTINUATION | **COMPLETE** | 28 integration cases against real PostgreSQL; migration `0015`; latent hashing defect fixed | EPIC-039–043, EPIC-086 | Done — see EPIC-109 |
| 2 | EPIC-110 — `ferret session` command surface | CONTINUATION | **COMPLETE** | 20 integration cases driving the built binary; planned entry retired | EPIC-109 | Done — see EPIC-110 |
| 3 | EPIC-111 — Session recall over MCP | CONTINUATION | NEXT | MCP tool catalogue exists; session domain unreachable from it | EPIC-109, EPIC-110 | Expose `session recall`/`show`/`list` as MCP tools |
| 4 | EPIC-112 — Session retention & redaction | HARDENING | TODO | `retention.ts` (EPIC-088) covers no session table; captures hold transcripts | EPIC-109, EPIC-082, EPIC-088 | Extend prune/retention to session rows |
| 5 | EPIC-113 — Provider sync transport (`ferret sync`) | PRODUCT DECISION REQUIRED | BLOCKED | `planned.ts` sync entry; EPIC-021/071/072 each excluded transport by name; `cursors.ts` exists | EPIC-075, EPIC-021, EPIC-071 | See "Decisions required" |
| 6 | EPIC-114 — PostgreSQL version coverage | HARDENING | TODO | EPIC-002 validation: minimum supported major is 14, **only 17 measured** | EPIC-002 | Add a CI matrix major |
| 7 | EPIC-115 — macOS packaging validation | HARDENING | TODO | EPIC-001 validation: macOS not validated | EPIC-105 | Requires a macOS runner |
| 8 | EPIC-116 — Session export fidelity | PRODUCT DECISION REQUIRED | BLOCKED | The four session tables are declared excluded from `ferret export`; the loss is stated in the manifest | EPIC-109, EPIC-089 | See "Decisions required" |
| — | #138 registry hygiene | HARDENING | OPEN | Three limitation rows with no owning Epic | — | Not reopened this run |
| — | #130 packaging gate flake | HARDENING | OPEN | Gate failed once, passed twice on one tree | — | Intermittent; not chased |

## EPIC-109 — Session & Memory Persistence

**Classification:** CONTINUATION · **Priority:** P0 · **Domain:** Session & Agent Memory

### Problem

Ferret describes itself as a *persistent* engineering context layer. The Session
& Agent Memory domain — session identity, transcript capture, checkpoints,
extracted engineering memory and recovery — is fully modelled, validated and
tested, and **none of it survives the process**. A session that ended still
takes its context with it, which is the exact failure EPIC-043 was written to
prevent.

### Existing evidence

- `EPIC-041` non-scope: *"Database tables, retention policy, or encryption
  implementation; those belong to storage/security Epics."* The deferral is
  explicit and the receiving Epic was never written.
- `EPIC-041` scope: *"Serialization suitable for durable storage by later
  storage/integration work."*
- `EPIC-039` outcome: *"…so later capture, checkpoint, memory, and recovery
  capabilities can **persist and retrieve** useful context."*
- `src/domain/session-recovery.ts` defines `SessionRecoveryPort`
  (`getSession`, `latestCheckpoint`, `memoriesFor`). Repository-wide search
  finds **one** implementation — a test double in
  `tests/unit/session-recovery.test.ts`. There is no production adapter.
- `src/cli/commands/planned.ts`: *"the session and memory model exists and is
  tested as a library; **no store persists it** and no command reaches it."*
- No `session` table exists in any of the 14 migrations.

### Current implementation baseline

Four immutable, validated domain values with deterministic canonical ids and
content hashes — `Session`, `SessionCapture`, `SessionCheckpoint`,
`EngineeringMemory` — plus `recoverSession`/`resumeSession` orchestration over
the port. 986 lines of domain code, exercised by five unit suites.

### User/product value

Session memory that outlives the session: a later agent recovers what an earlier
one decided, constrained and left unfinished, without replaying a transcript.

### Engineering scope

- Migration `0015_session_store.sql`: four tables in the `ferret` schema.
- Drizzle schema `src/storage/schema/sessions.ts`.
- `SessionStore` in `src/storage/sessions.ts`, implementing `SessionRecoveryPort`.
- Export through `src/storage/index.ts`.

### Non-scope

- The `ferret session` command (EPIC-110).
- MCP surfacing (EPIC-111).
- Retention and redaction of session rows (EPIC-112).
- Any change to the domain model. Persistence adapts to the domain, never the reverse.

### Dependencies

EPIC-039, EPIC-040, EPIC-041, EPIC-042, EPIC-043, EPIC-086.

### Risks

- **Domain drift.** A store that re-validates or re-derives risks two
  definitions of a session. Mitigated by reconstructing through the domain
  constructors on read, never by hand.
- **Identity mismatch.** Canonical ids are content-derived; a store that
  generates its own would break `recoverSession`. Mitigated by persisting the
  domain id as the primary key.
- **Sequence races.** Capture and checkpoint sequences are monotonic per
  session. Enforced in the database, not only in the domain.

### Acceptance criteria

1. A session round-trips through the store unchanged, including optional scope and lineage.
2. Session lifecycle persists; a terminal session cannot be reopened by a write.
3. Captures persist with their sequence, kind and content hash; a duplicate `(session, sequence)` is rejected by the database.
4. Checkpoints persist; `(session, checkpoint_sequence)` is unique and monotonic.
5. Engineering memories persist with origin, confidence, evidence links and supersession.
6. `SessionStore` satisfies `SessionRecoveryPort` and `recoverSession` works against it unmodified.
7. A recovered session reconstructs values equal to what was written, hashes included.
8. Rows are scoped to the `ferret` schema and participate in the existing migration and compatibility machinery.
9. Storage failures classify through `classifyDatabaseError`.
10. Integration tests run against real PostgreSQL.

### Expected tests

Integration (real PostgreSQL): round-trip for each of the four values; duplicate
sequence rejection; monotonic checkpoint enforcement; supersession; lineage walk
through the real store via `recoverSession`; empty-recovery reporting; error
classification. Unit: none new — the domain is already covered and must not be
re-tested through the store.

## Decisions required

### EPIC-116 — Session export fidelity

`ferret export` narrows a scoped export by **entity id**, and a session is not an
entity: `session.repository_id` is free text precisely so a session can be
recorded outside any repository Ferret has indexed (EPIC-039 AC-3). Carrying
sessions in a full export while silently dropping them from a scoped one is the
exact silence F-45 was about, so EPIC-109 declared all four tables excluded and
stated the loss in the manifest rather than exporting them partially.

The decision needed is what a scoped export of a session *means*:

1. Does a repository-scoped export carry the sessions whose `repository_id`
   matches, given that the column is text and may hold something that is not an
   entity id at all?
2. Does a transcript belong in a portable document? `content_blob` already
   carries indexed file content, so there is precedent — but a session
   transcript is a different kind of record and EPIC-089 never considered one.
3. If memories travel, must the captures they cite travel with them? EPIC-042
   forbids a memory whose evidence did not arrive.

Until these are answered, `pg_dump` is the stated recovery, which is what
EPIC-089 §8.1 already assigns it.

### EPIC-113 — Provider sync transport

`ferret sync` cannot be built from repository evidence alone. The GitHub and
Jira providers, PR/review modelling and sync cursors all exist and are tested,
but three product questions have no answer in the tree:

1. **Credential persistence at rest.** `EPIC-081` isolates credentials in
   memory and `EPIC-015` resolves provider secrets from configuration. Neither
   establishes whether a long-running sync may store a token, or must re-resolve
   per invocation.
2. **Scheduling model.** Whether `sync` is a one-shot operator command, a
   daemon, or both. `EPIC-078` reconciliation is a command; `EPIC-077` webhook
   ingestion explicitly declined to be a server.
3. **Conflict policy on re-ingest.** `EPIC-080` guarantees idempotent
   ingestion; it does not say whether a remotely edited issue overwrites local
   evidence or forks it.

These are product decisions, not implementation details. EPIC-113 stops here
until they are recorded. Items 1–4 and 6 above are independently executable and
proceed first.

## Completion record

Filled in as Epics land.

| Epic | Commit | PR | Merge | Status |
| --- | --- | --- | --- | --- |
| EPIC-109 | `452980d` | [#156](https://github.com/indoulia/Ferret/pull/156) | `ec0a376` | COMPLETE |
| EPIC-110 | `pending` | — | — | IMPLEMENTED |
