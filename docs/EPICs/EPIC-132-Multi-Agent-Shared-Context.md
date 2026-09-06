# EPIC-132 — Multi-Agent Shared Context

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

Two genuinely distinct agent clients use one Ferret for durable context, with
provenance, scope and lifecycle intact across the boundary and each agent's
working state still its own.

## What this Epic is not

> This EPIC is proof of the architecture, not an excuse to build a new
> multi-agent orchestration system.

So almost nothing is built. Two clients are composed over one store and the four
properties are asserted between them. There is no coordinator, no protocol
between agents, no shared session and no new mechanism: the second agent simply
asks Ferret what it holds.

## What the proof needed, and what it found

Most of the architecture was already agent-independent by construction:
`DurableContextPort` names no vendor, identity derives from the statement rather
than the author, and evidence records the producer. What had never been shown was
**two clients at once** — every dogfood before this used one.

Running two found a real defect.

**`ferret_context_promote` did not check who was asking.** Any agent holding
`record` could name another agent's session id and publish that agent's working
memories as shared organizational knowledge. Introduced by EPIC-129, and exactly
the scope item this Epic exists to test: *"agent-specific working state remains
isolated to each agent."*

Promotion now requires the calling principal to own the session. The `actorId`
comes from the composition root, never from tool input — the same rule as
`producer`, and for the same reason: a caller that could name its own identity
could name someone else's.

**The refusal does not say which case it is.** *"No session you own has that
identifier"* is true whether the id names nothing or names another agent's work,
so a caller learns nothing about whose sessions exist, while a legitimate owner
who mistyped one still gets an actionable answer.

## Recorded for EPIC-133

`ferret_session_recall` and `ferret_session_show` take a session id and enforce
no ownership either, so one agent can **read** another's session. That is a
read-access question and belongs to EPIC-133, which owns ownership and access
control. It is recorded here rather than fixed, because widening this Epic into
access control is how the boundary it is meant to prove gets blurred.

The distinction is not a technicality: reading another agent's notes and
**publishing** them as durable organizational knowledge are different acts, and
only the second was this Epic's to close.

## Scope

- Proof that two distinct clients share one durable context.
- `ContextToolDependencies.actorId`, and the ownership check on promotion.

## Non-scope

- Any orchestration, coordination or agent-to-agent protocol.
- Read access control across agents — EPIC-133.
- Any change to how durable context is modelled. Nothing here needed one.

## Acceptance criteria

- **AC-1** One agent reads what another recorded, without being told.
- **AC-2** The reader sees who stated it, not who asked.
- **AC-3** A restatement by a second agent merges rather than duplicating.
- **AC-4** A lifecycle transition by one agent is visible to the other.
- **AC-5** One agent may supersede another's statement, and both stay readable.
- **AC-6** An agent granted less is refused the curation the other has.
- **AC-7** An agent cannot promote another agent's session.
- **AC-8** The refusal is identical for an unknown id and another's session.
- **AC-9** The owner can promote its own session, and it then becomes shared.
- **AC-10** Neither agent holds a durable context store of its own.

## Test requirements

`tests/integration/mcp/multi-agent-context.test.ts` — 9 cases, two MCP servers,
two clients, two principals, two producers and one real PostgreSQL. The
isolation case is **proven against the unfixed code**.

## Security requirements

`actorId` comes from the composition root. The ownership refusal discloses
nothing about sessions the caller does not own. No second authorization
architecture is introduced: the check is one comparison against the principal
the guard already enforces permissions for.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; two distinct
agents driven against Ferret's own index in
`validation/EPIC-132-VALIDATION.md`.
