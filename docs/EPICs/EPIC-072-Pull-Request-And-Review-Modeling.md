# EPIC-072 — Pull Request & Review Modeling

**Status: VALIDATED | Priority: P1 | Domain: External Project Knowledge**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under External Project Knowledge.

## 1. Objective

Turn the records EPIC-021 returns into canonical knowledge: pull requests,
reviews and issues as entities, joined to the commits and branches Ferret
already has, with the evidence for every claim.

## 2. Value

Ferret can answer *what changed* and *who touched it*. It cannot answer the
question a person actually asks:

> *"Which pull request introduced this, who approved it, and what did the issue
> say it was for?"*

Every piece is already in place except the join. `kinds.ts` has declared
`PULL_REQUEST`, `REVIEW` and `ISSUE` since EPIC-006; `relationship.ts` has
declared `PULL_REQUEST_PROPOSES_COMMIT`, `PULL_REQUEST_TARGETS_BRANCH`,
`PULL_REQUEST_RESOLVES_ISSUE`, `REVIEW_REVIEWS_PULL_REQUEST`,
`DEVELOPER_REVIEWED_PULL_REQUEST` and `COMMIT_RESOLVES_ISSUE`;
`attributes.ts` has schemas for all three kinds. Nothing has ever produced one.

EPIC-021 supplied the records. This is the modelling it deliberately left out.

## 3. Scope

- **`src/project/`** — provider-neutral modelling: records in, canonical
  entities, relationships and evidence out.
- **Pull request, review and issue entities**, with the attribute schemas that
  already exist.
- **The joins**: to a merge commit, to a target branch, to a resolved issue.
- **Closing references parsed from text**, as *inference* with its basis named.
- **Reviewer and author actors** as developer entities, plus identity-link
  proposals rather than assumed merges.
- **Evidence for every attribute Ferret will later be asked to justify.**

## 4. Non-scope

- **Transport.** EPIC-021 reads GitHub; EPIC-071 will read Jira. Nothing here
  makes a request, and nothing here imports a provider.
- **Persistence.** This produces records; `EntityStore`, `RelationshipStore` and
  `EvidenceStore` write them, and the indexing pipeline calls both. A module
  that both modelled and wrote would be a second write path.
- **Identity merging.** EPIC-009's `IdentityStore.merge` is the only thing that
  merges, and it requires evidence. §8.6 produces the proposal, not the merge.
- **Releases and deployments.** EPIC-073.
- **Review comments as a thread.** A comment is modelled as evidence about the
  review or issue it belongs to, not as an entity of its own: nothing downstream
  asks a question that needs one, and `kinds.ts` declares no comment kind.
- **Cross-source resolution.** Whether GitHub's pull request and Jira's issue
  denote the same work is EPIC-051's.

## 5. Inputs

`ProjectPullRequest`, `ProjectReview`, `ProjectIssue` and `ProjectComment` from
EPIC-021's contract, plus the repository entity id the pull requests belong to —
which the caller has and this module cannot derive.

## 6. Outputs

`src/project/`, exported from the package root.

## 7. Dependencies

EPIC-021 (the contract), EPIC-006 (entities and identity), EPIC-007
(relationships), EPIC-008 (evidence and the emitter), EPIC-036 (identity
classification), EPIC-020 (the commit entities these join to).

## 8. Contracts

### 8.1 Identity is scoped to the repository, not global

A pull request numbered 12 exists in every repository. `canonicalKey` takes a
`scope`, and the scope is the repository entity's id — so `owner/repo#12` and
`other/repo#12` are two entities, and re-ingesting either produces the same id
it did last time.

The `sourceId` is the provider's stable id (`PR_kwDO…`), not the number. A
number is a display detail: GitHub's own numbering is per repository and Jira's
is per project, and keying on either would make the identity depend on which
system was read rather than on what was read.

### 8.2 A merged pull request proposes its merge commit, and only then

`PULL_REQUEST_PROPOSES_COMMIT` is emitted when the source reports a merge
commit, and not otherwise. An open pull request proposes commits Ferret has
usually never seen — they are on a branch that may not be fetched — and
inventing an edge to a commit id that resolves to nothing would produce a graph
that traverses into emptiness.

The commit entity is referenced by the identity Git derives for it, so the edge
lands on the commit EPIC-020 already created rather than on a second one.

### 8.3 The target branch is joined by name within the repository

`PULL_REQUEST_TARGETS_BRANCH`, with the branch entity derived the way EPIC-017
derives it: kind `branch`, scoped to the repository, `sourceId` the ref name. A
pull request targeting `main` joins the `main` Ferret already knows.

The **source** branch is recorded as an attribute rather than an edge. It is
usually deleted after a merge, and an edge to a branch that no longer exists is
a dangling one; the attribute keeps the fact without the claim.

### 8.4 A closing reference is an inference, and says so

"Fixes #12" in a pull request body is text a human wrote, and reading it is
inference — not observation. So `PULL_REQUEST_RESOLVES_ISSUE` carries `inferred`
evidence naming what it rests on, and the confidence is derived rather than
asserted.

The keyword list is GitHub's documented one — `close`, `closes`, `closed`,
`fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` — because a list
Ferret invented would be a claim about a convention it does not own. A bare
`#12` is **not** a closing reference: it is a mention, and treating a mention as
a resolution is how a compliance report starts claiming work was done.

A cross-repository reference (`owner/repo#12`) is parsed and scoped to *that*
repository, which is the only reading that can be right.

### 8.5 Only an approval is an approval, and a review is not a person

`REVIEW_REVIEWS_PULL_REQUEST` is emitted for every review. The reviewer's
`DEVELOPER_REVIEWED_PULL_REQUEST` edge is emitted for every review too — a
person who requested changes did review it — and the *verdict* lives on the
review entity's `state` attribute, where a query can ask for approvals
specifically.

Collapsing the two would make "was this approved" and "did anyone look at this"
the same question. EPIC-021 §8.8 already refused to call a comment an approval;
this refuses to lose the distinction one layer up.

### 8.6 An actor becomes a developer entity, and a proposal — never a merge

A GitHub login and a Git commit email are two identifiers for what is probably
one person, and *probably* is not a basis for merging entities. So:

- the actor becomes a `developer` entity scoped to the source system, keyed on
  the provider's stable identity;
- when the actor carries an email, `proposeIdentityLinks` is given the raw
  identity and produces a proposal with EPIC-036's own confidence;
- nothing is merged here. EPIC-009's `IdentityStore.merge` requires evidence and
  remains the only thing that merges.

Getting this wrong is the failure EPIC-036 exists to prevent: two people merged
because they share a display name is a knowledge base that has to be rebuilt.

### 8.7 A bot is classified as an agent, not a developer

`classifyIdentity` already tells a person from a bot, and `entityKindForActor`
maps the classification to a kind. `dependabot[bot]` opening 400 pull requests
must not appear in a report about who is contributing, and the classification is
EPIC-036's rather than a second heuristic here.

### 8.8 Every attribute that will be questioned carries evidence

Governance §6. A pull request's state, its merge commit and its resolved issue
are the three things a person will ask Ferret to justify, so each is emitted as
evidence with the source's own locator. The rest — title, timestamps — are
carried as attributes: evidence for every field would be evidence nobody reads,
and EPIC-008's cost is per record.

### 8.9 An unparseable record is skipped and counted, not fatal

One malformed pull request must not fail a repository's ingestion. Each record
is modelled independently; a failure is recorded with the record's id and the
pass continues. The count is reported, because "modelled 400 of 412" is a fact
and a silent 400 is not.

### 8.10 An edge needs its endpoint to exist, so the endpoints are emitted

A merge commit, a target branch and a referenced issue are entities another pass
owns — but `relationship` has a foreign key, and an edge whose endpoint has
never been written is a `23503` rather than a graph.

So each is emitted as a **placeholder**, and the ids are named in
`placeholderEntityIds`. The writer upserts a placeholder with `ifAbsent`, so a
stub emitted only to anchor an edge never overwrites a record an earlier run
read in full. The Git provider already does exactly this, and §17 records that
this Epic did not until an integration test refused it.

### 8.11 An inference is derived from evidence, not from an entity

`derivedFrom` names evidence rows: `evidence_derivation` has a foreign key to
`evidence`, and naming an entity there is a constraint violation dressed as a
citation.

So the closing reference produces **two** records: an `observed` one saying the
body contained this text, and an `inferred` one deriving the resolution from it.
That is also the honest chain — Ferret observed a sentence and inferred a
resolution — and it is what makes "why do you believe this" end at a quotation
somebody wrote rather than at an entity id.

## 9. Acceptance criteria

- **AC-1** A pull request becomes a `pull_request` entity scoped to its
  repository, keyed on the provider's stable id.
- **AC-2** Re-modelling the same record produces the same entity id.
- **AC-3** The same number in two repositories produces two entities.
- **AC-4** A merged pull request emits `PULL_REQUEST_PROPOSES_COMMIT` to the
  commit id Git derives.
- **AC-5** An open pull request emits no `PROPOSES_COMMIT` edge.
- **AC-6** `PULL_REQUEST_TARGETS_BRANCH` joins the branch entity EPIC-017
  derives; the source branch is an attribute, not an edge.
- **AC-7** `Fixes #12` emits `PULL_REQUEST_RESOLVES_ISSUE` with `inferred`
  evidence.
- **AC-8** A bare `#12` emits no resolution edge.
- **AC-9** `Fixes owner/other#5` scopes the issue to that repository.
- **AC-10** Every review emits `REVIEW_REVIEWS_PULL_REQUEST`, and the verdict is
  on the review entity.
- **AC-11** A reviewer emits `DEVELOPER_REVIEWED_PULL_REQUEST` whatever the
  verdict.
- **AC-12** An actor becomes a `developer` entity and, with an email, an
  identity-link proposal.
- **AC-13** A bot actor becomes an `agent`, not a `developer`.
- **AC-14** Nothing is merged: no `ENTITY_SUPERSEDES_ENTITY`, no store call.
- **AC-15** State, merge commit and resolution carry evidence with a locator.
- **AC-16** A malformed record is skipped and counted; the rest are modelled.
- **AC-17** `src/project/` imports no provider, no storage and no CLI.
- **AC-18** Every relationship emitted satisfies `relationship.ts`'s endpoint
  rules — asserted, not assumed.
- **AC-19** Every edge's endpoints are emitted, and the ones that are stubs are
  named in `placeholderEntityIds`.
- **AC-20** An inferred record's `derivedFrom` names evidence, and the whole set
  stores against the real schema.

## 10. Test requirements

**Unit** — every acceptance criterion, over records built by hand against
EPIC-021's contract types. No transport and no database: this module is a pure
function from records to canonical records, which is the whole reason it is a
module.

**Boundary** — AC-17 in `boundaries.test.ts`.

**Integration** — the modelled records written through the real stores, proving
AC-18 against the database's own constraints rather than only against the
domain's validation.

## 11. Security requirements

A pull request body and an issue title are written by anyone who can open one.
Both are carried verbatim and interpreted only by §8.4's keyword scan, which
reads a documented convention and emits an edge — never an instruction. The scan
is bounded: a body is read up to a cap, because a 2 MB description is a
plausible thing for a generated pull request to contain.

## 12. Observability

The result carries counts: entities, relationships, evidence, skipped records,
and the inferred resolutions separately from the observed ones — the last
because an inference count is what tells an operator how much of the graph rests
on text parsing.

## 13. Performance constraints

One pass over the records. No I/O.

## 14. Definition of Done

Scope implemented; AC-1 to AC-18 with evidence in
`validation/EPIC-072-VALIDATION.md`; `npm run verify` green; the registry
updated.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.4 is the whole of it: a closing keyword
  is inference and is labelled as one; a bare mention is not a resolution.
- **§5 Reuse Before Reinvent** — the kinds, the relationship types, the
  attribute schemas, the emitter and the identity classifier all already exist.
  This Epic adds no primitive.
- **§12 Untrusted Input** — §11.
- **§21 Reproducibility** — §8.1: the same record models to the same id.

## 16. Raised, not absorbed

- **An open pull request's commits are unmodelled.** §8.2 declines to invent
  edges to commits Ferret has not fetched. A provider operation that listed a
  pull request's commits would fix it, and EPIC-021 §3 did not include one.
- **A review's file-level comments are unmodelled.** They would need a locator
  into a diff, which is a shape `evidenceLocatorSchema` can express and nothing
  downstream asks for yet.
- **`COMMIT_RESOLVES_ISSUE` is declared and not emitted here.** A commit message
  is EPIC-020's input, not this Epic's, and the keyword scan §8.4 builds is the
  thing EPIC-020 would reuse. Named rather than quietly skipped.
- **A GitHub actor and a Git author are not merged**, by design — §8.6. Until
  EPIC-051 runs, a person who reviews on GitHub and commits through Git is two
  entities with a proposal between them, and a naive "who contributed" query
  will double-count. That is a real limitation and the alternative is worse.

## 17. Recorded during implementation

**The integration test found what the unit suite could not, twice.** Both
findings are foreign keys, and both were invisible to a suite that asserts the
shape of records rather than their storage.

**A modelled edge had no endpoint.** `PULL_REQUEST_PROPOSES_COMMIT` named the
commit id Git derives — correctly — and nothing had ever created that row, so
the insert was `23503`. The domain was satisfied: `createRelationship` validates
endpoint *kinds*, and the kinds were right. §8.10 emits the endpoints as
placeholders, which is the mechanism the Git provider already had and this Epic
had simply not used.

**An inference cited an entity.** `derivedFrom: [entity.id]` reads naturally and
is a constraint violation: `evidence_derivation` references `evidence`. The fix
is better than the bug — §8.11 now emits an observed record for the body text
and derives the inference from *that*, so the citation chain ends at a
quotation rather than at an id.

**`developerAttributes` takes lists, not fields.** `emails` and `usernames`,
because EPIC-036's schema comment says why: one person commits as several
addresses, and collapsing them throws away the evidence resolution depends on.
The first attempt wrote `username` and `primaryEmail` and was refused by the
attribute schema — the modelling then reported the record as *skipped*, which is
§8.9 working: the failure cost one record and named it.

Full evidence in [validation](validation/EPIC-072-VALIDATION.md).
