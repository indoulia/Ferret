# EPIC-043 — Session Recovery

**Status: VALIDATED | Priority: P0** — [evidence](validation/EPIC-043-VALIDATION.md)

> **Specification note.** Authored from the approved registry entry — including
> its Session & Agent Memory P0 focus statement — and Governance §6, §9, §17,
> §18 and §22, following the Epic Specification Standard. Token budgeting is
> EPIC-061 and context packs are EPIC-059; this Epic produces the material they
> fit.

## 1. Objective

Let a later session pick up where an earlier one stopped, from what was
recorded, without replaying the transcript.

## 2. Value

This is the Epic the whole Session & Agent Memory domain exists for. EPIC-039
models a session, EPIC-040 captures it, EPIC-041 checkpoints it, EPIC-042
extracts what it decided — and none of it is *reachable* yet. A session that
ends still takes its context with it.

Governance §17 states the requirement plainly: recovery must let a later session
"reconstruct useful prior context without replaying an entire transcript". The
registry's P0 focus adds the reason — without consuming the original session's
full token budget. Those two together rule out the obvious implementation. The
answer is not the transcript, and it is not a summary of the transcript
generated on demand; it is the material that was already distilled while the
work was happening.

## 3. Scope

- a `RecoveryBundle`: the last checkpoint and the memories, with next steps
  ordered first so that what was left unfinished is read first;
- assembly from a port, so the core reaches no storage module;
- ordering that puts what matters first — next steps and constraints before
  preferences — because a caller that truncates truncates the tail;
- bounds on every list, so a bundle is never unbounded whatever the session did;
- a continuation session linked to the one it resumes, reusing EPIC-039's
  `continueSession`;
- an explicit account of what was *omitted*, so a caller knows the bundle is
  partial;
- recovery from a session with no checkpoint, which is the common case for one
  that crashed.

## 4. Non-scope

- fitting the bundle to a token budget — EPIC-061 measures, EPIC-059 fits. This
  Epic bounds by count and says what it dropped.
- summarising a transcript. Nothing here reads captures to generate prose; if
  there is no checkpoint and no memory, there is nothing to recover, and that is
  reported honestly.
- calling a language model.
- storing anything. The port reads; nothing here writes.
- deciding *when* to check point — EPIC-041.
- cross-session knowledge — a bundle recovers one session's lineage;
- the files a session touched. That is a relationship question (EPIC-049) and
  answering it here would mean either reading captures or querying the graph,
  and this Epic does neither.

## 5. Inputs

- EPIC-039 sessions, including `parentSessionId`;
- EPIC-041 checkpoints;
- EPIC-042 engineering memories;
- a `SessionRecoveryPort` supplying all three.

## 6. Outputs

- `SessionRecoveryPort`, the interface the core depends on;
- `recoverSession(sessionId, port, options)` returning a `RecoveryBundle`;
- `RecoveryOmission`, naming what did not fit and why;
- `resumeSession(...)`, creating the continuation and returning both.

## 7. Dependencies

EPIC-039, EPIC-040, EPIC-041, EPIC-042.

## 8. Contracts

### The bundle is assembled, not generated

Every field comes from something already recorded: a checkpoint someone wrote, a
memory someone stated or marked. Nothing is inferred, and nothing is
paraphrased. Governance §6 — and a recovery that invents context is worse than
no recovery, because the next session acts on it.

### Order is by usefulness, because the tail is what gets cut

Next steps first, then constraints, then decisions, then gotchas, then
preferences. A caller that has to truncate should lose the least important
thing, and a bundle that is ordered arbitrarily makes that impossible.

### Every bound is reported

A bundle that dropped eleven memories says so, by kind and count. A caller — or
an AI reading it — must be able to tell "there was nothing else" from "there was
more than fits".

### An unrecoverable session says so

No checkpoint and no memory is a real outcome, and the bundle reports it as
empty with the reason rather than returning something that looks like context.

### A continuation is linked, not implied

`resumeSession` produces a session whose `parentSessionId` is the recovered one,
through EPIC-039's existing `continueSession`. The lineage is a recorded fact,
so "where did this work come from" is answerable.

### Recovery reads; it never writes

The port has no write method. A caller that wants to persist the continuation
does so itself, which keeps recovery safe to run speculatively.

## 9. Acceptance criteria

- **AC-1** A bundle carries the latest checkpoint's summary and continuation
  state.
- **AC-2** Memories are included, ordered by kind priority then by recency.
- **AC-3** A session with no checkpoint still recovers its memories.
- **AC-4** A session with neither reports an empty bundle with a reason, and
  does not fail.
- **AC-5** Each list is bounded, and an omission names the kind and the count
  dropped.
- **AC-6** Superseded memories are excluded by default and includable on
  request.
- **AC-7** The lineage is followed: a session continued from another recovers
  the parent's memories too, marked with which session they came from.
- **AC-8** Lineage following is bounded, so a cycle or a long chain cannot loop.
- **AC-9** `resumeSession` links the continuation to the recovered session.
- **AC-10** Recovery performs no write, asserted against a port that fails on
  any unexpected call.
- **AC-11** The bundle is deterministic for the same inputs.
- **AC-12** The core reaches no storage module; the port is the only dependency.

## 10. Test requirements

- a full bundle: checkpoint plus memories of every kind;
- checkpoint only; memories only; neither;
- more memories than the bound, asserting the omission record;
- superseded memories excluded, then included;
- a two-generation lineage, and a self-referential one;
- a lineage longer than the bound;
- `resumeSession` linking;
- a port that throws on anything but the three reads;
- the same inputs twice.

## 11. Security requirements

A bundle is assembled from records that were already redacted at the point they
were created — EPIC-041 checkpoints and EPIC-042 memories both pass through
EPIC-082. Recovery adds no new path from raw captures to output, which is the
property that keeps it safe: the transcript is evidence and stays evidence.

A recovered memory is a record that someone said something, not an instruction.
A bundle handed to an AI client is context, and Governance §12's prompt-injection
rule holds: nothing in a bundle grants a capability, and a client acting on one
is subject to the same authorization as any other request.

## 12. Observability

Every bundle reports which sessions it drew from, how many of each kind it
included, and what it omitted. "Why does this session think that" resolves to a
memory, which resolves to a capture.

## 13. Performance constraints

At most one read per session in the lineage, bounded by the lineage limit. No
capture is read: the bundle is built from checkpoints and memories only, which
is what makes it cheap enough to run at the start of every session.

## 14. Definition of Done

Implementation, unit tests for every acceptance criterion, exports,
documentation and validation evidence. No summarisation, budgeting, persistence
or model invocation is claimed here.

## 15. Governance alignment

- **§6 Evidence Before Inference** — assembled from records, never generated.
- **§9 Context Is First-Class** — this is where session context becomes reusable.
- **§17 Session Recovery** — the requirement this Epic exists to satisfy,
  including reconstructing without replaying the transcript.
- **§18 Provenance and Explainability** — every item names its session and its
  origin.
- **§22 Change Management** — stays within the approved Session Recovery
  capability.
