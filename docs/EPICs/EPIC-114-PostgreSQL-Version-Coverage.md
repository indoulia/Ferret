# EPIC-114 — PostgreSQL Version Coverage

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Storage & Data Lifecycle · Quality & Evaluation
**Classification:** INFRASTRUCTURE

## Outcome

The PostgreSQL range Ferret claims to support is measured, on a lane that costs
no pull request any wait.

## Problem

`MINIMUM_POSTGRES_MAJOR = 14` is enforced at runtime in
`src/storage/connection.ts`. EPIC-002's own limitation table recorded what stood
behind it: *"Only PostgreSQL 17 is measured. The floor is 14 and is enforced at
runtime, but 14–16 are unvalidated."*

So Ferret refused 13 and accepted 14, 15 and 16 having never run against any of
them. That is a claim in code with no measurement behind it — the shape
Governance §17 exists to prevent — and the only reason it had not been closed is
that closing it means changing CI, which the 2026-09-05 owner decision had
deliberately narrowed.

## Decision this Epic implements

Taken by the owner on 2026-09-05: both normal CI coverage and scheduled
compatibility coverage, with the cost of ordinary development minimised.
PostgreSQL 17 stays the primary target, 14 must actually be exercised, the
compatibility job is isolated where practical, failures stay visible, and **no
compatibility claim is made without running the relevant suite**. A scheduled
nightly lane is preferred where it gives equivalent confidence.

The declared minimum is **not** changed. It is still 14.

## Design

**Three kinds of coverage, named in the workflow.** The distinction is written
at the top of `ci.yml` because a job on the wrong one of the three is either
slowing every author down or claiming coverage nobody is paying for:

| | Jobs | Runs on | Answers |
| --- | --- | --- | --- |
| PR correctness | `verify`, `storage` | every pull request | is this change correct |
| Compatibility coverage | `compatibility` | schedule, dispatch | does the range we claim still work |
| Platform validation | the `verify` matrix | every pull request | does it work where we say it does |

**The lane is scheduled, not gating.** `if: github.event_name == 'schedule' ||
github.event_name == 'workflow_dispatch'`. Nothing in Ferret uses
version-specific syntax, so what this catches is a dependency or an image
changing underneath it — a break that is rarely caused by the commit that
reveals it, and that a nightly run finds within a day for no pull-request wait.

**14, 15 and 16 — the floor and the middle.** A floor that works while the
middle does not is not a supported range, and two more parallel containers on a
nightly run cost close to nothing. 17 is deliberately absent: `storage` measures
it on every pull request, and measuring it twice would spend a runner to learn
nothing.

**The same suite, not a subset.** The compatibility job runs `npm test` with
`FERRET_TEST_DATABASE_URL`, exactly as `storage` does. A reduced subset would
measure something other than what the gate measures, and the difference is
precisely where a version-specific break would hide.

**The server version is printed before anything asserts against it.** A service
image whose tag stopped meaning what it did would otherwise produce a green run
for the wrong major — the failure mode that makes a compatibility lane worse
than no lane.

**`fail-fast: false`, and one job name per version.** One broken major must not
hide the others, and a failure must name which version broke.

**`workflow_dispatch` is how the lane was measured before it was merged.** The
decision says no compatibility claim without running the suite, so the lane was
dispatched on its own branch and the result recorded before merge — rather than
merged and hoped for.

## Scope

- The `compatibility` job in `.github/workflows/ci.yml`.
- The coverage-taxonomy header in the same file.
- EPIC-002's limitation row, updated **after** the measurement, not before.

## Non-scope

- **Changing `MINIMUM_POSTGRES_MAJOR`.** It stays 14. This Epic measures the
  claim; it does not narrow it.
- **Adding PostgreSQL 14 to the pull-request gate.** The roadmap's option C
  offered it, and the owner decision prefers the scheduled lane where it gives
  equivalent confidence. It does: the floor breaks rarely and never silently.
- **PostgreSQL 13 or earlier.** Refused at runtime, and refusing correctly is
  already asserted by the connection suite.
- **Running the compatibility lane on Windows or macOS.** GitHub's Windows
  runners cannot run Linux service containers, which is why `storage` is on
  `ubuntu-latest` at all. Platform coverage is EPIC-115's.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | A compatibility lane exists over 14, 15 and 16 | `ci.yml` — the `compatibility` job |
| 2 | It never runs on a pull request | the `if` condition; and the PR run for this change shows only `verify`, `storage` and `audit` |
| 3 | It runs the same suite the gate runs | `npm test` with `FERRET_TEST_DATABASE_URL`, identical to `storage` |
| 4 | It reports the server version it actually reached | the "Report the server version under test" step |
| 5 | One broken major does not hide the others | `fail-fast: false`, and a job name per version |
| 6 | PostgreSQL 17 remains the primary target | `storage` is unchanged and still gates every pull request |
| 7 | The declared minimum is unchanged | `MINIMUM_POSTGRES_MAJOR` is untouched at 14 |
| 8 | The claim is measured before it is made | the dispatched run recorded in the validation evidence |

## Tests

No new test code. The change is CI configuration, and the evidence is a measured
run — recorded in
[the validation record](validation/EPIC-114-VALIDATION.md).

## Dependencies

EPIC-002 (the storage layer and its version check), EPIC-005 (the pgvector
image).

## Known limitations

- **A break is found after merge.** That is the trade the decision chose, and
  attributing it costs a bisect. The alternative was pull-request wait on every
  author for a break that is rare.
- **pgvector's version differs per image tag.** `pgvector/pgvector:pg14` does not
  necessarily carry the 0.8.6 EPIC-005 benchmarked. What this lane measures is
  **PostgreSQL major compatibility**, and it does not claim to measure a pgvector
  version.
- **The nightly run is on `main`.** A change to the lane itself is measured by
  dispatch, which is why the dispatch path exists.

## Definition of done

The lane exists, is isolated from the pull-request path, and has been run —
with its result recorded — before the Epic is called complete.
