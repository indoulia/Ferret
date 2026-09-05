# EPIC-110 — `ferret session` command surface: validation evidence

**Status: VALIDATED** · one command, seven subcommands, one planned entry
retired. No storage change: EPIC-109's store is used, not extended.

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

EPIC-109 made a session survive the process. Nothing reached it: the store was a
library with no caller outside its own tests, and `ferret session` was a
`(planned)` entry that exited 5.

`src/cli/commands/session.ts` adds the command with seven subcommands — `start`,
`end`, `checkpoint`, `remember`, `recall`, `list`, `show` — wired into
`src/cli/program.ts`, and removes `session` from `PLANNED_COMMANDS`, which leaves
`sync` as the only entry there.

## Acceptance criteria

Measured run: `tests/integration/storage/session-cli.test.ts` — **21 tests
passed, 92 289 ms**, each case spawning the built binary as a child process
against real PostgreSQL.

The suite is slow *by design*. EPIC-109 already proved the store against a real
database; what had never been tested was that an operator could reach it, and
that is only provable through the artefact an operator actually runs.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 the command ships and is no longer advertised as planned | PASS | `is advertised without the planned marker`; `no longer exits 5`. `distribution.test.ts` — **11 tests** — and the packaging suite's pinned surface were both updated in the same change |
| AC-2 a session can be opened and closed; a closed one cannot be closed again | PASS | `starts one and generates an identifier`; `accepts an identifier the caller chose`; `closes one, and a closed one cannot be closed again`; `records an abandoned session as abandoned`. The second close fails with a remediation, not a stack trace |
| AC-3 checkpoints are numbered without the caller supplying a sequence | PASS | `numbers checkpoints without being told the sequence`; `carries continuation state through as an object`; `refuses state that is not a JSON object, and says why` |
| AC-4 memories record with kind and rationale; a bad kind names the valid ones | PASS | `records a memory with its rationale`; `names the kinds when given one that does not exist` |
| AC-5 `recall` returns the checkpoint and memories in EPIC-043 priority order | PASS | `returns the checkpoint and the memories in priority order`; `walks a lineage the CLI itself created`; `says a session with nothing recorded is empty, rather than printing nothing` |
| AC-6 what a limit left out is reported rather than silently truncated | PASS | `reports what a limit left out instead of truncating silently — AC-6` |
| AC-7 `list` and `show` report what is held | PASS | `lists sessions for the local operator, newest first`; `shows a session with its checkpoint and memories`; `refuses to recall a session that is not on record`; `rejects a limit that is not a positive whole number` |
| AC-8 human output is readable without `--json` | PASS | `prints the bundle rather than JSON when --json is absent` |

**One of the 21 cases is not this Epic's.** `redacts a credential a person pasted
into a statement — EPIC-112` was added later by EPIC-112, which found a redaction
gap on the path this Epic opened. EPIC-110 shipped 20; the file holds 21 today.
Recorded so the count in this document and the count in
[#157](https://github.com/indoulia/Ferret/pull/157) can be reconciled by a later
reader rather than looking like a discrepancy.

## Dogfooding

Recorded in the pull request against a real installation: a session recorded,
checkpointed, ended and recovered; a continuation inheriting three memories with
each memory's origin named; and a closed session refusing to be amended with a
remediation rather than a stack trace.

## Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **The suite costs ~92 s.** Twenty-one child-process spawns against a real database. | It is the slowest integration file in the tree, and it runs on every full verify. | Accepted here: a CLI proved through anything other than the built binary is not proved. Not carried |
| **`ferret sync` remains the one planned entry.** | An operator can record and recall sessions, and still cannot ingest from a configured provider. | ROADMAP EPIC-113 — blocked on a product decision |
| **No MCP write path.** `recall` is reachable from a shell and, after EPIC-111, from an MCP client; recording is shell-only. | An agent can read prior context over MCP and must shell out to record its own. | ROADMAP EPIC-117 — blocked on a product decision |

## Governance alignment

| Rule | How EPIC-110 satisfies it |
| --- | --- |
| §2 Simplicity is a product requirement | No new configuration; the command uses the database details Ferret already requires |
| §6 Evidence before inference | Every criterion is proved through the built binary, not through the store the binary calls |
| §19 Testing and quality | Failure and boundary cases are first-class: a reused close, a non-object state, an unknown kind, an unknown session, a non-integer limit |
| §20 Observability | `--json` for machines, a readable bundle without it, and AC-6 refuses to truncate in silence |
| AI Rule §3 Epic scope is a contract | No storage change, no MCP surface, no retention |
| AI Rule §9 No fake completion | The late record, the case that belongs to EPIC-112, and the suite's cost are all stated |
