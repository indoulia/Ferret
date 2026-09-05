# EPIC-121 — GitHub Connector: validation evidence

**Status: VALIDATED** · two defects found by running the connector against the
**live GitHub API**, both of which every fixture in the repository agreed with
and therefore could not have caught. Both fixed here. No schema change and no
migration.

## Environment

| | |
| --- | --- |
| Tree | `025ba32` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | PostgreSQL 17 + pgvector, container started by `tests/support/postgres.ts` |
| Live source | `api.github.com`, repository `indoulia/Ferret`, authenticated |
| Date | 2026-09-05 |

## Implementation

| | |
| --- | --- |
| Connector | `src/connectors/project-connector.ts` — `projectSourceConnector`, widened |
| Record kinds | same — `PROJECT_ISSUE_RECORD`, `PROJECT_PULL_REQUEST_RECORD`, `PROJECT_REVIEW_RECORD`, `PROJECT_COMMENT_RECORD` |
| Fan-out bound | same — `ProjectConnectorOptions.fanOut`, default 25 |
| Comment modelling | `src/project/model.ts` — `ProjectModelInput.comments`, `addComment` |
| Reference fix | same — `addResolutions` prefers a record read in this batch |
| Ingestion path | unchanged — `SourceIngestor`, `writeContribution` |

**Nothing was added to the ingestion path.** `src/connectors/ingest.ts` and
`src/connectors/write.ts` are byte-identical to EPIC-119, as they were after
EPIC-120.

**No canonical model change.** No entity kind, no relationship type, no
attribute schema and no migration. A comment is a `document` and the edge to its
parent is `DOCUMENT_DESCRIBES_ENTITY`, both of which already existed.

## Real source exercised

The provider is the one Ferret ships. `createGithubProvider` is constructed with
only `fetch` supplied, so paging, ETags, rate-limit accounting and the REST
mapping onto `ProjectSource` are all production code. The dogfood section below
goes further and uses no stub at all.

## Acquisition → normalization → storage → retrieval

```
issues → pull requests → reviews → comments
```

```
acquired kinds        issue, pull_request, review, comment
ordering              every pull_request precedes the first review
                      every issue precedes the first comment
pages                 one cursor, four stages
```

Then into **real PostgreSQL** and back out through the **real `RetrievalStore`**:

```
findEntities({kind: 'issue', scope: sourceId})        → 2
neighbours(issue, DOCUMENT_DESCRIBES_ENTITY, IN)      → the comment body
SELECT DISTINCT producer, producer_version            → ferret.source.github, 0.1.0
```

The traversal is the assertion that matters: before this Epic it returned
nothing, because comments never reached the graph.

## Source identity

```
identify('indoulia/Ferret')  → { system: 'github', instance: 'github.com', resource: 'indoulia/Ferret' }
sourceIdentityKey(...)       → github::github.com::indoulia/ferret
```

A self-hosted instance is a different source: `github.acme.internal` and
`github.com` do not produce the same identity for the same `owner/repo`.

## Metadata and provenance

```
every evidence row   producer        = ferret.source.github
                     producerVersion = 0.1.0 (VERSION)
                     sourceSystem    = github
```

Every record a project owns is scoped to that project. Actors and commits are
deliberately **not** — a person is the same person and a sha is the same commit
whoever mentions them (EPIC-036, EPIC-051), and scoping them would defeat the
join those Epics exist to make.

## Relationships

| Edge | Asserted |
| --- | --- |
| `REVIEW_REVIEWS_PULL_REQUEST` | review → its pull request |
| `DEVELOPER_REVIEWED_PULL_REQUEST` | reviewer → the pull request, whatever the verdict |
| `PULL_REQUEST_RESOLVES_ISSUE` | from `Fixes #N` in a body |
| `PULL_REQUEST_PROPOSES_COMMIT` | merged pull request → its merge commit |
| `DOCUMENT_DESCRIBES_ENTITY` | comment → the issue or pull request it is on |

The commit entity is emitted into the canonical source system, not into
`github` — EPIC-051's rule, asserted here so a GitHub-side merge commit and the
Git-side one stay a single row.

## Idempotence, updates and deletion

```
second pass over the same project
  entities created        0
  evidence recorded       0
  evidence deduplicated   > 0
  entities / edges / evidence   unchanged

two independent runs, two stores
  entity ids              identical
```

Edges are counted by endpoint and type rather than by the store fake's key. The
fake keys an edge by `(from, type, to, validFrom)` and `modelProject` mints
`validFrom` from the clock, so two passes make two keys for one fact — whereas
the real `RelationshipStore.assert` is keyed by endpoints and reports
`unchanged`, which is why the PostgreSQL case sees one graph. Counting the
fake's keys would have asserted the fake's behaviour rather than Ferret's.

| Change | Result |
| --- | --- |
| Comment edited | **same** entity, new body — identity is the comment's id, not its content |
| Comment deleted | no longer acquired; the entity and its edge are kept |
| Incremental pass | asks with `since` = the previous pass's `cursorAdvancedTo` |

## Failure isolation and authorization

```
two projects, first refuses the connection
  outcome[0]        failed          outcome[1]  ingested, graph intact
  cursors written   1               — the failed source's position was not advanced

undeclared operations
  /pulls and /comments never requested; issues still produce a usable graph

unreadable cursor
  starts over rather than failing a source over a value it did not produce

304 Not Modified
  report.unchanged = true, 0 records — not collapsed into "there is nothing"
```

Retrieval was exercised through `PUBLIC_ACCESS`, the same `AccessContext`
parameter every read takes (EPIC-058). The connector adds no read path and no
way to reach GitHub except through the provider and its token, so no
authorization boundary is widened. The token is already declared in
`secretOptions` and is never carried into an identity: `instance` is a hostname.

## Dogfood: the connector against the live GitHub API

Run against `api.github.com` for `indoulia/Ferret` with a real token, bounded to
40 pages of 50. No stub anywhere in the path.

**Before the fixes:**

```
pages / records    22 / 204
skipped            25   — every one: comment names "…", which is not in this batch
ingested comments  0
ingested issues    50
```

**After:**

```
pages / records    ~22 / 204
skipped            0
ingested comments  25
ingested issues    30   — 29 read in full, 1 a stub for issue #12, which this
                          bounded pass never read and a pull request body cites
rate limit         ~1 700 requests spent of 5 000, reserve never touched
```

A real comment, as stored:

```
title            Comment on #27
scoped           true
body             "Fixed in `453d047` on `epic-032-index-lifecycle`. All four CI jobs …"
describes-edge   true
```

**Per-issue oracle.** Three issues whose comment counts `gh api` states
independently, against what the connector attached to each:

| Issue | `gh api` | Attached |
| --- | --- | --- |
| #27 | 1 | 1 |
| #130 | 1 | 1 |
| #109 | 2 | 2 |

## Defects found and fixed

**1 — every comment was an orphan.** `GithubProvider.listComments` is handed an
item *number* and synthesises `parentId` as `owner/repo#123`, because a number
is all it has. The same provider identifies that issue by its GraphQL `node_id`
whenever GitHub sends one — which the live API always does. So a comment named
`indoulia/Ferret#130` while the issue was `I_kwDOUIiLgM6…`, the two never
matched, and `modelProject` correctly skipped every comment as an orphan. **25
acquired, 25 skipped, 0 stored.**

It could not have been found from a fixture: a fixture without a `node_id` falls
back to exactly the form `listComments` synthesises, so the two agree by
accident. Every fixture in the repository was that shape. Fixed in the
connector, which is the one component holding both halves — it chose the number
*and* has the record the number came from — so it states the parent rather than
leaving a provider to infer it from an address. The same fix applies to reviews,
which had the identical mismatch.

Pinned by two cases, and every fixture in the suite now carries a `node_id`.

**2 — `Fixes #N` linked to a phantom issue.** Found immediately afterwards, by
giving the fixtures the `node_id` the live API sends. `addResolutions` mints a
placeholder issue with the id `owner/repo#N`, because "a provider's stable id is
not knowable from a body" — correct for an issue Ferret has never seen, and
wrong for one sitting in the same batch, where it produced **two entities for
one issue** and hung the `resolves` edge off the stub. In the live run this was
the difference between 50 issue entities and 30.

Fixed by preferring a record read in this batch, same project, matching number,
and falling back to the placeholder otherwise — so a cross-repository reference
and a not-yet-indexed issue behave exactly as before. This one was in
`modelProject`, so `ferret sync` had it too.

## Tests

| Suite | Result |
| --- | --- |
| `tests/integration/connectors/github-connector.test.ts` | **26 passed** (24 against the shipped provider, 2 against real PostgreSQL) |
| `tests/unit` + connectors + providers | **2331 passed, 98 files** |
| indexing + retrieval + mcp + security + storage | **936 passed, 62 files** |
| `tests/integration/packaging.test.ts` | 34 passed — the ceiling did not move |
| `npm run lint` | clean |
| `npm run typecheck` | clean |

EPIC-119's 35 cases and EPIC-120's 24 stay green unchanged.

## Stated rather than claimed

- **Not a GitHub client.** Nothing opens, comments on, labels, merges or closes
  anything. `acquire` reads and stops.
- **No canonical model change.** No kind, no relationship type, no migration.
- **No author edge invented** for a document, because EPIC-007 declares none.
- **No reasoning, no autonomous action, no scheduling, no webhooks.**

## Not applicable

Releases, deployments and deployment statuses are declared by the provider and
are `ProjectSynchronizer`'s (EPIC-073). Adding them here would be a second
enumeration of the same collections rather than the connector this Epic asks
for. GraphQL, Actions and webhooks are outside the stated scope.
