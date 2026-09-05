# EPIC-112 — Session retention & redaction: validation evidence

**Status: VALIDATED** · one retention target, one domain invariant closed. No
schema change: the cascade the tables already declared is what deletes.

## Why this record is late

Written after the merge rather than alongside it. The reasoning is recorded once,
in [EPIC-109's record](EPIC-109-VALIDATION.md#why-this-record-is-late), and
applies identically here.

## Environment

| | |
| --- | --- |
| Tree | `22d9255` (`main`) |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | Real PostgreSQL 17 + pgvector, local container |
| Date | 2026-09-05 |

## What the Epic does

Two halves, and only one of them was planned.

**Retention.** `src/storage/retention.ts` gains a `sessions` target and
`src/cli/commands/prune.ts` gains `--sessions` and `--sessions-older-than`. A
session that *ended* longer ago than a caller-supplied age is eligible; nothing
else is. Deleting one takes its transcript, its checkpoints and its memories with
it, through the `ON DELETE CASCADE` EPIC-109's tables already declared.

**Redaction — the half that was found, not planned.** EPIC-110 opened a path by
which a person types a statement into `ferret session remember` and it is stored
verbatim. `extractMemories` had always redacted, because it reads a transcript
nobody vetted; the *explicit* constructor had not, because the caller was assumed
to be a person who knew what they were writing. A pasted connection string does
not care about that assumption. `src/domain/engineering-memory.ts` now applies
the same redaction on the explicit path, and the count survives.

## Acceptance criteria

Measured runs: `retention.test.ts` (integration) — **17 tests passed, 753 ms**;
`retention.test.ts` (unit) — **15 tests passed**; `prune-cli.test.ts` — **8 tests
passed, 16 855 ms**; `engineering-memory.test.ts` — **54 tests passed**;
`session-cli.test.ts` — **21 tests passed** (one of them this Epic's).

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 a sessions target exists and reports in the plan | PASS | The pinned target list in `prune-cli.test.ts` names `sessions`; `reports every target and deletes nothing when none is named — AC-1` |
| AC-2 an age is required; none is invented | PASS | `refuses a session sweep with no age rather than choosing one — EPIC-112` and `refuses a negative session age` (unit — and the first proves the refusal happens **before the database is touched**); `refuses to choose an age, and reclaims nothing without one` (integration); `says an age is required rather than choosing one — AC-6` (CLI) |
| AC-3 planning deletes nothing | PASS | `plans without deleting — AC-1`; and the pre-existing `deletes nothing without apply, and reports the same counts — AC-2, AC-10` covers the new target unchanged |
| AC-4 an unclosed session is never eligible, however old | PASS | `never touches a session nothing has closed, however old it is`. A session left `active` is indistinguishable from one that crashed, and neither is garbage |
| AC-5 a session that ended recently is kept | PASS | `keeps a session that ended more recently than the age` |
| AC-6 deletion cascades, and the plan says so | PASS | `takes the transcript, the checkpoints and the memories with it` |
| AC-7 an explicit memory cannot carry a credential | PASS | `a memory cannot carry a credential — EPIC-112` — `redacts an assigned secret from a statement`; `redacts a rationale too — the field a reason for a choice goes in`; `leaves ordinary prose alone and reports nothing redacted` |
| AC-8 a redacted secret does not reappear on recall | PASS | `redacts a credential a person pasted into a statement — EPIC-112` (`session-cli.test.ts`) — proved end to end through the built binary: written on one invocation, read back on another, and the secret is not in the output |
| AC-9 a count an extracting caller earned survives | PASS | `keeps what an extracting caller already removed, and adds its own`; `removes a credential from a statement and counts it — AC-9` |

## What the redaction gap says about the seam

The invariant was never wrong in `extractMemories`; it was **not applied on the
second entrance to the same value**. EPIC-042 had one caller and one guard. EPIC-110
added a second caller, and the guard did not move with it — which is the shape of
defect that appears whenever a domain value acquires a new way in and the new way
is trusted more than the old one.

Recorded here rather than as a note, because the same seam exists wherever a
constructor is reachable both from a parser and from an operator.

## Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **A never-closed session is never reclaimed.** AC-4 is the point, not an oversight: nothing distinguishes a crashed session from one still running. | An abandoned `active` row accumulates until someone ends it. `ferret session end --abandoned` is the tool. | ROADMAP EPIC-117 — a session's lifetime is exactly the ownership question that Epic is blocked on |
| **Redaction is pattern-based.** It removes credential *shapes*, not every secret a person could paste. | A secret in a shape no pattern matches is stored. Inherited from EPIC-082 rather than introduced here. | EPIC-082 |
| **Captures are redacted on extraction, not at rest.** A transcript is stored as captured. | A raw transcript is evidence and is treated as such — but it is not itself scrubbed. | EPIC-082 / ROADMAP EPIC-116, where a transcript leaving the database is the question |

## Governance alignment

| Rule | How EPIC-112 satisfies it |
| --- | --- |
| §6 Evidence before inference | AC-2 refuses to choose an age, and the unit case proves the refusal precedes any database work rather than trusting that it does |
| §12 Security | The redaction gap was found and closed inside this Epic, and proved end to end through the binary rather than at the constructor alone |
| §14 / §23 No infrastructure for its own sake | No new table, no new migration; the cascade EPIC-109 already declared is what deletes |
| §19 Testing and quality | Both directions are tested: what must be deleted, and what must never be — an unclosed session and a recently ended one each have their own case |
| AI Rule §3 Epic scope is a contract | Export fidelity and the MCP write path were left to their owning roadmap entries rather than absorbed |
| AI Rule §9 No fake completion | The three limitations above, including one that is a deliberate consequence of AC-4, are stated rather than omitted |
