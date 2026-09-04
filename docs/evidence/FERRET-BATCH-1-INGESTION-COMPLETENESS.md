# Batch 1 — Ingestion completeness (F-01, F-02, F-03, F-04)

**Status: IMPLEMENTED, re-audited** · Base `0407618` · Branch `forensic/post-roadmap-audit` · 2026-09-03

> Not merged, not pushed to `main`, not deployed. No Epic status changed, no Epic
> created. The change is confined to `src/git/history.ts`, `src/git/provider.ts`
> and `src/indexing/indexer.ts`, plus two new test files.

## 1. What was wrong

Four findings, one root: **history was resumed by commit date, from a bounded page.**

- **F-01 (P0)** — `readHistory` reads at most 1 000 commits and reports `truncated`;
  the provider turns that into a resume cursor; the indexer's port type never declared
  the field, so it was discarded. One page was read, and the position was then advanced
  to the *newest* commit of a newest-first page. Every repository over 1 000 commits
  silently lost the rest, and `--full` could not reach it.
- **F-02 (P1-A)** — every shipped path shares one watermark scope (`index` defaults
  `--revision HEAD`, `reconcile` passes nothing), so indexing a second branch whose
  commits predate the first branch's tip lost them.
- **F-03 (P1-A)** — one commit dated in the future moved the position past every real
  commit; ingestion stopped, reporting success.
- **F-04 (P1-A)** — a branch merged after being written is older than the position, so
  its commits were never read and its merge parent was written as a parentless stub.

A date is not a position. It is a value the repository chooses, and it does not order
the commit graph.

## 2. What changed

**Resume by reachability, and follow the bound.**

| File | Change |
| --- | --- |
| `src/git/history.ts` | `ReadHistoryOptions.exclude` — object ids passed as `^<oid>`, each validated against the id pattern before it reaches an argument vector. New `resolveCommit` (the tip a revision names) and `knownCommits` (the subset a repository still holds). |
| `src/git/provider.ts` | `readHistory` accepts `exclude` and `cursor`, and returns `tip`. Stale ids are dropped before the walk, because `git log` fails on an id it does not hold and a failed read here is indistinguishable from an empty one. |
| `src/indexing/indexer.ts` | The port now declares `cursor` and `tip`. The history stage pages until the cursor is absent, carrying the exclusion onto **every** page. The stored position gains `tips`, and `lastCommitAt` is clamped to the observation instant. |

Three properties were deliberately preserved:

1. **No forced re-read on upgrade.** A position written before `tips` existed still
   resumes by `since`, exactly as it did. Only the first run after the change writes a
   tip; every run after that resumes by reachability.
2. **`lastCommitAt` is still written and still reported.** It is no longer what a run
   resumes *from*, but it is what "how far behind is this source" is measured from, and
   the run report and EPIC-108's cancellation guarantee both depend on it.
3. **Never both filters at once.** A date filter applied on top of an exclusion would
   reintroduce precisely the commits the exclusion exists to stop losing.

**What was deliberately *not* changed.** `watermarkScopeId` still maps `HEAD` and
`undefined` to the repository id. That collision was F-02's *mechanism*, not its
requirement: with a tip set, indexing branch B after branch A excludes what A reached
and reads exactly what B adds, so nothing is lost by sharing a scope. Changing the key
would orphan every existing position and force a full re-read on upgrade — a migration
disguised as a fix — to buy a property the tip set already provides. The requirement is
asserted directly by the F-02 case below.

## 3. Evidence

### The fixture fails, before the fix, for the four identified reasons

`tests/integration/indexing/history-completeness.test.ts`, against real PostgreSQL and
real `git`, at `0407618`:

```
× reads a repository deeper than one page — F-01
    expected { missing: 5, commitsRead: 1000 } to strictly equal { missing: 0, commitsRead: 1005 }
× cannot be repaired by a later run, and --full is not a way back — F-01
    expected [ …(5) ] to strictly equal []
× keeps a second branch whose commits predate the first branch tip — F-02
    expected [ …(2) ] to strictly equal []
× keeps ingesting after a commit dated in the future — F-03
    expected { missing: [ …(2) ], read: false } to strictly equal { missing: [], read: true }
× reads a back-dated branch merged after the last run — F-04
    expected [ …(2) ] to strictly equal []
```

`missing: 5, commitsRead: 1000` is F-01 exactly: 1 005 commits in the repository, one
page read, the five oldest never seen — and still missing after a second run and after
`--full`.

### The same fixture passes after it

```
✓ reads a repository deeper than one page — F-01
✓ cannot be repaired by a later run, and --full is not a way back — F-01
✓ pages a resumed read without leaving the walk it resumed — F-01
✓ keeps a second branch whose commits predate the first branch tip — F-02
✓ keeps ingesting after a commit dated in the future — F-03
✓ reads a back-dated branch merged after the last run — F-04
```

The assertions name no cursor, no watermark and no page size. They count the commits in
the repository, count the commits in the graph, and compare — so an implementation that
resumes some other correct way passes them unchanged. A commit present only as a
placeholder does not count: `attributes ? 'message'` is what separates history Ferret
read from a promise that something exists, which is what F-04 produced.

### A defect found by re-auditing the fix, and the test that now pins it

The first version of the change carried the exclusion only on the *first* page. A cursor
is an offset into a particular walk, so the second page would have walked the unfiltered
history and skipped exactly the commits the exclusion existed to find — the same defect
class, one level down.

`tests/unit/history-paging.test.ts` asserts the requests a run actually makes. Against
the buggy version:

```
× carries the exclusion onto every page of a resumed read
    expected [ …(3) ] to strictly equal [ …(3) ]
```

It is a unit test on purpose: over a real repository that defect returns a plausible
number of commits and says nothing about the ones it missed, which is how the original
four survived a green suite.

## 4. Re-audit

| Finding | Status | How it is now proved |
| --- | --- | --- |
| F-01 | **Closed** | 1 005-commit repository fully indexed in one run; second run and `--full` leave nothing missing; paging follows the cursor to its end and stays inside its walk |
| F-02 | **Closed** | Second branch's older commits present after indexing the first; asserted as commits in the graph, not as a scope key |
| F-03 | **Closed** | A 2035-dated commit no longer stops ingestion; the stored position is clamped to the observation instant |
| F-04 | **Closed** | A back-dated branch merged after the last run is read in full, with messages — not as placeholder stubs |

**Adversarial checks on the fix itself:**

- **Argument injection** — every excluded value is matched against the object-id pattern
  before it becomes an argument, and is passed as `^<oid>`, which cannot be read as an
  option. A non-id is refused with `E_USAGE` rather than silently dropped.
- **A rewritten or pruned history** — ids the repository no longer holds are dropped
  before the walk. If every stored tip is gone, the exclusion is empty and the run reads
  everything: degrading to *more* reading, never to less.
- **An unbounded provider** — paging stops at a bound far above any real history and says
  so at `warn` rather than reporting a complete read.
- **Position growth** — the tip set is bounded and deduplicated, so indexing many
  branches in turn cannot grow a position without limit. Dropping the oldest tip costs an
  idempotent re-read, not a gap.
- **Upgrade** — a position with no tips still resumes by date, so no installation
  re-reads its history because of this change.

## 5. Suite

`npm run lint && npm run typecheck && npm run build && vitest run` on the branch, against
a real PostgreSQL container:

```
Test Files  165 passed (165)
     Tests  3392 passed | 7 skipped (3399)
  Duration  445.51s
```

Against the forensic baseline at `0407618` (163 files, 3387 tests, 2 files failing, 41
skipped): two more files and twelve more tests, all of them this batch's, and **no
failures**. The 41-vs-7 skip difference is the packaging suite, which ran to completion
this time rather than timing out under contention — so this run also exercised the
packaging assertions the forensic pass recorded as silently skipped (F-73).

One regression was found and fixed during this batch: the run report's `watermark` lost
the previous position on a resumed run, which broke EPIC-108's "a cancelled content stage
leaves the watermark where it was". `lastCommitAt` is now carried forward whichever
resume path is taken.

## 6. Not done in this batch

Deliberately out of scope, and still open: F-95/F-96/F-97 (git parser isolation — the
same subsystem, next batch), and every other blocker in
`docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`. This batch closes four findings and
nothing else.
