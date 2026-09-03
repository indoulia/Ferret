# EPIC-073 — Release & Deployment Modeling

**Status: VALIDATED | Priority: P1 | Domain: External Project Knowledge**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under External Project Knowledge.

## 1. Objective

Answer *what shipped, and where it went* — which commits a release contains,
and which release a deployment put into an environment.

## 2. Value

`RELEASE_INCLUDES_COMMIT` and `DEPLOYMENT_DEPLOYS_RELEASE` have been declared
since EPIC-006 and never emitted. Between them they are the only path from a
line of code to the environment it is running in, which makes them the answer to
the question an incident starts with:

> *"Is the fix in production?"*

The first edge is the interesting one, because **no release API answers it**. A
GitHub release names a tag; a tag names one commit. "This release contains that
commit" is a question about the commit graph — and Ferret has the commit graph.

EPIC-021 §16 parked deployments here explicitly: *"`deployments` is declared in
the capability comment and not implemented. EPIC-073 owns deployment modelling
and will say what it needs."* This says what it needs.

## 3. Scope

- **`ProjectDeployment` and `ProjectDeploymentStatus`** on EPIC-021's contract,
  with two operations.
- **`listDeployments` and `listDeploymentStatuses`** on the GitHub provider.
- **`src/project/releases.ts`** — releases and deployments as entities.
- **`src/project/ancestry.ts`** — the commit-graph walk that answers §8.2.
- **Both edge types**, emitted for the first time.

## 4. Non-scope

- **Deciding what "production" means.** The source says which environment a
  deployment targeted, and Ferret records it. A rule that decided `prod-eu-2` is
  production and `production-canary` is not would be a policy, not a fact.
- **Deployment *logs* or artefacts.** Neither is knowledge about the repository.
- **Rollback modelling.** GitHub reports `inactive` for a superseded
  deployment, which this records; reconstructing *what rolled back to what* is
  an inference over a sequence and no downstream Epic asks for it.
- **Release-note parsing.** Notes are carried verbatim. Extracting the issues a
  release fixed from prose is EPIC-072's keyword scan applied to a different
  field, and doing it here would produce two conventions.
- **Tag resolution.** Turning `v1.2.0` into a SHA is Git's, and the caller
  supplies the map — §8.3.
- **Environments as entities.** `kinds.ts` declares no environment kind, and
  inventing one for a string a deployment already carries would be a kind with
  one attribute.

## 5. Inputs

`ProjectRelease` and `ProjectDeployment` records, a tag-to-commit map, and a
commit parent map — the last two from Git, which is where they live.

## 6. Outputs

The contract extension, the provider methods, and `src/project/releases.ts`.

## 7. Dependencies

EPIC-021 (the contract and the provider), EPIC-072 (the modelling module and
its placeholder convention), EPIC-019/020 (the commit graph this walks).

## 8. Contracts

### 8.1 A release is a release; a draft contains nothing

A draft release has not been published and its tag may not exist. It becomes an
entity — it is a real thing somebody is preparing — and it gets **no** commit
edges, and it does not become the predecessor for the next release's contents.
Emitting a commit set for a release that has not happened would be a claim about
a shipment nobody made.

### 8.2 A release contains what is new since the last one

`git log previous..head`, as a function. Everything reachable from this
release's commit and not from the previous release's, breadth-first over the
parent map the caller supplies.

That definition is the one every changelog tool uses and the only one that makes
`RELEASE_INCLUDES_COMMIT` useful: the alternative — every ancestor — makes each
release contain every commit before it, and "which release introduced this" then
has as many answers as there are releases.

**Bounded.** The first release in a repository has no predecessor, so its
ancestry is the entire history; emitting an edge per commit for a repository
with 80 000 of them is write amplification nobody asked for. The walk stops at
5 000 and reports the release as truncated, because a prefix labelled as a
prefix is usable and a prefix presented as a set is not.

A parent named by a commit the caller did not supply is recorded as
`unresolved` rather than treated as a root: "we do not have this commit" and
"this commit has no parents" are different facts and only the second is a claim
about history.

### 8.3 A tag is resolved by the caller, and an unresolved tag is reported

Turning `v1.2.0` into a SHA is Git's job. This module takes the map, and a
release whose tag is not in it gets an entity, no commit edges, and a place in
`unresolvedTags` — which is exactly the difference between "this release
contains nothing" and "Ferret could not tell".

### 8.4 A deployment's state comes from its statuses, and is absent until it does

Every system with the concept keeps a deployment's outcome in a separate
statuses collection, so filling it in during `listDeployments` would cost one
request per deployment against somebody else's rate limit — EPIC-021 §8.4's
argument, one level up. The provider returns deployments without a state, and
`listDeploymentStatuses` is a second call the caller chooses to make.

A deployment with no status recorded has **no** `state` attribute. Calling it
`pending` would be Ferret's guess presented as the system's answer.

The latest status wins, by `createdAt`. GitHub's seven states map to five:
`error` and `failure` are both failures, because GitHub distinguishes them by
*who* failed and Ferret has no use for that; `queued` and `pending` are both
"not started"; and `inactive` stays its own state, because a deployment
superseded by a later one is not a failure and must never be counted as one.

### 8.5 A deployment deploys a release only when it deployed a release

GitHub deploys a *ref*, which may be a tag, a branch or a raw SHA. The edge is
emitted only when that ref is a release's tag. A branch is not a release however
often it is deployed, and an edge that pretended otherwise would make "what is
in production" answer with the wrong thing on every repository that deploys
`main`.

### 8.6 The endpoints exist, because EPIC-072 learned that the hard way

Every commit a release includes is emitted as a placeholder, and the ids are
named in `placeholderEntityIds`. EPIC-072 §8.10 records why: `relationship` has
a foreign key, and an edge whose endpoint has never been written is a `23503`
rather than a graph.

## 9. Acceptance criteria

- **AC-1** A release becomes a `release` entity scoped to its repository, with
  its tag as the version.
- **AC-2** A release contains the commits new since the previous release, and
  not the ones the previous release already contained.
- **AC-3** The first release contains its whole ancestry, bounded, and is
  reported as truncated when the bound is reached.
- **AC-4** A draft release gets an entity, no commit edges, and does not become
  the predecessor.
- **AC-5** An unresolvable tag is reported in `unresolvedTags`, with an entity
  and no edges.
- **AC-6** A parent that is not in the map is reported as unresolved rather than
  treated as a root.
- **AC-7** A deployment becomes a `deployment` entity with its environment.
- **AC-8** A deployment with no status has no `state` attribute.
- **AC-9** The latest status decides the state, and `inactive` is not a failure.
- **AC-10** `DEPLOYMENT_DEPLOYS_RELEASE` is emitted when the ref is a release
  tag, and not when it is a branch.
- **AC-11** Every commit edge's endpoint is emitted as a placeholder.
- **AC-12** The GitHub provider lists deployments and statuses, and declares
  both operations.
- **AC-13** `listDeployments` makes one request and does not fetch statuses.
- **AC-14** GitHub's seven status states map to the contract's five.
- **AC-15** The whole set stores against the real schema.
- **AC-16** A malformed record is skipped and counted.

## 10. Test requirements

**Unit** — every acceptance criterion. The ancestry walk is a pure function over
a parent map, so the interesting cases — a merge, a first release, a bound, a
missing parent — are ordinary tests rather than fixtures.

**Integration** — AC-15, against real PostgreSQL, for EPIC-072's reason: the
foreign keys are what a unit suite cannot see.

## 11. Security requirements

Release notes are prose somebody wrote and are carried verbatim through
`redactSecrets` — a release note pasting a failing deploy command is a plausible
way for a token to reach the index.

## 12. Observability

`truncatedReleases` and `unresolvedTags` are reported, because both mean the
graph is incomplete in a specific way, and an operator who cannot tell an empty
release from an unresolvable one cannot act on either.

## 13. Performance constraints

The ancestry walk is O(commits) per release with the bound as its ceiling.
`listDeployments` is one request per page; statuses are one per deployment and
are therefore opt-in.

## 14. Definition of Done

Scope implemented; AC-1 to AC-16 with evidence in
`validation/EPIC-073-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-021 §16's deployments row struck.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.4: an absent status is absent, not
  `pending`; §8.5: a branch is not a release; §8.2: an unresolved parent is not
  a root.
- **§5 Reuse Before Reinvent** — the kinds, both edge types and the placeholder
  convention already existed.
- **§12 Untrusted Input** — §11.
- **§21 Reproducibility** — the edge records how it was derived, so a change to
  the walk is visible in the graph rather than only in the code.

## 16. Raised, not absorbed

- **A release's contents depend on which release came before it**, and that
  order is the source's publication dates. A repository that publishes releases
  out of order — a patch to an old branch released after a new minor — will get
  a commit set measured from the wrong predecessor. Fixing it needs the tag
  graph rather than the release list, and is a larger change than this Epic.
- **The bound is a real limit.** A first release in a large repository is
  truncated, and the truncation is reported rather than resolved. A caller that
  needs the whole set can raise the bound and pay for it.
- **Environments are strings.** §4. If a future Epic needs to ask "which
  environments exist", it will need a kind, and this Epic's attribute is where
  that data already is.
- **Rollbacks are recorded, not modelled.** `inactive` says a deployment was
  superseded and nothing says by what.

## 17. Recorded during implementation

**EPIC-072's two foreign-key findings were paid forward.** Both were fixed
before they could happen again: every commit a release includes is emitted as a
placeholder (§8.6), and the deployment's state evidence is `observed` about the
entity rather than derived from one. The integration test confirms it, and it
passed first time — which is the return on the previous Epic having found them.

**Ordering releases by publication date is the load-bearing assumption**, and it
is the one §16 flags. A repository that publishes out of order gets a commit set
measured from the wrong predecessor. The alternative — deriving order from the
tag graph — needs a tag-to-tag ancestry Ferret does not currently read, and
guessing would have been worse than stating it.

**A draft is not a predecessor.** Discovered while writing AC-4: if a draft
release became the previous release, the next real one would be measured from a
tag that may not exist, and would appear to contain nothing. Drafts are entities
and nothing else.

Full evidence in [validation](validation/EPIC-073-VALIDATION.md).
