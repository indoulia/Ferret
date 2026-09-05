# EPIC-121 — GitHub Connector

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

A GitHub project reaches Ferret through the EPIC-119 boundary as the thing it
actually is — issues, pull requests, reviews and **the discussion on them** —
with the relationships between them intact and every record attributable.

## Problem

EPIC-119 put the shipped GitHub provider on the universal boundary and read
*issues* from it. It said why it stopped there: widening "would mean paging
three collections against one cursor, which is `ProjectSynchronizer`'s job".
EPIC-120 then paged five collections of a repository behind one staged cursor
and the ingestor did not change to receive it, so the reason expired.

Underneath that was a gap nobody had noticed. **`listComments` has been
implemented by every project provider Ferret ships since EPIC-021, and nothing
has ever called it.** `ProjectSynchronizer` stages issues, pull requests and
reviews and stops; `modelProject` had no parameter for a comment; there is no
`comment` anywhere in the canonical model. The capability was declared, the
transport was written, the tests passed, and not one comment had ever reached
the graph.

That is the whole point of the Epic. A comment is where the reasoning behind a
change lives — the objection that moved a design, the "we tried that and here is
why it failed" that no commit message carries. A context layer that indexes the
issue and drops the discussion has kept the agenda and thrown away the meeting.

## Design

**One staged cursor, four collections.**

```
issues → pull requests → reviews → comments
```

Parents before children, and not as a preference: a review names the pull
request it reviews and a comment names the item it is on, and `modelProject`
skips-and-counts either whose parent is absent from the batch. Reading parents
first is what stops that happening on a first pass.

**Fan-out is bounded separately from page size.** Reviews and comments are
addressed *per parent* — one request each — so a tracker with four hundred pull
requests would spend four hundred pages of the ingestor's twenty-page budget and
never reach its comments. `fanOut` batches parents per page. It bounds requests
per page, never the total: every child still arrives.

**A comment is a `document`, and no kind was added.** `document` already models
text with a title, a body, a location and two instants, and
`DOCUMENT_DESCRIBES_ENTITY` is already the edge from a document to the thing it
is about. Adding a `comment` kind would have made every existing query that asks
for the documents about an issue miss the discussion on it — the same reason
EPIC-119 scoped its sources to `repository` rather than minting a `source` kind.
The body goes in `description`, which `attributes.ts` defines as "free-text
description or body, as the source provides it", and it is **redacted first**: a
tracker comment is the likeliest place in any source for somebody to paste a
failing request with a live token in it.

**There is no author edge, deliberately.** `document` has no authorship
relationship in EPIC-007's set, and inventing one would be this Epic deciding a
canonical-model question on behalf of one connector. The author is modelled as
an actor — so the person exists, is classified human or bot by EPIC-036, and
joins to their commits — and the comment records who wrote it as evidence.

**A child names its parent by the parent's id, not by its address.** The
connector re-parents what it acquires. See the defects below: this is the fix
for a failure that no fixture could have shown.

## Scope

Included: issues, pull requests, reviews, comments, the commits a pull request
proposes, the issues a body closes, source identity, provenance, staged paging,
fan-out bounding, idempotence, update handling and failure isolation.

Explicitly not included: Ferret does not automate GitHub and does not replace
it. Nothing opens, comments on, labels, merges or closes anything. No webhooks,
no scheduling, no realtime ingestion, no Actions, no GraphQL migration.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `projectSourceConnector` | `src/connectors/project-connector.ts` | The adapter, widened to four collections |
| `PROJECT_*_RECORD` | same | The four record kinds acquired |
| `ProjectConnectorOptions.fanOut` | same | Parents asked about per page |
| `ProjectModelInput.comments` | `src/project/model.ts` | Comments, in the canonical model |
| `addComment` | same | A comment as a `document` about its parent |

## Acceptance criteria

1. Issues, pull requests, reviews and comments are ingested through the
   EPIC-119 contract. — 26 targeted cases against the real provider.
2. Comments reach the graph at all, for the first time. — 25 real comments from
   the live API, attached to their parents.
3. Source identity distinguishes two deployments of GitHub.
4. Provenance is on every record.
5. Relationships resolve: review→PR, developer→PR, PR→issue, PR→commit,
   comment→parent.
6. Repeated ingestion is idempotent and deterministic.
7. Updates and deletions are handled — an edited comment updates in place, a
   deleted one is remembered.
8. A failing project is isolated; an undeclared operation is never called.
9. Agent-facing retrieval returns the discussion. — real PostgreSQL, real
   `RetrievalStore`.
10. Ferret is dogfooded against the live GitHub API during implementation.

## Test requirements

`tests/integration/connectors/github-connector.test.ts` — staged acquisition and
ordering, each collection onto the kind the model already had, comments as
documents, secret redaction, parent linking where the id is not the address,
review and resolution edges, commit identity, source identity, scoping,
provenance, idempotence, determinism, edited and deleted comments, incremental
`since`, fan-out bounding, undeclared operations, failure isolation, unreadable
cursors, `304 Not Modified`, and the end-to-end path into PostgreSQL and back
out through retrieval.

## Definition of Done

Targeted suite green, the suites it touches green, security suite green, lint
and typecheck clean, dogfood evidence against the live GitHub API, evidence
recorded in `validation/EPIC-121-VALIDATION.md`, and the registry and roadmap
updated.

## Governance alignment

§4 — the connector depends on `ProjectSource`, not on `GithubProvider`. §6 —
`304 Not Modified` stays distinct from an empty page, a failed project is
reported as failed rather than as empty, and a deleted comment is not erased.
§9 — no entity kind and no relationship type was added; comments map onto the
model as it stands. §21 — producer and producer version reach every emitted
record.
