# Development Checkpoint — EPIC-031

Durable handover record per Governance §17 and AI Development Rule §18.

**Last updated:** 2026-08-31

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-031 — Incremental Indexing (P0, Code Intelligence)

**Branch:** `feat/epic-031-incremental-indexing`, cut from `main` at `9efbb09`.

**Status:** VALIDATED — 9/9 acceptance criteria PASS. Evidence in
[`docs/EPICs/validation/EPIC-031-VALIDATION.md`](../EPICs/validation/EPIC-031-VALIDATION.md).

---

## Ferret now works end to end

This is the Epic where the product starts existing. `ferret index .` reads a Git
repository through the `source.repository` capability and writes its canonical
graph into PostgreSQL — and Ferret has indexed **its own repository**: 61
commits, 278 files, 638 entities, 1,403 relationships, 347 evidence records,
in 17 seconds. The second run wrote nothing.

The dogfooding output, the queries it can now answer about its own development,
and the defect it found are all in the validation evidence §4.

## Completed

- `RepositoryIndexer` — core logic, four narrow storage ports, no storage import.
- A watermark per repository, stored as an EPIC-010 derived artefact, moved only
  after every stage succeeds.
- `ferret index`, composing a storage provider and a source provider.
- **Two storage fixes** that the earlier Epics had recorded or implied.

## Files

```text
docs/EPICs/EPIC-031-Incremental-Indexing.md            specification
src/indexing/ports.ts                                  what the indexer needs, as interfaces
src/indexing/indexer.ts                                the indexer
src/cli/commands/index-command.ts                      `ferret index`
tests/integration/indexing/repository-indexer.test.ts  8 cases, real Git + real PostgreSQL
```

Modified: `src/storage/relationships.ts` (open-interval no-op and the lock that
makes it correct), `src/logging/logger.ts` (a dogfooding find),
`src/cli/program.ts`, `src/index.ts`, `tests/unit/logging.test.ts`.

## Tests

`npm run verify` — **1,147 passed, 3 skipped** across 46 files, zero unhandled
errors. `npm audit` — 0.

## Three defects, and how each was found

1. **Unbounded growth for unchanged content** — the one EPIC-018 recorded and
   named this Epic as owner of. Found by a test that counts *rows*, not
   outcomes.
2. **Write skew on the fix for (1)**, then **an ordering bug in the fix for
   that**. The first was found by three concurrent indexers; the second only
   under full-suite load, which is the signature of every ordering bug. There is
   no ordering of two concurrent observations in which two open intervals for one
   edge is right, so ordering was removed from the match.
3. **A log line strictly worse than the terminal output** — pino re-serializing
   an already-serialized error, joining every cause message and inventing a
   stack. **No test would have found this**: every existing assertion checked
   fields that were correct. It took reading real output from a real run.

## Notes for whoever picks this up

- **The indexer must not import `storage/`.** It names four ports; the stores fit
  them structurally. The boundary test enforces it and the design is why the CLI
  needed no cast.
- **Write entities, then relationships, then evidence.** Foreign keys, not
  preference.
- **The watermark moves only on success.** Resuming from a position a failed run
  never reached leaves a gap nothing will fill.
- **`--since` re-reads the boundary second, deliberately.** Skipping it would
  risk losing a sibling commit made in the same second.
- **Never take the open-interval check without the lock.** It is a
  read-decide-write, and three concurrent indexers will race it.

## Blockers

None. One correctness gap raised as
[issue #19](https://github.com/indoulia/Ferret/issues/19) and owned by EPIC-032.

## Known limitations

Full table in the validation evidence §7. The two that matter:

- **The watermark is per repository, not per revision** — indexing `HEAD` then a
  feature branch can skip commits. Raised as **issue #19**, owned by **EPIC-032**.
- **The file tree is read in full every run.** Only history is incremental, so
  the second run is cheaper but not cheap → **EPIC-032**

## Next step

Ferret can index. It cannot yet **answer**. The shortest path to an AI client
being able to use it:

**EPIC-052/053 (Retrieval)** → **EPIC-060/061 (Context Packs)** →
**EPIC-065 (MCP Server)**.

Retrieval first, because everything downstream is shaped by what it can return.
The graph already holds what those Epics need: entities with content hashes,
relationships with valid time, evidence with provenance — and PostgreSQL FTS and
pgvector are both provisioned by `ferret init`.

**EPIC-032 (Indexing Scheduler)** should come before any of them if Ferret is to
index more than one repository unattended, and it owns issue #19.
