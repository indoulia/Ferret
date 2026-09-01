# EPIC-069 — Destructive Operation Confirmation · Validation Evidence

**Assessed against:** working tree on top of `bf8f5cf`
**Date:** 2026-09-01
**Specification:** [`../EPIC-069-Destructive-Operation-Confirmation.md`](../EPIC-069-Destructive-Operation-Confirmation.md)

## 1. How this was assessed

Each criterion is classified `MET`, `PENDING`, `BLOCKED` or `NOT APPLICABLE`, and
each names the evidence that demonstrates it.

The gate's rules are demonstrated by unit tests, because they are rules about a
value and a digest. The *flow* is demonstrated through the real MCP protocol —
a unit test can prove `consume` refuses a spent token, and cannot prove the token
survives being serialized into a tool error and pulled back out of one by a
client. And the whole flow is additionally driven over **real stdio, in a
separate OS process, against the built `dist/` output**, because that is the only
configuration a real AI client ever runs.

The destructive tool driven in both cases is registered by the test or the probe,
through `createDestructiveToolGuard` — the public composition EPIC-066 will use.
Specification §4 excludes adding one to Ferret's own surface and §17 records
exactly what that does and does not leave untested.

Where evidence is weaker than the criterion deserves, §4 says so rather than
rounding up.

## 2. Criteria

| AC | Status | Evidence |
| --- | --- | --- |
| **AC-1** A destructive operation refuses its first invocation and changes nothing | **MET** | `confirmation.test.ts` — *"refuses the first call, changes nothing, and carries the plan"*, and *"treats an empty token as no token"* so an empty string is not a confirmation. Through the protocol, `integration/mcp/confirmation.test.ts` — *"refuses the first call, changes nothing, and returns the plan"* asserts the subject is untouched, not merely that an error came back. Over real stdio: `call 1 (no token) REFUSED E_CONFIRMATION_REQUIRED`. |
| **AC-2** The refusal discloses the plan | **MET** | The plan reaches the client whole: `{"operation":"config.set","summary":"Replace the configured log level.","effects":[{"target":"logLevel","change":"overwrite","from":"warn","to":"debug"}]}` over real stdio. `from` and `to` are both present, which is what makes the disclosure worth reading — an operator can see what is being replaced, not just that something is. |
| **AC-3** The refusal carries a token and states how to use it | **MET** | `integration/mcp/confirmation.test.ts` — *"tells the client how to proceed without it having to guess"*: the remediation contains the token and the instruction. `confirmation.test.ts` — *"accepts the token the refusal itself handed out"* tests the loop an AI client actually runs, which is the one that matters and the one easiest to leave unasserted. |
| **AC-4** Presenting that token performs the operation | **MET** | `integration/mcp/confirmation.test.ts` — *"performs the operation when the returned token is presented"*, asserting the handler ran **exactly once**: `applied` is `['debug']`, not `[]` and not `['debug','debug']`. Over real stdio: `call 2 (token) APPLIED {"applied":true,"value":"debug","timesApplied":1}`. |
| **AC-5** A token cannot be guessed, derived or computed | **MET** | 32 bytes from `crypto.randomBytes`, base64url — 43 characters, confirmed over stdio. `confirmation.test.ts` — *"issues a token nothing else could have produced"*: 100 requests for the **same plan** yield 100 distinct tokens, which is the property that matters, since a token derived from the plan would be computable by anything that knows the plan — including the repository that wrote the text it describes. Forged values, including the plan digest itself and a well-formed 43-character string, are refused: *"refuses a token Ferret never issued"*, and `call 5 (forged) REFUSED E_CONFIRMATION_INVALID`. |
| **AC-6** A token issued for one plan is refused for a different plan | **MET** | `confirmation.test.ts` — *"refuses a token issued for a different plan"* (confirm `logLevel`, then present it for `unset database`) and *"refuses a token whose plan has changed underneath it"*. `planDigest` is pinned in both directions: stable across field order, unstable across every component. Over stdio: `call 4 (escalate) REFUSED E_CONFIRMATION_INVALID` — a token issued for `to: debug` will not perform `to: trace`. |
| **AC-7** A token is single-use | **MET** | `confirmation.test.ts` — *"is single use"*, with `pendingCount` back to 0. Through the protocol and over stdio: `call 3 (replay) REFUSED E_CONFIRMATION_INVALID`. Spent **before** `run`, so a half-failed operation cannot leave a live approval for a world that has since moved. |
| **AC-8** A token expires, and an expired token is refused | **MET** | `confirmation.test.ts` — *"refuses an expired token"*, on an injected clock: usable at 999 ms, refused at 1000 ms with a 1000 ms TTL, so the boundary is asserted rather than approximated. Default 5 minutes pinned by *"expires by default five minutes out"*. |
| **AC-9** Authorization is evaluated before confirmation | **MET** | `integration/mcp/confirmation.test.ts` — *"refuses an unpermitted caller with NOT_PERMITTED and discloses no plan"*, asserting the code is `E_NOT_PERMITTED` **and** that the response contains no `logLevel`. *"does not build a plan for a caller it is about to refuse"* asserts the ordering by counting: the plan thunk runs zero times. *"does not let a valid confirmation substitute for a permission"* covers the converse — a token from a shared gate grants nothing. Over real stdio: `ungranted caller REFUSED E_NOT_PERMITTED / discloses a plan: false`. |
| **AC-10** A disclosed plan carries no secret value; a refusal leaks nothing | **MET** | `confirmation.test.ts` — *"redacts a secret-named value rather than disclosing it"*: `database.password` discloses the **path** and not `old-pw` or `new-pw`, via EPIC-003's `auditValue`. Paired with *"discloses a value that is not secret-named"*, because a gate that redacted everything would disclose nothing and confirm nothing. *"leaks neither the plan nor a value in the invalid-token refusal"* — a forged token gets the operation name and no plan, so a forged token is not a way to read state. Over stdio: `leaks credential false`. |
| **AC-11** A destructive tool cannot reach its handler unconfirmed, end to end through the real MCP protocol | **MET** | `tests/integration/mcp/confirmation.test.ts` — 11 tests over the SDK's transport with a real `McpServer` and a real `Client`. Then over **real stdio, separate process, built `dist/`**: five calls, one application. Also *"does not reuse a confirmation across a restart of the gate"*, which is the process-local contract. **Caveat, stated rather than rounded up:** the tool is registered by the test, not by Ferret — see §4. |
| **AC-12** A destructive tool cannot be registered without the gate, and the control is not a convention | **MET** | `tests/unit/mcp-destructive-tools.test.ts`, 8 source-level tests over `src/mcp/server.ts`. **Verified by making it fail**: injecting `ferret_wipe_everything` with `readOnlyHint: false` and the plain `guard` turned three tests red, the first naming the tool — *"ferret_wipe_everything is not annotated readOnlyHint: true, so it must pass through the destructive guard"*. Also pins that `server.ts` calls neither `assertPermitted(` nor `.consume(` itself, so the ordering guarantee stays in one place. |
| **AC-13** The two codes are distinguishable from each other, from `NOT_PERMITTED`, and from a failure | **MET** | Three distinct codes observed on one transport in one run: `E_CONFIRMATION_REQUIRED`, `E_CONFIRMATION_INVALID`, `E_NOT_PERMITTED`. `ExitCode.NOT_CONFIRMED` (8) is its own code for the reason `NOT_PERMITTED` got 7: a narrow grant is an operator's to widen, an unconfirmed operation is the caller's to confirm, and collapsing them would send a script to edit configuration when all it had to do was ask again. |
| **AC-14** The pending set is bounded | **MET** | `confirmation.test.ts` — *"never exceeds the ceiling however many are requested"* (50 requests, ceiling 4), *"evicts oldest first"*, *"keeps the newest usable after eviction"* so the bound does not make the mechanism unusable, and *"drops expired entries without needing a request to trigger it"* — a server that is never successfully confirmed still does not accumulate. |

**Summary: 14 MET.**

## 3. Test and production evidence

`npm run verify` — lint, typecheck, build, and the full suite: **91 files, 2136
passed, 3 skipped**, database suites against a real PostgreSQL.

New:

- `tests/unit/confirmation.test.ts` — 27 tests
- `tests/integration/mcp/confirmation.test.ts` — 11 tests, real MCP protocol
- `tests/unit/mcp-destructive-tools.test.ts` — 8 source-level architecture tests

The whole flow over **real stdio**, a separate OS process, against `dist/`:

```
annotations        {"readOnlyHint":false,"destructiveHint":true,"openWorldHint":false}
call 1 (no token)  REFUSED E_CONFIRMATION_REQUIRED
  plan             {"operation":"config.set","summary":"Replace the configured log level.",
                    "effects":[{"target":"logLevel","change":"overwrite","from":"warn","to":"debug"}]}
  token            pR5jaKHknygU… (43 chars)
  leaks credential false
call 2 (token)     APPLIED {"applied":true,"value":"debug","timesApplied":1}
call 3 (replay)    REFUSED E_CONFIRMATION_INVALID
call 4 (escalate)  REFUSED E_CONFIRMATION_INVALID
call 5 (forged)    REFUSED E_CONFIRMATION_INVALID

ungranted caller   REFUSED E_NOT_PERMITTED
  discloses a plan false
  remediation      Grant "config.write" to this principal in Ferret's configuration
                   (`authorization.permissions`), then restart the client.
```

Five calls, one application. The escalation attempt is the one worth reading
twice: a token Ferret issued, presented by the caller it was issued to, on the
same tool, in the same session, one argument different — refused.

## 4. Weaker than the criterion deserves

**AC-11's tool is registered by the test, not by Ferret.** Specification §4
excludes adding a destructive tool and §17 states the consequence: what is
untested is not "does confirmation work through MCP" but "does Ferret have
something to confirm". The composition driven is the public one, byte for byte
what EPIC-066 will call. The residual risk is that EPIC-066 composes it
differently — which is what AC-12's architecture test exists to catch, and which
was verified by making that test fail.

**Nothing proves a human saw the plan.** This is not a gap in the evidence, it is
the shape of the mechanism, and specification §16 states it as a limit rather than
dressing it up. An AI client can call twice by itself. What is enforced is that
the effect was disclosed first, that nothing happened on the disclosing call, that
what happened was bound by digest to what was disclosed, and that the confirming
value came from Ferret's CSPRNG. `destructiveHint: true` is how Ferret asks a
conforming client to prompt its user, and the annotation is confirmed reaching a
client over stdio — but the prompt is the client's control, not Ferret's.

**The token is compared by map lookup, not in constant time.** 256 bits of
entropy over a local pipe, where the attacker is already a process running as the
user. Recorded because it is a real property of the implementation, not because
it is a plausible attack.

## 5. What was found while building this

**Ferret had already solved this problem once, and said so better.**
`ferret_search` — dogfooding, per the project's own practice — surfaced
`encodeCursor` in `src/providers/sdk/operation.ts`, whose doc comment is the same
argument for the same design:

> Bound to the issuing provider and capability on purpose. A cursor travels out to
> an AI client over MCP and comes back later, by which time nothing guarantees it
> comes back to the same place it left. An unbound cursor handed to a different
> provider decodes cleanly into a position that means something else entirely, and
> the enumeration resumes at nonsense — silently, which is the worst way for it to
> be wrong.

A confirmation is that shape with a destructive operation on the end of it instead
of a page of results. `planDigest` now cites EPIC-011's precedent rather than
presenting the binding as new.

**Ferret could not answer the question this Epic is built on.** A search for the
exact governance sentence — *"Destructive operations require explicit
confirmation"*, `Governance/README.md` §12 — returns **zero results**. Markdown
has no parser: `validation/EPIC-108-VALIDATION.md` §74 records `159 no-parser` as
EPIC-024's designed outcome. So the governance corpus that every specification is
derived from is not retrievable through Ferret, and this Epic was researched with
`grep`. Recorded as an observation against EPIC-024/108, not as a defect of
either — both state the position — and not raised as a new Epic here.

**The guards moved out of `server.ts`.** Not planned. AC-12 needs a test to prove
a tool *took* a path, and a private closure inside `createMcpServer` cannot be
named by a test; AC-11 needs the destructive path drivable without Ferret shipping
a destructive tool. Both wanted the same thing, so `createToolGuard` was extracted
unchanged alongside the new `createDestructiveToolGuard`. The read guard's
behaviour is untouched — the 2136-test suite is the evidence — and `server.ts` lost
25 lines.

**One self-inflicted error worth recording.** `git checkout -- src/mcp/server.ts`,
used to revert the deliberately-injected unguarded tool from the AC-12 red-check,
reverted every uncommitted change to that file. The guard extraction was rewritten
from the same transformation. Nothing was lost and the suite caught it
immediately — `mcp-destructive-tools.test.ts` failed on `assertPermitted(` being
back in `server.ts`, which is the test doing its job on its own author.

## 6. What this closes

- **Governance §12** — *"Destructive operations require explicit confirmation"* —
  has a mechanism for the first time. It gates nothing yet, which §17 states
  plainly.
- **EPIC-068 §4's deferral** — *"the confirmation prompt for a destructive
  operation — EPIC-069"*. Both halves of the control now exist, and
  `createDestructiveToolGuard` is the one place they compose, in the order the
  contract requires.
- **EPIC-066 and EPIC-067 are unblocked** — again, and this time completely.
  EPIC-068 gave them a permission to declare; this gives them a confirmation to
  require. EPIC-059's *"until EPIC-069 provides confirmation for destructive
  operations, the safest"* count of destructive tools no longer applies.
- **`Checkpoints/EPIC-004.md` §100** — *"Do not add a repair path to `doctor`"* —
  becomes enforceable rather than advisory for anything registered on the MCP
  surface. A repair *command* is still EPIC-004's to leave alone; §4 excludes the
  CLI adapter and says why.

## 7. Raised, not absorbed

Both in specification §16, because neither is on record and both are decisions:

- **This confirms an operation; it cannot confirm a person.** Stated as the
  narrower guarantee it is, in four numbered parts, rather than as consent.
- **Five minutes, and sixteen pending.** A ceiling was required — an unbounded
  pending set is a memory leak on a long-lived stdio server, and an unexpiring
  token is a standing grant. Both are constructor options, so a measured reason
  can change them without a governance amendment.

## 8. Definition of Done

| Requirement | Status |
| --- | --- |
| Scope implemented | Yes |
| Acceptance criteria satisfied | 14 MET |
| Unit tests | Yes — 27 on the gate, 8 architecture |
| Integration tests | Yes — real MCP protocol, and real stdio against built `dist/` |
| Failure and boundary cases | Yes — empty token, forged token, plan digest as token, expired to the millisecond, evicted, replayed, escalated, empty plan |
| Security implications | The Epic *is* a security control; the plan-bound unguessable token is the property, and the disclosure is demonstrated redacted |
| Observability | The refusal names the operation, the plan and the token; the token is never logged |
| Documentation | Specification, this document, and the exit-code table |
| Governance | §12, §3, §6, §2, §5 |
| Dependencies validated | EPIC-001, 003, 064, 065, 068 |
| Known blockers | None. §4 records what is deliberately not covered. |
