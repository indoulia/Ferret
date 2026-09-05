# EPIC-122 — Jira Connector: validation evidence

**Status: VALIDATED** · four defects found, one of them a shipped failure that
had made Jira ingestion impossible end to end since EPIC-071. All four fixed
here. One relationship type added; no entity kind, no schema change, no
migration.

## Environment

| | |
| --- | --- |
| Tree | `baae460` (`main`) + this Epic, merged as `7db2ba9` |
| Host | Windows 11, Node v22.23.2, vitest 4.1.11 |
| Database | PostgreSQL 17 + pgvector, container started by `tests/support/postgres.ts` |
| Live source consulted | `nymi-inc.atlassian.net`, read-only, for field shapes only |
| Date | 2026-09-05 |

## Implementation

| | |
| --- | --- |
| Connector | `src/connectors/project-connector.ts` — `addressOf`, `skipUnsupported`, `nextStageCursor` |
| Contract | `src/providers/contracts/source-project.ts` — `ProjectIssueLink`, `ProjectIssue.links`, `issueType`, `priority` |
| Model | `src/project/model.ts` — `addIssueLinks`, key/type/priority on an issue |
| Domain | `src/domain/relationship.ts` — `ISSUE_LINKS_ISSUE` |
| Provider | `src/jira/provider.ts` — `toInstant`, `instantField`, `toLinks`, `issuelinks` requested |
| Ingestion path | unchanged — `SourceIngestor`, `writeContribution` |

**Nothing was added to the ingestion path.** `src/connectors/ingest.ts` and
`src/connectors/write.ts` remain byte-identical to EPIC-119. **No new
connector**: `projectSourceConnector` serves GitHub and Jira alike.

## Real source exercised

The provider is the one Ferret ships. `createJiraProvider` is constructed with
only `fetch` supplied, so JQL construction, `startAt` paging and the REST mapping
onto `ProjectSource` are production code.

Ferret's *assumptions* were then checked against a **live Jira Cloud instance**
(`nymi-inc.atlassian.net`, read-only, 50 issues sampled). Only field shapes were
extracted — no ticket content was read into the record:

```
date shape          NNNN-NN-NNTNN:NN:NN.NNN-NNNN     (50/50, negative offset)
link entry keys     id, self, type, outwardIssue | inwardIssue   (exactly one)
link type keys      id, self, name, inward, outward
linked issue keys   id, key, self, fields
directions          outward 65 · inward 79
distinct link types 14
```

That sample is the evidence for two decisions and the proof of one defect.

## The instant defect, and why nothing had caught it

```
instant   = z.iso.datetime({ offset: true })     → requires +00:00
Jira      = 2026-09-01T00:00:00.000-0500         → no colon
result    = createEntity rejects → modelProject skips and counts
outcome   = 100% of a Jira board arrives as a skip count
```

Reproduced directly: before the fix the targeted suite reported

```
skipped x2  issue: Entity is not valid — sourceObservedAt: Invalid ISO datetime
skipped x2  comment: comment names "10001", which is not in this batch
```

— the comments orphaned only because their parents had already been refused.

It survived EPIC-071 because that suite asserts the **provider's output** and
never carries it across the seam into the model. `tests/unit/jira-provider.test.ts`
has used the real spelling `2026-01-02T03:04:05.000+0000` since it was written;
nothing had ever handed that string to the thing that rejects it.

Fixed in the provider, which is what maps a vendor's representation onto the
contract. Loosening `instant` was rejected: it would let every other source emit
an offset Ferret cannot compare. An unparseable value now yields **nothing**,
following EPIC-020's rule for Git's dates.

## Defects found and fixed

**1 — Jira issues could not be modelled at all.** Above. The most severe of the
four: Jira ingestion had never worked end to end, through `ferret sync` or
anything else.

**2 — every Jira issue arrived without its key.** `modelProject` set the `key`
attribute from `issue.number` only. Jira has no number, so `FER-12` — the
identifier its users actually say out loud — never reached the graph.
`ProjectRecord.key` was added by EPIC-071 with that exact sentence on the field,
and the model then read only `number`.

**3 — issue type and priority were fetched and discarded.** The Jira provider has
named `issuetype` and `priority` in its `fields` parameter on every search since
EPIC-071 — paying for them in every response — and `toIssue` dropped both.
`issueAttributes` has declared `issueType` and `priority` since EPIC-006. Three
layers agreed the data mattered and no line carried it between them.

**4 — a tracker paid for stages it could never run.** Jira declares two of the
four operations, and stepping over `pulls` and `reviews` returned empty pages
that each cost one of the ingestor's twenty. Named in EPIC-121's record when it
was first measured on GitHub; fixed here, where it bites every pass. A Jira pass
is now **two pages, not four**, and the suite proves a `pageLimit: 2` run reaches
the comments and advances its cursor where it would previously have truncated
before acquiring one.

## Architecture decision: one generic link edge

`ISSUE_LINKS_ISSUE` is the only canonical-model addition in this Epic, and the
only relationship type in Ferret whose meaning lives in its metadata. That is a
deliberate exception, and the live sample is why:

```
Design Spec 35 · Related 25 · Polaris work item link 21 · Implement 18
Relate 12 · Cloners 11 · Blocks 5 · Depends 4 · Duplicate 3 · Explored 3
Problem/Incident 3 · Satisfies 2 · Documents 1 · Defect 1
```

Fourteen types on one instance, most of them configured for it. A fixed
enumeration would have carried `Blocks`, `Duplicate` and `Related` — 33 of 144
links — and dropped the rest. Recording links as evidence instead was
considered and rejected: it keeps the model frozen at the price of making links
unwalkable, and a link that cannot be traversed is not a relationship.

Direction is normalised to the vendor's outward reading, so the same link seen
from both ends is one edge rather than two facing each other. That is what makes
the pass idempotent whichever issues are in the batch, and it is asserted
directly.

## Identity, scope and provenance

```
identify('FER')  → { system: 'jira', instance: 'acme.atlassian.net', resource: 'FER' }
sourceIdentityKey → jira::acme.atlassian.net::fer

issue entity      source.id = 10001   (the numeric id, which survives a move)
                  attributes.key = FER-1
                  attributes.sourceState = "In Review"
                  attributes.state = "open"
                  attributes.issueType = Story · priority = Medium

every evidence    producer = ferret.source.jira · producerVersion = 0.1.0
                  sourceSystem = jira
every issue       source.scope = the source entity
```

Two tenants sharing a project key stay two sources — the reason `instance` is
required rather than defaulted.

`ProjectItemState` has three values by contract (`open`, `closed`, `merged`), so
Jira's `indeterminate` status category reads as `open`. Everything that
distinguishes it is preserved in `sourceState`, which is EPIC-021 §8.1's rule.
Widening the enum would ripple into GitHub and every consumer and was not in
scope.

## Comments

Addressed by key, parented by id — the two are not the same value and that is
the whole point:

```
requested   /rest/api/3/issue/FER-1/comment      ✔
never       /rest/api/3/issue/10001/comment      ✔
attached    1 comment → the issue whose source.id is 10001
```

EPIC-121's connector-side re-parenting covers Jira without the Jira provider
changing a line — the same mismatch, a different vendor, one fix. That is the
seam paying for itself.

## Idempotence, updates and isolation

```
second pass over the same project
  entities created 0 · evidence recorded 0 · entities/edges/evidence unchanged
two independent runs, two stores
  entity ids identical
edited comment
  same entity, new body — identity is the comment's id, not its content
failing project
  reported and stepped over; cursor not advanced; the healthy project intact
undeclared operation
  /comment never requested; issues still produce a usable graph
pasted credential
  redacted before it reaches an attribute
```

## Retrieval

Real PostgreSQL, real `RetrievalStore`, the two questions an agent actually asks:

```
findEntities({kind: 'issue', scope: sourceId})           → 2
neighbours(FER-2, ISSUE_LINKS_ISSUE, IN)                 → FER-1   ("what blocks this")
neighbours(FER-2, DOCUMENT_DESCRIBES_ENTITY, IN)         → "Blocked until FER-1 lands."
SELECT DISTINCT producer, producer_version               → ferret.source.jira, 0.1.0
```

## Tests

| Suite | Result |
| --- | --- |
| `tests/integration/connectors/jira-connector.test.ts` | **26 passed** (24 shipped provider, 2 real PostgreSQL) |
| `tests/integration/connectors` (all three connectors) | **73 passed** |
| `tests/unit` + connectors + providers | **2354 passed, 99 files** |
| indexing + retrieval + mcp + security + storage | **936 passed, 62 files** |
| `tests/integration/packaging.test.ts` | 34 passed — the ceiling did not move |
| `npm run lint` / `typecheck` | clean |

EPIC-119's 35, EPIC-120's 24 and EPIC-121's 26 stay green unchanged.

## Stated rather than claimed

- **Not a Jira replacement.** Nothing creates, transitions, assigns or comments.
- **No entity kind added.** One relationship type, with its reason and its
  rejected alternative recorded on the type itself.
- **No changelog history.** The provider does not request `expand=changelog` and
  this Epic did not add it — status *history* is a collection nobody has asked
  for yet, and adding it would be scope this Epic was not given.
- **No reasoning, no autonomous action, no scheduling, no webhooks.**

## Post-merge verification

Re-verified on merged `main` at `7db2ba9`: the three connector suites, the
EPIC-119 contract suite and the architecture boundary suite — **231 passed**.
Build clean. Working tree clean.

No live Jira run was made against the merged tree: Ferret's Jira provider needs
a token this environment does not hold, and the live instance was consulted for
field *shapes* only. What the shapes proved is recorded above; what a
credentialled run would add is a count, and inventing one would be worse than
saying so.

## Not applicable

Boards, sprints, workflows and JQL-as-a-user-surface are outside the stated
scope. Releases and deployments belong to `ProjectSynchronizer` (EPIC-073).
