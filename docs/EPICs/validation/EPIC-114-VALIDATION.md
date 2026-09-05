# EPIC-114 — PostgreSQL version coverage: validation evidence

**Status: VALIDATED** · PostgreSQL 14, 15 and 16 are measured for the first time.
The declared minimum is unchanged at 14, and no code changed — the gap was never
in the code.

## Environment

| | |
| --- | --- |
| Tree | `318dcfe` (`main`) + this Epic |
| Runner | `ubuntu-latest`, Node 22 |
| Images | `pgvector/pgvector:pg14`, `:pg15`, `:pg16` |
| Run | [33943782529](https://github.com/indoulia/Ferret/actions/runs/33943782529), dispatched on the branch before merge |
| Date | 2026-09-05 |

## What was measured

The lane was **dispatched on its own branch and run** before this Epic was
called complete, because the owner decision says no compatibility claim is made
without running the relevant suite. This table is that run, not a plan.

| Major | Server actually reached | Result | Duration |
| --- | --- | --- | --- |
| 14 | `14.24 (Debian 14.24-1.pgdg12+2)` | **187 files, 3 712 passed, 4 skipped** | 4m25s |
| 15 | `15.19 (Debian 15.19-1.pgdg12+2)` | **187 files passed** | 6m04s |
| 16 | `16.15 (Debian 16.15-1.pgdg12+2)` | **187 files passed** | 5m17s |

The version column is read from the server itself, printed by the job before
anything asserts against it. A tag that stopped meaning what it did would
otherwise produce a green run for the wrong major, which is the failure mode
that makes a compatibility lane worse than none.

**The floor is now a measurement.** `MINIMUM_POSTGRES_MAJOR = 14` has been
enforced in `src/storage/connection.ts` since EPIC-002 and had never been run
against. It has now, on the full suite rather than a subset.

## Cost, measured

The three jobs ran in parallel on the same run: 4m25s, 6m04s and 5m17s. **Zero
of it is on any pull request** — the job carries
`if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'`,
and the pull request for this change shows only `verify`, `storage` and
`dependency audit`.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 a lane exists over 14, 15 and 16 | PASS | three jobs in the dispatched run, one per major |
| AC-2 it never runs on a pull request | PASS | the `if` condition; the PR checks for this branch list three jobs and none of them is `compatibility` |
| AC-3 the same suite the gate runs | PASS | `npm test` with `FERRET_TEST_DATABASE_URL`, identical to `storage` — 187 files on 14, the same count `storage` collects on 17 |
| AC-4 the server version is reported | PASS | the three versions above, read from `SHOW server_version` |
| AC-5 one broken major does not hide the others | PASS | `fail-fast: false`, and each job is named for its version |
| AC-6 17 remains the primary target | PASS | `storage` is unchanged and still gates every pull request |
| AC-7 the declared minimum is unchanged | PASS | `MINIMUM_POSTGRES_MAJOR` is untouched; no source file changed in this Epic |
| AC-8 the claim is measured before it is made | PASS | this record describes a run that happened on the branch, before merge |

## What this closes, and in whose words

EPIC-002's validation record carried this limitation:

> Only PostgreSQL **17** is measured. The floor is 14 and is enforced at runtime,
> but 14–16 are unvalidated.

It is now closed, and that record is updated to say so with a pointer here. The
mitigation column had read *"widen the CI matrix; low risk, no version-specific
syntax is used"* — the low-risk assessment turned out to be correct, which is
worth recording precisely because it would have been just as worth recording had
it been wrong.

## Known limitations

- **A break is found after merge**, within a day of the nightly run.
  Attributing it costs a bisect. That is the trade the decision chose over
  pull-request wait on every author for a rare break.
- **pgvector's version differs per image tag.** `pgvector/pgvector:pg14` does
  not necessarily carry the 0.8.6 EPIC-005 benchmarked. What this lane measures
  is PostgreSQL major compatibility, and it does not claim otherwise.
- **`14.24`, `15.19` and `16.15` are what the images carried on 2026-09-05.**
  The lane measures the current patch release of each major, not a pinned one —
  the right target for a compatibility check, and worth stating rather than
  assuming.

## Governance alignment

§17 — a claim in code now has a measurement behind it, and the measurement is
recorded with the version it actually reached rather than the version a tag
promised. §5 — no new tooling: the lane reuses the service-container pattern the
`storage` job already established.
