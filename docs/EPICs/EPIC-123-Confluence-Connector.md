# EPIC-123 — Confluence Connector

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

A Confluence space reaches Ferret through the EPIC-119 boundary — its pages,
their hierarchy, the links between them and their versions — as the **first
provider to declare `source.connector`**.

## Problem

EPIC-119 wrote the connector contract for "a source that is neither a Git
checkout nor a tracker", and then had nothing to point at. EPIC-120's repository
connector and EPIC-121/122's tracker connector are both *adapters* over
contracts that already existed: `source.repository` and `source.project`. Each
proved the boundary was convenient. Neither proved it was **necessary**, because
in both cases there was an older, narrower contract that would have done.

A wiki page is not a branch and is not an issue. There is no third contract to
adapt. So this is the first source that can only be reached through the
universal boundary, and therefore the first real test of EPIC-119's claim rather
than a restatement of it.

There was also nothing to build on. Unlike the last three Epics, **no Confluence
provider existed** — no transport, no auth, no mapping. What did exist was the
Jira provider's HTTP client, which is Atlassian's: same host, same credential,
same `Retry-After`, same 401/403 semantics. A second copy of that would have
been two places to fix a backoff.

## Design

**A space is the source; a page is a `document`.** No entity kind was added.
`document` already models text with a title, a body, a location and two
instants, which is what a page is — and EPIC-119's own reasoning applies: a new
kind would make every existing query for the documents in a scope miss the wiki.

**The provider implements the three verbs itself.**

```
identify → acquire → normalize
```

`identify` is pure and takes the **space key**, because that is what a person
types and what a URL carries, and the contract requires identity to resolve
without a request. The numeric id the API pages by is resolved in `acquire` —
once — and carried in the cursor, so the second page does not ask again.

**The provider is deliberately not itself a `SourceConnector`.** Both `Provider`
and `SourceConnector` declare a `contractVersion`, and they mean different
things: the provider platform's version (EPIC-010) and the connector contract's
(EPIC-119). A class implementing both has one field for two facts. They are both
`1` today, so a conflating class compiles, passes and is wrong the moment either
moves. The provider exposes a `connector` value instead — one property, two
versions kept apart. This is recorded as a finding rather than a preference:
it could only have been discovered by the first provider to declare the
capability, and the next one should not rediscover it.

**The transport moved rather than being copied.** `src/atlassian/client.ts` is
`src/jira/client.ts`, lifted. `JiraClient` is now a binding of it with
`product: 'Jira'`, and EPIC-071's own tests — which exercise that name and were
not rewritten — are what prove the lift was faithful. Providers stay isolated
from each other: Confluence does not import `src/jira`, Jira does not import
`src/confluence`, and `boundaries.test.ts` asserts both.

**Hierarchy and links are two edges, not one edge with a flag.**
`DOCUMENT_CONTAINS_DOCUMENT` and `DOCUMENT_LINKS_DOCUMENT`. EPIC-007 already
refused to conflate containment with a transient hold, for the branch and the
worktree, on exactly this reasoning: "what is under this page" and "what
mentions this page" are different questions with different answers, and one edge
with a discriminator makes the difference unqueryable at the point it matters.

**Links come out of the body, because the API does not report them.** Confluence
v2 has no outbound-link collection, so `findPageReferences` scans the body — a
bounded scan, a fixed set of patterns, deduplicated, no HTML parser. It is
deliberately the same shape as `src/project/references.ts`, which has turned
`Fixes #12` into an edge since EPIC-072. A reference by **id** may be stubbed; a
reference by **title** is resolved only against pages read in this pass and
never stubbed, because a title is unique within a space and not beyond it, so
minting an entity from one would invent an identity the source never issued.

**Versions need no new kind.** A page carries its version number, and a new
version updates the same document in place: identity is the page id, which
survives an edit and a rename. `documentAttributes` has no version field, so the
number goes in `unknownFields`, which is what EPIC-006 provides for a field
Ferret does not model.

## Scope

Included: pages, hierarchy, links, versions, metadata, provenance, cursor
paging, space identity, idempotence, malformed-record isolation, failure
isolation and retrieval of the result.

Explicitly not included: Ferret does not become a Confluence UI or a
Confluence replacement. Nothing creates, edits, moves, publishes or comments —
`get` is the only HTTP verb the transport has. No blog posts, no attachments, no
comments-on-pages, no space permissions mirror, no CQL surface for users, no
webhooks, no scheduling.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `ConfluenceProvider` | `src/confluence/provider.ts` | The provider, declaring `source.connector` |
| `ConfluenceProvider.connector` | same | Its three verbs, as a `SourceConnector` |
| `CONFLUENCE_PAGE_RECORD` | same | The record kind acquired |
| `findPageReferences` | `src/confluence/references.ts` | Links, out of a body, bounded |
| `PageReference`, `PageReferenceKind` | same | By id, or by title |
| `AtlassianClient` | `src/atlassian/client.ts` | The transport, shared with Jira |
| `DOCUMENT_CONTAINS_DOCUMENT` | `src/domain/relationship.ts` | Hierarchy |
| `DOCUMENT_LINKS_DOCUMENT` | same | Reference |

## Acceptance criteria

1. A Confluence space is ingested through the EPIC-119 contract by a provider
   that declares it. — 28 targeted cases.
2. Pages become documents scoped to their space; two spaces sharing a title stay
   two pages.
3. Hierarchy is walkable, and distinct from reference.
4. Links are resolved from bodies, by id and by title, without inventing pages.
5. A version change updates one document rather than creating a second.
6. Identity resolves without a request, and never carries a credential.
7. Provenance is on every record.
8. Repeated ingestion is idempotent and deterministic.
9. A malformed page is skipped and counted; a failing space is isolated; an
   unauthorized one says so.
10. Agent-facing retrieval answers "what is under this page" and "what links to
    it".
11. Ferret's assumptions are checked against a live Confluence instance.

## Test requirements

`tests/integration/connectors/confluence-connector.test.ts` — capability
declaration, registry selection, the connector/provider separation, read-only
surface, ingestion and scoping, identity without I/O, credential-free instance,
provenance, cross-space separation, secret redaction, hierarchy, containment
versus reference, storage-format links, unresolvable titles, stubbed parents,
version changes, reference extraction, cursor paging, single space resolution,
idempotence, determinism, malformed pages, unknown spaces, failure isolation,
unauthorized responses, unreadable cursors, and the end-to-end path into
PostgreSQL and back out through retrieval.

## Definition of Done

Targeted suite green, the suites it touches green, conformance and boundary
gates green, security suite green, lint and typecheck clean, assumptions
verified against a live Confluence instance, evidence recorded in
`validation/EPIC-123-VALIDATION.md`, and the registry and roadmap updated.

## Governance alignment

§4 — the provider sits behind a versioned capability and the core cannot see it.
§6 — a page that cannot be identified is skipped and counted rather than
dropped, an unknown space is named as unknown, and a credential problem is
reported as unauthorized rather than as absence. §9 — no entity kind added; two
relationship types added, each with its reason and its rejected alternative
recorded on the type. §21 — producer and producer version reach every record.
