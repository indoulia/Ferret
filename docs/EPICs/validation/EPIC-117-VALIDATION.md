# EPIC-117 — Recording a session over MCP: validation evidence

**Status: VALIDATED** · four writing tools, one new permission, no schema change
and no migration. The permission set was amended on the record, and the
destructive-tool control was amended with its destructive half untouched.

## Environment

| | |
| --- | --- |
| Tree | `b2cfb37` (`main`) + EPIC-116 + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Protocol | The real MCP SDK over `InMemoryTransport`, client and server both |
| Database | Real PostgreSQL 17 + pgvector for the CLI authorization cases |
| Date | 2026-09-05 |

## What the Epic does

`ferret_session_start`, `ferret_session_remember`, `ferret_session_checkpoint`
and `ferret_session_end` — the write half of what EPIC-111 shipped read-only. An
agent opens a session, records what it decided, checkpoints where it got to, and
closes it, without a shell.

## The three decisions, and how each is measured

**D-117.1 — the server owns identity.** Two assertions, and the second is the one
that matters: `ferret_session_start` returns a minted uuid, and its input schema
has exactly five properties, none of which is a session id. The *absence* is the
test — a field a client could fill would make session ids a shared namespace
whatever the handler then did with it — and the schema is `strictObject`, so a
client that sends one is refused rather than ignored.

**D-117.2 — a closed transport is not an ended session.** The transport is
closed mid-session and the session is asserted `active` with `endedAt` null; a
second connection then reads the same session and continues it. An editor
restarting is not a user finishing their work, and nothing on the transport path
may decide otherwise.

**D-117.3 — recording has its own permission.** Three refusals: a principal with
`READ` alone is refused all four tools and writes nothing; a principal with
`READ` and `INDEX` is refused `ferret_session_start`, which is the overload the
decision rejected, stated as a test; and a principal with `RECORD` alone is
refused `ferret_session_recall`, because the grant is narrow in both directions.

## Acceptance criteria

Measured runs: `session-tools.test.ts` — **29 passed, 144 ms**;
`cli-authorization.test.ts` — **17 passed, 51 053 ms** (3 of them this Epic's);
`mcp-destructive-tools.test.ts` — **10 passed**; `tools.test.ts` — **78 passed**;
`packaging.test.ts` — **34 passed**; `tests/unit` and `tests/integration/mcp`
together — **2 392 passed** before the README gate was satisfied, and green after.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 seven tools, four annotated additive | PASS | the tool list, and `readOnlyHint: false` with `destructiveHint: false` on each of the four |
| AC-2 the server mints the identity | PASS | a minted uuid; a different one per call; the schema offers no id field and refuses an undeclared one |
| AC-3 memories and checkpoints record and read back | PASS | a memory recalled through `ferret_session_recall`; checkpoint sequences 1 then 2, numbered by Ferret |
| AC-4 a closed transport leaves the session active | PASS | `active` and `endedAt: null` after `close()`; a second connection continues it; `ferret_session_end` completes or abandons it; a second end is refused |
| AC-5 `RECORD` is required and `INDEX` is not enough | PASS | four refusals with nothing written; the `INDEX` refusal; the `RECORD`-only principal refused a recall |
| AC-6 a server with no writer says so | PASS | `E_NOT_IMPLEMENTED` reading "cannot open a session", not a `TypeError` |
| AC-7 the CLI is re-permissioned and the default is unchanged | PASS | `index` alone is refused at exit 7 naming `record`; `record` is the control; and an unconfigured operator still records |
| AC-8 a pasted credential does not reach storage | PASS | the statement comes back without the key and `redactedSecrets: 1` — EPIC-112's constructor-level redaction, reached from a third caller |
| AC-9 the destructive control is amended, not weakened | PASS | the destructive list is byte-for-byte unchanged; the additive list is pinned by name; a tool may not be both read-only and destructive; and silence about `destructiveHint` is still refused |

## The control that had to be amended, and why it is not weaker

`mcp-destructive-tools.test.ts` read **"not read-only ⇒ destructive guard"**, and
argued its value was having no exceptions. That rule was correct about every tool
that existed when it was written, and wrong about the first tool that writes
something *additive*: `ferret_session_remember` records one sentence an agent
wants a later session to inherit, and putting it behind EPIC-069's confirmation
gate would have required a human per sentence — removing the capability the
control was protecting.

The control now keys on `destructiveHint`, which is the protocol's own
distinction and the one the gate is actually about. Everything it required of a
destructive tool it still requires. What it *gained*: an additive tool must
declare itself additive (silence is still refused), no tool may claim to be both
read-only and destructive, and the additive tools are pinned by name in a second
list — so a tool that should have been destructive is caught here rather than by
a client that did not prompt.

## Known limitations

- A crashed client leaves an `active` session. EPIC-112's recorded limitation,
  unchanged: `ferret prune --sessions` reclaims it on an operator's age.
- A client that loses its handle and does not call `ferret_session_list` opens a
  second session, fragmenting one piece of work. Closing that needs the
  idempotency key D-117.1's option C describes, which the decision taken does not
  require.
- Nothing writes a transcript; captures remain the client adapters'.

## Upgrade note

An installation whose configuration grants `index` and not `record` loses
`ferret session start`, `end`, `checkpoint` and `remember` until `record` is
added. This is deny-by-default working correctly and is recorded on
[EPIC-068 §17](../EPIC-068-AI-Authorization-Model.md#17-amendment--2026-09-05-record-epic-117).
An installation with no `authorization` block is unaffected.

## Governance alignment

§2 — nothing new is required to start Ferret; the default grant is unchanged for
anyone who configured nothing. §6 — "cannot record" is reported rather than
looking like a missing tool. §12 — a statement a client sends is untrusted text,
redacted at the constructor before it is stored. EPIC-068's closed set was
amended in the open, with the cost stated.
