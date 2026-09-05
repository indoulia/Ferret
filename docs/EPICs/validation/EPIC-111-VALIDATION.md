# EPIC-111 — Session recall over MCP: validation evidence

**Status: VALIDATED** · three read-only tools, no storage change, no new
permission. The boundary the MCP surface has always kept is unchanged.

## Why this record is late

Written after the merge rather than alongside it. The reasoning is recorded once,
in [EPIC-109's record](EPIC-109-VALIDATION.md#why-this-record-is-late), and
applies identically here.

## Environment

| | |
| --- | --- |
| Tree | `22d9255` (`main`) |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | Not used — see below |
| Date | 2026-09-05 |

## What the Epic does

`src/mcp/session-tools.ts` registers `session.recall`, `session.list` and
`session.show` on the MCP server, each behind `Permission.READ`. An AI client
that reconnects can now ask what the previous session decided without an operator
shelling out to `ferret session recall`.

## Why there is no database in this record

The suite runs **13 protocol cases against a fake `SessionRecoveryPort`**, and
that is deliberate. EPIC-109 already proved the store satisfies that port against
real PostgreSQL, across 28 cases. Re-proving it here would test the store a
second time and the MCP surface not at all; what this Epic owns is the protocol
translation, the guards and the boundary, and a fake port is the only way to
exercise those without the database's behaviour standing in for them.

## Acceptance criteria

Measured run: `tests/integration/mcp/session-tools.test.ts` — **13 tests passed,
130 ms**.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 three tools register, all read-only | PASS | `registers all three, and every one is read-only` — the read-only annotation is asserted on each, not assumed from the absence of a write |
| AC-2 recall returns the checkpoint and memories in EPIC-043 priority order | PASS | `returns the checkpoint and the memories, flattened`; `follows a lineage and says which session each memory came from`; `drops superseded memories by default and can be asked for them` |
| AC-3 omissions are reported rather than dropped | PASS | `reports what it left out rather than dropping it — AC-3` |
| AC-4 a missing session is distinguishable from one that decided nothing | PASS | `distinguishes a session that decided nothing from one that does not exist — AC-4`. The two are different answers to a client, and collapsing them would make an empty recall indistinguishable from a typo'd id |
| AC-5 `list` and `show` report what is held | PASS | `lists the calling principal's sessions by default`; `says an actor has none rather than returning a bare empty list`; `shows one session with its checkpoint and every memory, superseded included`; `reports a missing session rather than an empty one` |
| AC-6 the guards apply: permission, unknown arguments, schema bounds | PASS | `refuses a principal without read`; `rejects an unknown argument rather than ignoring it`; `rejects a limit outside the bounds the schema declares` |
| AC-7 the MCP surface still does not reach storage | PASS | `tests/unit/boundaries.test.ts` — **120 tests passed**, assertions unmodified. The tools reach a port, never a `storage/` module |
| AC-8 the README documents every registered tool and no phantom | PASS | `tests/integration/mcp/tools.test.ts` — **78 tests passed**, including the F-87 catalogue control, which checks the README in **both** directions: an undocumented tool fails, and a documented tool that does not exist fails too |

## Read-only, deliberately

EPIC-111 exposes recall and stops there. A client can read what the last session
decided and cannot record what this one decided, which is half a memory — and the
half an autonomous agent needs most.

What blocks the other half is not plumbing. The store and the domain both support
a write already. It is one question the repository has no answer to: **who owns a
session's identity and lifetime.** Does the client supply the session id or does
the server mint one; when does a session *end*, given that a transport closing is
not a session ending and an editor restarting is the common case; and does an
agent recording its own memory need `INDEX` or a permission of its own, when
EPIC-068's set is closed and every write on the MCP surface today is
configuration or provider administration rather than knowledge.

Recording without answering those produces sessions nothing closes, and memories
attached to sessions that were never opened — where the foreign key would refuse
the very first call. **The read-only scope is that refusal made deliberate**, not
an omission. Tracked as [ROADMAP EPIC-117](../ROADMAP.md), `PRODUCT DECISION
REQUIRED`.

## Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **No write path.** Recorded above, with the question that blocks it. | An MCP client reads session memory and cannot contribute to it. | ROADMAP EPIC-117 — blocked on a product decision |
| **Proved against a fake port, not a database.** Reasoned above. | If `SessionStore` ever stopped satisfying `SessionRecoveryPort`, this suite would not notice — EPIC-109's would, and does. | Accepted; the port is the contract and both sides are tested against it |

## Governance alignment

| Rule | How EPIC-111 satisfies it |
| --- | --- |
| §4 Provider-first architecture | The tools name a port, never a store; `boundaries.test.ts` proves it rather than asserting it |
| §6 Evidence before inference | AC-4 exists because "no memories" and "no session" are different facts and a client must be able to tell them apart |
| §12 Security | Every tool is behind `Permission.READ`; unknown arguments are rejected rather than ignored; schema bounds are enforced at the boundary |
| §19 Testing and quality | The three guard cases are failure cases, and they are first-class rather than an appendix |
| §20 Observability | AC-3: what a limit left out is stated, never silently dropped |
| AI Rule §3 Epic scope is a contract | Read-only was the declared scope and the write path was not quietly started |
| AI Rule §9 No fake completion | The missing write path is stated as the open half, with the decision that blocks it named |
