# EPIC-093 — Provider Failure Isolation

**Status: APPROVED | Priority: P0 | Domain: Reliability & Operations**

> **Specification note.** Six approved documents park provider failure
> isolation on this Epic by name (EPIC-015 §4, EPIC-016 §4, EPIC-079 §4,
> EPIC-081 §4, EPIC-094 §4, EPIC-099 §4). None of them says what it should do,
> which is what this specification is for.
>
> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> §2 describes the code as it is.

## 1. Objective

Stop one provider's failure from being every provider's failure: a component
Ferret can work without must be able to fail without stopping Ferret.

## 2. Problem, measured

**Every provider is required, because none of them is optional.**
`ProviderRegistry.initializeAll` (`src/providers/registry.ts:278`) wraps each
provider's `initialize` in a try, and on any failure shuts down everything
already started and rethrows. There is no way to register a provider whose
absence is survivable, because there is no notion of one.

The classification inside that catch is careful and good — a provider's own
`FerretError` keeps its code, remediation and retryability rather than being
relabelled. What it does with a failure is the problem, not how it describes it.

The consequences are concrete:

- **A parser that cannot load its grammar takes down `ferret index`.** Content
  indexing is opt-in and degradable by design — EPIC-108 built five distinct
  skip reasons for exactly this, and `ContentStageSkip.NO_PARSER` is one of
  them. But those reasons are only reachable if the runtime *starts*; a parser
  that throws from `initialize` never gets that far.
- **EPIC-071's Jira provider will make this worse.** An external system that is
  down is the ordinary case for a network provider, and under today's rules an
  unreachable Jira would stop a Git-only index run.
- **`describe()` cannot say a provider failed.** It reports `initialized` and
  `enabled` (`registry.ts:228-232`); a provider that threw is neither, and is
  indistinguishable from one that was switched off in configuration. Governance
  §6 wants those to look different.

**What is already right, and is not this Epic's to redo.** Per-file isolation
inside a run: EPIC-108 §8.9 counts an unreadable blob and a throwing parser
separately and continues; EPIC-079 retries a transient storage failure;
`runtime.shutdown` aggregates release failures into one `E_SHUTDOWN_FAILED`
rather than losing the rest. The gap is the *lifecycle boundary*, not the
operation.

## 3. Scope

1. **A provider may be registered as optional.** An optional provider that
   fails to initialize is recorded, disabled and reported; the runtime starts.
2. **A required provider is unchanged** — it still fails the start, with the
   same classification it has today. Required is the default.
3. **A failed provider offers no capability.** Capability selection must not
   hand a caller a provider that did not start.
4. **`describe()` distinguishes failed from disabled**, and carries the reason.
5. **Health reports a failed optional provider as degraded**, naming it.

## 4. Non-scope

- **Restart, retry or backoff of a provider** — EPIC-014 (P1) owns lifecycle and
  health; EPIC-079 owns retry and explicitly assigns provider-level policy here,
  but a *policy* is not a restart mechanism and this Epic builds none.
  **Built 2026-09-03 in EPIC-014**, and this Epic's own behaviour is unchanged:
  `initializeAll` still records and continues, and recovery is a separate call
  nothing on the start path makes.
- **Per-operation circuit breaking.** A provider that fails on its ninth call is
  EPIC-014's; this is the initialize boundary.
- **Changing how a failure is classified.** The catch in `initializeAll`
  preserves the provider's own error, and that is correct.
- **Deciding which providers are optional in production.** The composition root
  decides per command, because it knows what the command needs — §8.1.
- **Health checks, probes or a diagnostics surface** — EPIC-004, EPIC-095.
- **Provider sandboxing or out-of-process isolation.** EPIC-024 recorded the
  absence of a parser sandbox and did not plan one; a failing provider is
  isolated from the *runtime*, not from the process.

## 5. Inputs

`ProviderRegistry.register`, `initializeAll`, `select`, `supports`, `describe`
(EPIC-013); `ProviderSettings.enabled` (EPIC-015); `DependencyStatus` and the
health report (EPIC-004); `ContentStageSkip` (EPIC-108), which is what a
degraded run already looks like downstream.

## 6. Outputs

- An optional registration, and the isolation it buys.
- A failure recorded per provider, with its classified error.
- `describe()` reporting failed, with a reason.
- A health component naming providers that failed to start.

## 7. Dependencies

EPIC-011, EPIC-012, EPIC-013, EPIC-015 — all VALIDATED. Nothing here changes an
acceptance criterion of any of them.

## 8. Contracts

### 8.1 Optionality is the composition root's decision, not the provider's

A provider cannot know whether it is essential: the same parser is optional for
`ferret index` and required for `ferret index --content`. Ferret's own storage
provider is essential to every command that touches a database and irrelevant to
`ferret version`. So the flag lives at **registration**, where the caller
composing the runtime already knows what it needs.

A provider that declared its own optionality would be asserting something about
a deployment it cannot see, and would make "required" un-overridable by the one
component that has the context.

### 8.2 Required is the default

An unmarked provider fails the start, exactly as today. This Epic adds a way to
opt out of that, and changes nothing for a caller that does not.

### 8.3 A failed provider offers nothing

`select` and `supports` must not return a provider that failed to initialize.
Handing a caller an object whose `initialize` threw is worse than having none:
the failure resurfaces later, somewhere with no context about why.

### 8.4 Failed and disabled are different facts

`enabled: false` is a configuration decision; failed is an event. Governance §6
requires them to look different, and an operator diagnosing "why is content
indexing not running" needs to know which one happened.

### 8.5 Isolation is not silence

An isolated failure is logged at `warn` and appears in health. A provider that
fails quietly and is never mentioned again is the outcome this Epic must not
produce — it converts a loud failure into a silent capability gap, which is
harder to diagnose than the crash it replaced.

## 9. Acceptance criteria

- **AC-1** A provider registered as optional that throws from `initialize` does
  not fail `initializeAll`; the runtime starts.
- **AC-2** A required provider that throws still fails the start, with the same
  error code, remediation and retryability it produces today.
- **AC-3** Providers that initialized before an optional failure stay
  initialized; the registry does not tear them down.
- **AC-4** A failed optional provider offers no capability: `select` returns
  another provider or nothing, and `supports` reports unsupported.
- **AC-5** `describe()` reports a failed provider distinctly from a disabled one
  and from an initialized one, and carries the failure reason.
- **AC-6** The failure is logged once, at `warn`, naming the provider and its
  error code — never the error's full message if that message could carry a
  path or a value beyond what redaction already allows.
- **AC-7** Health reports a failed optional provider as degraded, naming it,
  and stays `ok` when none failed.
- **AC-8** `shutdown` does not attempt to stop a provider that never started,
  and a failure in one shutdown does not prevent the others.
- **AC-9** Nothing changes for a caller that registers no optional provider —
  proved by the existing suites passing unchanged.

## 10. Test requirements

- **Unit** — an optional provider that throws, beside a required one that does
  not: the runtime starts, the good one is initialized, the bad one is failed
  and offers no capability. The reverse: a required provider that throws still
  aborts, and the classification is unchanged.
- **Isolation of the teardown** — an optional failure must not shut down a
  provider that already started (AC-3), which is the behaviour most likely to be
  got wrong, because the required path deliberately does the opposite.
- **Health** — degraded with a name, `ok` without.
- **No new integration fixture.** This is registry behaviour; the existing
  integration suites prove AC-9 by continuing to pass.

## 11. Security requirements

A failure reason reaches a log and a health report, both of which are
disclosure surfaces. It goes through the existing redaction — EPIC-091's
funnel — and the log line carries the provider id and the error *code* rather
than an unbounded message.

## 12. Observability

AC-5, AC-6, AC-7. A capability that is unavailable because a provider failed
must be traceable from `ferret doctor` to the provider and the reason, without
reading a log from the start of the process.

## 13. Performance constraints

None beyond the existing start path. Isolation adds a branch, not a retry.

## 14. Definition of Done

Every acceptance criterion satisfied; `npm run verify` green; a validation
document; the registry updated; the six documents that park failure isolation
here updated or left accurate.

## 15. Governance alignment

- **§4 Provider-First** — "replacing a provider requires no unrelated core
  change" is weaker than it sounds if any provider can stop the process.
- **§6** — failed and disabled must not look the same.
- **§13** — a degraded run that reports itself beats a failed run.
- **§20** — the failure is inspectable, not silent.

## 16. Raised, not absorbed

- **This Epic does not make anything optional.** It adds the mechanism and
  changes no existing registration, so `ferret index --content` still fails if
  its parser cannot load. Choosing which of Ferret's own providers should be
  optional is a per-command decision with user-visible consequences, and it
  belongs with the command's Epic rather than being taken here by default.
- **EPIC-014 is P1 and owns the rest.** Restart, health polling and circuit
  breaking are named non-scope; if a failed optional provider should ever
  recover without a restart of Ferret, that is EPIC-014's to design.
  **Answered 2026-09-03 by [EPIC-014](EPIC-014-Provider-Lifecycle-And-Health.md):**
  it should, and `ProviderRegistry.recover` does it — one bounded attempt, asked
  for and never assumed, with a circuit that opens after four failures. Health
  *polling* is still not built and is still EPIC-078's to decide, because a poll
  that recovered a provider unattended would make a decision nobody asked for at
  a moment nobody chose. Per-operation circuit breaking also remains out: this
  Epic's states come from the initialize boundary, exactly as recorded here.
