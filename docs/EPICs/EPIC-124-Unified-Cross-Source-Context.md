# EPIC-124 — Unified Cross-Source Context

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

An agent asking about a Jira issue reaches the pull request that closed it, the
commit that pull request proposed, the files that commit touched, and the wiki
page all of them cite — as one graph, from four sources, through one retrieval
surface.

## Problem

After EPIC-120 to EPIC-123, Ferret held four correct graphs and no connection
between them. Three of the four hops in the question already resolved:

```
Jira issue → GitHub pull request → commit → repository files
             └ PULL_REQUEST_PROPOSES_COMMIT ┘ └ COMMIT_MODIFIES_FILE ┘
```

The **cross-source** hops did not, and could not — not through inattention, but
because of where a connector sits. `normalize` is pure by contract: it is handed
records and an emitter and cannot ask the database anything. A pull request body
saying `Fixes FER-12` knows a *key*; the Jira issue is identified by a numeric
id under a Jira scope. Nothing in the connector had both halves, and nothing
should: a connector that queried would be doing retrieval during ingestion.

Underneath that, the machinery for the join had been **built twice and joined
neither time**:

- `proposeResolutions` (EPIC-051) has a `QUOTED_KEY` rule — "an issue key quoted
  in the other system's record", scored `PROBABLE`. Exported from core,
  unit-tested, **never called**.
- `externalIds` has been on every entity since EPIC-006, is persisted in its own
  table, is queryable through `EntityQuery.externalId`, and is surfaced over
  MCP. **No provider had ever populated one.**

And the text the join needs was being thrown away. `ProjectRecord.body` is
fetched by both providers, and `modelProject` dropped it — *while reading it*,
to find closing references. Ferret knew what a pull request said for exactly
long enough to pull one edge out of it, and then forgot the sentence.

## Design

**The join happens after ingestion, where a store can be read.**
`linkCrossSourceReferences` reads the entities in the scopes it is given, finds
the identifiers their text quotes, resolves each against `externalIds`, and
asserts an edge. That is what `proposeResolutions` was shaped for and never had.

**No relationship type was added.** Every cross-source hop is an edge the model
already had a word for:

| From | To | Edge |
| --- | --- | --- |
| pull request whose body *closes* it | issue | `PULL_REQUEST_RESOLVES_ISSUE` |
| document — a page, a comment | anything it names | `DOCUMENT_DESCRIBES_ENTITY` |
| issue | issue | `ISSUE_LINKS_ISSUE` |

A pull request that merely *mentions* an issue yields no edge: there is no
`pull_request_mentions_issue`, and saying nothing beats saying the wrong thing
about whether work is done.

**A tracker key is only a key if Ferret holds that project.** `UTF-8`, `HTTP-2`
and `RFC-7540` all have the shape of `FER-12`, and no pattern separates them —
because nothing about the text does. What separates them is whether anybody has
a project called `UTF`. So the pass learns which projects it holds *first*, from
the `key` attribute of the issues it read, and filters on that. This turns an
unanswerable question about English into a lookup, and keeps `unresolved`
meaning "a source has not been ingested yet" rather than "this body mentions a
character encoding".

**Nothing is invented and nothing is merged.** A reference that names nothing
Ferret holds is counted, not turned into a placeholder: a key quoted in a body
is somebody's assertion that a thing exists, and minting an entity from it would
let a typo create an issue. Whether two records are the same *thing* remains
`IdentityStore.merge`'s question; this answers the far narrower one of whether a
record *mentions* another, which a quoted identifier settles.

**Scopes are a parameter, not a sweep.** A pass over the whole store would grow
with the database and would cross an authorization boundary the caller never
named. The scopes a caller passes are the ones it already had the right to read,
and every read goes through `RetrievalPort` with the caller's `AccessContext`.

**Bodies are stored, at last.** Issues and pull requests now carry their text,
redacted like every other field. This is a defect fix in its own right — a
context layer that held an issue's title and not its body had indexed the agenda
and thrown away the meeting — and it is what the pass scans.

## Scope

Included: cross-source identity through `externalIds`, reference extraction,
explicit relationships, unified retrieval across four sources, provenance on
every link, duplicate suppression, deterministic and idempotent behaviour, and
preserved authorization boundaries.

Explicitly not included: no LLM reasoning, no engineering-answer generation, no
autonomous action, no workflow orchestration, no realtime ingestion, no
webhooks, no scheduling, no federation. The pass matches identifiers and stops.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `linkCrossSourceReferences` | `src/context/cross-source.ts` | The pass |
| `findCrossSourceReferences` | same | What one source says about another |
| `CrossSourceReferenceKind` | same | Key, project number, or either Atlassian URL |
| `CrossSourceReport`, `ResolvedLink` | same | What it did, reviewably |
| `externalIdsFor` | `src/project/model.ts` | How another system would quote a record |

## Acceptance criteria

1. A Jira issue reaches its pull request, that pull request's commit, and that
   commit's files — one traversal, four sources.
2. A Confluence page reaches the issue and the pull request it cites.
3. `externalIds` are populated, and a cross-source lookup finds by them.
4. Issue and pull-request bodies are stored.
5. No relationship type is added.
6. Every link carries what was quoted and how it was recognised.
7. Repeated passes are idempotent; two passes over one graph are identical.
8. A duplicate reference produces one edge.
9. A reference to an un-ingested source is counted, never invented.
10. Only the scopes the caller named are examined.
11. Ordinary text is not mistaken for a tracker key.

## Test requirements

`tests/integration/connectors/cross-source.test.ts` — four real providers, four
real connectors, a real Git repository, real PostgreSQL and the real
`RetrievalStore`: external ids, stored bodies, the full four-source walk, the
page's outbound links, the no-new-edge-type assertion, provenance, idempotence,
determinism, duplicate suppression, unresolved references, scope confinement,
and the extractor on its own including the false-positive case.

## Definition of Done

Targeted suite green, the suites it touches green, security suite green, lint
and typecheck clean, evidence recorded in `validation/EPIC-124-VALIDATION.md`,
and the registry and roadmap updated.

## Governance alignment

§4 — the pass depends on `RetrievalPort` and `RelationshipWriter`, not on a
store. §6 — a reference that resolves to nothing is reported as unresolved
rather than invented, and a mention is not recorded as a resolution. §9 — no
entity kind and no relationship type added. §21 — every link carries the
producer that asserted it and the text it was derived from.
