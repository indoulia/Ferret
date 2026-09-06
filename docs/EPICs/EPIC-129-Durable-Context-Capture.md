# EPIC-129 — Durable Context Capture

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Durable Context
**Classification:** FOUNDATION

## Outcome

An agent can promote what a session decided and learned into durable context, so
a later session inherits it — without any route by which a transcript, a
scratchpad or working state could follow.

## Problem

Two halves existed and nothing joined them. Session memories (EPIC-042) are
keyed on the **session** that recorded them, so they are unreachable to any
later session that was not that one. Durable context (EPIC-126) is keyed on the
**statement**, and had no way to receive what a session had already worked out.

An agent could restate a memory through `ferret_context_record`, but restating
loses the provenance — the work that produced the statement — and makes the
agent responsible for remembering what it had already recorded.

## Design

**The judgment already exists, and this Epic does not add a second one.**
`memory-extraction.ts` decided it for EPIC-042:

> A missed memory costs a re-derivation; a fabricated one costs the credibility
> of the whole store.

A memory is already the high-precision extract. Promotion is therefore a
*mapping*, not a filter that re-judges the material.

**A transcript cannot be promoted, structurally.** Captures are not an input to
`promoteMemories`, and `ferret_context_promote` takes one field — which session.
There is no argument that could name a capture, a range or a sequence. The
forbidden case is unreachable rather than refused.

**How sure the session was decides what the context becomes.**

| Memory origin | Confidence | Becomes |
| --- | --- | --- |
| `explicit` — the client called `ferret_session_remember` | `STRONG` (0.95) | current context |
| `extracted` — a marker matched a line | `PLAUSIBLE` (0.6) | a **candidate** |

That is what makes promoting extraction safe at all: automatic extraction can
never silently become current context. It also gives EPIC-127's `candidate`
state its first real job.

**A superseded memory is never promoted.** Promoting one would revive a belief
the session had already retracted.

**Provenance reaches the work.** `sourceSystem` is `ferret.session`, `sourceId`
is the session id, `observedAt` is when the memory was recorded, and the
memory's own confidence carries across — so "why does Ferret believe this"
reaches the session that produced it rather than stopping at Ferret's name.

## Scope

- `planPromotion` — pure, one memory to one outcome or one refusal.
- `promoteMemories` — over `DurableContextPort`, with a per-session report.
- `ferret_context_promote`, registered only where a session read is wired.
- `AgentProvenance.confidence`, which promotion sets and no tool exposes.

## Non-scope

- Promoting captures, transcripts or working state, in any form.
- Automatic promotion. Promotion is deliberate; nothing sweeps.
- Re-judging what a memory said. That was EPIC-042's decision.
- Retention and deletion of promoted context — EPIC-133.

## Contracts

`AgentProvenance` gains `confidence`. **Not settable by an agent** — no tool
exposes it, because a caller naming its own confidence is self-assessment.
It exists for a producer Ferret runs.

## Acceptance criteria

- **AC-1** An explicit memory promotes to current context; an extracted one to a
  candidate.
- **AC-2** Every memory kind has a durable counterpart, so promotion loses none.
- **AC-3** A superseded memory is refused, and the refusal is reported.
- **AC-4** An unrecognised kind is reported, not thrown.
- **AC-5** Promotion carries the session, the recording instant and the memory's
  confidence.
- **AC-6** Promoting twice creates nothing the second time.
- **AC-7** A session with no memories promotes nothing.
- **AC-8** The tool's schema offers no way to name a capture or a transcript.
- **AC-9** Promotion needs `record`, not `mutate` — promoting what a session
  decided is recording it durably.
- **AC-10** A build with no session read offers no promotion tool.

## Test requirements

`tests/unit/context-promotion.test.ts` — 12 cases over the pure rule and the
promotion loop, against a fake port that derives ids through the real
`createDurableContext` so it cannot disagree with the product about identity.
`tests/integration/mcp/context-tools.test.ts` — 8 further cases through the real
protocol.

## Security requirements

A promoted statement passes through the same containment and the same notice as
any other durable context. The producer is Ferret's own promoter, never the
caller's. `redactSecrets` has already run twice by the time a statement is
promoted — once in `createEngineeringMemory`, once in `createDurableContext`.

## Definition of Done

Targeted and full suites green; lint, typecheck, build clean; dogfood evidence of
a real session promoted through the real tools, in
`validation/EPIC-129-VALIDATION.md`.
