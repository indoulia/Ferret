# EPIC-115 — macOS Packaging Validation

**Status:** CLOSED — coverage DEFERRED by owner decision; the false claim is corrected
**Priority:** P2 (lowered by the owner, 2026-09-05)
**Domain:** Distribution & Packaging · Quality & Evaluation
**Classification:** INFRASTRUCTURE

## Outcome

macOS coverage is not restored, by owner decision. What this Epic delivers
instead is the other half of that decision, which is not optional: **no record
claims macOS is validated**, and the README says plainly that it is not.

## Problem

**Nothing about macOS was ever unmeasurable. It was measured.** EPIC-105 ran
`macos-latest` on [#140](https://github.com/indoulia/Ferret/pull/140): 112 test
files and 2 463 tests passed, including the full packaging suite and all seven
signal tests. The owner decision of 2026-09-05 then dropped macOS from the
`verify` matrix, and the workflow says so plainly: *"this workflow no longer
measures macOS, and no record should claim it does."*

The workflow was honest. **The README was not.** Its platform table still read:

| platform | verified | how |
| --- | --- | --- |
| Linux | everything, database suites included | `ubuntu-latest` on every pull request |
| macOS | everything except the database suites | `macos-latest` on every pull request |
| Windows | everything except the database suites | `windows-latest` on every push to `main` |

Two of those three rows were false the moment the matrix changed: macOS ran
nowhere, and Windows ran on every pull request rather than only on a push to
`main`. A user reading the front page was told Ferret is verified on a platform
nothing had run it on.

That is the failure this Epic actually closes, and it is worth being precise
about why it is a failure rather than an omission: a table of what is verified is
a claim, and a stale claim is indistinguishable from a fabricated one to the
person reading it.

## Decisions this Epic implements

Two, taken by the owner on 2026-09-05, in that order.

**First: add genuine macOS packaging validation, preferably on a scheduled
lane.** Do not confuse it with changing a schedule trigger; the packaging path
must actually execute on macOS; preserve Windows and Linux; document exactly
what macOS coverage proves.

**Second, superseding the runner half of the first: do not enable remote CI for
macOS.** It is the owner's last priority.

The second decision removes the deliverable of the first — a `macos-latest` job
was designed and is **not** implemented — and leaves its final clause standing
and unaffected: *"do not pretend macOS is validated unless the packaging path
actually ran on macOS."* That clause is what this Epic delivers.

## Design

There is no code and no CI change. There is a correction, and its shape is the
point.

**The row says "not currently measured", not "unsupported".** They are different
claims and only one of them is true. Ferret has evidence macOS worked on
2026-09-03 and no evidence about today's tree, and the README now says exactly
that instead of inheriting a three-day-old run's conclusion.

**The Windows row is corrected too.** It claimed a push-to-`main` cadence that
stopped being true in the same change. A table with one true row and two false
ones is not partly right; it is a table nobody can use.

**What goes unmeasured is named.** Two things, because neither is covered
anywhere else:

- the POSIX **global-install path** — `lib/node_modules` against Windows's
  `node_modules`, the bin shim, its shebang and its executable bit, none of which
  Windows can express;
- the **shutdown contract** — the seven signal tests are `describe.skip` on
  Windows because Node delivers no `SIGTERM` there at all, so nothing currently
  measures how Ferret shuts down.

Naming them is what makes the gap actionable rather than a shrug: whoever
revisits this knows what a runner would buy.

## Scope

- The README platform table and the paragraphs under it.
- This Epic record, and the roadmap entry.

## Non-scope

- **A `macos-latest` job.** Declined by the owner. The design for one — its
  condition, its suite, and what it would prove — is recorded in this file's
  history and in the roadmap entry, so restoring it is a decision rather than a
  rediscovery.
- **Amending the nineteen validation records that cite EPIC-105's measurement.**
  They describe what was measured on 2026-09-03 and are accurate about that
  date. Rewriting a historical record to match today's coverage would be the
  opposite of the honesty this Epic is for.
- **Restoring Linux to the `verify` matrix.** The workflow records that Linux
  stopped being measured for everything except `storage`. That is a separate
  gap, and `storage` does run the full suite on Linux on every pull request, so
  the Linux row is the one that was still true.
- **Removing macOS from the supported platforms.** Nothing measured says it is
  broken. Unmeasured and unsupported are different, and Ferret claims neither.

## Acceptance criteria

| # | Criterion | Evidence |
| --- | --- | --- |
| 1 | No document claims macOS is currently verified | the README platform table; `ci.yml` already said so |
| 2 | The Windows row matches what CI does | `windows-latest` runs on every pull request, per the `verify` job |
| 3 | The Linux row matches what CI does | `storage` runs the full suite on `ubuntu-latest` on every pull request |
| 4 | The gap is named, not merely admitted | the global-install path and the shutdown contract, both listed |
| 5 | Evidence that macOS *did* work is preserved, dated | EPIC-105's measurement is cited with its date rather than deleted or restated as current |
| 6 | No CI change | `.github/workflows/ci.yml` is untouched by this Epic |

## Tests

None. The claim being corrected is prose, and the check is that it matches
`ci.yml` — verified by reading both, and recorded in
[the validation record](validation/EPIC-115-VALIDATION.md).

## Dependencies

EPIC-105 (the measurement this Epic dates rather than inherits), EPIC-114 (the
coverage taxonomy the corrected table describes).

## Known limitations

- **macOS is unmeasured, and will stay so until a runner is approved.** The two
  things that buys are named above.
- **A prose claim is not enforced by a test.** `distribution.test.ts` gates the
  README's *command* and *tool* tables against the code, and there is no
  equivalent for the platform table because CI configuration is not importable.
  A future Epic could parse `ci.yml` and assert the table against it; it is not
  built here, because inventing a gate for a decision that was just made would be
  scope this Epic was not given.

## Definition of done

Every macOS claim in the repository is either dated to the run that supports it
or removed; the platform table matches CI; no runner is enabled.
