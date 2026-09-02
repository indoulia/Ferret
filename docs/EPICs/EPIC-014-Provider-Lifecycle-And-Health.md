# EPIC-014 — Provider Lifecycle & Health

**Status: VALIDATED | Priority: P1 | Domain: Provider Architecture**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Provider Architecture;
> only the specification is new.

## 1. Objective

Give a provider a **state** an operator can read, and give a *failed optional*
provider a way back without restarting Ferret.

## 2. Value

Six Epics route lifecycle and health here, and one of them asks the question
this Epic exists to answer. **EPIC-093 §16:** *"if a failed optional provider
should ever recover without a restart of Ferret, that is EPIC-014's to
design."*

Today it cannot. `initializeAll` records a failure and continues — which is
EPIC-093 working correctly — and there is no path back: the capability stays
missing until the process restarts. On a long-running MCP server, a database
that was down for ten seconds at start-up costs the whole session.

- **EPIC-011 §4, EPIC-013 §4, EPIC-015 §4, EPIC-016 §4, EPIC-081 §4** — all
  name "provider health, restart or failure isolation" as this Epic's.
- **EPIC-093 §4** — "Restart, retry or backoff of a provider — EPIC-014 owns
  lifecycle and health", and "per-operation circuit breaking… is EPIC-014's;
  this is the initialize boundary."
- **EPIC-095 §4** — "Provider restart or health polling — EPIC-014."

## 3. Scope

- **An explicit lifecycle state** per provider, with the transitions that are
  legal and no others.
- **`recover(providerId)`** — one bounded attempt to initialize a **failed
  optional** provider, on demand.
- **A circuit that opens** after repeated failures, so recovery is attempted a
  finite number of times and says when it has stopped.
- **State in the health report**, so `ferret doctor` can advise on it.

## 4. Non-scope

- **Restarting a *required* provider.** §8.4 — a required provider's failure
  already tears the process down (`initializeAll` shuts down and throws), and a
  restart mechanism for one would be pretending a fatal condition is transient.
- **Health *polling*.** §8.6 — nothing here runs on a timer. EPIC-078 owns
  periodic work, and a poll that restarts a provider unattended is a decision
  that Epic has to take. **It took it on 2026-09-03 and declined:** recovery
  re-runs an `initialize` that already failed, and doing that on a timer turns a
  misconfiguration into a log full of identical warnings — which is why the
  circuit in §8.3 exists. `ferret reconcile` cannot reach `recover`, and a test
  asserts it.
- **Per-operation retry.** EPIC-079 owns retry policy and EPIC-093 owns
  isolation at the initialize boundary. This Epic adds the *state* a circuit
  needs, not a retry wrapper around every call.
- **Re-registering a provider.** The registry seals at `initializeAll`
  (EPIC-013), and that stays true: recovery re-initializes a registered
  provider, it never adds one.
- **Changing how a failure is classified.** EPIC-093 §4's rule, unchanged.

## 5. Inputs

`ProviderRegistry`'s existing `#initialized`, `#disabled` and `#failed` sets,
and `Provider.initialize` / `release`.

## 6. Outputs

`src/providers/lifecycle.ts` — the state vocabulary and the circuit.
`ProviderRegistry.stateOf`, `.states()`, `.recover()`. State in `describe()`
and in the health report.

## 7. Dependencies

EPIC-011 (the contract), EPIC-013 (the registry), EPIC-093 (the failure
recording this builds on), EPIC-004 (`doctor`), EPIC-095 (diagnostics).

## 8. Contracts

### 8.1 A provider is in exactly one state, and the set is closed

`registered` → `initialized` | `disabled` | `failed`, and `released` from any of
them. `failed` → `initialized` is the recovery this Epic adds; `failed` →
`unrecoverable` is the circuit opening.

Derived from the registry's existing sets rather than stored beside them: two
places recording the same fact is how they come to disagree. The sets are
already the truth, and this Epic gives them one name.

### 8.2 Recovery is asked for, never assumed

`recover(providerId, host)` makes **one** attempt. It is not a loop, not a
timer, and not called from `initializeAll` — a start-up that retried would turn
a five-second start into a minute of silence, and EPIC-093's contract is that
the start *continues*.

Success moves the provider to `initialized` and clears the recorded failure, so
the capability it offers becomes available to the next operation that asks. A
second failure is recorded like the first.

### 8.3 The circuit opens after a bounded number of attempts

After {@link MAX_RECOVERY_ATTEMPTS} failed attempts the provider is
`unrecoverable` and `recover` refuses without trying. The reason is honesty
rather than efficiency: a provider that has failed to initialize four times is
not going to succeed on the fifth for any reason a caller can act on, and an
unbounded retry converts a permanent misconfiguration into a permanent stream
of warnings.

The count is per provider and resets on success. Nothing resets it otherwise —
a caller who believes the underlying cause is fixed restarts Ferret, which is
the honest signal that something outside Ferret changed.

### 8.4 A required provider is never recovered

`recover` refuses a provider that was not registered optional, and says why: a
required provider's failure already tore the process down, so there is nothing
in this process to recover. Offering the call would imply Ferret was running
usefully without it.

### 8.5 State is reported, and a degraded state names what is missing

`describe()` gains the state, and the health report names the state beside the
capabilities the provider would have offered. EPIC-093 §8.5's rule holds:
isolation is not silence, and a capability quietly missing is harder to diagnose
than the crash it replaced.

### 8.6 Nothing polls

No timer, no background task. State is read when something asks — a health
check, `doctor`, an operator. EPIC-078 owns periodic work, and a poll that
recovered a provider unattended would be making a decision nobody asked for at
a moment nobody chose.

## 9. Acceptance criteria

- **AC-1** Every registered provider reports exactly one state.
- **AC-2** A provider that initialized reports `initialized`.
- **AC-3** A provider switched off in configuration reports `disabled`, not
  `failed`.
- **AC-4** An optional provider whose `initialize` threw reports `failed`.
- **AC-5** `recover` on a `failed` optional provider re-runs `initialize`.
- **AC-6** A successful recovery reports `initialized`, and the capability it
  offers is available afterwards.
- **AC-7** A successful recovery clears the recorded failure from health.
- **AC-8** A failed recovery leaves the provider `failed` and records the new
  failure's code.
- **AC-9** After `MAX_RECOVERY_ATTEMPTS` failures the provider is
  `unrecoverable`.
- **AC-10** `recover` on an `unrecoverable` provider refuses **without calling
  `initialize`**.
- **AC-11** `recover` refuses a **required** provider, naming the reason.
- **AC-12** `recover` refuses an `initialized` provider rather than restarting
  a working one.
- **AC-13** `recover` refuses a `disabled` provider — off is a choice, not a
  fault.
- **AC-14** A recovered provider's state appears in `describe()` and in the
  health report.
- **AC-15** Nothing in this Epic starts a timer, and a test asserts that.
- **AC-16** The attempt count resets on success, so a provider that recovers
  and later fails is not immediately `unrecoverable`.

## 10. Test requirements

**Unit** — every state and every transition; the circuit's bound; each refusal.

**Integration** — recovery of a real optional provider through a real runtime,
and the capability becoming available afterwards.

**Failure** — a provider that throws on every attempt; one that throws on
`release`; one whose `initialize` succeeds the second time.

**Regression** — EPIC-093's isolation suite and EPIC-013's registry suite
unchanged.

## 11. Security requirements

A recovery is not a privilege escalation: it re-runs an `initialize` the
composition root already registered, with settings from the same configuration.
A failure's **code** is reported and never its message, which is EPIC-093's rule
and for its reason — a message can carry a path or a value.

## 12. Observability

State per provider, the attempt count, and the recorded failure code. One log
line per recovery attempt, naming the outcome.

## 13. Performance constraints

`stateOf` is set membership. `recover` costs exactly one `initialize`.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 with evidence in
`validation/EPIC-014-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-093 §16's recovery question and the five §4 deferrals struck with
dated notes.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.1 derives state from the sets that
  already hold it rather than storing a second copy.
- **§12 Security** — the code, never the message.
- **§5 Reuse Before Reinvent** — no new bookkeeping; the registry's existing
  sets are the state.
- **§13 Diagnosability** — §8.5: a missing capability names itself.

## 16. Raised, not absorbed

- **No polling, so a provider recovers only when something asks.** On an MCP
  server that is the next tool call; on a CLI run it is that run. A provider
  that came back while nothing was happening stays `failed` until someone looks,
  which is the honest behaviour and not the convenient one.
- **The circuit never closes on its own.** §8.3 — a caller who fixed the cause
  restarts Ferret. Closing it on a timer would need EPIC-078, and closing it on
  a guess would be worse than staying open.
- **A provider that fails *during* an operation is not detected here.** This
  Epic's states come from the initialize boundary. Per-operation circuit
  breaking needs a call-path hook, which EPIC-079's retry policy is closer to
  than this is.
- **`release` failures during recovery are logged, not raised.** A failed
  provider may hold a half-open resource, and refusing to retry because the
  cleanup of a previous failure failed would leave it stuck for the wrong
  reason.
