# EPIC-014 — Provider Lifecycle & Health · Validation Evidence

**Assessed against:** working tree on top of `2d44dce`
**Date:** 2026-09-03
**Environment:** the real `ProviderRegistry` with real providers whose
`initialize` throws a controlled number of times; the real `parseConfig` for the
disabled case.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 exactly one state per registered provider | **MET** | `provider-lifecycle.test.ts` "reports registered before initialization has run", and "reports one state per registered provider, and no more" |
| AC-2 an initialized provider reports `initialized` | **MET** | "reports initialized after a successful start" |
| AC-3 a disabled provider reports `disabled`, not `failed` | **MET** | "refuses a provider switched off in configuration" — the state is asserted before the refusal |
| AC-4 a failed optional provider reports `failed` | **MET** | "reports failed, not disabled, for an optional provider that threw" — with the code, and the attempt counted |
| AC-5 `recover` re-runs `initialize` | **MET** | "re-runs initialize and reports initialized" — the provider's own call count goes 1 → 2 |
| AC-6 the capability is available afterwards | **MET** | "makes the capability selectable again" — `UNAVAILABLE` before, defined declaration after |
| AC-7 a successful recovery clears the failure from health | **MET** | "clears the recorded failure from health" — `failures()` non-empty before, empty after |
| AC-8 a failed recovery stays `failed` and records the code | **MET** | "records the new failure and stays failed when recovery fails" |
| AC-9 `unrecoverable` at the bound | **MET** | "becomes unrecoverable at the bound" — `MAX_RECOVERY_ATTEMPTS` initialize calls, no more |
| AC-10 refuses **without calling** `initialize` | **MET** | "refuses without calling initialize once the circuit is open" — the call count is unchanged by the refused attempt |
| AC-11 refuses a required provider | **MET** | "refuses a required provider, naming the reason" |
| AC-12 refuses a running provider | **MET** | "refuses a provider that is running" — and does not restart it |
| AC-13 refuses a disabled provider | **MET** | "refuses a provider switched off in configuration" — `initialize` never called |
| AC-14 state in `describe()` and health | **MET** | "describes a failed provider as failed and a recovered one as initialized"; `checkAll` names the state and gives `unrecoverable` different advice |
| AC-15 nothing starts a timer | **MET** | "starts no timer" spies on `setInterval`/`setTimeout` across a start-up and a recovery; "names no timer in the source" asserts over the module text |
| AC-16 the count resets on success | **MET** | "resets the count on success, so a later failure is not immediately fatal", and "counts per provider" |

Sixteen of sixteen MET. `npm run verify` green: 144 files, 2 993 passed,
3 skipped.

## Found while implementing

**`ProviderState` already existed, and means something else.** `BaseProvider`
declares `created → initializing → ready → shutting-down → stopped` — a
provider's view of **itself**, and only a provider that extends `BaseProvider`
has one. This Epic's state is the **registry's** view, and it holds facts a
provider cannot know about itself: that configuration switched it off, that it
was registered optional, that it has failed four times. The collision surfaced
as four type errors in `provider-sdk/concurrency.test.ts` the moment both were
on the barrel.

Renamed to `ProviderLifecycleState` rather than merged, and the reason is
recorded in the module: two vocabularies for two different observers is correct;
one name for both would have made every reader work out which was meant. Reusing
the SDK's would have been worse — `disabled` and `failed` are not states a
provider can put itself in.

**The start-up attempt counts against the budget.** `initializeAll` records the
failure, so a provider that has already failed there has spent one of its four.
The alternative — a fresh budget at the first `recover` — would give a provider
that fails at start-up five total attempts and one that fails only later four,
which is a distinction with no meaning. Asserted directly: `attempts` is 1
immediately after a failed start.

**`recover` releases before it retries, and ignores a release failure.** A
failed provider may hold a half-open resource, so `shutdown` runs first. Its
failure is logged at debug and swallowed — refusing to retry because the cleanup
of a *previous* failure failed would leave the provider stuck for the wrong
reason. Recorded in §16 as a deliberate asymmetry rather than left as a quiet
`catch`.

**The circuit is derived, not stored.** `unrecoverable` is computed from the
attempt count wherever it is asked for, so `recover`'s refusal and the health
report cannot disagree about whether the circuit is open. Storing a flag beside
the count would have been the third place recording the same fact — §8.1's own
argument, applied to this Epic's own addition.

**The architecture-boundary gate asked about the new module, correctly.**
`boundaries.test.ts` refuses any `providers/` module reachable from the core
that is not on an explicit allowlist, and `lifecycle.ts` was not. It belongs
there on exactly the ground `configuration.ts` joined on with EPIC-015: it is
the state vocabulary and the recovery budget the registry keeps *about* a
provider, and it imports nothing but `errors/`. Added with that reason recorded
beside the others, which is what keeps the allowlist auditable rather than
accumulating.

## Decisions worth recording

**Recovery is asked for and never assumed.** Not from `initializeAll` — a
start-up that retried would turn a five-second start into a minute of silence,
and EPIC-093's contract is that the start *continues*. Not on a timer, because a
poll that recovered a provider unattended would make a decision nobody asked for
at a moment nobody chose.

**Five refusals, five remediations.** A test asserts they are all distinct: a
required provider, a disabled one, a working one, an unknown id and an exhausted
circuit need five different things done about them, and one shared message would
make four of them useless.

**The circuit never closes on its own.** A caller who fixed the cause restarts
Ferret. Closing it on a timer would need EPIC-078; closing it on a guess would be
worse than staying open. The health report says so in the `unrecoverable` case
rather than advising an operator to "try again", which is advice that cannot
work.

**The code, never the message.** EPIC-093's rule, kept: a recovery failure logs
and reports `classified.code`, because a message can carry a path or a value and
this line reaches an operator's terminal.

## Limitations, recorded

- **No polling, so a provider recovers only when something asks.** On an MCP
  server that is the next tool call; on a CLI run it is that run. A provider that
  came back while nothing was happening stays `failed` until someone looks —
  honest rather than convenient.
- **A provider that fails *during* an operation is not detected here.** The
  states come from the initialize boundary. Per-operation circuit breaking needs
  a call-path hook, which EPIC-079's retry policy is closer to than this is, and
  EPIC-093 §4 already recorded it as this Epic's — so it stays open.
- **No CLI surface.** `recover` is a registry method with no `ferret` command
  behind it, because the caller that benefits is a long-running MCP server rather
  than a person at a terminal, and a command would need a story for which
  provider ids are safe to name. EPIC-067 (MCP provider administration) is where
  that belongs.
- **`RELEASED` is registry-wide, not per provider.** `shutdownAll` releases
  everything, so one flag is sufficient today. A future partial shutdown would
  need it per provider, and would find this the wrong shape.
