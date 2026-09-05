# EPIC-120 — Repository Connector

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

A Git repository — its files, its directories, its commits, its branches, its
checkouts — is ingested through the EPIC-119 connector contract, with no
ingestion path of its own and no second model of a commit.

## Problem

EPIC-119 cut the seam and proved it with a tracker. A tracker is the easy case.

`ProjectSource` returns one flat collection, so `projectSourceConnector` is a
projection: map an issue to a record, hand the records to `modelProject`, done.
Nothing about it tests whether `AcquisitionPage` can carry a source that is not
one list, because a board *is* one list.

A repository is not. It is a description, its checkouts, its refs, its tree and
its history — five collections, four of which page independently, none shaped
like an issue and none convertible into the others. A tree entry has a path and
an object id; a commit has a sha, two identities and a set of changes; a branch
is a name pointing at a commit. If the universal boundary could not carry that,
it was not universal, and the honest thing would have been to find out at the
second connector rather than at the fifth.

There was also a concrete gap. `source.repository` (EPIC-017) has always been
Ferret's richest source contract, and the only thing that could drive it was
`RepositoryIndexer` — a class that knows about content stages, lifecycle
reconciliation, watermarks and run records. Nothing could ingest a repository
*as a source among sources*, which is what EPIC-124's cross-source context needs
a repository to be.

## Design

**An adapter, not a second implementation.** `repositorySourceConnector` is the
whole of it. `acquire` calls the operations the provider already declares;
`normalize` calls the provider's own `emitGraph` / `emitFiles` / `emitHistory`,
which is the same modelling `RepositoryIndexer` has always called. There is one
model of a commit in Ferret and this Epic does not add a second.

**Five collections, one cursor.** A repository's collections are walked as
*stages* of a single opaque cursor:

```
describe → branches → files → commits
```

The cursor names the running stage and carries that stage's own position, so the
ingestor's paging, page bounding, cancellation and cursor-advance rules apply to
a repository exactly as they apply to a board. The order is `RepositoryIndexer`'s
and for its reason: the tree is read before the history, so a commit's change
edge points at a file entity that was read from the source rather than at a
placeholder some later pass has to repair.

**One repository, one root.** The one substantive decision. `emit()` derives the
repository entity from `DiscoveredRepository.identityKey`; the ingestor has
already derived a source entity from `sourceIdentityKey(identity)`. Left alone
that is *two* `repository` rows for one ingested repository — one holding the
entire graph, one holding a name. `normalize` therefore re-roots the description
onto the identity the pass was scoped to, which is what
`NormalizationContext.sourceEntityId` exists to say. Nothing the real identity
carried is lost: `remoteUrl`, `identityKind` and `localRoot` stay on the entity,
so the resolution layer can still collapse two clones of one remote.

**Identity is the checkout, resolved without I/O.** `identify` is pure and total
by contract — the cursor is keyed by its answer, so a version that read
`.git/config` for the remote would make an *unreachable* repository
indistinguishable from an *unknown* one. The resource is therefore the path,
separator-normalised, and the remote reaches the graph as an attribute instead.

**Provenance is the provider's, not the connector's.** The connector deliberately
does not claim `systemOfRecord`. Git is the system of record for its own
commits, but `GitSourceProvider`'s emitter does not claim it and
`RepositoryIndexer` emits through that emitter — so claiming it here would give
the same observation of the same commit a different authority depending on which
path read it, and two rows that should deduplicate would not. Raising it is
EPIC-045's decision for the provider, not this connector's for one caller.

**Emitters are injected, so normalization carries the pass's provenance.** The
provider's `emit*` methods took their emitter from the provider. They now accept
one, defaulting to the provider's own, so a connector can normalize through
`NormalizationContext.emitter` as the contract requires. Every existing caller
passes nothing and is unchanged.

**Core still does not know Git exists.** `src/connectors` is core, and EPIC-017's
rule is that core never reaches a provider. The port is therefore stated in
core's own structural terms — `AcquiredTreeEntry` needs a `path`, `AcquiredCommit`
needs a `sha`, because those are the record ids and nothing else is load-bearing
— exactly as `RepositoryIndexer`'s port avoids naming Git. The first draft of
this file imported the provider's types for convenience and
`boundaries.test.ts` refused it.

**Deletion is remembered, not erased.** A file deleted at HEAD stops being
*acquired* — the tree no longer lists it — but its entity and the commit edges
that touched it stay. Retiring an entity is a reconciliation over a *complete*
listing (EPIC-031) and is not something a connector may do from a bounded page.

## Scope

Included: files, directories, commits, branches, worktrees, repository identity,
metadata, provenance, staged acquisition and paging, change handling, repeated
ingestion, failure isolation, and retrieval of the result.

Explicitly not included: Ferret does not become a Git client or a workflow
system. Nothing clones, fetches, checks out, commits, merges, rebases or pushes.
No webhooks, no scheduling, no realtime ingestion, no lifecycle sweep of its own.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `repositorySourceConnector` | `src/connectors/repository-connector.ts` | The adapter onto `SourceConnector` |
| `RepositorySourcePort` | same | What the connector needs of a repository source |
| `AcquiredTreeEntry`, `AcquiredCommit` | same | The record shapes, in core's own terms |
| `LOCAL_INSTANCE` | same | The `instance` for a checkout on this machine |
| `REPOSITORY_RECORD` … `COMMIT_RECORD` | same | The five record kinds acquired |
| `EmissionOverride` | `src/git/provider.ts` | A caller-supplied emitter for `emit*` |
| `GitSourceProvider.listFiles` | same | Now accepts the cursor it returns |

## Acceptance criteria

1. A repository is ingested through the EPIC-119 contract with no ingestion path
   of its own. — `repository-connector.ts`, 24 targeted cases.
2. Files, directories, commits, branches and checkouts reach the graph. — six
   entity kinds, checked against `git ls-files` and `git log`.
3. Source identity, metadata and provenance survive ingestion. — one repository
   root; producer, version and system on every record.
4. Repeated ingestion is idempotent and deterministic. — second pass creates
   nothing; two independent runs derive identical ids.
5. Added, modified and deleted files are handled. — one entity across a change,
   a second `file_version`, deletion dropped from the tree and kept in history.
6. A malformed or unreadable source is isolated. — reported and stepped over,
   cursor untouched.
7. Records are scoped to their own repository. — two repositories sharing a path
   stay two files.
8. Agent-facing retrieval returns what was ingested. — real PostgreSQL, real
   `RetrievalStore`, scope query and traversal.
9. No agent reasoning or autonomous action is introduced.
10. Ferret is dogfooded during the implementation.

## Test requirements

`tests/integration/connectors/repository-connector.test.ts` — staged
acquisition, tree and history against Git's own answer, branches, worktrees,
single-root identity, cross-repository scoping, provenance, remote retention,
added/modified/deleted files, incremental `since`, idempotence, determinism
across stores and across page sizes, tree paging, failure isolation, undeclared
operations, unreadable cursors, and the end-to-end path into PostgreSQL and back
out through retrieval.

## Definition of Done

Targeted suite green, the suites it touches green, security suite green, lint
and typecheck clean, dogfood evidence against Ferret's own repository, evidence
recorded in `validation/EPIC-120-VALIDATION.md`, and the registry and roadmap
updated.

## Governance alignment

§4 — the connector depends on a port, not on `GitSourceProvider`. §6 — a
repository that could not be read is reported as failed rather than as empty,
and a deleted file is dropped from the tree without being erased from the
record. §9 — a repository, a worktree and a branch stay distinct entities; no
new kind is added. §21 — producer and producer version reach every emitted
record, and are identical to the indexer's, so the two paths deduplicate.
