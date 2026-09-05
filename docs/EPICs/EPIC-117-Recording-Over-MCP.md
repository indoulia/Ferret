# EPIC-117 — Recording a Session over MCP

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** AI Control Plane · Session & Agent Memory · Security & Authorization
**Classification:** CONTINUATION

## Outcome

An AI client can open a session, record what it decided, checkpoint where it got
to, and close it — over MCP, without a shell.

## Problem

EPIC-111 shipped recall read-only and said why: recording needed an answer to
who owns a session's identity and lifetime, and half a write path built without
one produces sessions nothing closes and memories attached to sessions that were
never opened. A client that can read what the last session decided but cannot
record what this one decided is half a memory, and the missing half is the one
an autonomous agent needs most.

Every write on the MCP surface until now was configuration or provider
administration. There was no precedent for an agent writing a record of its own
reasoning, which is why the question had to be decided rather than inferred.

## Decisions this Epic implements

Taken by the owner on 2026-09-05 against the
[decision queue](ROADMAP.md#epic-117--recording-a-session-over-mcp).

**D-117.1 — server-owned session identity.** `ferret_session_start` mints the id
and returns it; the input schema has no field a client could supply one in, and
it is `strictObject`, so an attempt is refused rather than ignored. A client
*participates* by naming the id it was given on every later call. Identity is
therefore unforgeable and is not a shared namespace.

**D-117.2 — a closed transport is not an ended session.** Nothing in the tools
and nothing in `server.ts` ends a session when a connection drops. A session ends
when `ferret_session_end` says so, which is an explicit state transition the
domain already models (`endSession`) and the database already constrains
(`session_ended_with_status`). Reclaiming a crashed client's session stays where
EPIC-112 put it: `ferret prune --sessions`, on an age an operator supplies.

**D-117.3 — a dedicated permission.** `Permission.RECORD`, an amendment to
EPIC-068's closed set, raised as one — see
[EPIC-068 §17](EPIC-068-AI-Authorization-Model.md#17-amendment--2026-09-05-record-epic-117).
Neither `INDEX` nor `MUTATE` was overloaded.

## Design

**Four tools, one permission, one seam.** `ferret_session_start`,
`ferret_session_remember`, `ferret_session_checkpoint` and `ferret_session_end`,
each guarded by the same `createToolGuard` every other tool uses, each naming
`Permission.RECORD` at its call site.

**Additive, not destructive.** The four declare `destructiveHint: false`, which
is MCP's own word for a tool that performs only additive updates. This required
amending `mcp-destructive-tools.test.ts`, which read "not read-only ⇒ destructive
guard" — a rule that was right about every tool that existed when it was written
and wrong about the first tool that writes something additive. Requiring
EPIC-069's confirmation for `ferret_session_remember` would have made agent
memory need a human per remembered sentence, which is the capability this Epic
exists to provide. **Nothing about a destructive tool is relaxed:** the gate, the
annotation and the permission are all still required for `destructiveHint: true`,
a tool may not claim to be both read-only and destructive, and the additive tools
are now pinned by name in their own list so growing that set is a visible line in
a diff.

**The CLI moved too.** `ferret session start|end|checkpoint|remember` used
`Permission.INDEX`. They now use `RECORD`, because the CLI and the MCP surface
read their grant from the same configuration and a session write needing
different permissions depending on how it arrived would be two rules wearing one
name. `LOCAL_OPERATOR_PRINCIPAL` gains `RECORD` so an operator who configured
nothing loses nothing.

**The write half of the port is optional.** `SessionAccess` gains `save`,
`saveCheckpoint` and `recordMemory` as optional methods, and a composition
without them gets a tool that *reports* recording is unavailable rather than one
that is silently absent or throws a `TypeError`. "This build cannot record" and
"this tool does not exist" are different facts.

**Checkpoint sequences are read, never asked for.** EPIC-110's reasoning applied
to the MCP surface: a caller who has to supply a sequence can only get it wrong.

**A recorded memory is `explicit`.** A client stating something is not an
extraction from a transcript, and EPIC-042 requires an *extracted* memory to cite
the captures it was drawn from. Claiming extraction here would either violate
`engineering_memory_extracted_has_evidence` or fabricate the citation.

## Scope

- `Permission.RECORD`, and `LOCAL_OPERATOR_PRINCIPAL`.
- Four recording tools in `src/mcp/session-tools.ts`; `SessionAccess` extended.
- The four CLI session write subcommands re-permissioned.
- `mcp-destructive-tools.test.ts` amended to key on `destructiveHint`.
- EPIC-068 §17, the amendment record.

## Non-scope

- **An idle timeout that abandons a stale session.** D-117.2 asks for an
  explicit state transition, and that is what this delivers. The roadmap's
  option C — a sweep marking a session `abandoned` after a configured idle
  period — is additional product behaviour, and EPIC-112 already gives an
  operator a way to reclaim old sessions. The limitation it would close is
  EPIC-112's recorded one and is not deepened here: `ferret session start` has
  had exactly this property since EPIC-110.
- **A client-supplied idempotency key.** The roadmap's D-117.1 option C would
  let a reconnecting client resolve to the same session. It needs a column and a
  uniqueness rule, and the decision taken says only that the server owns
  identity. A client that reconnects calls `ferret_session_list` and continues
  the session it was given.
- **Capturing a transcript.** Nothing writes a `session_capture` yet; EPIC-112
  recorded that the capture path belongs to the client adapters that will own it.
- **Authentication.** EPIC-068 §16 stands: Ferret authorizes and cannot
  authenticate over stdio.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | Seven session tools are offered; the four that write are annotated additive | `session-tools.test.ts` — "registers all seven, and annotates the four that write" |
| 2 | The server mints the identity, and no field could carry a client's | "offers no way for a client to choose a session identifier"; "mints an identifier and returns it"; "refuses a field the schema does not declare" |
| 3 | A session records memories and checkpoints, and reads them back | "records a memory, a checkpoint, and reads them back" |
| 4 | A closed transport leaves the session active; only an explicit call ends it | "leaves a session active when the connection closes"; "ends only when an explicit call says so" |
| 5 | Every writing tool needs `RECORD`, and `INDEX` does not satisfy it | "refuses every writing tool to a principal holding only READ"; "is not satisfied by INDEX" |
| 6 | A server with no writer reports it rather than failing | "reports that recording is unavailable rather than throwing a TypeError" |
| 7 | The CLI is re-permissioned, and the local default is unchanged | `cli-authorization.test.ts` — the refusal, the control, and the no-configuration default |
| 8 | A credential a client pastes does not reach storage | "removes a credential a client pasted into a statement" |
| 9 | The destructive control is amended, not weakened | `mcp-destructive-tools.test.ts` — the destructive list is unchanged, both categories are pinned, and no tool may be both read-only and destructive |

## Tests

29 protocol cases in `tests/integration/mcp/session-tools.test.ts` (16 of them
this Epic's), 3 CLI authorization cases, and the amended source-level control.

## Dependencies

EPIC-111 (the recall surface), EPIC-109 (the store), EPIC-110 (the command
surface), EPIC-068 (authorization), EPIC-069 (the confirmation gate), EPIC-042.

## Known limitations

- **A crashed client leaves an `active` session.** EPIC-112's recorded
  limitation, unchanged and not deepened: `ferret prune --sessions` reclaims it
  on an age an operator supplies.
- **A reconnecting client must find its session.** `ferret_session_list` is how.
  Without an idempotency key, a client that loses its handle and opens a second
  session fragments one piece of work into two.
- **Nothing writes a transcript.** The four tools record a session, its
  checkpoints and its memories; captures remain the client adapters'.

## Definition of done

All acceptance criteria implemented and tested through the real protocol; the
permission amendment recorded on EPIC-068; the destructive control amended with
its destructive half unchanged; merged through normal governance.
