# STATE

**Phase:** Batch 1 implemented and re-audited; verify in progress at time of writing.
**Base:** `0407618` (main, untouched). **Worktree:** `C:\AIAgent\ferret-forensic`, branch `forensic/post-roadmap-audit`.
**Last action:** F-01/F-02/F-03/F-04 fixed; forensic fixture green; full verify run.

## Done
- Forensic verification — 100 findings (`docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`).
- Triage — buckets, dependencies, eight batches (`docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`).
- **Batch 1 — ingestion completeness** (`docs/evidence/FERRET-BATCH-1-INGESTION-COMPLETENESS.md`):
  resume by reachability (`^<tip>`) instead of by commit date, and follow the page cursor
  to its end. Closes F-01 (P0), F-02, F-03, F-04.

## Changed
`src/git/history.ts` (`exclude`, `resolveCommit`, `knownCommits`) ·
`src/git/provider.ts` (`exclude`/`cursor` in, `tip` out) ·
`src/indexing/indexer.ts` (port declares `cursor`/`tip`; paging loop; tips in the stored
position; `lastCommitAt` clamped to the run instant).
New: `tests/integration/indexing/history-completeness.test.ts`, `tests/unit/history-paging.test.ts`.

## Proved
Fixture red before the fix for the four identified reasons (`missing: 5, commitsRead: 1000`
on 1 005 commits, unrepairable by re-run or `--full`; branch, skew and back-dated merge
losses). Green after. One self-inflicted defect found by re-auditing the fix — the
exclusion was carried only onto the first page — is now pinned by a unit test that fails
against it. One regression found and fixed: the report's `watermark` lost the previous
position on a resumed run (EPIC-108 AC-10).

## Constraints in force
No new Epics. No Epic status changes. No PRs. No merge. No deploy. No changes to `main`.

## Next action (not started, not authorized)
Batch 2 — F-30, F-29, F-17, F-16. Each is small, self-contained, and restores an
explicit EPIC claim. Await authorization.

## Open decisions for a human
1. F-21 — is GitHub/Jira ingestion meant to be reachable in this release, or library-only?
2. F-20 — same question for Session & Agent Memory.
3. F-10 — issue identity keying, best decided before any data exists.
