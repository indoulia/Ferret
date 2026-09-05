# EPIC-119 — Universal Source Connector Contract

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

A source of any shape — a wiki, a build system, a mail store — reaches Ferret's
existing storage, index and retrieval path by implementing three methods, and
nothing about the ingestion path changes to receive it.

## Problem

Ferret had two source contracts and no common one.

`source.repository` (EPIC-017) is shaped around a Git working tree: worktrees,
branches, object ids, revisions. `source.project` (EPIC-021, EPIC-071) is shaped
around a tracker: issues, pull requests, reviews, deployments. Both are good
contracts for what they cover, and **neither is something a third kind of source
can implement.** A Confluence page is not a branch; a Jenkins build is not a
review.

So adding a source meant adding an *ingestion path*, not just a provider. The
evidence is in the tree: `ferret sync` (EPIC-113) is 630 lines that read a
cursor, enumerate under a page bound, model what came back, write entities then
relationships then evidence, and advance the cursor only if the pass finished.
Every one of those decisions is general. Every line that expresses them names
issues, pull requests or reviews. The third source would have got a second copy,
and the fourth a third — which is the "bespoke ingestion architecture per source"
this Epic exists to prevent.

There is a smaller, sharper version of the same defect. `indexing/ports.ts`
already carries this comment about its converters:

> once inside the indexer and once inside `project/sync.ts` — until the second
> caller made the duplication real.

The converters were shared. The **loop around them was not**, and it is the loop
that holds the rules: the write order the foreign keys demand, the `ifAbsent`
placeholder rule from issue #48, the `reconcileConflicts` sweep that EPIC-047
had to add twice because it depended on a caller remembering.

## Design

**Three verbs, and nothing that decides.**

```
identify → acquire → normalize
```

`identify` turns a user's words into the stable identity a source is remembered
by. `acquire` returns records verbatim, a page at a time. `normalize` maps them
onto Ferret's *existing* canonical model. A connector transports and maps; it
does not decide what to fetch next, call a model, or act on what it read.

**The contract carries no storage.** A connector never writes. `SourceIngestor`
writes, through the ports `RepositoryIndexer` and `ProjectSynchronizer` already
use. That is not a resemblance — `connectors/write.ts` **is**
`ProjectSynchronizer.#write`, lifted out unchanged, and the synchronizer now
calls it. There is one write path, so a rule learned once is applied everywhere.

**Provenance is attached by construction, not by discipline.** `normalize` is
handed an `Emitter` (EPIC-008) rather than the `createEntity`/`createEvidence`
functions. Producer, producer version and source system are supplied once when
the ingestor builds the emitter, and every record carries them. A connector
author cannot forget what they were never asked to pass.

**Identity is three parts.** `system` / `instance` / `resource` — `github` /
`github.com` / `owner/repo`. Two parts would have filed `PROJ` at one company
and `PROJ` at another as one board. `sourceIdentityKey` is deterministic and
total, and is what the sync cursor is keyed by and what the source entity's
`source.id` derives from; it is a stored format, not a formatting helper.

**No new entity kind.** The scope entity is a `repository`, which is the kind
Ferret's model already uses for "the bounded thing records belong to". Adding a
`source` kind would have made every existing query that scopes by repository
miss half the graph.

**Change detection is two fields and a checkpoint.** `since` and `cursor` on the
request, an opaque `checkpoint` on the page, persisted through EPIC-075's cursor
store. A connector whose source cannot filter ignores `since` and re-reads;
ingestion is idempotent, so the cost is traffic rather than correctness. That is
the whole of it — realtime ingestion is a later Epic and would not change this
contract, which is the test of whether the seam is cut in the right place.

**Failure is isolated per source, and cancellation is not.** `ingestSources`
steps over a source that throws: it is reported with its error code, its cursor
is left where it was so nothing is skipped, and no other source's records are
touched. An aborted run is the runtime shutting down rather than a source
misbehaving, so it propagates — swallowing it would turn "stop now" into "carry
on through the remaining forty sources".

## Scope

Included: the connector contract, source identity, acquisition paging, the
shared ingestion path, provenance, deterministic and idempotent repeated
ingestion, per-source failure isolation, and one real adapter proving a
production source can implement it.

Explicitly not included, and none of it is stubbed: GitHub, Jira, Confluence,
Outlook, Jenkins and Bitbucket connectors; webhooks; realtime ingestion;
scheduling; a marketplace; RBAC expansion; federation; autonomous actions; LLM
reasoning; replacement UIs; workflow orchestration. `tests/unit/source-connector.test.ts`
asserts the absence of the mechanisms these would need, rather than trusting the
list.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `SourceConnector` | `src/providers/contracts/source-connector.ts` | The three verbs a source implements |
| `SourceIdentity`, `sourceIdentityKey` | same | Which source instance, stably |
| `AcquiredRecord`, `AcquisitionPage` | same | What acquisition returns |
| `SourceContribution`, `NormalizationContext` | same | What normalization returns, and what it is given |
| `Capability.SOURCE_CONNECTOR` | `src/providers/capabilities.ts` | `source.connector`, version 1 |
| `SourceIngestor`, `ingestSources` | `src/connectors/ingest.ts` | The one ingestion path, and per-source isolation |
| `writeContribution` | `src/connectors/write.ts` | The one write path, shared with `ferret sync` |
| `projectSourceConnector` | `src/connectors/project-connector.ts` | The real adapter over `ProjectSource` |

## Acceptance criteria

1. A concrete source implements the contract with no bespoke ingestion
   architecture.
2. Connector output flows through the existing pipeline — same ports, same
   order, same store.
3. Identity, metadata and provenance survive ingestion and are retrievable.
4. Repeated ingestion is deterministic and idempotent.
5. One source's failure does not corrupt unrelated data.
6. Existing agent-facing retrieval remains usable and returns ingested content.
7. No agent reasoning or autonomous action is introduced.
8. Ferret is dogfooded during the implementation.

## Test requirements

`tests/unit/source-connector.test.ts` — contract shape, source identity,
extraction and normalization, write ordering, metadata survival, provenance
attachment and retrieval, duplicate handling, idempotence across passes,
determinism across independent stores, change detection and cursor discipline,
failure isolation, cancellation propagation, the real GitHub provider end to
end, and the scope boundary.

## Definition of Done

Targeted suite green, the existing suites it touches green, lint and typecheck
clean, evidence recorded in `validation/EPIC-119-VALIDATION.md`, and the
registry and roadmap updated.

## Governance alignment

§4 — every replaceable implementation sits behind a versioned provider contract.
§6 — "nothing changed" and "nothing exists" stay distinguishable, and a source
that failed is reported as failed rather than as empty. §9 — the canonical model
is unchanged; a connector maps onto it rather than extending it. §21 — producer
and producer version reach every emitted record, so re-extraction stays
answerable.
