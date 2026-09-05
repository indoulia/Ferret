# EPIC-122 — Jira Connector

**Status:** IMPLEMENTED
**Priority:** P1
**Domain:** Source Integration & Synchronization
**Classification:** FOUNDATION

## Outcome

A Jira project reaches Ferret through the EPIC-119 boundary — its issues, their
status, their comments and the typed links between them — and, for the first
time, it reaches it at all.

## Problem

EPIC-121 widened the tracker connector to four collections and proved it against
GitHub. Jira is the same contract and a different tracker in every way that
matters: it **keys** its issues where GitHub numbers them, identifies them by a
numeric id that survives a move between projects, declares two of the four
operations and nothing else, and has typed links between issues that GitHub has
no concept of.

Underneath that, three things had been declared and never joined — the same
family of gap EPIC-121 found in `listComments`:

- **`ProjectRecord.key`** was added by EPIC-071 with the reason on the field:
  "a contract with only `number` would have made every Jira issue arrive without
  the identifier its users actually say out loud". `modelProject` then read only
  `number`, so that is precisely what happened.
- **`issueAttributes.issueType` and `.priority`** have existed since EPIC-006,
  and the Jira provider has *requested* both fields on every search since
  EPIC-071 and dropped them for want of a contract field to carry them.
- **Jira's instants.** Jira reports `2026-09-01T00:00:00.000-0500` — a numeric
  offset with no colon. `instant` is `z.iso.datetime({ offset: true })`, which
  rejects it. So `createEntity` refused every Jira issue and `modelProject` did
  the correct thing with a record it cannot model: skipped it and counted it.
  **A whole board arrived as a skip count.** Jira ingestion had never worked end
  to end, through `ferret sync` or anything else.

That last one survived EPIC-071 because its suite asserts what the *provider*
returns — a `ProjectIssue` carrying the string — and never carried that output
across the seam into the model that rejects it. The fixture had the real Jira
spelling from day one; nothing ever handed it to the thing that refuses it.

## Design

**No new connector.** `projectSourceConnector` is the GitHub connector, the Jira
connector and the connector for the next tracker. What changed is that it now
addresses a parent the way *its* tracker addresses one.

**A parent is addressed by number, then key, then id.** Both fields are on
`ProjectRecord` for exactly this. The id is the wrong answer for Jira and the
old fallback made it the only answer: `toIssue` identifies by numeric id while
`listComments` demands an issue **key** and throws `E_USAGE` on anything else, so
a connector reaching for comments handed `10042` to a method wanting `FER-12`
and failed the whole source.

**A stage the provider cannot serve costs nothing.** Jira declares issues and
comments; stepping over `pulls` and `reviews` used to spend two of the
ingestor's twenty pages arriving at collections it would never run. Now the
cursor skips to the next servable stage within one call. A Jira pass is two
pages, not four.

**Issue links are one generic edge carrying the vendor's own word.**
`ISSUE_LINKS_ISSUE`, with `metadata.linkType`. This is the one canonical-model
addition in the Epic and the evidence for it is empirical: a live Jira instance
was sampled — 50 issues, 144 links — and used **fourteen** distinct link types,
most configured for that instance (`Design Spec`, `Polaris work item link`,
`Implement`, `Explored`, `Satisfies`, `Problem/Incident`, `Defect`) alongside
the familiar `Blocks`, `Duplicate` and `Related`. Any fixed enumeration would
have dropped three quarters of them. The alternative considered and rejected was
recording links as evidence, which keeps the model frozen at the price of making
them unwalkable — and a link that cannot be traversed is not a relationship,
which is what this Epic was asked for.

**Direction is normalised to the vendor's outward reading.** Jira reports the
same link on both issues — outward on one, inward on the other — so modelling
each as stated would give two edges facing each other for one fact. Flipping the
inward ones means both readings derive the same edge, which is what makes the
pass idempotent whichever issues are in the batch.

**Instants are normalised in the provider, not loosened in the model.** A
provider's job is to map its vendor's representation onto the contract. Widening
`instant` would let every other source emit an offset Ferret cannot compare. An
unparseable value yields nothing, following the rule EPIC-020 settled for Git's
dates: absent is honest, a wrong instant is not.

## Scope

Included: issues, comments, status, issue type, priority, typed links,
provenance, identity across tenants, staged paging without wasted pages,
idempotence, update handling and failure isolation.

Explicitly not included: Ferret does not become a Jira replacement. Nothing
creates, transitions, assigns or comments on anything. No JQL surface for users,
no boards, no sprints, no workflows, no changelog history — the provider does not
request `expand=changelog` and this Epic does not add it.

## Contracts

| Symbol | File | What it is |
| --- | --- | --- |
| `ProjectIssueLink` | `src/providers/contracts/source-project.ts` | One typed link, as the tracker states it |
| `ProjectIssue.links` | same | Links on an issue. Optional; GitHub reports none |
| `ProjectRecord.issueType`, `.priority` | same | The tracker's own words, at last carried |
| `RelationshipType.ISSUE_LINKS_ISSUE` | `src/domain/relationship.ts` | The generic link edge |
| `addIssueLinks` | `src/project/model.ts` | Links, direction-normalised |
| `toInstant`, `toLinks` | `src/jira/provider.ts` | Jira's spellings, mapped onto the contract |
| `addressOf`, `skipUnsupported` | `src/connectors/project-connector.ts` | Addressing, and stages that cost nothing |

## Acceptance criteria

1. A Jira project is ingested through the EPIC-119 contract. — 26 targeted cases
   against the shipped provider.
2. Issues reach the graph at all, for the first time. — the instant fix.
3. An issue carries the key its users say out loud, its type and its priority.
4. Status keeps the tracker's own word beside the comparable reading.
5. Typed links are walkable, direction-normalised, and survive a type Ferret has
   never heard of.
6. Comments attach to a parent identified by id and addressed by key.
7. Two tenants sharing a project key stay two sources.
8. Repeated ingestion is idempotent and deterministic; an edited comment updates
   in place.
9. A failing project is isolated; an undeclared operation is never called.
10. Agent-facing retrieval answers "what blocks this, and what was said on it".
11. Ferret's assumptions are checked against a live Jira instance.

## Test requirements

`tests/integration/connectors/jira-connector.test.ts` — ingestion, key
addressing, comment parenting, status, type and priority, the real instant
format in both signs and `Z`, an unreadable instant, typed links, direction
normalisation, a link to an unread issue, link evidence, malformed links, an
unfamiliar link type, page economy under a limit that would have truncated,
undeclared operations, tenant identity, provenance, scoping, idempotence,
determinism, edited comments, failure isolation, secret redaction, and the
end-to-end path into PostgreSQL and back out through retrieval.

## Definition of Done

Targeted suite green, the suites it touches green, security suite green, lint
and typecheck clean, assumptions verified against a live Jira instance, evidence
recorded in `validation/EPIC-122-VALIDATION.md`, and the registry and roadmap
updated.

## Governance alignment

§4 — the connector depends on `ProjectSource`, not on `JiraProvider`. §6 — the
vendor's own status survives beside Ferret's reading, an unreadable instant is
absent rather than invented, and a failing project is reported as failed. §9 —
one relationship type was added and no entity kind; the reason and the rejected
alternative are recorded on the type itself. §21 — producer and producer version
reach every emitted record.
