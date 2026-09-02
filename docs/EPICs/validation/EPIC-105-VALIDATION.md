# EPIC-105 — Cross-Platform Packaging · Validation Evidence

**Assessed against:** `.github/workflows/ci.yml` on
`feat/epic-105-cross-platform-packaging`, PR #140
**Date:** 2026-09-03
**Environment:** GitHub-hosted `macos-latest`, Node 22 — run
[33682370852](https://github.com/indoulia/Ferret/actions/runs/33682370852).

This Epic's evidence is a CI run and could not be anything else: the whole
content of the nineteen records it closes is that no macOS host is available
locally (§8.1).

## The measurement

**macOS passes.**

| job | result | duration |
| --- | --- | --- |
| `verify (macos-latest, node 22)` | **pass** | **3m47s** |
| `verify (ubuntu-latest, node 22)` | pass | 3m02s |
| `storage integration (PostgreSQL 17 + pgvector)` | pass | 3m51s |
| `dependency audit` | pass | 27s |

On macOS: **112 test files passed, 37 skipped; 2 463 tests passed, 601 skipped**
of 3 064. Every skip is a database suite — §8.3, and the reason is below.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 `macos-latest` in the matrix | **MET** | `ci.yml`, both branches of the matrix expression |
| AC-2 macOS runs on this Epic's own pull request | **MET** | PR #140's checks include `verify (macos-latest, node 22)`; the evidence precedes the merge |
| AC-3 lint, typecheck, build succeed | **MET** | the job reached the test step, which follows all three |
| AC-4 the suites pass, database suites excepted | **MET** | 2 463 passed, 0 failed |
| AC-5 the packaging suite passes | **MET** | `packaging.test.ts` is in the passing set — `npm pack`, a global install, and the installed binary running, on macOS |
| AC-6 the signal tests **run** | **MET** | `tests/integration/signals.test.ts (7 tests)` — no skips, where Windows skips three. §8.5's prediction, confirmed |
| AC-7 every skip is named and explained | **MET** | 37 files, all database suites; §8.3 and the table below |
| AC-8 the duration is recorded | **MET** | 3m47s against Ubuntu's 3m02s, above |
| AC-9 where macOS runs is decided from AC-8 | **MET** | it stays on the PR gate — the reasoning is below |
| AC-10 the nineteen rows struck or re-measured | **MET** | each replaced with a dated note naming what was measured |
| AC-11 no source change was needed | **MET** | the change set is `ci.yml`, the specification, this document, and the nineteen notes — no `src/` change |
| AC-12 the workflow comment replaced | **MET** | the comment now records what is true rather than why macOS was absent |

Twelve of twelve MET.

## What macOS did **not** run

37 files, 601 tests — every one a database suite. GitHub's macOS runners cannot
run Linux containers, so PostgreSQL is unavailable and `databaseAvailable()`
skips with the reason in the suite title.

This is the same state Windows is in, and the workflow already recorded why it
must be stated rather than hidden: *"attempting it in this matrix would produce
coverage on Linux and a silent skip on Windows — an asymmetry that is easy to
mistake for a passing gate."*

So the honest claim is narrow and worth stating precisely: **Ferret's package,
CLI, parsers, retrieval, MCP surface and security controls are validated on
macOS. Its PostgreSQL behaviour is validated on Linux only.** A platform 80%
measured and reported as "validated" would be worse than one honestly
unmeasured, which is the mistake this Epic exists to correct.

## Where macOS runs, and why

**It stays on the pull-request gate.** 3m47s against Ubuntu's 3m02s is 45
seconds, and Windows was moved off the gate on evidence of a different
magnitude entirely — "Ubuntu verify took 1m52s–2m55s and Windows 6m41s–11m54s,
so Windows was the whole of the wait on every one of six PRs."

macOS is not the whole of the wait; it is barely distinguishable from it. The
argument that moved Windows does not apply, and applying it anyway would trade a
real signal for 45 seconds. §8.2 required this decision to come *from* the
measurement rather than before it, and the measurement says keep it.

A consequence worth naming: a macOS-only break is now found *before* a merge,
where a Windows-only break is found minutes after one. That asymmetry is
deliberate and follows from the durations.

## Found while implementing

**Nothing.** No source change was needed, no test failed, and no platform
special case was added — AC-11. That is the least interesting possible outcome
and the one most worth recording plainly, because the alternative was nineteen
documents continuing to say "nobody knows" on the strength of nobody looking.

**The signal tests are the one substantive gain.** EPIC-001 recorded that
`SIGTERM` is undeliverable on Windows, so three of the seven skip there. On
macOS all seven ran and passed, which is the first time Ferret's shutdown path
has been exercised on a second platform that actually delivers signals. §8.5
named this as the first thing to watch, and it was worth watching.

## Decisions worth recording

**The evidence had to precede the merge.** §8.2, and it is the difference
between this Epic and a promise. Adding macOS post-merge only — the arrangement
Windows has — would have meant merging a claim of macOS support with no run
behind it, which is precisely the failure the workflow comment was guarding
against.

**A failure would have been a finding, not a retreat** (§8.4). Being willing to
deliver "macOS does not work, here is what breaks" is what stops the incentive
to avoid looking. It passed, but the Epic did not depend on that.

## Limitations, recorded

- **One macOS version, one architecture.** `macos-latest` is whatever GitHub
  currently pins, on Apple silicon. Intel macOS is unmeasured and an older macOS
  is unmeasured; claiming either would repeat the mistake this Epic corrects.
- **No Docker on macOS**, so PostgreSQL behaviour is validated on Linux only.
  Not a claim that it behaves identically there.
- **No signing or notarisation**, because Ferret ships JavaScript. If a future
  Epic ships a native binary, notarisation becomes real work and this Epic's
  non-scope stops being adequate.
- **~~Alpine and musl are unmeasured.~~ Measured 2026-09-03 by EPIC-107.** The
  Docker image is `node:22-alpine`, and a probe run inside it parsed TypeScript
  through the real provider: `{"parserId":"ferret.parser.code","symbols":
  ["arrow","named","Thing"],"segments":4}`. `tree-sitter`'s WASM grammars load
  on musl; all four ship in the image.
- **No nightly macOS run.** Windows has one because it is off the PR gate;
  macOS is on it, so every pull request is the run.
- **A downgrade across two installed versions is still untested.** EPIC-089 §16
  and EPIC-106 §16 both ask for it, and this Epic's matrix is now the place it
  could live — but installing two Ferret versions in one job is a job shape
  neither Epic has written.
