# EPIC-031 — Incremental Indexing

**Status: APPROVED | Priority: P0**

> **Specification note.** Elaborated to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry and Governance §4, §6, §10, §13 and §17. It introduces no
> capability the registry did not approve.

## 1. Objective

Turn what a provider observed into what Ferret knows: read a repository, write
its canonical graph, and make the second run cheap and the tenth run harmless.

## 2. Value

The whole product converges here. Everything before this Epic **reads**;
everything after it **answers**. This is the only place the two meet, and until
it exists Ferret is a well-tested library that stores nothing.

Three properties decide whether it is usable or merely functional.

**Indexing twice must change nothing.** Governance §10 states it, and it is not
free. Entity identity is content-derived, so entities behave. Relationship
identity includes `validFrom` — so an hourly index of an unchanged repository
would have written a new row *per edge, per run, for ever*. EPIC-018 recorded
that as its most important limitation. Nothing fails; the database simply grows
without bound for content nobody touched.

**The second run must be cheaper than the first.** A tool that re-reads a large
repository's entire history every hour is a tool people turn off.

**Writing must be ordered.** A relationship names two entities and evidence names
a subject. Entities first, relationships second, evidence last — not a
preference, a foreign key.

## 3. Scope

- A `RepositoryIndexer` that reads a repository through the
  `source.repository` capability and writes through narrow storage ports.
- A watermark per repository, so the next run reads only what is newer.
- `ferret index`, the command that composes a storage provider and a source
  provider and hands both to an indexer that knows about neither.
- The open-interval no-op in EPIC-007's relationship store, and the lock that
  makes it correct under concurrent writers.

## 4. Non-scope

- Scheduling, parallelism and back-pressure — EPIC-032.
- Untracked working-directory state.
- Retrieval and ranking — EPIC-052 onward.
- Parsing file content — EPIC-024.

## 5. Inputs

EPIC-006/007/008 stores, EPIC-010's derived-artifact store, EPIC-011's capability
selection, EPIC-017–023's provider operations.

## 6. Outputs

`src/indexing/` — core logic, reachable from the package root — plus
`ferret index`.

## 7. Dependencies

EPIC-002, EPIC-006, EPIC-007, EPIC-008, EPIC-010, EPIC-011, EPIC-012,
EPIC-017–023.

## 8. Contracts

### The indexer is core, and does not import storage

Deciding what to read, in what order, and what has already been seen has nothing
to do with PostgreSQL. The indexer names four narrow ports —
`EntityWriter`, `RelationshipWriter`, `EvidenceWriter`, `WatermarkStore` — and
the EPIC-002 stores satisfy them **structurally**, without either side importing
the other. The architecture test proves the core still reaches no `storage/`
module.

### The watermark is a derived artefact

Not a new table. A watermark *is* something Ferret built, attributed to a
producer and a version, that becomes stale when either changes — which is exactly
EPIC-010's derived-artifact record. A watermark written by a different build is
ignored and the run falls back to a full read: resuming from a position a
different producer reached would leave a gap nothing would ever fill.

It moves **only after every stage succeeded**. A run that failed halfway must be
repeated, not resumed from a place it never reached.

### `--since` has second granularity, and that is left alone

The watermark commit is re-read on every incremental run, and so is any commit
sharing its second. Moving the boundary forward to avoid that would risk skipping
a sibling commit made in the same second — and silently losing history is far
worse than re-reading a commit whose write is idempotent anyway.

## 9. Acceptance criteria

- **AC-1** A first run writes a connected graph: repository, worktrees, branches,
  commits, developers, files and versions, with their relationships and evidence.
- **AC-2** A second run over an unchanged repository adds **no rows**.
- **AC-3** A second run reads less than the first, and reports that it was
  incremental.
- **AC-4** `--full` re-reads everything and still writes nothing new.
- **AC-5** A branch switch is recorded as history: exactly one open checkout
  interval per worktree.
- **AC-6** Cancellation stops the run and leaves no watermark it did not earn.
- **AC-7** Concurrent indexers over one repository never produce two open
  intervals for one edge.
- **AC-8** `ferret index` selects its source by capability, never by name.
- **AC-9** The core reaches no storage module, enforced by test.

## 10. Test requirements

- **Integration against real infrastructure only:** a real Git repository indexed
  into a real PostgreSQL. Every criterion above is a property of the two
  together, and a mocked store would assert only that the mock was called.
- **Concurrency:** three indexers over one repository, asserting no edge has more
  than one open interval.
- **Durability:** row counts before and after a repeat run.
- **Performance:** the second run must be measurably cheaper than the first.
- **Dogfooding:** Ferret indexes its own repository. See the validation evidence.

## 11. Security requirements

Nothing new is trusted here: content was bounded and stripped by EPIC-019/022,
and evidence passes through EPIC-008's redaction on the way in. The indexer adds
no subprocess, no filesystem access and no network.

## 12. Observability

The report names what was read, what was written by outcome, what was skipped and
why, and where the watermark now stands. A run that wrote nothing is
distinguishable from a run that read nothing.

## 13. Performance constraints

The second run must be cheaper than the first, or the watermark is decorative.

## 14. Definition of Done

Indexer, ports, command, the storage fix, and evidence including a real index of
Ferret's own repository.

## 15. Governance alignment

- **§4 Provider-First** — the command composes; the indexer depends on neither
  provider.
- **§6 Evidence** — a watermark is never claimed for a run that did not finish.
- **§10 Idempotent ingestion** — measured in rows, not asserted in prose.
- **§13 Reliability** — an interrupted index leaves Ferret knowing less, never
  knowing something wrong.
- **§17 Performance** — §13.
