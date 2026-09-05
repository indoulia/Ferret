# EPIC-110 — `ferret session` Command Surface

**Status:** IMPLEMENTED  
**Priority:** P1  
**Domain:** Session & Agent Memory  
**Classification:** CONTINUATION

## Outcome

Make the Session & Agent Memory domain reachable by an operator. EPIC-109 gave
it a store; this gives it a command.

## Why this Epic exists

After EPIC-109 the capability was real, tested, durable — and reachable only by
importing a class. `ferret session` still exited `5` with `E_NOT_IMPLEMENTED`,
and `planned.ts` still named it, because the entry describes what an operator
can *do* rather than what the tree contains. The Epic that closes that entry is
this one.

## Scope

- `src/cli/commands/session.ts` — seven subcommands.
- Registration in `program.ts`; the `session` entry removed from
  `PLANNED_COMMANDS`.
- README moved from `Planned` to `Implemented`, with worked usage.

## The surface

| Subcommand | Permission | What it does |
| --- | --- | --- |
| `start` | `INDEX` | Opens a session and prints its id, generating one when not given |
| `end <id>` | `INDEX` | Closes it. `--abandoned` records that instead of completion |
| `checkpoint <id>` | `INDEX` | Records resumable state; the sequence is read, not asked for |
| `remember <id>` | `INDEX` | Records a decision, constraint, preference, gotcha or next step |
| `recall <id>` | `READ` | Assembles what a later session needs |
| `list` | `READ` | Sessions for the local operator, newest first |
| `show <id>` | `READ` | One session, its latest checkpoint and what it decided |

Permissions follow the precedent the CLI already sets: reads take
`Permission.READ`, writes take `Permission.INDEX` — the split `import`, `prune`
and `reconcile` already use. No permission was added; adding one to the closed
set in EPIC-068 would be an architecture change this Epic has no cause to make.

## Design

**`recall` is the command that matters.** The rest exist so there is something
to recall. A bundle comes from what was already distilled while the work
happened — the latest checkpoint and a few dozen sentences — rather than from a
transcript, because reconstructing context *without* replaying one is EPIC-043's
whole constraint.

**Omissions are printed, never dropped.** A bundle that quietly held back half
the memories would be a recovery that looks complete and is not, which EPIC-043
names in its own doc comment as worse than no recovery.

**The checkpoint sequence is read rather than supplied.** A caller who has to
track it by hand can only get it wrong, and EPIC-041 made the progression
monotonic precisely so nobody has to.

**Every subcommand emits JSON under `--json`.** Governance §16, and the reason
`ferret config` already does: EPIC-111 can expose these as MCP tools without a
second implementation. A failure is a JSON document on stdout with `ok: false`,
not a line on stderr, so a caller parses one stream.

## Non-scope

- **Writing a transcript.** `session_capture` is a stream an AI client produces,
  not something an operator types at a prompt, so capture stays with the client
  adapters that will own it. A memory recorded here is `explicit` — a person
  stating a decision knows they made one — and explicit memories cite no
  captures, which is why this command can exist before anything writes one.
- MCP surfacing — EPIC-111.
- Retention of session rows — EPIC-112.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | The command ships and is no longer advertised as planned | `session-cli.test.ts` — "the command exists and is no longer planned"; `distribution.test.ts` |
| 2 | A session can be opened and closed; a closed one cannot be closed again | "a session is opened and closed" |
| 3 | Checkpoints are numbered without the caller supplying a sequence | "numbers checkpoints without being told the sequence" |
| 4 | Memories record with kind and rationale; a bad kind names the valid ones | "checkpoints and memories are recorded" |
| 5 | `recall` returns the checkpoint and memories in EPIC-043 priority order | "recall assembles what a later session needs" |
| 6 | What a limit left out is reported rather than silently truncated | "reports what a limit left out instead of truncating silently" |
| 7 | `list` and `show` report what is held | "list and show report what is held" |
| 8 | Human output is readable without `--json` | "human output is readable" |

## Tests

20 integration cases in `tests/integration/storage/session-cli.test.ts`, driving
the **built binary** as a child process against real PostgreSQL — not the store
directly. That is deliberate: EPIC-109 already tested the capability, and what
was never tested was that an operator could reach it.

## Dependencies

EPIC-109, EPIC-039–043, EPIC-068 (permissions), EPIC-001 (command structure).

## Definition of done

All acceptance criteria implemented and tested against a real server; the
planned entry retired; README current; merged through normal governance.
