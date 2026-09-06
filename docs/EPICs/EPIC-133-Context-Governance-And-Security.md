# EPIC-133 — Context Governance & Security

**Status:** IMPLEMENTED
**Priority:** P0
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

Durable organizational context is exposed and mutated only within authorized
scope, its provenance stays auditable, and its retention is explicit — chosen by
the caller, never by Ferret.

## Boundary held

> Do not build a parallel authorization architecture. Reuse Ferret's existing
> security and access-context patterns where applicable.

Nothing new was built. Every control here is one Ferret already had —
`Permission`, the tool guard, `permissionScope` on evidence, `source.scope` on
the entity, `authorityFor(method)`, `RetentionService` — applied to durable
context. The largest change is **one comparison** and **one removed field**.

## What was closed

**A session is read by the agent that ran it.** `ferret_session_recall` and
`ferret_session_show` took an identifier and enforced no ownership, so one agent
could read another's working state. Found while proving EPIC-132 and recorded
there for this Epic rather than folded in — reading another agent's notes and
publishing them as durable knowledge are different acts, and EPIC-132 closed
only the second.

**`ferret_session_list` no longer takes an actor.** The field is *removed*, not
defaulted: a parameter that is ignored is a parameter someone will believe.
Listing another agent's sessions disclosed how much work it had done and when,
and handed over the identifiers every other session read takes. The local CLI
operator surface is untouched — `ferret session` composes `SessionStore`
directly and never these tools.

**The refusal discloses nothing.** *"No session you own has that identifier"* is
returned for an unknown identifier and for another agent's session alike, so a
caller cannot enumerate another agent's work by probing. Stated once in
`notYours` rather than three times, because a rule written three times holds in
two places.

## Retention, and what it refuses

`RetentionTarget.CONTEXT` reclaims **archived** durable context past an age the
caller names, with the observations behind it.

The three states it never reclaims are the substance of the decision:

| State | Never reclaimed, because |
| --- | --- |
| `superseded` | it is the record of a decision that changed, and *"why did we change our mind"* is a question this model exists to answer |
| `active` | age is not evidence that something stopped being true — EPIC-057 refused a decay curve for the same reason |
| `candidate` | a proposal nobody accepted is unanswered, not abandoned; reclaiming it decides by timeout what nobody decided |

Archiving is a deliberate act by an agent holding `mutate`, saying a statement no
longer applies with nothing replacing it. Reclaiming those after an age is the
one deletion this model can defend.

`archivedOlderThanDays` is required and has no default, on EPIC-088 §8.3's rule
that Ferret does not choose how long the record of its own work lasts. A caller
that names no age reclaims nothing and is told why.

## Scope

- Session-read ownership on `recall` and `show`; the actor field removed from
  `list`.
- `RetentionTarget.CONTEXT` and `RetentionRequest.archivedOlderThanDays`.
- Security tests over the whole of it.

## Non-scope

- Any new permission, principal class or policy engine.
- Targeted deletion of a single statement. Credentials are already removed
  before a statement acquires an identity (EPIC-126), so the case that would
  justify it is already prevented; adding a destructive tool for a case that
  cannot arise is surface without a reason.
- Ownership of a *statement*. A durable statement is the organization's, and its
  provenance names who said it. Inventing an owner would make it somebody's
  property, which is the opposite of a shared record.

## Acceptance criteria

- **AC-1** A reader may not record.
- **AC-2** A recorder may not retire what others rely on.
- **AC-3** An agent may not read another agent's session.
- **AC-4** The refusal is identical for an absent session and another's.
- **AC-5** An agent may not publish another agent's session.
- **AC-6** The owner may read and publish its own.
- **AC-7** A trust report counts only support the caller may see, and echoes no
  scope token.
- **AC-8** An agent's statement is recorded as `asserted`, and no input field
  can set its producer, method, authority, confidence or permission scope.
- **AC-9** Retention reclaims nothing without an age the caller named.
- **AC-10** Retention reclaims archived context and its evidence.
- **AC-11** Retention never reclaims current, proposed or superseded context.
- **AC-12** A plan deletes nothing.

## Test requirements

`tests/security/context-governance.test.ts` — 13 cases against real PostgreSQL,
driving real MCP clients. The session-read case is **proven against the unfixed
code**.

## Security requirements

Every control is an existing one. `actorId` and `producer` come from the
composition root, never from tool input. Support is read with the caller's
permitted scopes. Deletion is opt-in, age-gated by the caller, and refuses three
states outright.

## Definition of Done

Security, targeted and full suites green; lint, typecheck, build clean; evidence
in `validation/EPIC-133-VALIDATION.md`.
