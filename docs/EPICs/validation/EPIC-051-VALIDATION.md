# EPIC-051 — Cross-Source Entity Resolution — Validation

**Validated 2026-09-03.** Evidence for
[EPIC-051](../EPIC-051-Cross-Source-Entity-Resolution.md), AC-1 to AC-17.

Six validation documents parked a limitation here. The expected work was a
proposal engine — EPIC-009's *"nothing goes looking for two addresses that are
probably one person"*. That got built.

**The finding was something else: the graph was already split.**

## The split

`canonicalKey` includes the source system, for a good reason — GitHub's issue 12
and Jira's issue 12 are different things. A commit SHA is not like that: it is a
hash *of the commit*, and there is exactly one commit with it.

So when EPIC-072 recorded that a pull request merged as `abc123`, it derived a
**`github` commit** beside the **`git` commit** the Git provider had already
indexed:

```
git    → ee226317-8ac6-8cac-ad05-8f7e3f541baa
github → 9cde5045-5d07-8dca-b798-4b69fed7a699
```

Every `PULL_REQUEST_PROPOSES_COMMIT` edge and every `RELEASE_INCLUDES_COMMIT`
edge pointed at an entity nothing else in the graph knew about. The integration
tests passed — the endpoints existed, because EPIC-072 §8.10 had emitted them as
placeholders — so the graph was *whole* and *wrong*, which is the harder failure
to see. Branches had the same split, from the same cause.

Fixed by construction rather than by proposal: a commit is derived in the `git`
system whoever reported it. AC-1 to AC-3 assert it end to end, and the
assertions in EPIC-072's and EPIC-073's suites that said `github` are corrected
with the reason recorded — they were asserting the defect.

## Acceptance criteria

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | **MET** | `gives one commit one identity, whoever mentions it`. |
| AC-2 | **MET** | `makes EPIC-072 point its merge-commit edge at Git commit` — end to end through `modelProject`. |
| AC-3 | **MET** | `makes the target branch the branch Git indexed`. |
| AC-4 | **MET** | `leaves everything else scoped to the system that reported it` — issues, pull requests and releases unchanged, because GitHub's 12 and Jira's 12 really are different. |
| AC-5 | **MET** | `reduces owner/repo to the identifier a remote produces`. |
| AC-6 | **MET** | `needs the host, and does not guess it`; `knows api.github.com is not one` — a remote points at `github.com`, and identity has to agree with the remote or nothing resolves. |
| AC-7 | **MET** | `refuses a project name that is not one` — including `../etc`. |
| AC-8 | **MET** | `proposes the same mailbox across systems` — `Ada+ferret@Example.COM` and `ada@example.com`, `STRONG`. |
| AC-9 | **MET** | `joins a web-UI commit to the reviewer through a noreply login`. |
| AC-10 | **MET** | `rates a shared username below an address, and a shared name below that` — `PLAUSIBLE` and `EVEN`. |
| AC-11 | **MET** | `never proposes within one system`. |
| AC-12 | **MET** | `proposes a pair once, at its best rule`. |
| AC-13 | **MET** | `orders proposals strongest first`. |
| AC-14 | **MET** | `proposes an issue that quotes another tracker key`, with the quotation in the rationale. |
| AC-15 | **MET** | `proposes nothing for a key no tracker in the batch has`. |
| AC-16 | **MET** | `resolution boundary` in `boundaries.test.ts`. |
| AC-17 | **MET** | Nothing in `src/resolution/` writes: the module returns proposals and imports no store. |

## What the boundary test forced

`repositoryIdentifierFor` needs `normalizeRemote`, which lived in
`src/git/identity.ts`. Importing it put a Git-provider module into
`src/resolution/` — and therefore into `src/project/`, and therefore into the
core barrel, which an existing gate asserts never reaches `src/git/`.

The gate was right, and not on a technicality: reducing a remote URL to the
identity two clones share is not Git-specific, and the function was in the wrong
module. It moved to `src/identity/remote.ts` beside EPIC-036's other
provider-neutral identity logic, and `src/git/identity.ts` re-exports it so no
caller changed.

**A second caller is what reveals that a module was in the wrong place.** This is
the second time in three Epics: EPIC-071 found the same thing about a contract.

## What the compiler found

`ResolutionRule` was already taken — EPIC-035 exports one for *reference*
resolution, which is closer to that word's ordinary meaning in a compiler. Two
exports with one name is how a consumer imports the wrong one and gets a type
error three files away. Renamed to `CrossSourceRule`. The third name collision
this project has had; EPIC-014's `ProviderState` was the first.

## What a hostile input found

A dot is legal in a repository name, so `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`
admits `../etc` and normalizes it into a plausible identifier for a repository
nobody named. Found by the test that tried four hostile names — because trying
four hostile names is the habit here, not because this one was expected.

## What this does not claim

- **Nothing is merged**, by design. `IdentityStore.merge` remains the only
  thing that merges and it requires evidence, which is what a proposal is.
- **Proposals are not persisted.** A caller runs the proposer over a batch and
  adjudicates; a durable queue of unadjudicated guesses is a queue nobody
  drains.
- **Proposal is quadratic across systems.** Fine for a batch, wrong for an
  organisation-wide pass.
- **A repository resolves by construction only if the caller supplies the
  host**, and nothing currently does — `repositoryIdentifierFor` and `hostOf`
  are the pieces, and wiring them through `ProjectModelInput` is a signature
  change to a merged Epic that this one did not make.
- **Nothing resolves a fork to its upstream.** EPIC-017's row asks for it; a
  fork relationship is GitHub's `parent` field, which EPIC-021 does not read.
