# EPIC-007 — Architecture Decisions

Decisions taken while implementing the Relationship & Temporal Model, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19).

---

## D-001 — A table with indexes, not a graph database

**Decision.** Relationships live in `ferret.relationship`, indexed on each
direction.

**Alternatives.** Neo4j or another graph store; a recursive-CTE-oriented design.

**Reason.** Governance §14 requires additional infrastructure to be justified by
measured requirements, and §23 warns against accumulating it for architectural
fashion. The traversals Ferret needs are shallow and typed — "which release
contains this commit", "who reviewed this pull request" — not arbitrary-depth
path finding, and PostgreSQL answers those from an index.

Introducing a second datastore would also fork the transactional boundary:
an entity and its relationships could no longer commit together, and every
ingestion would have to reason about partial failure across two systems.

**Revisit when** EPIC-050 measures a traversal that PostgreSQL cannot serve.

---

## D-002 — Relationships are bitemporal

**Decision.** `valid_from`/`valid_to` record when the fact was true in the world.
`first_indexed_at`/`last_indexed_at` record when Ferret learned and last
confirmed it.

**Reason.** AC-6 requires temporal queries to distinguish observed time from
indexed time, and one clock cannot do it. A commit authored last year and
indexed today is not a fact about today, and "what did this look like last
Tuesday" is a different question from "what did Ferret believe last Tuesday" —
the second is what you ask when you are debugging Ferret rather than the code.

The separation also makes staleness measurable (EPIC-057): a relationship whose
`last_indexed_at` is old may be stale regardless of how recent its valid time is.

---

## D-003 — Valid intervals are half-open

**Decision.** `[validFrom, validTo)` — a relationship that ended at T was not
true *at* T.

**Reason.** Exclusive relationships hand over at an instant: one closes and the
next opens at the same timestamp. With closed intervals both would be true at
that instant, and a point-in-time query would return two answers to a question
that has one. Half-open intervals make the handover unambiguous without any
special case, and a test asserts exactly one answer at the handover instant.

---

## D-004 — Identity includes the start of the interval

**Decision.** A relationship's id derives from `(fromId, type, toId, validFrom)`.

**Alternatives.** `(fromId, type, toId)` alone, with the interval as mutable
state.

**Reason.** The same edge can be true over several disjoint periods — a file
removed from a directory and later restored, a branch checked out, detached and
checked out again. Identity without time collapses those into one and makes the
history unrepresentable, which defeats the point of recording time at all.

Including `validFrom` also gives idempotency for free: a replayed event produces
the same id and conflicts on a unique index rather than inserting again.

---

## D-005 — Types declare which entity kinds they may connect

**Decision.** Each relationship type names its permitted `fromKinds` and
`toKinds`; `createRelationship` checks them when the caller supplies endpoint
kinds.

**Reason.** AC-4 requires branch and worktree relationships to stay distinct, and
Governance §9 forbids conflating the two. Declared endpoint kinds make that a
*rule*: `REPOSITORY_CONTAINS_BRANCH` cannot end at a worktree whatever a provider
intends, and `WORKTREE_CHECKS_OUT_BRANCH` cannot start at a branch.

Type names read `SUBJECT_VERB_OBJECT` so direction is unambiguous at every call
site. A relationship is directed: `a CONTAINS b` is not `b CONTAINS a`.

Some types deliberately leave an end unconstrained — evidence can support
anything, and `ENTITY_SUPERSEDES_ENTITY` connects any two entities of a kind.
Unconstrained is a decision, recorded as `undefined` rather than an empty list.

---

## D-006 — Some types are exclusive from their source

**Decision.** A type may declare `exclusiveFrom`. Asserting a new relationship of
an exclusive type closes any other open one from that entity.

**Reason.** A branch points at exactly one commit; a worktree has at most one
branch checked out; a deployment deploys one release. Without exclusivity, a
branch that had moved five times would appear to point at five commits at once —
a stream of observations rather than a history.

Exclusivity is per type, not global: a commit modifies many files, and a release
includes many commits.

---

## D-007 — Exclusive assertions take a transaction-scoped advisory lock

**Decision.** `pg_advisory_xact_lock(hash(fromId, type))` before the read, inside
the transaction.

**Reason.** Found by test. Eight concurrent assertions each read a snapshot in
which no *other* relationship was open, so none closed the others and all eight
remained open — write skew under PostgreSQL's default READ COMMITTED isolation,
and invisible to single-threaded testing.

The lock is taken **before the read**, because the point is to make the whole
read-decide-write sequence atomic; a lock acquired afterwards protects nothing.
It is keyed on `(fromId, type)` rather than on the type alone, so two providers
asserting about different branches never wait on each other — a test asserts
that four branches assert in parallel.

`pg_advisory_xact_lock(bigint)` uses a **separate lock space** from the
two-argument form EPIC-002's migrator takes, so the two cannot collide. Being
transaction-scoped, it releases on commit or rollback with no unlock call, so a
failed transaction cannot strand it.

**Alternative rejected.** A partial unique index on
`(from_id, type) WHERE valid_to IS NULL` would let the database enforce it, but
the index is table-wide and would wrongly forbid a commit from having several
open `commit_modifies_file` relationships.

---

## D-008 — Out-of-order events are reconciled, not dropped

**Decision.** Asserting an interval (a) truncates any interval — open **or
already closed** — that covered its start, and (b) bounds itself by the earliest
interval that starts later.

**Reason.** The advisory lock alone left two open intervals rather than eight,
which was the more interesting bug. Closing only intervals that start at or
before the new one is correct in isolation — an older observation must not close
a newer interval — but it leaves the timeline inconsistent when events arrive
out of order.

Rule (a) must include already-closed intervals: inserting Jan 5 between an
existing Jan 3–Jan 8 would otherwise leave two intervals covering the same days,
and "close whatever is open" misses it because Jan 3 is already closed. Rule (b)
is what lets a late-arriving older event become history rather than either being
dropped or wrongly becoming current — Governance §15 forbids silently discarding
conflicting evidence.

The resulting invariant is checked at whole-table level: exactly one open
interval per exclusive `(entity, type)`, and no two intervals overlapping.

---

## D-009 — Retiring closes, never deletes

**Decision.** `retire` sets `valid_to`. Nothing in the store removes a row.

**Reason.** Governance §6 forbids discarding source evidence. A relationship that
simply vanished would be indistinguishable from one that was never observed, and
"when did this stop being true" is one of the questions the temporal model exists
to answer.

`retire` also refuses an event claiming a relationship ended before it began.
Recording an impossible interval would make every temporal query defend against
it forever.

---

## D-010 — Self-loops are rejected

**Decision.** A relationship may not connect an entity to itself.

**Reason.** It is almost always a provider bug — a commit is not its own parent,
and both endpoints resolving to the same canonical entity usually means a mapping
collapsed two things that differ. Letting one in produces traversals that never
terminate, and the failure surfaces far from its cause.

---

## D-011 — A checked-out `pg` client gets its own error handler

**Decision.** `createPool` attaches `pool.on('connect', client => client.on('error', …))`.

**Reason.** Found by this Epic's test run, and not an EPIC-007 concern at all —
it is a live crash in shipped code.

`pg` attaches its pool-level error handler only to *idle* clients. A client
checked out for a transaction has none, so when PostgreSQL terminates that
backend — an administrator command, a failover, a restart — the `FATAL 57P01`
arrives as an unhandled `error` event and **Node ends the process**. Every
Drizzle transaction and the whole of a migration hold a checked-out client, so a
routine server restart would have killed the user's AI session rather than
failing one query.

Attaching at `connect` rather than at each borrow covers every borrower,
including ones inside Drizzle that Ferret never sees. The operation still fails,
and still fails with a classified error; what it no longer does is take the
process down.

The full test run had been reporting this as an unhandled error *while still
passing* — the shape of defect that gets ignored indefinitely. The suite now
completes with zero unhandled errors, which is worth keeping true.
