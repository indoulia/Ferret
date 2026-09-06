# EPIC-127 — Context Lifecycle & Authority

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

For any durable statement Ferret holds, it can say whether that statement is
current, what state it is in if not, which evidence it rests on, and — when
nothing in the evidence decides — that nothing decides.

## Problem

EPIC-126 gave durable context two states: `active` and `superseded`. That is
enough to stop a replaced statement polluting retrieval and not enough to answer
the question this Epic is accepted on. Three gaps:

- **Nothing could be proposed.** Every write was immediately believed, so an
  agent had no way to record a statement it was not yet asserting.
- **Nothing could be retired.** A statement that had stopped applying, with
  nothing replacing it, could only be superseded — which promises a replacement
  a reader can go to — or left standing.
- **Authority was ranked but never reported.** `preferredEvidence` decided which
  observation wins and nothing surfaced the decision, so "why should I believe
  this" was answerable only by reading the evidence table by hand.

## Design

**Two lifecycle states, not five.** `candidate` and `archived` join
`LifecycleState`; `current` is the existing `active`. There is deliberately no
`historical` state — historical is the *category* that `superseded`, `archived`
and `deleted` fall into, exported as `HISTORICAL_LIFECYCLE_STATES`. A sixth
value meaning the same as `superseded` would claim to add something it does not.

`entity.lifecycle` is plain `text` with no CHECK constraint, so this needed **no
migration**. `retrieval/freshness.ts` already anticipated it — its `STANDING`
table is keyed by string with an "unrecognised is unassessed" fallback and is
spaced by tens *"so a rank can be inserted later without renumbering"*. Both
insertions used the gaps.

| State | Standing | Why there |
| --- | --- | --- |
| `active` | 0 | current |
| `candidate` | 10 | stated in full, merely unaccepted — outranks `unknown` |
| `unknown` | 20 | Ferret has only heard *of* it |
| `deleted` | 40 | gone at its source |
| `archived` | 45 | retired deliberately, but nothing replaces it |
| `superseded` | 50 | a replacement is retrievable, so the old one is worst |

**Transitions touch the entity and nothing else.** `accept`, `archive`,
`reinstate` and the existing `supersede` all move one column and recompute the
content hash (issue #118). Evidence is never rewritten — which is what
"provenance preserved across transitions" has to mean, and is asserted rather
than assumed.

**Writes stay `active` by default.** A producer that is proposing says
`state: 'candidate'`; making every write need acceptance would be an approval
workflow nobody asked for. A restatement of a candidate adds support without
promoting it, because `EntityStore.upsert` never changes a stored row's
lifecycle.

**The trust report** answers the acceptance question from what is already
recorded: the state, the preferred supporting evidence with its authority,
confidence, method and observation time, the contradictions the merger found,
and what superseded what. When `preferredEvidence` declines to decide, `trust`
reports `undecided` rather than a pick.

## Scope

- `candidate` and `archived` lifecycle states, with standing and explanations.
- `accept`, `archive`, `reinstate` transitions; evidence untouched.
- `DurableContextStore.trust` — the current/authoritative/why report.
- `ContextQuery.states` — current, historical, or every state, explicitly.

## Non-scope

- RBAC, ownership, retention and audit — EPIC-133.
- Any agent-facing MCP tool or CLI command — EPIC-128.
- Deciding a contradiction Ferret has no ground to decide.

## Contract change

`ContextQuery.includeSuperseded` is **replaced** by `ContextQuery.states`. A
boolean could say "current" and "everything" and nothing else; with candidates
and archived records in the model it cannot express what a caller means, and two
ways to ask one question is one too many. EPIC-126 merged one commit earlier and
nothing outside this repository consumes it.

## Acceptance criteria

- **AC-1** A candidate is recorded, kept out of current reads, and findable when
  asked for.
- **AC-2** Restating a candidate adds support without promoting it.
- **AC-3** `accept` promotes it and preserves every observation.
- **AC-4** `archive` retires without deleting; `reinstate` reverses it.
- **AC-5** A transition that is not a transition is refused, and changes nothing.
- **AC-6** `trust` reports a current record with the evidence behind it.
- **AC-7** `trust` reports a superseded record as not the answer, and names the
  one that is.
- **AC-8** `trust` reports `undecided` when nothing in the evidence separates two
  sources.
- **AC-9** `trust` reports a contradiction without resolving it.
- **AC-10** `trust` is permission-scoped: support the caller may not see is not
  counted.
- **AC-11** Every record in a new state still verifies under `ferret verify`.

## Test requirements

`tests/integration/storage/context-lifecycle.test.ts` — 13 cases against real
PostgreSQL, one per criterion. `tests/unit/retrieval-freshness.test.ts` — the
two new standing bands and their explanations.

## Security requirements

`trust` requires `permittedScopes` rather than defaulting it — EPIC-083's rule
that a read which can forget to say who is asking will. Its `reason` string is
assembled from the lifecycle state and counts only and never from a statement,
so no tool output has a hole for indexed content.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; dogfood evidence
against Ferret's own index in `validation/EPIC-127-VALIDATION.md`.
