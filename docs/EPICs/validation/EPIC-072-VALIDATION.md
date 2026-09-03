# EPIC-072 — Pull Request & Review Modeling — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-072](../EPIC-072-Pull-Request-And-Review-Modeling.md), AC-1 to AC-20.

Ferret could answer *what changed* and *who touched it*, and not the question a
person actually asks: **"which pull request introduced this, who approved it,
and what did the issue say it was for?"** Every piece existed — `kinds.ts`
declared `pull_request`, `review` and `issue` since EPIC-006, `relationship.ts`
declared six edge types between them, `attributes.ts` had the schemas — and
nothing had ever produced one.

## What was built

- **`src/project/model.ts`** — records in, canonical entities, relationships and
  evidence out. No transport, no store, no clock.
- **`src/project/references.ts`** — GitHub's documented closing keywords, and
  the refusal to read a bare `#12` as a resolution.
- **`tests/unit/project-modeling.test.ts`** — 27 tests.
- **`tests/integration/storage/project-modeling.test.ts`** — 2 tests, and they
  are the ones that mattered.

**This Epic adds no primitive.** The kinds, the relationship types, the
attribute schemas, the emitter and the identity classifier all already existed.
It is the join nothing had performed.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `scopes a pull request to its repository` — scope is the repository id; `source.id` is the provider's stable id, not the number. |
| AC-2 | **MET** | `is stable across re-modelling` — same input, same id. |
| AC-3 | **MET** | `separates the same number in two repositories`. |
| AC-4 | **MET** | `joins a merged pull request to the commit Git derives` — the id equals `canonicalId(canonicalKey({kind: commit, sourceId: sha}))`, so the edge lands on EPIC-020's entity rather than a second one. |
| AC-5 | **MET** | `emits no commit edge for an open pull request`. |
| AC-6 | **MET** | `joins the target branch, and keeps the source branch as an attribute`. |
| AC-7 | **MET** | `reads a closing keyword as an inference` — `EvidenceMethod.INFERRED`, `derivedFrom` non-empty, `inferredResolutions: 1`. |
| AC-8 | **MET** | `does not read a bare mention as a resolution` — the body carries `Fixes #7` and `#99`; one edge. |
| AC-9 | **MET** | `scopes a cross-repository reference to that repository`. |
| AC-10 | **MET** | `links every review to its pull request, verdict on the entity` — two reviews, two edges, states `['approved', 'changes_requested']`. |
| AC-11 | **MET** | `records a reviewer whatever the verdict` — a `CHANGES_REQUESTED` review still produces `DEVELOPER_REVIEWED_PULL_REQUEST`. |
| AC-12 | **MET** | `makes an actor a developer, and offers an identity to link` — and the identity is presented in GitHub's noreply form, the one spelling EPIC-036's `GITHUB_NOREPLY_LOGIN` rule can join to a web-UI commit. |
| AC-13 | **MET** | `classifies a bot as an agent, not a developer` — through `classifyIdentity`, not a second heuristic. |
| AC-14 | **MET** | `merges nothing` — no `ENTITY_SUPERSEDES_ENTITY`, no store call. |
| AC-15 | **MET** | `carries evidence with a locator for the questioned attributes` — state and merge commit, `kind: 'pull-request'`, `start: 12`. |
| AC-16 | **MET** | `skips one malformed record and models the rest`. |
| AC-17 | **MET** | `project modelling boundary` in `boundaries.test.ts` — no provider, no storage, no CLI. |
| AC-18 | **MET** | `emits only edges the canonical model permits`, and the integration test reads the same five types back out of PostgreSQL. |
| AC-19 | **MET** | The integration test writes placeholders with `ifAbsent`; without them the insert is `23503`. |
| AC-20 | **MET** | The whole set — entities, relationships, evidence — stores against the real schema. |

## What the integration test found, twice

The unit suite is thorough and both defects were invisible to it, for the same
reason: it asserts the *shape* of records, and both failures were foreign keys.

**A modelled edge had no endpoint.** `PULL_REQUEST_PROPOSES_COMMIT` named the
commit id Git derives — correctly — and nothing had created that row:

```
[23503] insert into "ferret"."relationship" … pull_request_proposes_commit
```

The domain was satisfied, because `createRelationship` validates endpoint
*kinds* and the kinds were right. §8.10 emits the merge commit, the target
branch and the referenced issue as placeholders, which is the mechanism the Git
provider already had and this Epic had simply not used.

**An inference cited an entity.** `derivedFrom: [entity.id]` reads naturally and
violates a foreign key: `evidence_derivation` references `evidence`.

```
[23503] insert into "ferret"."evidence_derivation" …
```

The fix is better than the bug. §8.11 now emits an `observed` record saying the
body contained this text and derives the `inferred` resolution from it, so the
citation chain ends at a quotation somebody wrote rather than at an id — which
is what Governance §6 asks for and what the first version only approximated.

## What the attribute schema found

`developerAttributes` takes `emails` and `usernames` as **lists**, and EPIC-036's
own comment gives the reason: one person commits as several addresses, and
collapsing them discards the evidence resolution depends on. The first attempt
wrote `username` and `primaryEmail`, was refused, and — worth noting — the
refusal arrived as a *skipped record with a reason*, which is §8.9 working
exactly as specified: the failure cost one record and named it.

## What this does not claim

- **An open pull request's commits are unmodelled.** §8.2 declines to invent
  edges to commits Ferret has not fetched.
- **A review's file-level comments are unmodelled.**
- **`COMMIT_RESOLVES_ISSUE` is declared and not emitted here** — a commit
  message is EPIC-020's input, and `findClosingReferences` is the thing it would
  reuse.
- **A GitHub actor and a Git author are not merged.** ~~Until EPIC-051 runs, a~~
  **EPIC-051 (2026-09-03) supplies the proposal and still does not merge**: a
  person who reviews on GitHub and commits through Git is two entities with a
  named, scored candidate between them, and a naive "who contributed" query
  double-counts until somebody adjudicates it. That is a real limitation, and
  the alternative — merging on a display name — is the failure EPIC-036 exists
  to prevent.
- **The merge-commit edge pointed at the wrong entity.** Found by EPIC-051 and
  fixed there: `canonicalKey` includes the source system, so this Epic's commit
  entity was `github`'s copy of a SHA rather than the commit Git indexed. The
  AC-4 assertion above said `github` and was asserting the defect.
