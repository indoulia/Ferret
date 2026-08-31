# EPIC-043 — Session Recovery: validation evidence

**Status: VALIDATED** · no new dependency, no I/O, no model invocation. A port,
three reads, and an ordering decision.

## What the Epic does

`recoverSession(sessionId, port)` assembles what a later session needs from an
earlier one: the latest checkpoint, the engineering memories — following the
session's lineage — ordered so that the least important thing is the first to be
cut, and an explicit record of everything omitted. `resumeSession` adds the
linked continuation.

## Acceptance criteria

All rows are `tests/unit/session-recovery.test.ts`.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 the latest checkpoint | PASS | `carries the latest checkpoint` — summary and continuation state |
| AC-2 ordered by kind priority | PASS | `orders memories by usefulness, because the tail is what gets cut` — asserted against `RECOVERY_KIND_ORDER` itself; `puts the nearer generation first, whatever the kind` |
| AC-3 memories with no checkpoint | PASS | `recovers memories with no checkpoint at all` |
| AC-4 neither reports empty with a reason | PASS | `reports an empty bundle with a reason rather than something that looks like context` |
| AC-5 bounds reported | PASS | `reports what it dropped, by count`; `reports no omission when everything fitted`; `has a default bound` |
| AC-6 superseded excluded, includable | PASS | `excludes them by default and says how many`; `includes them on request` |
| AC-7 lineage followed and attributed | PASS | `recovers a parent session's memories, marked with where they came from` — each memory carries its session and generation |
| AC-8 lineage bounded against cycles and length | PASS | `does not loop on a session that is its own parent`; `bounds a long chain and says so`; `stops cleanly at a parent that is not on record` |
| AC-9 continuation linked | PASS | `links the continuation to the session it resumes`; `refuses to resume a session that is not on record` |
| AC-10 recovery performs no write | PASS | `calls only the three reads the port declares` — the exact call list is asserted |
| AC-11 deterministic | PASS | `is deterministic for the same inputs` — two bundles compared with `toStrictEqual` |
| AC-12 no storage dependency | PASS | the module imports only `errors`, `engineering-memory`, `session` and `session-checkpoint`; the port is the only external surface |

## Design decisions worth recording

**Order is the whole design.** A caller fitting a bundle into a budget truncates
from the end, so the order has to mean something: nearest generation first, then
next steps, constraints, decisions, gotchas, preferences. What is *unfinished*
matters most to the session picking up; a preference is the first thing anyone
can afford to lose. `puts the nearer generation first, whatever the kind` pins
the precedence between the two axes — a preference from this session outranks a
constraint from a grandparent, because the closer context is the one being
resumed.

**Nothing is generated.** Every field comes from a checkpoint someone wrote or a
memory someone stated. There is no summarisation path, and there is no model
call. A recovery that invents context is worse than no recovery, because the
next session acts on it.

**No capture is read.** The bundle is built from checkpoints and memories only.
That is what makes it cheap enough to run at the start of every session, and it
is also the security property: there is no path from a raw transcript to a
bundle, so nothing unredacted can reach one. `reads no captures — the transcript
stays evidence` asserts it.

**Every bound is reported.** A caller — or an AI reading the bundle — must be
able to tell "there was nothing else" from "there was more than fits".
Omissions name the reason and the count.

**The lineage walk uses a seen-set, not just a depth counter.** A session whose
parent is itself is a corrupt record, not an impossible one, and a bounded loop
that still loops is not a bound.

**An empty bundle is a real outcome.** A session that crashed before its first
checkpoint has nothing to recover, and saying so is better than returning a
shape that looks like context.

**The port has no write method.** Recovery is therefore safe to run
speculatively, and a write would not compile rather than merely failing a test.

## Limitations

- **Nothing implements the port.** `SessionRecoveryPort` is satisfied by test
  doubles only; there is no store behind it and no MCP tool in front of it. This
  is the same gap the last five Epics have: the model and the logic exist, and
  the wiring does not.
- **The bundle is bounded by count, not by tokens.** EPIC-061 measures and
  EPIC-059 fits; a bundle of sixty short memories and a bundle of sixty long
  ones are very different sizes, and this Epic cannot tell them apart.
- **Only the latest checkpoint.** Earlier checkpoints of the same session are
  not offered, so "what did we think halfway through" is unanswerable from a
  bundle.
- **One lineage, no siblings.** Two sessions continued from the same parent do
  not see each other's memories.
- **Recency ordering is by `recordedAt` string comparison.** Correct for the
  ISO-8601 instants the model stores, and wrong for anything else — the schema
  is what keeps it honest.
- **No relevance.** Memories are ordered by kind and age, not by whether they
  relate to what the new session is about. That is EPIC-056's problem and would
  need the new session's intent, which recovery does not have.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 38 files, 1094 passed.
