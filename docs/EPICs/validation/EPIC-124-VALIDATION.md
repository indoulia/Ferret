# EPIC-124 — Unified Cross-Source Context: validation evidence

**Status: VALIDATED** · the four-source chain resolves end to end against real
storage. One defect fixed, two long-built mechanisms joined to the pipeline for
the first time. **No entity kind and no relationship type added**; no schema
change, no migration.

## Environment

| | |
| --- | --- |
| Tree | `5b7c6fd` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | PostgreSQL 17 + pgvector, container started by `tests/support/postgres.ts` |
| Date | 2026-09-05 |

## Implementation

| | |
| --- | --- |
| Pass | `src/context/cross-source.ts` — `linkCrossSourceReferences` |
| Extraction | same — `findCrossSourceReferences`, `CrossSourceReferenceKind` |
| External ids | `src/project/model.ts` — `externalIdsFor`; `src/confluence/provider.ts` |
| Bodies | `src/project/model.ts` — `description` on issues and pull requests |
| Ingestion path | unchanged — `SourceIngestor`, `writeContribution` |

`src/connectors/ingest.ts` and `src/connectors/write.ts` remain byte-identical
to EPIC-119 — five Epics, four connectors, one ingestion path.

## The chain, walked

Four real providers, four real connectors, a real Git repository on disk, real
PostgreSQL, and the real `RetrievalStore`. The only doubles are the HTTP
transports, which answer fixtures rather than the network.

```
findEntities({externalId: {system:'jira', id:'FER-12'}})   → the issue
neighbours(issue,  PULL_REQUEST_RESOLVES_ISSUE,   IN)      → "Follow renames in retrieval"
neighbours(pull,   PULL_REQUEST_PROPOSES_COMMIT,  OUT)     → the commit, sha = HEAD
   attributes.message contains "Follow renames in retrieval"
   — read from Git, not a stub GitHub minted: a placeholder carries no message
neighbours(commit, COMMIT_MODIFIES_FILE,          OUT)     → src/retrieval.ts
neighbours(page,   DOCUMENT_DESCRIBES_ENTITY,     OUT)     → the issue and the pull request
```

The commit hop is worth naming: GitHub reported a merge sha and the Git
connector read a commit, and they are **one entity** because EPIC-051 identifies
a commit in the canonical system rather than the reporting one. That was already
true; this Epic is what made it reachable from a Jira key.

## What had been built and never joined

**`proposeResolutions` (EPIC-051)** carries a `QUOTED_KEY` rule — "an issue key
quoted in the other system's record", scored `PROBABLE`. It is exported from
core and unit-tested, and **nothing has ever called it**.

**`externalIds` (EPIC-006)** is on every entity, persisted in its own table,
queryable through `EntityQuery.externalId`, and surfaced over MCP. **No provider
had ever populated one.** It is exactly the mechanism a cross-source link needs
and the reason one could not be made: a pull request body knows `FER-12`, and
the Jira issue is identified by `10012` under a Jira scope.

Both are now joined. `externalIds` are written by the project model and the
Confluence provider; the pass resolves against them.

```
findEntities({externalId: {system:'jira',       id:'FER-12'}})           → issue
findEntities({externalId: {system:'github',     id:'indoulia/Ferret#44'}}) → pull_request
findEntities({externalId: {system:'confluence', id:'77001'}})            → "Rename Design"
```

## Defect found and fixed: the body was read and discarded

`ProjectRecord.body` is fetched by the GitHub provider and the Jira provider,
and `modelProject` dropped it — **while reading it**, to find closing
references. Ferret knew what a pull request said for exactly long enough to pull
one edge out of the text, and then forgot the text.

`issueAttributes` and `pullRequestAttributes` have carried `description` through
`base` since EPIC-006. So an agent asking a context layer what an issue *says*
got a title, and the pass this Epic adds had nothing to scan.

Fixed, redacted like every other field:

```
pull_request.attributes.description   contains "Fixes FER-12"
issue.attributes.description          contains "/wiki/spaces/DEV/pages/77001"
```

This is the fifth member of a family this arc kept finding — `listComments`,
`ProjectRecord.key`, `issuetype`/`priority`, `externalIds`, and now `body`. Each
is a value that three layers agreed mattered with no line carrying it between
them, and each survived because the suites tested one side of a seam.

## No new relationship type

Asserted directly rather than claimed:

```
new Set(report.links.map(row => row.type))
  → { document_describes_entity, pull_request_resolves_issue }
```

Both predate this Epic. `ISSUE_LINKS_ISSUE` is available for issue-to-issue
mentions and was not needed by this fixture. A pull request that merely
*mentions* an issue yields **no** edge: there is no `pull_request_mentions_issue`
and saying nothing beats saying the wrong thing about whether work is done.

## A tracker key is only a key if Ferret holds the project

The false positive that would have mattered: `UTF-8`, `HTTP-2` and `RFC-7540`
all have the shape of `FER-12`, and no pattern separates them, because nothing
about the text does. What separates them is whether anybody has a project called
`UTF`.

So the pass learns which projects it holds first — from the `key` attribute of
the issues it read — and filters on that:

```
'Encode as UTF-8 over HTTP-2, per RFC-7540. Fixes FER-12.'
  with projects {FER}   → ['FER-12']
  with no projects      → every candidate, which is what a diagnostic wants
```

The prefixes come from `attributes.key` and not from `externalIds` because
`RetrievalStore.findEntities` deliberately does not hydrate external ids — its
own comment says so, and it is right to: a search result would pay a second
query per row for a field almost no caller reads. Discovered by writing the
index the other way first and getting no links at all.

## Determinism, idempotence and duplicate suppression

```
two dry runs over one graph      identical link lists, in identical order
second real pass                 same link count; relationship row count unchanged
duplicate references             one edge per (from, type, to) — asserted as a set
reference to an un-ingested key  counted as unresolved; no entity created for OPS-999
```

Idempotence is by construction: the edge is keyed by its endpoints and
`RelationshipWriter.assert` asserts rather than appends.

## Authorization and source boundaries

Every read goes through `RetrievalPort` with the caller's `AccessContext`, so a
link can only be made between entities the caller could already see. Scopes are
a required parameter and not a sweep:

```
linkCrossSourceReferences(..., { scopes: [] })  → examined 0, links []
```

A pass over the whole store would grow with the database and would cross a
boundary the caller never named.

## Provenance

Every asserted link carries the producer that made it, the reference kind that
recognised it, and the text that was quoted — enough for a reader to disagree
with the join rather than having to trust it.

## Tests

| Suite | Result |
| --- | --- |
| `tests/integration/connectors/cross-source.test.ts` | **17 passed** (11 against real PostgreSQL, 6 on the extractor) |
| `tests/unit` + connectors + providers + distribution | **2418 passed, 102 files** |
| indexing + retrieval + mcp + security + storage | **936 passed, 62 files** |
| `tests/integration/packaging.test.ts` | 34 passed (ceiling raised, see below) |
| `npm run lint` / `typecheck` / `build` | clean |

EPIC-119's 35, EPIC-120's 24, EPIC-121's 26, EPIC-122's 26 and EPIC-123's 28
stay green unchanged.

## Package size

The non-grammar ceiling moved an eighth time: 3 350 881 against 3 339 000, 0.36%
over. Measured on both sides — `dist/` at 9 158 189 with `src/` stashed and
9 184 416 with it restored — and the per-file deltas sum to exactly that 26 227:

```
+14 513  dist/context/cross-source.js
 +7 134  dist/context/cross-source.d.ts
 +2 899  dist/project/model.js
   +576  dist/confluence/provider.js
   +310  dist/context/index.js
   +287  dist/index.d.ts
   +286  dist/context/index.d.ts
   +222  dist/index.js
```

Ceiling raised to 3 451 000 — 3% headroom, as every previous raise has taken. No
dependency added.

## Stated rather than claimed

- **No reasoning.** The pass matches identifiers against `externalIds` and
  stops. No model call, no scoring, no threshold, no guess.
- **No merging.** It asserts edges between entities that already exist.
  `IdentityStore.merge` remains the only thing that merges.
- **No entity kind and no relationship type added.**
- **No autonomous action, no workflow orchestration, no realtime ingestion, no
  webhooks, no scheduling, no federation.**
- **No live credentialled run.** The four transports answer fixtures. The
  wire shapes they answer with were verified against live GitHub, Jira and
  Confluence in EPIC-121 to EPIC-123 and are recorded there.

## Not applicable

Freshness and change metadata are carried where the sources already supply them
— `sourceObservedAt` on every record, a Confluence version number, a Jira
`updated` — and this Epic adds no new notion of staleness. Realtime propagation
of a cross-source link when one side changes would need change detection Ferret
does not have, and inventing it here would be scope this Epic was not given: the
pass is re-runnable and idempotent, which is the honest answer until then.
