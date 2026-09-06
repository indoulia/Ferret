# EPIC-132 — Multi-Agent Shared Context: validation evidence

**Status: VALIDATED** · two distinct agents share one Ferret with provenance,
scope and lifecycle intact — and one real isolation defect was found by running
them together. **No migration, no model change.**

## Environment

| | |
| --- | --- |
| Tree | `eb47448` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | two `McpServer` instances, two `Client`s, two transports |
| Database | `ferret-dogfood`, PostgreSQL 17 + pgvector |
| Date | 2026-09-06 |

## The two agents

They differ in every way a client can, and share only the store.

| | A | B |
| --- | --- | --- |
| principal | `agent.indexer` | `agent.reviewer` |
| permissions | read, record, **mutate** | read, record |
| producer | `agent.indexer/1.0` | `agent.reviewer/2.0` |
| server / transport | its own | its own |

## Dogfood — Ferret's own index

```
A recorded                                            2
B reads back without being told                       2
B sees who stated it                    agent.indexer/1.0
  and its authority                                  20
B restates A — outcome                           merged
  one record, observations now                        2
A proposes — B sees it as current?                false
A accepts — B sees it now?                         true
B archiving A's constraint                      refused
B promoting A's session   refused — No session you own has that identifier.
  A's working note visible to B                        no
A promoting its own session — created                  1
  shared once A offered it                            yes
durable context records in Ferret                      4
durable context stores per agent                       0
```

Every property the Epic asks for, across a real boundary:

- **Shared.** B reads A's records without being told they exist.
- **Provenance.** B sees `agent.indexer/1.0` stated it — the producer, not the
  caller.
- **No duplication.** B's restatement in different words **merged**; one record,
  two observations. Neither agent's copy.
- **Lifecycle.** A's proposal is a proposal for B; A's acceptance makes it
  current for B, with no message between them.
- **Scope.** B holds `record` and not `mutate`, and was refused the curation A
  has.
- **Isolation.** B could not publish A's working note; A could, and only then
  was it shared.
- **Neither owns it.** Four records in Ferret, zero durable context stores per
  agent.

## The defect running two agents found

**`ferret_context_promote` did not check who was asking.**

Any agent holding `record` could name another agent's session id and publish
that agent's working memories as shared organizational knowledge. Introduced by
EPIC-129, and precisely the scope item this Epic exists to test — *"agent-specific
working state remains isolated to each agent."*

**Proven against the unfixed code.** Reverting the check and re-running:

```
× refuses to let one agent publish another agent's session
    AssertionError: expected true to be false
× lets the owner promote its own session
    AssertionError: expected +0 to be 1
```

The first is A's private note appearing in **B's own** `ferret_context_find`.
The second is the consequence: by the time the owner promoted it, B already had.

The fix is one comparison. `actorId` comes from the composition root, never from
tool input — the same rule as `producer`, and for the same reason.

**The refusal discloses nothing.** *"No session you own has that identifier"* is
true whether the id names nothing or names another agent's work, so a caller
learns nothing about whose sessions exist. A test asserts both cases return the
identical message.

## Recorded for EPIC-133, not fixed here

`ferret_session_recall` and `ferret_session_show` take a session id and enforce
no ownership either, so one agent can **read** another's session. That is
read-access control and belongs to EPIC-133, which owns ownership and access.

Not folded in, deliberately: reading another agent's notes and **publishing**
them as durable organizational knowledge are different acts, and only the second
was this Epic's to close. Widening here is how the boundary this Epic exists to
prove would get blurred.

## Suites

| Suite | Result |
| --- | --- |
| `tests/integration/mcp/multi-agent-context.test.ts` | 9 passed |
| `tests/integration/mcp/*` | 212 passed |
| Full suite | see the PR |
| lint · typecheck · build | clean |
