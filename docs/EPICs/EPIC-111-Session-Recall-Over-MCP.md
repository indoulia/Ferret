# EPIC-111 — Session Recall over MCP

**Status:** IMPLEMENTED  
**Priority:** P1  
**Domain:** AI Control Plane & MCP · Session & Agent Memory  
**Classification:** CONTINUATION

## Outcome

Make session recall reachable by the caller the Session & Agent Memory domain
exists for: an AI client.

## Why this Epic exists

EPIC-109 made a session's context durable and EPIC-110 gave an operator a
command for it. Neither helped an AI client, which is usually a process with no
shell, no `ferret` on its path, and no way to read another process's exit code.
`ferret session recall` was exactly as reachable to it as `ferret status --json`
was before EPIC-070 — which is to say, not at all.

This is the same finding EPIC-070 recorded, in the same shape, one domain over:
the capability was real, tested, and structured for a client that could not
call it.

## Scope

- `src/mcp/session-tools.ts` — three read-only tools.
- `SessionAccess` port on `McpServerDependencies`; the composition root in
  `src/cli/commands/mcp.ts` passes `SessionStore`.
- README tool catalogue.

## The tools

| Tool | Answers |
| --- | --- |
| `ferret_session_recall` | "What did the last session decide?" — checkpoint plus memories, across a lineage |
| `ferret_session_list` | "Which sessions are on record?" — to find the id a recall needs |
| `ferret_session_show` | One session and everything it recorded, superseded memories included |

## Design

**A port, not the store.** `boundaries.test.ts` refuses an MCP module that
reaches `src/storage/`, and the tools answer through EPIC-043's own
`SessionRecoveryPort`, which `SessionStore` already satisfies. The composition
root passes the store straight through, so this layer never learns PostgreSQL
exists — which is what makes the tools testable without one.

**Read-only, deliberately.** Recording over MCP — opening a session, closing it,
checkpointing it — needs an answer to who owns a session's identity and lifetime
when the client and the server disagree about when a session began. **EPIC-117**
owns that. Half of it built here would be a write path with no lifecycle behind
it, and the foreign key from a memory to its session would refuse the first
call.

**Found and empty are different answers.** A session that decided nothing and a
session that does not exist both produce no memories, and a client that cannot
tell them apart will ask a user to repeat context that was never lost. `found`
is reported separately from `empty`, with a remediation naming the tool that
resolves it.

**Memories are flattened.** A client should not have to know that a memory
arrives wrapped in a recovery envelope to read what it says. The generation and
origin session survive the flattening, because "we decided this two sessions
ago" is what tells a reader how much weight a memory carries.

**`recall` and `show` are different questions.** Recall assembles what a *later*
session needs — bounded, prioritised, drawn from a whole lineage, superseded
memories dropped. Show reports what *one* session holds, both halves of a
supersession included, because "why did we change our mind" is worth answering.
The boundary is stated in both descriptions so a client does not have to infer
it, following the precedent EPIC-070 set between `ferret_health` and
`ferret_providers`.

## Non-scope

- Recording a session over MCP — EPIC-117.
- Transcript capture — no Epic; it is a client-adapter concern.
- Retention of session rows — EPIC-112.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Three tools register, all read-only | `session-tools.test.ts` — "the tools are offered" |
| 2 | Recall returns the checkpoint and memories in EPIC-043 priority order | "recall reaches a client" |
| 3 | Omissions are reported rather than dropped | "reports what it left out rather than dropping it" |
| 4 | A missing session is distinguishable from one that decided nothing | "distinguishes a session that decided nothing from one that does not exist" |
| 5 | `list` and `show` report what is held | "list and show" |
| 6 | The guards apply: permission, unknown arguments, schema bounds | "the guards apply" |
| 7 | The MCP surface still does not reach storage | `boundaries.test.ts` |
| 8 | The README documents every registered tool and no phantom | `tools.test.ts` F-87 block |

## Tests

13 cases in `tests/integration/mcp/session-tools.test.ts`, driving the real
protocol over an in-memory transport against a fake port. **No database, and
that is the point:** EPIC-109 already proved `SessionStore` satisfies the port
against real PostgreSQL, and proving it again here would test the store rather
than the surface.

## Dependencies

EPIC-109, EPIC-110, EPIC-043, EPIC-068 (permissions), EPIC-070 (the port
precedent), EPIC-085 (audit).

## Definition of done

All acceptance criteria implemented and tested; the boundary gate green; the
README catalogue current in both directions; merged through normal governance.
