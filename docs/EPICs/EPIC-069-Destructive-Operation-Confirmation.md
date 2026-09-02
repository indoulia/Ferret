# EPIC-069 — Destructive Operation Confirmation

**Status: IMPLEMENTED | Priority: P0 | Domain: AI Control Plane & MCP**

> **Specification note.** The registry approved this Epic by name, domain and
> priority; no specification was ever written. This document supplies one.
>
> Every acceptance criterion below is derived from something already on record —
> Governance §12 (*"Destructive operations require explicit confirmation"*),
> `Architecture/EPIC-004-DECISIONS.md` §41, `Checkpoints/EPIC-004.md` §100,
> `EPIC-058-Permission-Aware-Retrieval.md` §120,
> `EPIC-059-061-064-065-Context-And-MCP.md` §54 and §110,
> `validation/EPIC-059-061-064-065-VALIDATION.md` §160, and EPIC-068 §4 and §8.
> **Nothing here invents a requirement.** Where a plausible requirement is *not*
> on record, §4 excludes it and names the owner.
>
> Authored after a readiness review against `bf8f5cf` measured what exists: `src/`
> contains no confirmation mechanism of any kind, and `grep -rn confirm src/`
> returns only forward references to this Epic.

## 1. Objective

Make a destructive operation impossible to perform in one step, and impossible to
perform differently from what was disclosed — so that "explicit confirmation" is a
control Ferret enforces rather than a sentence in a prompt.

## 2. Value

Governance §12 states the requirement in one line and does not qualify it:

> Destructive operations require explicit confirmation.

Four places on record are waiting on the mechanism that satisfies it.

1. **EPIC-068 decided permission and deliberately stopped there.** Its §4 excludes
   "the confirmation prompt for a destructive operation — EPIC-069. This Epic
   decides whether an operation is permitted; EPIC-069 decides whether it was
   *intended*, and both must hold." `MUTATE` and `CONFIG_WRITE` exist in the
   vocabulary, are denied by default, and currently gate nothing. Half the control
   is built.

2. **EPIC-066 and EPIC-067 are blocked on this half.** EPIC-059 §110: "until
   EPIC-069 provides confirmation for destructive operations, the safest" number
   of them is none. `validation/EPIC-059-061-064-065-VALIDATION.md` §160 names the
   three Epics together — 066, 067, 069 — as what closes "no configuration or
   administration tools".

3. **EPIC-004 already refused to build a repair path without this.**
   `Architecture/EPIC-004-DECISIONS.md` §41: "`doctor` therefore *advises* rather
   than repairs. A repair command is a separate, explicitly-requested operation —
   EPIC-069 (Destructive Operation Confirmation) governs anything of that shape."
   `Checkpoints/EPIC-004.md` §100 repeats it as an instruction to whoever picks it
   up: "Do not add a repair path to `doctor`."

4. **The MCP surface says so in its own header.** `src/mcp/server.ts` §65: "Every
   tool is also **read-only** … EPIC-069 is where a destructive operation would
   need confirmation, and until then the safest number of destructive tools is
   none."

Read-only-by-omission has carried Ferret this far. It stops working the moment one
tool needs to write, and every Epic above is that tool.

## 3. Scope

- An **operation plan** — what a destructive operation would do, in structured
  form, disclosed before it is done: the operation, a summary, and one effect per
  thing that would change.
- A **confirmation token** — issued by Ferret, unguessable, bound to one plan,
  single-use, expiring.
- A **gate** — `request(plan)` discloses and issues; `consume(plan, token)`
  either permits the operation to proceed or refuses.
- **Refusal on the first call**, so a destructive operation can never be a side
  effect of one request.
- **Binding to the disclosed effect**, so a confirmation issued for one change
  cannot execute another.
- **Redaction of the disclosure**, since a plan is the first thing in Ferret that
  deliberately shows a *configuration value* to a model.
- **Composition into the MCP surface**, at the same point EPIC-068's check
  already sits, and ordered after it.
- **A source-level control that a destructive tool cannot be registered without
  the gate**, so the guarantee does not depend on a future author remembering.

## 4. Non-scope

Named here so it is not quietly adopted:

- **Authenticating the confirming party, or proving a human saw the plan.**
  Ferret is spawned over stdio by the client it serves and has no channel to a
  person. §16 records the limit plainly rather than dressing it up. MCP's
  `destructiveHint` annotation is how Ferret *asks* the client to prompt; the
  client's approval UI is the client's control, not Ferret's.
- **Any destructive operation.** No tool becomes writable here, exactly as
  EPIC-068 added no mutating tool. EPIC-066 is the first; adding one would be
  taking its scope. §17 records what that costs and what it does not.
- **Whether an operation *is* destructive.** The operation declares it. A
  mechanism that classified operations for itself would be guessing about code it
  cannot see.
- **A CLI confirmation adapter.** Ferret has no destructive CLI command — `doctor`
  advises by construction (EPIC-004 D-002) and no command takes `--force` or
  `--yes`. The gate is transport-independent so the adapter is small when the
  first such command exists; building it now would be building for no caller.

  **Superseded 2026-09-02.** Two destructive CLI commands now exist —
  `verify --repair --yes` (EPIC-094) and `ferret prune --yes`
  ([EPIC-088](EPIC-088-Retention-And-Exclusion-Policies.md)) — and **neither
  uses this gate**. Both take an explicit flag instead, for the reason EPIC-094
  recorded and EPIC-088 §8.1 repeats: Ferret is spawned by an AI client as often
  as by a person, and this Epic's confirmation is a *round trip* the CLI has no
  channel for — a prompt would hang in a pipe. The adapter foreseen here would
  therefore be an adapter to a mechanism the CLI cannot use, so the two surfaces
  differ deliberately: MCP confirms with a token, the CLI confirms with a flag.
  Recorded rather than reconciled; a future Epic that wants one shape for both
  has to choose which surface changes.
- **Undo, rollback, or a restore point.** EPIC-089/090 (Backup & Export, Data
  Import & Recovery). Confirmation prevents an unintended change; it does not
  reverse an intended one.
- **Audit events for a confirmation** — EPIC-085. The configuration journal
  (EPIC-003) already records a configuration change and keeps doing so.
- **Persisting a pending confirmation across processes.** A confirmation must not
  outlive the session that produced it; see §8.
- **Rate limiting a destructive operation** — EPIC-079 owns backoff. §8 bounds the
  pending set for memory, which is not a rate limit.

## 5. Inputs

- `Permission`, `Principal`, `assertPermitted` (EPIC-068) — the decision this one
  composes with and runs after.
- `FerretError`, `ErrorCode`, `serializeError` (EPIC-001/009) — a refusal that
  serializes and redacts.
- `auditValue` (EPIC-003) — the existing key-name redactor for a configuration
  value.
- `node:crypto` — `randomBytes` for a token, `createHash` for a plan digest.
  Governance §5: not reinvented.

## 6. Outputs

- `OperationPlan`, `PlannedEffect`, `EffectChange`, `ConfirmationRequest`.
- `ConfirmationGate`, with `request` and `consume`.
- `planDigest(plan)`.
- `ErrorCode.CONFIRMATION_REQUIRED`, `ErrorCode.CONFIRMATION_INVALID`, and
  `ExitCode.NOT_CONFIRMED`.
- `src/mcp/guards.ts` — `createToolGuard` and `createDestructiveToolGuard`, the
  latter being the one path a destructive tool may take, plus
  `CONFIRM_PARAMETER_DESCRIPTION` so every such tool spells the parameter the same
  way. The read guard is extracted from `createMcpServer` unchanged; the
  destructive one is new.

  No `McpServerDependencies.confirmations`. A dependency a server accepts and
  hands to nothing is not a seam, it is a field, and EPIC-066 is what turns it
  into one when it registers a tool that needs a gate.

## 7. Dependencies

| Epic | Status | What is needed |
| --- | --- | --- |
| EPIC-001 Core Runtime | VALIDATED | `FerretError`, the redacting serializer |
| EPIC-003 Configuration Engine | VALIDATED | `auditValue` |
| EPIC-064/065 MCP | VALIDATED | the surface a confirmation gates |
| EPIC-068 AI Authorization Model | IMPLEMENTED | the permission check this runs after |

No external dependency. No new package. No schema change.

## 8. Contracts

Other Epics may rely on the following.

- **Two calls, never one.** A destructive operation refuses its first invocation
  and changes nothing. There is no argument, no configuration value and no
  permission that makes a destructive operation single-call, because the disclosure
  is the point and a disclosure nobody could read is not one.
- **A token is Ferret-issued and unguessable.** 256 bits from
  `crypto.randomBytes`. Nothing a client sends, nothing Ferret indexed and nothing
  a model can compute is a valid confirmation. This is the property that makes the
  gate hold under EPIC-084's threat model: a repository that can write arbitrary
  text cannot write a confirmation.
- **A token is bound to the plan it was issued for.** `consume` recomputes the
  digest of the plan actually being performed and refuses a token issued for a
  different one. So an approval for "unset `logLevel`" cannot execute "unset
  `database`".
- **A token is single-use.** Consumed on the call that succeeds. One approval,
  one change.
- **A token expires.** Default five minutes. A confirmation that outlived the
  exchange that produced it is a standing grant nobody meant to issue.
- **A pending confirmation is process-local and never persisted.** It dies with
  the session, which is the same reasoning: a confirmation that survives a restart
  is a confirmation nobody is still present for.
- **The digest is computed over the true plan; the disclosure is redacted.** Not
  the other way round. Binding to the redacted rendering would let two different
  secrets share one digest, and a token issued for one would confirm the other.
- **A refusal is an error, not an empty result and not a success.** EPIC-068's rule
  and for the same reason: an unconfirmed operation did not happen, and reporting
  success for it would be a lie. `CONFIRMATION_REQUIRED` carries the plan and the
  token; `CONFIRMATION_INVALID` says the token cannot be used and does not say
  which of unknown, expired, spent or mismatched it was.
- **Authorization first, confirmation second.** A caller that was not granted the
  permission is refused with `NOT_PERMITTED` and never receives a plan, because a
  plan is a disclosure about Ferret's state. Both must hold; the order is not an
  implementation detail.
- **Confirmation is not authorization.** Holding a valid token for an operation the
  principal was not granted permits nothing. Neither substitutes for the other.

## 9. Acceptance criteria

| # | Criterion | Derived from |
| --- | --- | --- |
| AC-1 | A destructive operation refuses its first invocation and changes nothing. | Gov §12 |
| AC-2 | The refusal discloses the plan: the operation, a summary, and one effect per thing that would change. | Gov §12; §2 |
| AC-3 | The refusal carries a token the caller can present, and states how. | Gov §3 |
| AC-4 | Presenting that token performs the operation. | Gov §12 |
| AC-5 | A token cannot be guessed, derived or computed from anything the caller knows. | Gov §12; EPIC-084 |
| AC-6 | A token issued for one plan is refused for a different plan. | Gov §12 |
| AC-7 | A token is single-use: the second presentation is refused. | Gov §12 |
| AC-8 | A token expires, and an expired token is refused. | Gov §12 |
| AC-9 | Authorization is evaluated before confirmation: an unpermitted caller gets `NOT_PERMITTED` and no plan. | EPIC-068 §4, §8 |
| AC-10 | A disclosed plan carries no secret value, and a refusal leaks no configuration or credential. | Gov §12; EPIC-009 |
| AC-11 | A destructive tool cannot reach its handler unconfirmed, driven end to end through the real MCP protocol. | §159; EPIC-059 §110 |
| AC-12 | A destructive tool cannot be registered without the gate, and the control is not a convention. | `Checkpoints/EPIC-004.md` §100 |
| AC-13 | `CONFIRMATION_REQUIRED` and `CONFIRMATION_INVALID` are distinguishable from each other, from `NOT_PERMITTED`, and from a failure. | EPIC-009 serialization |
| AC-14 | The pending set is bounded, so issuing confirmations cannot grow memory without limit. | §13 |

## 10. Test requirements

**Unit.** The gate: a plan digest that is stable across key order and unstable
across values; a token that is unique per request; the four refusals — unknown,
expired, spent, mismatched; single use; the bounded pending set and what eviction
does to an evicted token; a disclosure whose values are redacted; an injected
clock, so expiry is tested rather than waited for.

**Integration.** Through the real MCP protocol, over the SDK's in-memory
transport: a destructive tool refuses its first call with
`CONFIRMATION_REQUIRED` and a plan; the same call with the token succeeds and the
underlying operation runs exactly once; a token from a different plan is refused;
a second use is refused; an unpermitted caller receives `NOT_PERMITTED` and no
plan.

The tool that is driven is registered **by the test**, through
`createDestructiveToolGuard` — the same public composition a product tool will
use. §4 excludes adding a destructive tool to Ferret's own surface, and a
confirmation flow nobody has driven through the protocol is a flow nobody has
tested; registering one in a test resolves both without taking EPIC-066's scope.

**Failure.** A malformed token, an empty token, a token of the right shape that
Ferret never issued, and a plan with no effects must each be refused rather than
throwing from inside a handler.

**Security.** A token is not derivable from the plan; a plan carrying a
secret-named configuration value discloses a redaction; `CONFIRMATION_INVALID`
does not distinguish expired from never-issued, so a caller cannot probe for a
token's existence; the ordering test that proves a denied caller sees no plan.

**Architecture.** A source-level test over `src/mcp/server.ts`: every tool
registered without `readOnlyHint: true` passes through `guardDestructive`. This is
AC-12, and it is the test that keeps holding when EPIC-066 adds the first one.

## 11. Security requirements

- The token is the control. It comes from a CSPRNG, is compared in full, and is
  never logged.
- A plan is a disclosure and is treated as one: it is redacted before it leaves,
  and a caller without permission never receives it.
- `CONFIRMATION_INVALID` is returned identically for unknown, expired and spent,
  so a refusal cannot be used to learn whether a token exists.
- Every refusal goes through EPIC-009's serializer, which is where the
  no-credentials guarantee lives.
- Governance §12: the control is in Ferret. A repository that can write arbitrary
  text into an indexed file cannot produce a confirmation, because it cannot
  produce a value Ferret generated at random and is still holding.

## 12. Observability

- A request and a consume are loggable at debug with the operation and the token's
  short prefix — never the token, never a disclosed value.
- The refusal an AI client receives states the operation, the plan and the token,
  so a client can tell "show this to the user and call again" from "start over".

## 13. Performance constraints

- `request` and `consume` are a hash and a map lookup. No query, no round trip.
- The pending set is bounded — default sixteen — and expired entries are dropped
  on access, so a long-lived server does not accumulate them.

## 14. Definition of Done

- Scope implemented; every acceptance criterion classified with evidence.
- Unit, failure, security and architecture tests pass; the regression suite passes.
- `docs/EPICs/validation/EPIC-069-VALIDATION.md` records the evidence, including
  what is `PENDING` and why.
- Registry entry updated.
- No acceptance criterion of any other Epic changed.

## 15. Governance alignment

- **§12 Security** — the rule this Epic exists for, enforced by Ferret rather than
  by a prompt; the plan is never taken from content and the token is never
  derivable from it.
- **§3 AI-Operated by Default** — a refusal an AI client can act on without a
  human reading a manual: it says what would change and how to proceed.
- **§6 Evidence Before Inference** — the plan states what *would* happen and the
  refusal states that nothing did. Neither manufactures certainty.
- **§2 Simplicity** — nothing to configure. A deployment that performs no
  destructive operation never encounters the gate.
- **§5 Reuse Before Reinvent** — `node:crypto`, `FerretError`, `auditValue` and
  MCP's own `destructiveHint` are consumed, not re-created.

## 16. Raised for governance

**This confirms an operation; it cannot confirm a person.** Ferret is spawned over
stdio by the client it serves, and there is no channel on which a human could
answer it. So what the gate guarantees is narrower than "a person agreed", and
worth stating exactly:

1. the destructive effect was disclosed, in structured form, before it happened;
2. nothing happened on the call that disclosed it;
3. what happened was bound by digest to what was disclosed;
4. the confirming value was generated by Ferret at random and could not have come
   from indexed content, from a tool argument, or from a model.

What it does not guarantee is that a human read (1). An AI client can call twice
by itself. The mitigation available is MCP's own `destructiveHint` annotation,
which is why every destructive tool must declare it — a conforming client prompts
its user before calling such a tool, and the two-call shape means the prompt it
shows contains Ferret's plan. That is the client's control, and Governance §12
requires Ferret's; both exist here, and only the second is Ferret's to enforce.
Closing the gap needs a transport that can carry a human's answer, which no
approved Epic defines. This is the same shape of limit EPIC-068 §16 recorded for
authentication, and it is recorded for the same reason.

**Five minutes, and sixteen pending.** Neither number is on record. A ceiling was
required — an unbounded pending set is a memory leak on a long-lived stdio server
and an unexpiring token is a standing grant — and these are chosen to be
comfortable for one exchange between a client and a user while being far too short
to be a durable capability. Both are constructor options, so a caller with a
measured reason can change them without a governance amendment.

## 17. Known gap at authoring time

**Ferret's own MCP surface still has no destructive tool**, and §4 excludes adding
one: EPIC-066 owns the first, and building it here would take its scope — the same
line EPIC-068 drew when it added a permission vocabulary and no mutating tool.

That is a gap in *coverage of the surface*, not in the mechanism. AC-11 is
demonstrated against a tool the test registers through
`createDestructiveToolGuard`, which is the identical composition EPIC-066 will
use, so what is untested is not "does confirmation work through MCP" but "does
Ferret have something to confirm". AC-12's architecture test is what guarantees
the gap cannot be filled incorrectly: the first destructive tool registered in
`server.ts` without that guard fails the suite. EPIC-066's evidence records the
first product tool walking the path.
