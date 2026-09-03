# STATE

**Phase:** Batch 5 implemented, re-audited and verified. Stopped, as instructed.
**Base:** `0407618` (main, untouched). **Worktree:** `C:\AIAgent\ferret-forensic`, branch `forensic/post-roadmap-audit`.
**Last action:** F-32/F-64/F-66 fixed as one boundary; six second-order defects found by
re-auditing and corrected; one wrong-layer test replaced; full verify run.

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

- **Batch 5 — prompt-injection boundary** (`docs/evidence/FERRET-BATCH-5-PROMPT-INJECTION-BOUNDARY.md`):
  a fence that survives truncation (the cut is made in the payload and the fence re-applied,
  the trim marker outside it); containment that recurses into arrays and nested objects with
  a depth bound and counts every leaf; the prose/token line redrawn by **shape** rather than
  by key name, because recursion arrives at keys the module never heard of; `unknownFields`,
  `externalIds` and edge `metadata` contained; untrusted records contained where they
  **enter** the pack and answer builders rather than at each place they leave; the notice
  first, under the key every other tool uses, with the test enumerating `listTools()`.
  Closes F-32, F-64, F-66.

- **Batch 4 — answer truthfulness** (`docs/evidence/FERRET-BATCH-4-ANSWER-TRUTHFULNESS.md`):
  lifecycle consulted by the answer surfaces; withheld rows and cut hops reported as
  separate facts; supersession applied only to single-valued fields; spans that name the
  bytes they quote. Closes F-05, F-31, F-28, F-06, F-24. **F-27 remains open** — the fix
  needs a second symbol write after cross-file resolution, which is a structural change to
  the content stage and was not started at the end of a batch.

## Changed
Batch 5: `src/security/containment.ts` · `src/security/index.ts` · `src/context/pack.ts` ·
`src/context/answer.ts` · `src/mcp/server.ts`. New test:
`tests/security/injection-boundary.test.ts`; five cases added and one corrected in
`tests/unit/containment.test.ts`; the source-grep block in
`tests/security/untrusted-content.test.ts` replaced with a behavioural one.
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
`lint && typecheck && build && vitest run`: **3442 passed, 7 skipped, 1 failed** (170 files).
The failure is `scale.test.ts > scans rather than indexes when the whole table is wanted`:
PostgreSQL chose `Index Only Scan using entity_lifecycle_idx` over a sequential scan for
`SELECT count(*)`. **Not caused by Batch 5** — proved by running it with the changes stashed
(passes) and with them restored in isolation (passes); nothing in the batch touches SQL,
schema or query planning. Recorded as **F-101**, a new infrastructure finding of F-92's
class. F-92 and F-73 did not fire this run: the wide-tree walk passed and packaging
completed all 34 tests.

## Proved (Batch 5)
The fixture is at the **response** layer — an MCP client and server over an in-memory
transport with a hostile fake retrieval, asserting over the bytes a client receives. 8 of 9
assertions red before any implementation change: the pack led with `formatVersion` not
`notice`; the notice serialized at offset 2 674 against content at 612; the fence was
unbalanced; the trimmed value carried `CONTENT_OPEN` and no `CONTENT_CLOSE`;
`ferret_search` emitted 5 unfenced payloads; no `inspected` field existed; a developer's
`emails[0]` came back raw. The one that passed is the control that containment removes
nothing — it passed before and after, which is why it is there.

Six second-order defects found by re-auditing the green fix, each corrected:
`unknownFields`/`externalIds` uncontained on four surfaces; edge `metadata` uncontained on
both neighbour branches; a pack item's evidence `statement` uncontained; provider-supplied
`field`/`locator`/`sourceUrl`/producer uncontained **and interpolated into sentences Ferret
wrote** (which moved containment to the entry point); double containment then corrupting
the quotation with `[delimiter removed]` — self-inflicted, caught by an assertion written
to look for it; and two test-only checkers wrongly on the declared control surface, caught
by `control-reachability.test.ts`.

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
Batch 6 — credential and safety enumeration: F-94, F-71. Make the safety lists
deny-by-default or derived rather than hand-maintained; F-94 proves the enumeration is
incomplete and F-71 is the same list missing `FERRET_DATABASE_URL`. Batch 5's own argument
supports it: every finding it closed was an enumeration that failed towards exposure — a
prose *allowlist* by key name, a traversal that visited only what it recognised, a notice
test with a hand-written tool list.

F-27 also remains, and is the natural companion to any further content-stage work.
Await authorization.

## Open decisions for a human
1. F-21 — is GitHub/Jira ingestion meant to be reachable in this release, or library-only?
2. F-20 — same question for Session & Agent Memory.
3. F-10 — issue identity keying, best decided before any data exists.
