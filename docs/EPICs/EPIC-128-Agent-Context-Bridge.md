# EPIC-128 — Agent Context Bridge

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

An agent can put its durable knowledge in Ferret and read it back in a later
session — or a different agent's session — instead of maintaining a store of its
own beside it. Ferret gains no knowledge of that agent.

## Problem

EPIC-126 and EPIC-127 built durable context and gave it a lifecycle. Neither
gave anything a way to reach it: `DurableContextStore` is a TypeScript class in
`src/storage/`, and an AI client is usually a process with no shell, no `ferret`
on its path and no way to construct one.

So the eleven markdown files this repository's own agent maintains outside the
product stayed outside it — which is the parallel durable store the Epic exists
to make unnecessary.

## Design

**A port, not a store.** `DurableContextPort` lives in `src/context/` and names
no client, no protocol and no vendor. `DurableContextStore` satisfies it
structurally without importing it, so the MCP layer never learns PostgreSQL
exists — the boundary `boundaries.test.ts` enforces and the reason these tools
are testable without a database. A second surface — a CLI, an HTTP endpoint —
would be another adapter over the same port, and none of them owns the model.

That is how the Epic's constraint is met structurally rather than by intention:
Claude is the first thing to call this, not what it was built around. A test
asserts the offered surface contains no vendor's name.

**Four tools, not six.** The conceptual operations are store, find, get, relate
and lifecycle.

- `relate` is not a tool. Relating is what recording already does: `subjectId`
  relates a statement to an entity, `supersedes` relates it to what it replaces,
  and near-duplicates are related by the merger without being asked.
- `get` is not a tool. Reading one record is `ferret_context_trust`, because a
  statement returned with no indication of whether Ferret still believes it is
  the question EPIC-127 exists to answer, left unanswered.

| Tool | Permission | Writes |
| --- | --- | --- |
| `ferret_context_record` | `record` | additive |
| `ferret_context_find` | `read` | no |
| `ferret_context_trust` | `read` | no |
| `ferret_context_lifecycle` | `mutate` | additive |

**The permission split is the substantive decision.** Recording is EPIC-117's
`record` — "create, continue and terminate a *recording*" — raised precisely so
that storing what an agent learned is not conflated with ingesting a source. A
lifecycle transition is `mutate`, whose own definition is "change canonical
knowledge: merge identities, resolve a conflict, retract"; it is never granted
by default, which is the right default for retiring knowledge other people rely
on. An agent may record freely and must be trusted deliberately before it can
curate.

**The producer comes from the composition root.** There is no field a client
could supply one in. An agent that could name its own producer could claim a
parser's identity and inherit its authority — Governance §12, one layer up.

## Scope

- `DurableContextPort` and the shapes it exchanges.
- Four MCP tools over it, with containment and the one data-not-instructions
  notice — `CONTENT_NOTICE`, widened to name durable statements rather than
  duplicated.
- Composition: `ferret mcp` passes the store as the port.
- README: the tool table and how the writing tools are governed.

## Non-scope

- Any CLI command for durable context. The Epic is about the caller with no
  shell; an operator surface is not what is missing.
- Promotion of agent activity into context — EPIC-129.
- Ownership, retention and audit of context — EPIC-133.
- Any reasoning, decision or action. Ferret stores, relates and reports.

## Acceptance criteria

- **AC-1** Exactly four tools are offered; reads declare `readOnlyHint`, writes
  declare `destructiveHint: false`.
- **AC-2** The offered surface names no client, protocol or vendor.
- **AC-3** A build without durable context registers none of these tools, so a
  client can tell "not served here" from "unavailable".
- **AC-4** Recording stores a statement and reports whether it created or merged.
- **AC-5** The producer is the composition root's, and no input field can set it.
- **AC-6** A statement may be proposed rather than asserted.
- **AC-7** An over-length statement is refused by the schema, before a handler
  runs.
- **AC-8** Reads return current context by default and history when asked.
- **AC-9** `ferret_context_trust` returns the belief with its evidence.
- **AC-10** An absent record is reported as absent, not as a failure.
- **AC-11** Every returned statement is contained, and the notice precedes it.
- **AC-12** An agent holding `record` but not `mutate` is refused a transition.
- **AC-13** No tool offers a way to supersede without stating the replacement.

## Test requirements

`tests/integration/mcp/context-tools.test.ts` — 16 cases through the real
protocol against a fake port. `tests/integration/storage/durable-context.test.ts`
asserts the store satisfies the port. `tests/unit/mcp-destructive-tools.test.ts`
and `tests/integration/distribution.test.ts` pin the surface.

## Security requirements

Every statement returned is passed through EPIC-087's containment, because a
durable statement is producer-supplied text reaching a model — more untrusted
than indexed content, not less, since an agent may have read it out of a
repository. The notice comes first in every response. No sentence Ferret writes
has a hole for a statement. The producer and the permission scopes come from the
composition root; neither is an input.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; dogfood evidence of
an agent's parallel store moved into Ferret through the real tools, in
`validation/EPIC-128-VALIDATION.md`.
