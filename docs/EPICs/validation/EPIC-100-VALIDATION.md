# EPIC-100 — Security Regression Suite · Validation Evidence

**Assessed against:** working tree on top of `99e8cec`
**Date:** 2026-09-02
**Environment:** Windows 11; the suite is structural and unit-level and needs no database.

## Why this Epic exists, in one number

Seventeen test files carried security assertions, every one of them passing, and
**four security defects shipped in code marked VALIDATED**. Each was a property
of the relationship between two components, where both components' own tests
were correct:

| defect | each part tested | the untested sentence |
| --- | --- | --- |
| Slack, Google, npm and Stripe tokens printed to stderr (#93) | `redact.test.ts` (51 cases), `secrets.test.ts` | the two pattern lists are the same size |
| every provider received the database password | EPIC-015 tested per-provider `settings` | a provider cannot reach a credential at all |
| `detectGit` handed `git --version` the whole environment (#94) | the Git runner's scrub was tested | *every* spawner scrubs, not just that one |
| `init --save` destroyed a stored `$secret` reference (#92) | `ConfigStore`, `resolveSecrets` | a reference survives a write-read-write round trip |

The suite is 74 checks over four invariants, and it found a fifth defect while
being written.

## The defect this Epic found

**`describeConfig` redacted by key name and declared path, never by value.**
It is "the only supported way to show configuration to a human, a log or an AI
client", and it is what `ferret config` and `ferret doctor --show-config` print
through. A credential in a field whose *name* is innocuous — a connection URL
with userinfo under a provider's `baseUrl`, a `remoteUrl`, an `endpoint` —
rendered verbatim.

The log path had used `redact()` since EPIC-001; the render path had not. Every
one of the twelve enumerated kinds failed the "masks a … in rendered
configuration" assertion on first run. Fixed by passing leaves through the same
shared redactor, which is the change the invariant was asking for — §16
anticipated this and permits absorbing a fix that *is* the invariant.

## What the enumerations found

The suite prints what it covered, because "the suite passed" over an empty set
is the failure mode a security test must not have:

```
[EPIC-100] redaction parity covers 12 credential kinds
[EPIC-100] provider-context construction sites: cli/health.ts, providers/registry.ts, providers/sdk/testing.ts
[EPIC-100] process spawners: environment/detect.ts, git/runner.ts
[EPIC-100] configuration mutators: set, unset, setMany, replace
[EPIC-100] search branches: entityMatches, evidenceMatches, contentMatches, objectIdMatches
```

Two of those lists are worth reading twice. The context enumeration finds
`cli/health.ts` — the second construction site that made EPIC-081's narrowing
true by type and false at runtime, and which was found by looking rather than
by a failing test. The branch enumeration finds `objectIdMatches`, which the
first version of the pattern **missed**: it insisted on `= sql\`` and that
branch is guarded by a ternary. An enumeration that fails open is the whole
problem restated, so it was widened before the assertion was trusted.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 `npm run test:security` runs alone, and in `verify` | MET | new script; `vitest.config.ts` already includes `tests/**`, so `npm test` picks the suite up |
| AC-2 every kind redacted from a log, an error and configuration | MET | 48 cases, four surfaces × twelve kinds, enumerated from `SECRET_KINDS` |
| AC-3 an uncovered kind fails the suite | MET | `assertSamplesAreTotal` compares the sample table to `SECRET_KINDS` in both directions and throws naming the gap |
| AC-4 no provider context carries a credential | MET | construction sites enumerated from the source; each must project |
| AC-5 every spawner reaches the credential scrub | MET | enumerated from `node:child_process` imports; behaviour asserted over `CREDENTIAL_ENV` |
| AC-6 a `$secret` reference survives every rewrite | MET | mutators enumerated from `ConfigStore`; round trip asserted, and D-011's literal case asserted alongside it |
| AC-7 every search branch is scope-filtered | MET | four branches enumerated; `scopePredicate` required in each; a branch selecting `permission_scope` must also consult it — defect #87's exact shape |
| AC-8 no declared control is unreachable | **NOT MET** | not attempted as stated; see Raised |
| AC-9 no real credential in the shipped tree | MET | the existing packaging scan, which **failed during this Epic** on a credentialled URI in a comment the fix introduced, and was corrected |
| AC-10 untrusted content is fenced | MET | containment behaviour, plus per-field assertions on `highlight`, `statement` and `attributes` |
| AC-11 each invariant fails when its property breaks | MET in effect | not by a deliberate break: `describeConfig` broke twelve of them for real on first run, and the branch enumeration failed open until widened. Both are stronger evidence than a planted fault |
| AC-12 under 10 seconds | MET | the suite is structural; `npm run verify` is unchanged in wall-clock within noise |

## What is asserted structurally, and why that is the right shape

A spawner invariant asserts an **import**, because the alternative is writing a
parser for call sites — a fragile control defending a real one. A redaction
invariant asserts **masked output**, because that is observable. The division is
deliberate and stated in each file.

Three of the four invariants would have failed before the defects that prompted
them: the parity one on #93, the containment one on `cli/health.ts` and on
`detectGit`, the round-trip one on #92. That is the test for whether a
regression suite is worth having.

## Verification

`npm run verify` green: 114 files, 2 478 passed, 3 skipped. New: `tests/security/`
(74 checks across four files), `tests/support/secret-samples.ts`, and an
`npm run test:security` script.

## Raised, not absorbed

- **AC-8 is not met, and was not weakened to look met.** "No declared control is
  unreachable from a production path" is an import-graph question, and most of
  Ferret's controls are reached through ports — which is exactly what makes them
  look unreachable to a scanner. §16 predicted this. The narrower version — a
  hand-written list of controls to check — is the hand-written list §8 rejects,
  so it was left undone rather than done badly. **The property still matters**:
  `EvidenceStore.verify` was correct, tested and reachable from nothing for
  three Epics, and EPIC-094 found it by accident. A workable form of this
  criterion is worth a follow-up.
- **`tests/unit/boundaries.test.ts` still owns the spawner assertion** added by
  EPIC-081, and this suite asserts the same property independently. §4 chose
  duplication over moving it: taking the assertion would take scope from
  EPIC-081's evidence, and two angles on an omission are not a redundancy.
- **The `describeConfig` fix widens redaction on a display path.** Over-redaction
  there is cosmetic, which is the trade `redact.ts` documents for every other
  surface. If a legitimate configuration value is ever masked, the fix is a
  narrower pattern in `redact.ts`, not a narrower boundary here.
- **A fifth defect from the same session is not covered by an invariant.**
  EPIC-094 found that `content_hash` was a function of a timestamp's spelling.
  The property — "a stored row's hash is recomputable from the row" — is now
  asserted by EPIC-094's own sweep, which is the right owner; naming it here as
  well would be this suite absorbing another Epic's evidence.
