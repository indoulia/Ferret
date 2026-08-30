# EPIC-018 — Branch & Worktree Discovery

**Status: APPROVED | Priority: P0**

> **Specification note.** The Epic registry (v3.0) approved this capability by
> name, domain and priority. This specification elaborates it to the
> [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md) from the approved
> registry entry, `docs/Governance/README.md` §6, §9 and §10, and the contracts
> EPIC-011, EPIC-012 and EPIC-017 publish. It introduces no capability the
> registry did not approve.

## 1. Objective

Read a repository's checkouts and its branches, and connect them into a graph in
which a repository, a worktree and a branch remain three distinct things.

## 2. Value

Governance §9 makes context a first-class concept and states the distinction this
Epic exists to preserve: **a branch is not a worktree, and neither is a
repository**.

It sounds pedantic until you try to answer *"what was I working on last
Tuesday"*. A developer with four worktrees of one clone is working on four
branches simultaneously. A model that stores "the current branch" against the
repository can represent exactly one of them, and will be confidently wrong about
the other three — and it will be wrong in the way that matters most, because the
question an AI client actually asks is *which of my checkouts is this file in*.

EPIC-017 established the repository. This Epic establishes the two things that
hang off it, and the relationships that make them a graph rather than three
disconnected lists.

It also produces the first **exclusive** relationship in real data.
`worktree_checks_out_branch` is declared exclusive from the worktree (EPIC-007):
a checkout is on one branch at a time. Switching branches must therefore produce
*history* — the old interval closed, a new one opened — rather than a
contradiction, and EPIC-007's advisory-lock reconciliation exists precisely for
this.

## 3. Scope

- **Worktree enumeration** — every checkout of a repository, primary first,
  including detached, locked, prunable and bare states.
- **Branch enumeration** — local branches with their head commits, upstreams and
  which one is checked out, paged.
- **Default branch** — the ref a fresh clone would check out, when the
  repository records one.
- **Graph emission** — `worktree` and `branch` entities, and the three
  relationships that connect them to the repository and to each other.
- **Untrusted ref content** — ref names, lock reasons and upstream names come
  from a repository Ferret does not control.

## 4. Non-scope

- Commits. `branch_points_to_commit` needs a commit entity to point at, which is
  EPIC-019/EPIC-020.
- Remote branches and tags — EPIC-020.
- Reflog, and therefore *when* a checkout moved to a branch — EPIC-019.
- Storing what is emitted — EPIC-031.
- Submodules — EPIC-019, which reads `.gitmodules` properly.

## 5. Inputs

EPIC-017's `DiscoveredRepository` (which already carries `gitDir`,
`commonGitDir` and `linkedWorktree`), its Git runner, EPIC-012's SDK, EPIC-006's
`branch` and `worktree` entity kinds, EPIC-007's relationship types and their
declared exclusivity.

## 6. Outputs

- `listWorktrees` and `listBranches` on the `source.repository` capability.
- `emitGraph`, producing entities, relationships and evidence together.

## 7. Dependencies

EPIC-006, EPIC-007, EPIC-011, EPIC-012, EPIC-017. Externally: the `git`
executable.

## 8. Contracts

Both readers use **plumbing** commands with explicit formats:

- `git worktree list --porcelain` — documented as machine-readable and stable,
  and it orders the primary worktree first, which is the only way to tell it from
  a linked one.
- `git for-each-ref --format=%(refname)%00...` — NUL-separated. `%(upstream)` is
  *empty* for a branch that tracks nothing and `%(HEAD)` is a single space for
  one that is not checked out, so any whitespace-delimited parse silently shifts
  every field along.

**Identity.** A branch is scoped to its repository: `main` means nothing on its
own, and two repositories' `main` branches are different objects. A worktree is
scoped the same way and identified by its path, because a checkout genuinely is
machine-local — which is why EPIC-017 deliberately kept paths off the repository.

**Observation time is explicit.** `emitGraph` takes the instant it observed, and
threads it through every relationship. Relationship identity includes `validFrom`
(EPIC-007), so a graph emitted without a shared instant would not even be
internally consistent. Git cannot say *when* a branch came to be contained by its
repository, so what Ferret records is when it looked — and Governance §6 requires
that distinction to stay visible rather than be smoothed into a confident date.

## 9. Acceptance criteria

- **AC-1** Every checkout of a repository is reported, primary first.
- **AC-2** Asking about any checkout of a repository gives the same answer.
- **AC-3** Detached, locked, prunable and bare states are reported as states, not
  as absences or errors.
- **AC-4** Local branches are reported with ref, short name, head commit,
  upstream and checked-out status.
- **AC-5** The default branch is reported when recorded and reported as unknown
  when not — never guessed.
- **AC-6** Branch listing is paged and deterministic.
- **AC-7** A repository, its worktrees and its branches form a connected graph
  with the three declared relationship types.
- **AC-8** A detached worktree is connected to no branch.
- **AC-9** Two worktrees of one repository are two entities; two repositories'
  `main` branches are two entities.
- **AC-10** Re-reading unchanged state produces identical entity ids, and one
  observation instant produces identical relationship ids.
- **AC-11** Control characters in repository-controlled text are removed, and
  everything taken from a repository is length-bounded.

## 10. Test requirements

- **Integration against real repositories:** linked worktrees, detached HEAD, a
  locked worktree, a worktree whose directory was deleted, a bare repository,
  branches with and without upstreams, a recorded and an unrecorded default
  branch, paging.
- **Graph:** the relationship set; a detached worktree connected to nothing; two
  checkouts as two entities; two repositories' `main` as two branches; a branch
  switch producing a different checkout relationship over the same worktree.
- **Idempotence:** identical entity ids on re-read; identical relationship ids
  for one observation instant.
- **Security:** control characters and length bounds on ref-derived text; a head
  commit that is not a commit id is not emitted.
- **Failure:** a repository too old or too broken to answer degrades to an empty
  list rather than failing the enumeration.

## 11. Security requirements

Ref names, lock reasons and upstream names are repository-controlled. Git forbids
control characters in ref *names*, but lock reasons are free-form, and all of it
reaches a terminal — an ANSI escape in a branch listing can rewrite what an
operator believes they are looking at. Everything taken from a repository is
stripped of control characters and length-bounded, and a `%(objectname)` that is
not a commit id is dropped rather than emitted as though it had been observed.

A repository with a million refs is either an enormous mirror or an attempt to
exhaust memory; both get the same answer, which is a bounded read and a cursor.

## 12. Observability

Every Git invocation is logged by the EPIC-017 runner. A repository that could
not be read returns an empty list rather than an exception, so a caller sees a
repository with no branches rather than a failed index.

## 13. Performance constraints

Two Git invocations per repository for worktrees plus branches, and one more for
the default ref. Process creation dominates — roughly 480 ms per invocation on
Windows — so the number of invocations per repository is the figure to watch, and
EPIC-017's performance test is where an added one becomes visible.

## 14. Definition of Done

- Both operations are declared on the capability and implemented.
- `emitGraph` produces entities, relationships and evidence together.
- Integration tests run against repositories created by real `git`, and skip
  loudly when it is absent.
- Validation evidence records every criterion with a named artefact.

## 15. Governance alignment

- **§6 Evidence** — a detached worktree is connected to nothing rather than to a
  guess; an unrecorded default branch is unknown rather than `main`.
- **§9 Context is first-class** — the whole Epic.
- **§10 Idempotent ingestion** — entity identity is content-derived; the
  residual relationship concern is recorded and owned.
- **§12 Security** — §11.
- **§13 Reliability** — an unreadable repository reduces what Ferret knows
  without breaking what it knows.
