# EPIC-123 — Confluence Connector: validation evidence

**Status: VALIDATED** · a new provider, the first to declare `source.connector`,
and one latent contract collision found by being that first. Two relationship
types added; no entity kind, no schema change, no migration.

## Environment

| | |
| --- | --- |
| Tree | `533c396` (`main`) + this Epic, merged as `5b7c6fd` |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | PostgreSQL 17 + pgvector, container started by `tests/support/postgres.ts` |
| Live source consulted | `nymi-inc.atlassian.net`, read-only, for wire shapes only |
| Date | 2026-09-05 |

## Implementation

| | |
| --- | --- |
| Provider | `src/confluence/provider.ts` — `ConfluenceProvider`, `createConfluenceProvider` |
| Connector | same — `ConfluenceProvider.connector`, the three verbs |
| Link extraction | `src/confluence/references.ts` — `findPageReferences` |
| Transport | `src/atlassian/client.ts` — `AtlassianClient`, shared with Jira |
| Domain | `src/domain/relationship.ts` — `DOCUMENT_CONTAINS_DOCUMENT`, `DOCUMENT_LINKS_DOCUMENT` |
| Package | `./confluence` subpath, asserted by `distribution.test.ts` |
| Ingestion path | unchanged — `SourceIngestor`, `writeContribution` |

**Nothing was added to the ingestion path.** `src/connectors/ingest.ts` and
`src/connectors/write.ts` remain byte-identical to EPIC-119, across four
connectors and four Epics.

## What this Epic actually tested

EPIC-120's repository connector and EPIC-121/122's tracker connector are
adapters over `source.repository` and `source.project` — contracts that already
existed. Both proved the universal boundary *convenient*. Neither proved it
**necessary**, because in each case a narrower contract would have served.

A wiki page is neither a checkout nor an issue, and there is no third contract
to adapt. `ConfluenceProvider` therefore declares `Capability.SOURCE_CONNECTOR`
and implements `identify` / `acquire` / `normalize` itself. EPIC-119 predicted
its first declarer would be EPIC-120's; it was not, because a repository already
had a contract worth adapting. This is where the claim is exercised rather than
asserted:

```
capability   source.connector, version 1
operations   identify, acquire, normalize
systems      confluence
registry     forCapability(SOURCE_CONNECTOR) → ferret.source.confluence
```

## Defect found: two contracts, one field name

`Provider.contractVersion` is the provider platform's version (EPIC-010).
`SourceConnector.contractVersion` is the connector contract's (EPIC-119). A
class implementing both has **one field for two facts**.

Both are `1` today, so the first draft — `class ConfluenceProvider extends
BaseProvider implements SourceConnector` — compiled, and would have passed every
test in the repository. It is wrong the moment either version moves, and the
failure then is a provider reporting the wrong platform version to the registry:
silent, and years from the change that caused it.

Fixed by exposing the connector as a value rather than making the provider one.
One property, two versions kept apart. Pinned by an assertion that says so
directly:

```
isSourceConnector(provider.connector)  true
isSourceConnector(provider)            false
```

This could only have been found by the first provider to declare the capability.
It is recorded on the property and in the spec so the second one does not
rediscover it.

## Real source consulted

No Confluence provider existed before this Epic, so every wire shape was checked
against a **live Confluence Cloud instance** (read-only) before the fixtures
were written. Structure only — no page content was carried into the repository,
the tests or this record:

```
API base        /wiki/api/v2
paging          _links.next, a *relative URL* carrying `cursor=` and `body-format=`
instants        2024-02-27T09:58:28.972Z — Zulu, so EPIC-122's Jira defect
                cannot recur here
version         { number, message, minorEdit, authorId, createdAt }  — first-class
hierarchy       parentId + parentType: 'page'  — a direct pointer, no extra request
space           { id, key, name, type, status, homepageId, createdAt }
body            large pages can be truncated by the server, and say so
```

Two of those changed the design. Paging by relative URL is why the cursor is
parsed out of a query string rather than sliced; a first-class `version` and a
direct `parentId` are why versions and hierarchy cost no extra requests.

**A credentialled end-to-end run was not made.** Ferret's provider takes an API
token, and this environment holds an OAuth session for a separate MCP client
rather than a token to hand it. What was verified against the live instance is
recorded above; what a credentialled run would add is a count, and inventing one
would be worse than saying so.

## Acquisition → normalization → storage → retrieval

Through `SourceIngestor` into **real PostgreSQL** and back out through the
**real `RetrievalStore`**:

```
findEntities({kind: 'document', scope: sourceId})              → 3
neighbours(Architecture, DOCUMENT_CONTAINS_DOCUMENT, OUT)      → Indexing, Retrieval
neighbours(Indexing,     DOCUMENT_LINKS_DOCUMENT,    IN)       → Retrieval
SELECT DISTINCT producer, producer_version                     → ferret.source.confluence, 0.1.0
```

The two traversals are the point: *what is under this page* and *what links to
it* are different questions, and they return different answers.

## Identity, scope and provenance

```
identify('DEV')  → { system: 'confluence', instance: 'acme.atlassian.net', resource: 'DEV' }
sourceIdentityKey → confluence::acme.atlassian.net::dev

requests made by identify()   0   — pure and total, so unreachable and unknown stay apart
instance from a URL carrying `ada:sekret@`   → 'acme.atlassian.net', credential absent
every page                    source.scope = the source entity
every evidence row            producer = ferret.source.confluence
                              producerVersion = 0.1.0 · sourceSystem = confluence
```

## Hierarchy, links and versions

| Behaviour | Result |
| --- | --- |
| Child under parent | `DOCUMENT_CONTAINS_DOCUMENT`, 2 edges for 2 children |
| Containment vs reference | `Retrieval` links to `Indexing` and contains nothing |
| Link by URL | resolved by page id |
| Link by storage macro | resolved by title, `metadata.by = 'title'` |
| Title naming an unread page | **no edge, no entity** — a title is unique only within a space |
| Parent this pass did not read | stubbed by id, carrying no invented title |
| Version 17 → 18 | **one** document, updated in place, body replaced |
| Reference extraction | both kinds found, neither twice, entities decoded |

## Paging, idempotence and failure

```
three pages of results        3 acquire calls, cursor followed, truncated false
space id resolved             once, then carried in the cursor
second pass                   entities created 0 · evidence recorded 0 · counts unchanged
two runs, two stores          entity ids identical
page with no id               skipped and counted; the other page still stored
unknown space key             E_SOURCE_UNAVAILABLE, naming the key
401                           E_SOURCE_UNAUTHORIZED — not reported as absence
failing space beside a good one   isolated; cursor not advanced; the good one intact
unreadable cursor             starts over rather than failing the source
```

## Gates that caught things

**The conformance gate refused the provider before it had one.**
`provider-conformance-harness.test.ts` fails when a module declaring
`ProviderKind` is neither run against the conformance suite nor declared as
covered elsewhere. It named `confluence/provider.ts` on the first run. Answered
by running it, not by declaring an exemption — the gate now reports ten provider
implementations and exercises nine.

**The boundary suite gained the assertions a new provider needs.** Confluence
reaches neither storage, the CLI, nor another provider; Jira does not reach
Confluence; the core reaches neither `confluence/` nor `atlassian/`. The pointed
one is that sharing a *transport* must not become one provider importing the
other — if that assertion fails, `src/atlassian` has stopped being a shared
layer and become a back door.

## The transport was moved, not copied

`src/atlassian/client.ts` is `src/jira/client.ts`, lifted. `JiraClient` is a
binding of it with `product: 'Jira'`. EPIC-071's suite exercises that name and
was not rewritten, so **149 passing tests are the proof the lift was faithful**.

One of them had to change, and it is worth recording why. `has no method that
writes` inspected the instance's own prototype; with a base class, `get` lives
one level up. The assertion now walks the whole chain — which is what the
guarantee always meant, and which additionally catches a write method added to
the shared base. The control got stronger, not weaker.

## Tests

| Suite | Result |
| --- | --- |
| `tests/integration/connectors/confluence-connector.test.ts` | **28 passed** (26 against the provider, 2 against real PostgreSQL) |
| `tests/integration/connectors` (all four connectors) | **101 passed** |
| `tests/unit` + connectors + providers + distribution | **2401 passed, 101 files** |
| `tests/unit/boundaries.test.ts` | 125 passed, including the new block |
| `tests/unit/provider-conformance-harness.test.ts` | 7 passed, Confluence included |
| `tests/security` + packaging | 187 passed |
| `npm run lint` / `typecheck` / `build` | clean |

EPIC-119's 35, EPIC-120's 24, EPIC-121's 26 and EPIC-122's 26 stay green.

## Stated rather than claimed

- **Not a Confluence replacement and not a UI.** Nothing creates, edits, moves,
  publishes or comments; `get` is the only verb the transport has.
- **No entity kind added.** Two relationship types, each with its reason and its
  rejected alternative recorded on the type itself.
- **No credentialled live run.** Shapes were verified; a run count was not, and
  is not claimed.
- **No blog posts, attachments, page comments, permissions mirror, CQL surface,
  webhooks or scheduling.**

## Post-merge verification

Re-verified on merged `main` at `5b7c6fd`: the four connector suites, the
EPIC-119 contract suite, the boundary suite and the conformance harness —
**271 passed**. Build clean. Working tree clean.

## Not applicable

Page comments are a separate collection and would be the fifth thing this
connector reads; they were not asked for and are not stubbed. Attachments are
content indexing (EPIC-108), which remains `RepositoryIndexer`'s decision for
the same reason it was in EPIC-120: reading and parsing every file is a
materially different cost from listing them.
