# EPIC-093 — Provider Failure Isolation · Validation Evidence

**Assessed against:** working tree on top of `28ef378`
**Date:** 2026-09-02
**Environment:** Windows 11. Registry behaviour; no database or `git` required.

## What changed

**Every provider was required, because none of them could be optional.**
`initializeAll` wrapped each `initialize` in a try and, on any failure, shut
down everything already started and rethrew. There was no way to register a
provider whose absence is survivable, because there was no notion of one.

A parser that cannot load its grammar therefore took down `ferret index` —
even though EPIC-108 built five distinct skip reasons for a run without a
parser, and `ContentStageSkip.NO_PARSER` is one of them. Those reasons are only
reachable if the runtime *starts*.

| before | now |
| --- | --- |
| any provider's failure aborts the start | a provider registered `{ optional: true }` is recorded and skipped |
| a failure tears down providers that already started | an optional failure leaves them running |
| a failed provider is indistinguishable from a disabled one | `describe()` carries `failure`, and `enabled` stays true |
| a failed provider stays in the capability index | `forCapability`, `supports` and `allForCapability` exclude it |
| a failure reaches no health surface | a `:startup` dependency result, degraded, naming the provider |

**Required is the default and nothing existing changed.** 2 504 tests pass,
including every suite that registers providers the old way.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 an optional failure does not stop the start | MET | `initializeAll` resolves with a failing optional provider registered |
| AC-2 a required failure still aborts, classification intact | MET | rejects with the provider's own `E_DEPENDENCY_UNAVAILABLE`, not a generic init error |
| AC-3 providers already started stay started | MET | asserted on both `initializeCount` and `shutdownCount`, plus a provider registered *after* the failing one still starts |
| AC-4 a failed provider offers no capability | MET | `forCapability` undefined, `supports` reports `unavailable`, `allForCapability` empty — and a second provider of the same capability is still selected |
| AC-5 failed, disabled and initialized are distinct | MET | `failure` set, `enabled` true, `initialized` false — the combination that separates "it broke" from "it was switched off" |
| AC-6 logged once at warn, code not message | MET | one record, `warn`, carrying `code`; the error's message is asserted absent |
| AC-7 degraded in health, quiet when clean | MET | a `:startup` result at `degraded` with a `ferret doctor` remediation; `failures()` empty and no `:startup` result on a clean start |
| AC-8 shutdown skips what never started | MET | `shutdownAll` returns no failure for the provider that never initialized |
| AC-9 nothing changes for existing callers | MET | full suite green, 117 files, 2 504 passed |

## The design decision worth reviewing

**Optionality is declared at registration, not by the provider** (§8.1). A
provider cannot know whether it is essential: the same parser is optional for
`ferret index` and required for `ferret index --content`. The composition root
is the only component with that context, and a provider that declared its own
optionality would be asserting something about a deployment it cannot see —
and would make "required" un-overridable by the one caller that knows better.

The consequence is that this Epic ships the mechanism and changes no existing
registration. That is deliberate; see below.

## Verification

`npm run verify` green: 117 files, 2 504 passed, 3 skipped. New:
`tests/unit/provider-failure-isolation.test.ts` (13 checks).

## Raised, not absorbed

- **Nothing is optional yet.** No existing registration was changed, so
  `ferret index --content` still fails if its parser cannot load. Choosing which
  of Ferret's own providers should be optional is a per-command decision with
  user-visible consequences — a run that silently indexes without symbols is not
  obviously better than one that refuses — and it belongs with each command's
  Epic rather than being taken here by default. **The mechanism is unused in
  production until someone makes that call.**
- **Isolation is not recovery.** A failed optional provider stays failed for the
  life of the process. Restart, health polling and circuit breaking are
  EPIC-014's (P1) and are named non-scope; if a provider should ever recover
  without restarting Ferret, that Epic designs it.
- **The failure reason is an error code, not a message.** Enough to route an
  operator to `ferret doctor` and no more. A message can carry a path or a
  value, and this line reaches a terminal and a health report — but it does mean
  `describe()` alone will not tell you *why* the grammar failed to load.
- **`checkAll` now skips a failed provider's own dependency check.** Its check
  would run against an object whose `initialize` threw and would report a
  confusing second failure rather than the first. Recorded because it means a
  failed provider contributes exactly one health line, not two.
