# EPIC-115 — macOS packaging validation: validation evidence

**Status: CLOSED, coverage DEFERRED** · No macOS runner was enabled, by owner
decision. What is validated here is that **nothing claims otherwise** — which is
the half of the decision that was not optional.

## Environment

| | |
| --- | --- |
| Tree | `318dcfe` (`main`) + EPIC-114 + this Epic |
| CI change | **none** — `.github/workflows/ci.yml` is untouched by this Epic |
| Date | 2026-09-05 |

## What was actually wrong

The workflow was honest and the README was not.

`ci.yml` has said since 2026-09-05: *"this workflow no longer measures macOS,
and no record should claim it does."* The README's platform table still claimed:

> | macOS | everything except the database suites | `macos-latest` on every pull request |
> | Windows | everything except the database suites | `windows-latest` on every push to `main` |

Both rows were false. macOS ran nowhere, and Windows had moved *onto* every pull
request in the same change that removed macOS. A reader of the front page was
told Ferret is verified on a platform nothing had run it on — which is not an
omission but a claim, and a stale claim is indistinguishable from a fabricated
one to the person reading it.

## Acceptance criteria

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 no document claims macOS is currently verified | PASS | the platform row now reads **not currently measured**, with no "how" |
| AC-2 the Windows row matches CI | PASS | `verify` is `windows-latest` with no event filter, so it runs on every pull request — which is what the row now says |
| AC-3 the Linux row matches CI | PASS | `storage` runs `npm test` on `ubuntu-latest` with a real PostgreSQL on every pull request, so "everything, database suites included" was and remains true |
| AC-4 the gap is named | PASS | the POSIX global-install path and the shutdown contract, both listed, with why each is uncovered elsewhere |
| AC-5 evidence macOS worked is preserved and dated | PASS | EPIC-105's 2026-09-03 run is cited with its date and its counts, rather than deleted or restated in the present tense |
| AC-6 no CI change | PASS | this Epic's diff contains no workflow file |

## Cross-check: what else mentions macOS

Twenty-five documents mention macOS. They divide into two kinds, and only one
kind needed anything:

- **Validation records** (EPIC-001 through EPIC-105, nineteen of them). Each
  describes a run on a date. They are accurate about that date and are left
  exactly as they are — rewriting a historical record to match today's coverage
  would be the opposite of what this Epic is for.
- **Present-tense claims.** The README platform table was the only one, and the
  workflow's own comment was already correct.

## What is not measured, and what a runner would buy

Named rather than admitted, so that revisiting this is a decision rather than a
rediscovery:

- **The POSIX global-install path.** `lib/node_modules` against Windows's
  `node_modules`, the bin shim, its shebang, and its executable bit — a branch
  `packaging.test.ts` already carries and no gating platform exercises.
- **The shutdown contract.** The seven signal tests are `describe.skip` on
  Windows, because Node delivers no `SIGTERM` there and `SIGINT` only through
  console emulation. Nothing currently measures how Ferret shuts down.

EPIC-105 measured the job at **3m47s**, so the cost of restoring it is known.

## Known limitations

- **macOS is unmeasured** and stays so until a runner is approved.
- **The platform table is prose, not a gate.** `distribution.test.ts` asserts
  the README's command and tool tables against the code; there is no equivalent
  for the platform table, because CI configuration is not importable. A future
  Epic could parse `ci.yml` and assert against it. Not built here — inventing a
  gate for a decision just made would be scope this Epic was not given, and it
  is recorded so the next reader can weigh it.

## Governance alignment

§6 — "not currently measured" is stated where "verified on every pull request"
used to be, and "unmeasured" is not spelled the same way as "unsupported".
§17 — the whole of this Epic: a skip may not read as a pass, and neither may a
three-day-old pass read as a current one.
