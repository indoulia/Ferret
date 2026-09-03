# EPIC-073 — Release & Deployment Modeling — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-073](../EPIC-073-Release-And-Deployment-Modeling.md), AC-1 to AC-16.

`RELEASE_INCLUDES_COMMIT` and `DEPLOYMENT_DEPLOYS_RELEASE` had been declared
since EPIC-006 and never emitted. Between them they are the only path from a
line of code to the environment it is running in — the answer to the question an
incident starts with: *is the fix in production?*

## The question no API answers

A GitHub release names a tag; a tag names one commit. There is no endpoint that
returns "the commits in this release", and the two obvious substitutes are both
wrong: the release's own commit is one commit, and every ancestor makes each
release contain every commit before it, so "which release introduced this" gets
as many answers as there are releases.

The right answer is `git log previous..head` — reachable from this release's
commit and not from the previous one — and it is a question about the commit
graph, which Ferret already holds. `src/project/ancestry.ts` is that walk, as a
pure function over a parent map, so the interesting cases are ordinary tests.

## What was built

- **`src/providers/contracts/source-project.ts`** — `ProjectDeployment`,
  `ProjectDeploymentStatus`, `DeploymentState`, two operations.
- **`src/github/provider.ts`** — `listDeployments`, `listDeploymentStatuses`.
- **`src/project/ancestry.ts`** — the walk, bounded and honest about it.
- **`src/project/releases.ts`** — releases and deployments as entities.
- **`tests/unit/release-modeling.test.ts`** — 22 tests.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `makes a release entity with its tag as the version` — scoped to the repository, `version` and `tag` both the tag. |
| AC-2 | **MET** | `reports what is new since the previous release` — `v1.0.0..v2.0.0` gives `c3, c4, c5` and not `c1, c2`; `crosses a merge and reaches both sides`; `orders releases by publication, whatever order they arrive in`. The edge records `basis: 'ancestry'` and `since: 'v1.0.0'`, so the derivation is in the graph. |
| AC-3 | **MET** | `returns the whole ancestry with no predecessor` and `stops at the bound and says it stopped`; `reports a truncated release` at the modelling level. |
| AC-4 | **MET** | `gives a draft an entity, no commits, and no successorship`. |
| AC-5 | **MET** | `reports an unresolvable tag rather than an empty release` — the entity exists, `unresolvedTags` names the tag. |
| AC-6 | **MET** | `reports a parent it was not given, rather than calling it a root`. |
| AC-7 | **MET** | `makes a deployment entity with its environment`. |
| AC-8 | **MET** | `leaves the state absent when nothing reported one`. |
| AC-9 | **MET** | `takes the latest status, and inactive is not a failure` — `in_progress` then `success` gives `succeeded`; `success` then `inactive` gives `inactive`. |
| AC-10 | **MET** | `joins a deployment to the release whose tag it deployed`, and `does not call a branch a release`. |
| AC-11 | **MET** | `emits every commit endpoint as a placeholder`. |
| AC-12 | **MET** | `declares both deployment operations`. |
| AC-13 | **MET** | `lists deployments in one request, without their statuses` — one recorded call, and no `state` on the record. |
| AC-14 | **MET** | `maps GitHub seven status states onto the contract five`. |
| AC-15 | **MET** | `stores a release, its commits and a deployment` against real PostgreSQL — the state reads back `succeeded`, the deploys-release edge is present, and `v2.0.0` includes exactly one commit. |
| AC-16 | **MET** | `skips one malformed record and models the rest`. |

## The decisions

**`error` and `failure` are the same failure.** GitHub distinguishes them by
*who* failed — the deployment, or the system reporting on it — and Ferret has no
use for that distinction. `queued` and `pending` are both "not started".

**`inactive` is not a failure.** A deployment superseded by a later one to the
same environment is neither a success nor a failure, and counting it as either
would be wrong in the direction that matters: a dashboard that reports failed
deployments would report every deployment that had ever been replaced.

**A branch is not a release.** GitHub deploys a ref. On every repository that
deploys `main`, an edge that treated the ref as a release would make "what is in
production" answer with the wrong thing.

**An absent status stays absent.** Calling an unreported deployment `pending`
would be Ferret's guess presented as the system's answer.

## What the previous Epic paid for

EPIC-072 found two foreign-key defects with its integration test — an edge with
no endpoint, and an inference citing an entity. Both were avoided here by
construction: commits are emitted as placeholders, and the deployment's state
evidence is `observed` about the entity. The integration test passed first time,
which is the return on the previous Epic having found them.

## What this does not claim

- **Release order is the source's publication dates.** A repository that
  publishes out of order — a patch to an old branch released after a new minor —
  gets a commit set measured from the wrong predecessor. Fixing it needs the tag
  graph. §16.
- **The bound is a real limit.** A first release in a large repository is
  truncated, and the truncation is reported rather than resolved.
- **Environments are strings**, not entities. `kinds.ts` declares no environment
  kind, and inventing one for a string a deployment already carries would be a
  kind with one attribute.
- **Rollbacks are recorded, not modelled.** `inactive` says a deployment was
  superseded; nothing says by what.
- **Nothing here has spoken to GitHub**, as EPIC-021 §16 records for the whole
  provider.
