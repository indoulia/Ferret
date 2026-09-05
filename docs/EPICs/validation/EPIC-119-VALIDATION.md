# EPIC-119 — Universal Source Connector Contract: validation evidence

**Status: VALIDATED** · two defects found by running a connector against the
real database rather than against the suite's fakes, both fixed here. No schema
change and no migration.

## Environment

| | |
| --- | --- |
| Tree | `1316e1a` (`main`) + this Epic |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | PostgreSQL 17.11 + pgvector 0.8.6, the persistent `ferret-dogfood` container |
| Protocol | Real MCP over stdio, against the built CLI |
| Date | 2026-09-05 |

## Contract

| | |
| --- | --- |
| Contract | `src/providers/contracts/source-connector.ts` — `SourceConnector`, `SourceIdentity`, `sourceIdentityKey`, `AcquiredRecord`, `AcquisitionPage`, `SourceContribution`, `NormalizationContext` |
| Capability | `Capability.SOURCE_CONNECTOR` = `source.connector`, version 1, minimum 1 |
| Ingestion path | `src/connectors/ingest.ts` — `SourceIngestor`, `ingestSources` |
| Write path | `src/connectors/write.ts` — `writeContribution`, shared with `ferret sync` |
| Concrete implementation | `src/connectors/project-connector.ts` — `projectSourceConnector` |

## Concrete implementation

**Not a fixture.** `projectSourceConnector` adapts `ProjectSource` — the
capability the shipped GitHub provider (EPIC-021) and Jira provider (EPIC-071)
already implement — onto the connector contract. Neither provider changed. The
adapter is 165 lines and contains no transport, no paging of its own, no
storage and no second model: `acquire` calls the operation the provider
declared, `normalize` calls EPIC-072's `modelProject`.

`tests/unit/source-connector.test.ts` constructs the **real** `GithubProvider`
via `createGithubProvider`, initializes it with `createTestProviderContext`, and
ingests through the connector with only `fetch` stubbed:

```
report.connectorId  ferret.source.github
report.identityKey  github::github.com::indoulia/ferret
report.counts       1 record
stored issue        attributes.title = "Retrieval misses renamed files"
```

A second case runs a `ProjectSource` shaped like Jira (`FER-12`, state
`In Review`) and confirms the vendor's own word survives beside Ferret's
comparable reading: `sourceState = "In Review"`, `state = "open"`.

## Pipeline

```
connector.identify(resource)  →  SourceIdentity  →  sourceIdentityKey
connector.acquire(request)    →  AcquisitionPage (records, cursor, checkpoint)
connector.normalize(records)  →  SourceContribution, emitted through Emitter
SourceIngestor                →  writeContribution
                                 EntityWriter.upsert    (entities first)
                                 RelationshipWriter.assert
                                 EvidenceWriter.record + reconcileConflicts
                              →  EntityStore / RelationshipStore / EvidenceStore
                              →  SyncCursorStore.advance (completed passes only)
retrieval                     →  ferret_find, ferret_why over MCP
```

`writeContribution` **is** the former `ProjectSynchronizer.#write`, lifted out;
`src/project/sync.ts:513` now calls it. There is one write path, not two that
agree.

## End-to-end run, against PostgreSQL

A connector for a source Ferret has never heard of (a wiki — neither a Git
checkout nor a tracker), ingested three times into the dogfood database:

```
identityKey   wiki::handbook-v3.epic119.local::handbook
sourceEntity  cabc6213-de7e-8598-820e-fb0dbcc75feb
pass 1       created=3 updated=0 unchanged=0 evidence(new/dedup)=2/0 since=-                        cursor=2026-09-05T10:32:31.154Z
pass 2       created=0 updated=0 unchanged=3 evidence(new/dedup)=0/2 since=-                        cursor=2026-09-05T10:32:31.245Z
pass 3       created=0 updated=0 unchanged=3 evidence(new/dedup)=0/2 since=2026-09-05T10:32:31.245Z cursor=2026-09-05T10:32:31.297Z
determinism   same source entity id across passes
isolation     failed:E_UNKNOWN  ingested:wiki::healthy.epic119.local::handbook
```

- **Idempotence** — pass 2 is a full re-read of identical source state and
  creates nothing, updates nothing, and deduplicates every evidence record. Pass
  3 is the incremental case and does the same.
- **Determinism** — the source entity id and every record id are re-derived
  identically across passes. The unit suite adds the stronger form: two
  independent runs against two separate stores produce the same id set.
- **Change detection** — pass 3 asked from the instant pass 2 *started*, read
  from the cursor the ingestor persisted.
- **Failure isolation** — the broken source is reported with its code, its
  cursor is not written, and the healthy source that follows it in the same call
  is ingested normally.

## Identity

`sourceIdentityKey` is `system::instance::resource`, lowercased, and is the
source entity's `source.id`:

```
wiki::handbook-v3.epic119.local::handbook  →  cabc6213-de7e-8598-820e-fb0dbcc75feb
```

Every record of that source is then scoped to it, which is what keeps two
deployments apart. The stored document, read back over MCP:

```
canonicalKey   8:document4:wiki36:cabc6213-…-fb0dbcc75feb14:epic119-page-1
source.system  wiki
source.scope   cabc6213-de7e-8598-820e-fb0dbcc75feb
```

The suite asserts the same for `jira/a.atlassian.net/PROJ` versus
`jira/b.atlassian.net/PROJ` — different keys, different source entities, and
different record entities rather than only different scopes.

## Metadata

Retrieved from the database through `ferret_find` after ingestion:

```json
{
  "kind": "document",
  "source": { "system": "wiki", "id": "epic119-page-1",
              "url": "https://handbook-v3.epic119.local/epic119-page-1",
              "scope": "cabc6213-de7e-8598-820e-fb0dbcc75feb" },
  "attributes": { "title": "EPIC-119 handbook page 1",
                  "location": "epic119-page-1",
                  "modifiedAt": "2026-09-05T00:00:00.000Z" }
}
```

Title, URL and modification instant all survive; the title is content-fenced by
the MCP surface, as every indexed value is.

## Provenance

`ferret_why` on that entity, over MCP:

```json
{
  "field": "title",
  "statement": "EPIC-119 handbook page 1",
  "method": "observed",
  "producer": "fixture.source.wiki@0.1.0",
  "sourceSystem": "wiki",
  "sourceUrl": "https://handbook-v3.epic119.local/epic119-page-1",
  "authority": 100,
  "integrity": "verified"
}
```

The connector never passed a producer or a version. The `Emitter` the ingestor
constructs did, which is the mechanism: it cannot be forgotten from inside
`normalize`. `authority: 100` is `SYSTEM_OF_RECORD`, from the connector's
`systemOfRecord` declaration.

## Retrieval

Both queries above are the existing agent-facing surface, unmodified — real MCP
over stdio against the built CLI, no SQL. Ferret also retrieves this Epic's own
code through the same surface after re-indexing:

```
ferret_find { kind: code_symbol, attributes: { name: SourceIngestor } }
→ src/connectors/ingest.ts:112-317, class, exported
```

## Boundary

`tests/unit/source-connector.test.ts` asserts, over the source text of all five
new modules, that none of them contains `setInterval`, `setTimeout`, `cron`,
`webhook`, `anthropic`, `openai`, `completion(` or `prompt(`; that the contract
names no vendor; that the connector object exposes `identify`, `acquire` and
`normalize` and nothing named `plan`, `decide`, `act`, `execute`, `reason` or
`orchestrate`; and that the ingestion modules reach storage only through
`indexing/ports.js`. `boundaries.test.ts` is unchanged and still passes.

## Dogfood, and the two defects it found

Ferret was queried over MCP against its own index while the Epic was being
written. Asking *"who writes evidence during ingestion"* returned
`src/indexing/ports.ts` and `docs/EPICs/EPIC-113-Provider-Sync-Transport.md`,
which confirmed the Epic's premise precisely: the **converters** were already
shared and documented as shared, and the **loop around them** was duplicated —
so the rules the loop holds were the part being copied.

Running a connector against the real database then found two defects that the
unit suite could not:

1. **The cursor was keyed by the identity string.** PostgreSQL answered
   `22P02 invalid input syntax for type uuid`. `SyncCursorStore`'s scope is a
   canonical id; `wiki::host::handbook` is not one. The suite's cursor fake took
   any string. Fixed: the cursor is keyed by the source entity id.
2. **The contract did not require records to be scoped.** An unscoped connector
   derives entity identity from the record id alone, so the same page slug on
   two wikis collapsed into one entity — visible in a run as
   `created=1 updated=2` where `created=3` was expected.
   `NormalizationContext.sourceEntityId` now states the obligation, and the
   suite asserts two instances keep their records apart.

Both were found by running the product, not by reading it.

## Hardening: a bounded pass could not finish a large source — 2026-09-06

Recorded here rather than in a separate note because it changed the code.

**The defect.** `DEFAULT_INGEST_PAGE_LIMIT` bounded a pass, and a bounded pass
persisted nothing about where it had stopped. `page.cursor` was assigned to a
local and discarded at `pages >= pageLimit`; the advance block then wrote no
position at all, because it was guarded on `!truncated`. The next pass asked the
source for its *first* page again, under the same `since`.

So a source holding more than `pageLimit × pageSize` records could never be read
past that prefix, however many times ingestion ran — while every pass wrote rows,
reported records and returned `truncated: true`, which the CLI renders as
"re-run to continue". The advice was sound and the re-run never completed. No
fixture was larger than one bounded pass, so nothing caught it.

**The fix.** A pass and a window are separated. A truncated pass persists
`pageCursor` (the connector's own token, opaque here) and `passStartedAt`
alongside an *unmoved* `syncedAt`; the next pass resumes from it. A finished pass
writes `syncedAt` = the instant the window **opened**, not the instant its last
pass ran, and no `pageCursor` — and because `SyncCursorStore` replaces a
position's metadata rather than merging into it, that clears the continuation by
construction rather than by remembering to delete it. `cursorAdvancedTo` still
reports `undefined` for an unfinished pass, so no existing caller changes.

One new state needed deciding: a source answering `unchanged` to a request that
carries a cursor has contradicted itself, since the unread tail is exactly what
it was asked about. Believing it would close the window over records nobody had
read, so the continuation is kept.

**Proven against the old code before the fix.** The regression suite was run on
the unmodified implementation: 7 of 10 cases failed, including
`expected 101 to be 126` — 125 records over 25 pages against the default bound
of 20, of which the old implementation stored 100 and could never store more.

**Dogfood, and the second defect it found.** The corrected path was run against
**Ferret's own repository** through the real Git provider and real PostgreSQL at
`pageLimit: 5`, deliberately tight so the boundary is crossed many times. The
window closed after **12 passes** having read **1 092 records**, the continuation
advancing through the connector's own stages (`files` → `commits`) and the
position carrying no `syncedAt` until the last pass.

The first run of that exercise stored **75 of 866 files and 0 of 211 commits**:
passes 2 to 12 read 1 002 records and created **zero** entities. That is
EPIC-120's `normalize` returning an empty contribution when the batch carries no
repository record — a defect this correction *caused to matter*, since before it
a bounded pass always restarted from the first stage and always had one. Fixed
there; see that Epic's validation. After the fix the same run stores **880 file
entities and all 211 commits**, matching `git rev-list --count HEAD` exactly.

## Tests

| Suite | Result |
| --- | --- |
| `tests/unit/source-connector.test.ts` | 35 passed |
| `npm run test:unit` (94 files) | 2261 passed |
| `npm run test:security` (9 files) | 153 passed |
| `npm run lint` | clean |
| `npm run typecheck` | clean |

Existing suites re-run for the refactor and the capability addition:
`project-sync`, `boundaries`, `capabilities`, `providers`, `github-provider`,
`jira-provider`, `provider-conformance` — 289 passed.

## Stated rather than claimed

**No registered provider declares `source.connector` yet.** The capability is
defined, versioned and in the catalogue; `projectSourceConnector` produces a
`SourceConnector` from a provider that declares `source.project`, and the
ingestor is driven by the connector object directly rather than by capability
selection through the registry. So the capability is *declared and unclaimed* —
the state `source.project` itself was in from EPIC-013 until EPIC-021 gave it a
contract and a provider.

That is the correct state for this Epic and not an oversight: making the GitHub
provider declare `source.connector` would mean asserting it implements
`identify`/`acquire`/`normalize`, which it does not — the adapter does. The first
provider to declare it is EPIC-120's, and nothing here is stubbed in advance of
it.

## Not applicable

**Performance benchmarks** — N/A. The Epic adds no query, no index and no hot
path; `writeContribution` executes the same statements in the same order the
sync path already executed them.

**Schema and migration** — N/A. No table, column or migration was added.
