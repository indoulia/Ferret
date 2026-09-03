# EPIC-051 — Cross-Source Entity Resolution

**Status: VALIDATED | Priority: P1 | Domain: Knowledge Model**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Knowledge Model.

## 1. Objective

Decide when two records from two systems are one thing — and, where the answer
is knowable rather than arguable, make them one thing by construction.

## 2. Value

Ferret now reads Git, GitHub and Jira. Six validation documents park a
limitation here, and EPIC-009's states the shape of it:

> *"Nothing proposes reconciliations. Ferret records and adjudicates a mapping a
> caller asserts; it does not go looking for two addresses that are probably one
> person."*

But the larger finding is not the missing proposal engine. It is that **the
graph was already split in a way nobody had noticed**: `canonicalKey` includes
the source system, so when EPIC-072 recorded that a pull request merged as
`abc123`, it derived a `github` commit — beside the `git` commit the Git
provider had already indexed. Every `PULL_REQUEST_PROPOSES_COMMIT` and
`RELEASE_INCLUDES_COMMIT` edge pointed at an entity nothing else in the graph
knew about.

## 3. Scope

- **`src/resolution/global.ts`** — identifiers that mean the same thing in every
  system, and the canonical system each belongs to. Resolution by construction.
- **`src/resolution/propose.ts`** — candidates for everything else, with a named
  rule, a confidence and a rationale. Resolution by proposal.
- **The split, fixed** — EPIC-072 and EPIC-073 emit commits and branches into
  the canonical system.
- **`normalizeRemote`, moved** to `src/identity/` — §17.

## 4. Non-scope

- **Merging.** `IdentityStore.merge` is the only thing that merges, it requires
  evidence, and EPIC-009 made it deliberately the least reversible operation in
  the system. This produces the evidence.
- **Automatic adjudication.** §8.3. A threshold above which Ferret merges
  without asking is a policy, and the wrong policy here is permanent.
- **Fuzzy title matching between issues.** Two tickets with similar titles are
  usually two tickets. §8.4 uses a quoted key, which is a fact somebody wrote,
  rather than a similarity nobody can defend.
- **A resolution store.** Proposals are returned, not persisted: EPIC-009's
  `identity_alias` is where an *adjudicated* mapping lives, and a table of
  unadjudicated guesses is a queue nobody drains.

## 5. Inputs

Actor and issue records from any provider, and the kind and system of an entity
about to be derived.

## 6. Outputs

`src/resolution/`, exported from the package root, and one moved module.

## 7. Dependencies

EPIC-006 (identity derivation), EPIC-009 (the store that merges), EPIC-036 (the
identity normalizer and its rules), EPIC-021/071/072/073 (the sources that made
the split visible).

## 8. Contracts

### 8.1 Two mechanisms, and knowing which applies is most of the work

**By construction** where an identifier is global: derive the entity in the
canonical system and the collision is simply right. **By proposal** everywhere
else, because a login and an email are not the same identifier however often
they belong to the same person.

Construction is always better where it is available. A proposal has to be
adjudicated by somebody, and a queue of unadjudicated proposals is a graph that
is wrong in a way that looks like work in progress.

### 8.2 A commit SHA means the same thing in every system

`canonicalKey` includes the source system for a good reason: GitHub's issue 12
and Jira's issue 12 are different things, and an identity scheme that ignored
the system would merge them.

A commit SHA is not like that. It is a hash *of the commit*; there is exactly
one commit with it, whoever mentions it. So a commit is derived in the `git`
system regardless of which provider reported it, and the entity GitHub's merge
commit refers to is the entity Git indexed.

Branches follow, for a related reason: a branch name is unique within its
repository and the repository *scope* already carries that, so the system adds
nothing but a split. Files are deliberately **not** included: a path is unique
within a repository too, and EPIC-023 already scopes it — adding it here would
be change for its own sake.

### 8.3 A proposal names its rule, its confidence and its reason

Five rules, ordered by what they are worth:

| Rule | Confidence | What it is |
|---|---|---|
| `same-address` | `STRONG` | The same mailbox once casing and plus-tags are normalized |
| `noreply-login` | `PROBABLE` | A GitHub noreply address's login matching a username |
| `quoted-key` | `PROBABLE` | An issue quoting another tracker's key |
| `same-username` | `PLAUSIBLE` | The same username string in two systems |
| `same-display-name` | `EVEN` | A shared display name and nothing else |

The last is deliberately worth almost nothing. Two people called "admin" are two
people, and the rule exists to surface a candidate for a human rather than to
carry one over a threshold.

**Only across systems.** Two GitHub accounts are two people until GitHub says
otherwise, and proposing within one system would rediscover every colleague who
shares a surname.

**One proposal per pair, at its best rule.** Two rules agreeing does not make a
pair more certain than its best evidence, and keeping both would let a reviewer
count the same fact twice — EPIC-036's `proposeIdentityLinks` records the same
reasoning.

### 8.4 An issue that quotes a key is a candidate, not a conclusion

`FER-12` in a GitHub issue is the strongest cross-tracker signal there is and is
still only a mention: teams reference a ticket to give context as often as to say
"this is that". So it is `PROBABLE`, it is a proposal, and the rationale quotes
the text so a reviewer can see which of the two readings it was.

### 8.5 A repository's identifier is the remote's, and the host is not guessed

`owner/repo` on GitHub, `git@github.com:owner/repo.git` in a config and
`https://github.com/owner/repo` in a browser are one repository.
`normalizeRemote` already reduces the last two; this adds the first, which
carries no host at all.

The host is therefore required. Guessing `github.com` would be wrong for every
Enterprise Server install, and being wrong here merges two organisations'
repositories of the same name — which is the failure mode this whole Epic exists
to avoid, produced by the Epic meant to avoid it.

## 9. Acceptance criteria

- **AC-1** A commit derived from a GitHub record has the id Git derives.
- **AC-2** EPIC-072's merge-commit edge points at that entity.
- **AC-3** A target branch is the branch Git indexed.
- **AC-4** Issues, pull requests and releases stay scoped to their system.
- **AC-5** `owner/repo` plus a host reduces to a remote's canonical form.
- **AC-6** The host is required and is not guessed; `api.github.com` resolves to
  `github.com`.
- **AC-7** A project name that is not one is refused, including `../etc`.
- **AC-8** The same mailbox across systems proposes `same-address`.
- **AC-9** A GitHub noreply login proposes `noreply-login`.
- **AC-10** A shared username ranks below an address, and a shared name below
  that.
- **AC-11** Nothing is proposed within one system.
- **AC-12** A pair is proposed once, at its best rule.
- **AC-13** Proposals are ordered strongest first.
- **AC-14** An issue quoting another tracker's key proposes `quoted-key`, with
  the quotation in the rationale.
- **AC-15** A key no tracker in the batch has proposes nothing.
- **AC-16** `src/resolution/` reaches no provider, no store and no CLI.
- **AC-17** Nothing here merges.

## 10. Test requirements

**Unit** — every acceptance criterion. AC-1 to AC-3 are the interesting ones:
they assert a defect this Epic found, end to end through EPIC-072's modelling.

**Boundary** — AC-16, which is the gate that forced §17's move.

**Regression** — EPIC-072's and EPIC-073's suites, whose commit-id assertions
were asserting the defect and are corrected with the reason recorded.

## 11. Security requirements

§8.5's host requirement is the security-relevant one: a guessed host merges
repositories across organisations. AC-7 refuses a project name shaped like a
path traversal, because a dot is legal in a repository name and the obvious
character class admits `../etc`.

## 12. Observability

A proposal carries a rationale written for a person: *"github:ada and jira:ada
share a username, which is a signal and not a proof"*. A merge made from one of
these should be defensible six months later by reading the sentence.

## 13. Performance constraints

Proposal is O(actors²) across systems, which is fine for the scale a batch has
and would not be for a whole organisation. Named in §16.

## 14. Definition of Done

Scope implemented; AC-1 to AC-17 with evidence in
`validation/EPIC-051-VALIDATION.md`; `npm run verify` green; the registry
updated; the parked rows in EPIC-006, EPIC-009 and EPIC-072 struck or narrowed.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.3 and §8.4: every proposal is a named
  rule with a rationale, and none of them merges anything.
- **§5 Reuse Before Reinvent** — EPIC-036's normalizer and confidence scale are
  reused rather than re-derived; `IdentityStore.merge` stays the only merger.
- **§21 Reproducibility** — §8.2: one object, one identity, whichever provider
  reported it.

## 16. Raised, not absorbed

- **Proposals are not persisted.** §4. A caller runs the proposer over a batch
  and adjudicates; nothing accumulates. A durable queue is a different Epic and
  needs somebody to own draining it.
- **Proposal is quadratic across systems.** Fine for a batch, wrong for an
  organisation-wide pass. Blocking on an address index would fix it and is
  unnecessary until somebody runs it at that scale.
- **A repository is resolved by construction only if the caller supplies the
  host.** Nothing currently does — EPIC-021's provider knows its base URL and
  the modelling does not receive it. `repositoryIdentifierFor` and `hostOf` are
  the pieces; wiring them through `ProjectModelInput` is a change to a merged
  Epic's signature that this one did not make.
- **A Jira issue moved between projects keeps its id and changes its key**, so
  a `quoted-key` proposal against the old key will not match. Correct, and worth
  knowing.
- **Nothing resolves a fork to its upstream.** EPIC-017's row asks for it, and
  two clones with different remotes are genuinely two repositories to Git; a
  fork relationship is GitHub's `parent` field, which EPIC-021 does not read.

## 17. Recorded during implementation

**The boundary test refused the first design, and was right.**
`repositoryIdentifierFor` needs `normalizeRemote`, which lived in
`src/git/identity.ts`. Importing it put a Git-provider module into
`src/resolution/` — and therefore into `src/project/`, and therefore into the
core barrel, which the existing gate asserts never reaches `src/git/`.

The objection is real rather than technical: reducing a remote URL to the
identity two clones share is not Git-specific, and the function was in the wrong
module. It moved to `src/identity/remote.ts`, where EPIC-036's other
provider-neutral identity logic already lives, and `src/git/identity.ts`
re-exports it so no existing caller changed. **A second caller is what reveals
that a module was in the wrong place**, and this is the second time in three
Epics — EPIC-071 found the same thing about a contract.

**`ResolutionRule` was already taken.** EPIC-035 exports one for *reference*
resolution, which is closer to that word's ordinary meaning in a compiler. Two
exports with one name is how a consumer imports the wrong one and gets a type
error three files away; renamed to `CrossSourceRule`, and found by the compiler,
which is where it should be found. The third name collision this project has had
— EPIC-014's `ProviderState` was the first.

**A dot is legal in a repository name**, so `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`
admits `../etc` and normalizes it into a plausible identifier for a repository
nobody named. Found by the test that tried four hostile names because trying
four hostile names is the habit, not because this one was expected.

Full evidence in [validation](validation/EPIC-051-VALIDATION.md).
