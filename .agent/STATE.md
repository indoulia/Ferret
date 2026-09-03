# STATE

**Phase:** Batch 4 implemented, re-audited and verified. Stopped, as instructed.
**Base:** `0407618` (main, untouched). **Worktree:** `C:\AIAgent\ferret-forensic`, branch `forensic/post-roadmap-audit`.
**Last action:** F-05/F-31/F-28/F-06/F-24 fixed; F-27 left open with its analysis; full verify run.

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

- **Batch 3 — untrusted-input bounds** (`docs/evidence/FERRET-BATCH-3-UNTRUSTED-INPUT-BOUNDS.md`):
  the ZIP bound enforced by the decompressor on real bytes rather than on the archive's
  own claim; `.docx` routed through a bounded reader before `mammoth`; git records found
  by a marker rather than by recognising content; per-commit isolation in the emitter; a
  cut-short read keeping what it read and saying so. Closes F-60, F-61, F-95, F-96, F-97.

- **Batch 4 — answer truthfulness** (`docs/evidence/FERRET-BATCH-4-ANSWER-TRUTHFULNESS.md`):
  lifecycle consulted by the answer surfaces; withheld rows and cut hops reported as
  separate facts; supersession applied only to single-valued fields; spans that name the
  bytes they quote. Closes F-05, F-31, F-28, F-06, F-24. **F-27 remains open** — the fix
  needs a second symbol write after cross-file resolution, which is a structural change to
  the content stage and was not started at the end of a batch.

## Changed
Batch 1: `src/git/history.ts` · `src/git/provider.ts` · `src/indexing/indexer.ts`.
Batch 4: `src/parsing/detect.ts` · `src/parsing/framework.ts` · `src/parsers/text/provider.ts` ·
`src/context/answer.ts` · `src/context/pack.ts` · `src/mcp/server.ts` · `src/retrieval/query.ts` ·
`src/retrieval/traverse.ts` · `src/storage/retrieval.ts` · `src/storage/evidence.ts` ·
`src/domain/evidence.ts` · `src/indexing/content.ts` · `src/indexing/indexer.ts` ·
`src/project/model.ts`. New test: `tests/unit/span-fidelity.test.ts`; cases added to
`answer-pack`, `mcp/tools`, `evidence-store`; seven test files adapted to the port change.
Batch 3: `src/parsers/sheet/zip.ts` · `src/parsers/office/document.ts` ·
`src/git/history.ts` · `src/git/provider.ts` · `src/git/runner.ts` (export `firstLine`) ·
`src/indexing/indexer.ts`. New tests: `tests/integration/git/malformed-history.test.ts`,
plus cases in `sheet-parser`, `docx-parser`, `git-history-parser`; fixture generators
extended in `tests/support/ooxml-fixtures.ts`.
Batch 2: `src/storage/export.ts` · `src/storage/import.ts` · `src/storage/provider.ts` ·
`src/storage/migrator.ts` · `src/cli/commands/init.ts` ·
`src/storage/migrations/0013_embedding_repair.sql` (target schema version 12 -> 13).
New tests: `tests/integration/indexing/history-completeness.test.ts`,
`tests/unit/history-paging.test.ts`, `tests/integration/storage/backup-fidelity.test.ts`,
`tests/integration/storage/embedding-provisioning.test.ts`, plus one case in
`tests/unit/export.test.ts`.

## Verified
`lint && typecheck && build && vitest run`: 3409 passed, 7 skipped, 1 failed.
The failure is `discovery.test.ts > walks a wide tree within budget` (38 769 ms vs a
30 000 ms ceiling) — F-92, environmental, 2 242 ms in isolation. F-73 did not fire this
run: packaging completed all 34 tests.

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
Batch 5 — prompt-injection boundary: F-32, F-64, F-66. Small, and they are one defence
rather than three: a trim that cuts the closing delimiter, containment that only walks
top-level strings, and the content notice arriving last in the two prompt-facing tools.
F-27 also remains, and is the natural companion to any further content-stage work.
Await authorization.

## Open decisions for a human
1. F-21 — is GitHub/Jira ingestion meant to be reachable in this release, or library-only?
2. F-20 — same question for Session & Agent Memory.
3. F-10 — issue identity keying, best decided before any data exists.
