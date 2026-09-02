# EPIC-099 — Provider Conformance Harness · Validation Evidence

**Assessed against:** working tree on top of `ceaa9ab`
**Date:** 2026-09-02
**Environment:** Windows 11. The harness needs no database; the storage provider's own conformance run stays in the integration suite that already has one.

## What this Epic is, and what it deliberately is not

EPIC-016 built the conformance suite and built it well — eighteen stable checks,
a structured report, an assertion helper, published through
`@indoulia/ferret/testing`. Its own opening says it "is the conformance suite,
not the cross-provider quality harness that runs it over time (EPIC-099)".

Its AC-11 applied the suite to Ferret's own providers, and that was done. **By
hand, three times, in three files:**

| provider | where it was checked |
| --- | --- |
| `GitSourceProvider` | `tests/unit/provider-conformance.test.ts:346` |
| code parser | `tests/unit/code-parser.test.ts:309` |
| `PostgresStorageProvider` | `tests/integration/providers/conformance.test.ts:54` |

Nothing enumerated the set. A fourth provider — the Jira provider EPIC-071
plans, a second parser, anything a contributor adds — would be conformant only
if somebody remembered to write a fourth test, and the failure mode is silence.

That is the shape of every defect EPIC-100 was written for: a control correctly
applied to the subjects someone listed, and not to the subject nobody listed.
This Epic closes it for providers, and adds nothing else.

## What the gate reports

```
[EPIC-099] provider implementations: git/provider.ts, parsers/code/provider.ts, storage/provider.ts
[EPIC-099]
2 provider(s), 34 checks passed, 0 failed, 2 skipped
  ok   ferret.source.git                  17 passed, 0 failed, 1 skipped
  ok   ferret.parser.code                 17 passed, 0 failed, 1 skipped
```

The storage provider is declared covered in the integration suite, and the
declaration is itself checked: the gate opens the named file and fails unless it
both mentions the provider and calls `runConformance`. An escape hatch that
nobody verifies is an opt-out.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 every provider is run or declared | MET | enumeration over `src/` finds three; two run here, one is declared and its declaration is verified |
| AC-2 the enumeration is read from source and fails closed | MET | `providerModules()` scans for `readonly kind = ProviderKind.`; a companion assertion requires at least three, so a scanner that found nothing fails rather than passing over an empty set |
| AC-3 one call, one report per provider, EPIC-016's shape | MET | `runProviderConformance`; `passed + failed + skipped === checks.length` asserted per report |
| AC-4 per-provider counts and verdict | MET | `summarizeConformance`, printed above |
| AC-5 a non-conformant provider fails the aggregate, naming checks | MET | a deliberately malformed provider produces `providerId: checkId` entries |
| AC-6 the run states its own scope | MET | the two `[EPIC-099]` lines |
| AC-7 nothing from EPIC-016 changed | MET | `conformance.ts` untouched; the harness is a new module that imports it |
| AC-8 under 5 seconds added | MET | the harness suite runs in ~70 ms; no new integration fixture |

## A defect in the gate itself, found and fixed before it shipped

`declaresId`'s fallback branch — resolving a provider id declared through a
constant — was written as a `RegExp` built from a template literal containing
`\s`. In a template literal that is the letter `s`, so the pattern could never
match.

**It passed anyway**, because the literal branch above it covers both providers
that currently exist. A broken fallback in a gate is precisely the quiet hole
this Epic exists to close, and it would have surfaced only when a provider first
declared its id through a constant — which is to say, at the moment the gate was
being relied on. Replaced with whitespace normalisation and a plain string
comparison, which cannot be wrong in that way.

Recorded because "the test passed" is what made it invisible.

## Verification

`npm run verify` green: 115 files, 2 485 passed, 3 skipped. New:
`src/providers/sdk/conformance-harness.ts` and
`tests/unit/provider-conformance-harness.test.ts` (7 checks).

## Raised, not absorbed

- **`COVERED_ELSEWHERE` is a real escape hatch.** It is bounded — the gate opens
  the named file and requires it to mention the provider and call
  `runConformance` — but a future author could use it to opt a provider out
  rather than to record where it is covered. Designing it away would mean
  requiring a database to run the gate at all, which would make the gate
  something people skip. Recorded, as §16 said it would be.
- **Both runnable providers skip one check each.** Neither declares
  `secretOptions`, so the secret checks report `skipped` — EPIC-016's designed
  outcome, not a gap. Worth naming because "17 passed, 1 skipped" should not be
  read as incomplete coverage.
- **No provider was found non-conformant.** §16 said a finding would be filed
  against its owning Epic rather than absorbed here; there was nothing to file.
- **The harness is not run against third-party providers**, deliberately. Ferret
  does not install other people's packages to test them; EPIC-016 AC-12 already
  made the suite reachable by an author who wants it.
