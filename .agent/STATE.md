# STATE

**Phase:** Batch 2 implemented, re-audited and verified. Stopped, as instructed.
**Base:** `0407618` (main, untouched). **Worktree:** `C:\AIAgent\ferret-forensic`, branch `forensic/post-roadmap-audit`.
**Last action:** F-30/F-29/F-17/F-16 fixed; fixtures green; full verify run.

## Done
- Forensic verification — 100 findings (`docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`).
- Triage — buckets, dependencies, eight batches (`docs/evidence/FERRET-POST-FORENSIC-TRIAGE.md`).
- **Batch 1 — ingestion completeness** (`docs/evidence/FERRET-BATCH-1-INGESTION-COMPLETENESS.md`):
  resume by reachability (`^<tip>`) instead of by commit date, and follow the page cursor
  to its end. Closes F-01 (P0), F-02, F-03, F-04.

- **Batch 2 — small self-contained blockers** (`docs/evidence/FERRET-BATCH-2-BLOCKERS.md`):
  credential redaction in the printed backup command; a catalogue allowlist for imported
  column names; per-value rather than per-line redaction on export; extensions provisioned
  before migrating, plus a repair for installations already past it. Closes F-30, F-29,
  F-17, F-16.

## Changed
Batch 1: `src/git/history.ts` · `src/git/provider.ts` · `src/indexing/indexer.ts`.
Batch 2: `src/storage/export.ts` · `src/storage/import.ts` · `src/storage/provider.ts` ·
`src/storage/migrator.ts` · `src/cli/commands/init.ts` ·
`src/storage/migrations/0013_embedding_repair.sql` (target schema version 12 -> 13).
New tests: `tests/integration/indexing/history-completeness.test.ts`,
`tests/unit/history-paging.test.ts`, `tests/integration/storage/backup-fidelity.test.ts`,
`tests/integration/storage/embedding-provisioning.test.ts`, plus one case in
`tests/unit/export.test.ts`.

## Verified
`lint && typecheck && build && vitest run`: 3366 passed, 41 skipped, **0 failing tests**.
One failing *file* — `packaging.test.ts`, hook timeout under contention — is F-73, present
in the forensic baseline and passing in isolation (34/34).

## Proved (Batch 1)
Fixture red before the fix for the four identified reasons (`missing: 5, commitsRead: 1000`
on 1 005 commits, unrepairable by re-run or `--full`; branch, skew and back-dated merge
losses). Green after. One self-inflicted defect found by re-auditing the fix — the
exclusion was carried only onto the first page — is now pinned by a unit test that fails
against it. One regression found and fixed: the report's `watermark` lost the previous
position on a resumed run (EPIC-108 AC-10).

## Constraints in force
No new Epics. No Epic status changes. No PRs. No merge. No deploy. No changes to `main`.

## Next action (not started, not authorized)
Batch 3 — untrusted-input bounds: F-60, F-61, plus F-95, F-96, F-97. Everything an
outsider can trigger by committing a file, plus the git-parser isolation that turns one
bad record into a lost page. Await authorization.

## Open decisions for a human
1. F-21 — is GitHub/Jira ingestion meant to be reachable in this release, or library-only?
2. F-20 — same question for Session & Agent Memory.
3. F-10 — issue identity keying, best decided before any data exists.
