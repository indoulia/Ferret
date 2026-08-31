# EPIC-037 — Repository Context · EPIC-038 — Worktree Context

**Status: VALIDATED | Priority: P0 (both)** — [evidence](validation/EPIC-037-038-VALIDATION.md)

> **Specification note.** Two registry entries, one document, because the second
> is where the first is *observed* and neither is coherent alone. Authored from
> the approved registry entries and Governance §6, §9, §10, §12 and §22,
> following the Epic Specification Standard. Precedent: EPIC-019/020,
> EPIC-022/023, EPIC-052/053.

## 1. Objective

**EPIC-037:** describe the repository a piece of work belongs to.
**EPIC-038:** describe the checkout it is happening in, right now.

## 2. Value

Everything Ferret knows is history. Nothing yet answers *where am I* — and that
is the first thing any answer has to be relative to.

An AI client starting a session in `C:\work\ferret` has no way to ask Ferret
which repository that is, which branch is checked out, whether the tree is
clean, or who the local Git identity belongs to. Without it every question has
to carry its own context, the client has to shell out to `git` to build it, and
two clients will build it differently.

The distinction between the two Epics is the one Governance §9 forbids
collapsing. A **repository** is the durable thing — its identity, its remotes,
its default branch. A **worktree** is a checkout of it: a path, a branch, a HEAD,
a state that changes between one question and the next. One repository has
several worktrees; a worktree can be detached from any branch. Modelling the
second as "a repository with a path" makes both unanswerable.

## 3. Scope

- resolving a working directory to the repository that contains it;
- the repository's canonical identity, remotes and default branch, reusing
  EPIC-017's discovery rather than re-deriving them;
- the worktree's path, HEAD commit, checked-out ref, and detached/bare state;
- **working-tree state**: whether there are staged, unstaged or untracked
  changes, and how many — a fact no other Epic supplies and every session needs;
- the local Git identity, classified through EPIC-036, so a session knows who is
  working;
- an `EngineeringContext` combining them, with everything optional that can
  genuinely be absent;
- the ahead/behind counts against the tracked upstream, when there is one;
- conflicted paths counted on their own, because an unmerged entry is neither
  staged nor simply modified.

## 4. Non-scope

- indexing anything. This Epic *reads* the current state; it emits no entities
  and writes nothing.
- discovering repositories by walking a tree — EPIC-017;
- listing branches or worktrees — EPIC-018;
- reading history or files — EPIC-019, EPIC-022;
- the content of the changes. Counts and paths, never a diff.
- context packs — EPIC-059. This supplies a fact; that Epic decides what fits.
- session modelling — EPIC-039.

## 5. Inputs

- a working directory;
- EPIC-017 `describeRepository` and the Git runner;
- EPIC-018's worktree listing, for the primary/linked distinction;
- EPIC-036 identity normalization and classification.

## 6. Outputs

- `describeEngineeringContext(cwd, options)` returning an `EngineeringContext`;
- `WorkingTreeState`: counts of staged, unstaged and untracked paths, and a
  bounded sample of them;
- `UpstreamState`: the tracked ref and the ahead/behind counts.

## 7. Dependencies

EPIC-017, EPIC-018, EPIC-036.

## 8. Contracts

### A repository and a worktree are separate

They are separate fields of the result, not a flattened one. Governance §9
forbids conflating them, and the shape of the answer is where that either holds
or quietly stops holding.

### Absent is absent

A directory that is not in a repository, a bare repository with no worktree, a
detached HEAD with no branch, a branch with no upstream — each is reported as
absent, never as an empty string or a zero. Governance §6: "no answer" and
"the answer is nothing" must not look the same.

### State is a count and a sample, never a diff

Working-tree state reports how many paths are staged, unstaged and untracked,
plus a bounded sample of the paths. Not the content: a diff is unbounded, is the
most sensitive thing in a working tree, and is not what "am I on a clean tree"
asks.

### Reading state never changes it

Every command is a read. Nothing fetches, nothing writes an index, nothing
touches a ref — so calling this on a colleague's machine mid-rebase is safe.

### The local identity is classified, not trusted

`git config user.email` is whatever the user set. It is normalized and
classified by EPIC-036 like any other identity, so a machine account running CI
is reported as an agent rather than as the person at the keyboard.

## 9. Acceptance criteria

- **AC-1** A directory inside a repository resolves to that repository, with its
  identity and remotes.
- **AC-2** A directory that is not in a repository yields no context, and does
  not fail.
- **AC-3** The worktree reports its path, HEAD commit and checked-out ref.
- **AC-4** A detached HEAD reports the commit and no ref, rather than a
  fabricated one.
- **AC-5** A clean tree reports zero of each count and `clean: true`.
- **AC-6** Staged, unstaged and untracked changes are counted separately and
  correctly, including a file that is both staged and modified again.
- **AC-7** The path sample is bounded, and says when it was truncated.
- **AC-8** A renamed path is reported as staged, with the new path.
- **AC-9** Upstream ahead/behind is reported when a branch tracks one, and is
  absent when it does not.
- **AC-10** The local Git identity is reported, normalized, with its actor
  class; a bot-shaped identity is reported as an agent.
- **AC-11** Nothing this Epic does mutates the repository — asserted by
  comparing the full ref set and HEAD before and after.
- **AC-12** A path containing spaces, quotes or non-ASCII is reported intact.

## 10. Test requirements

Against real Git throughout — the state of a working tree is not a thing to
mock.

- a nested directory, resolving up to the repository root;
- a directory outside any repository;
- clean, staged-only, unstaged-only, untracked-only, and all three at once;
- a file staged and then modified again, appearing in both counts;
- a rename;
- more changed paths than the sample bound;
- detached HEAD; a branch with an upstream and one without;
- a bot-shaped `user.email`;
- paths with a space, a quote and a non-ASCII character;
- a before/after comparison of every ref and of HEAD.

## 11. Security requirements

The working directory is caller-supplied and the repository it lands in is
untrusted content. Every Git invocation goes through EPIC-017's hardened runner,
which strips the environment and refuses repository-nominated programs, so a
repository cannot make reading its own state execute anything.

No diff content is read, so the most sensitive part of a working tree never
enters a result. Paths are returned verbatim but are data: nothing resolves,
opens or executes them. The configured email is personal data and is redacted
from logs by the existing rules.

## 12. Observability

The result is a plain record: every field is either a value or explicitly
absent, and the counts are numbers. A caller can log it whole, and "why does
Ferret think I am on a dirty tree" is answerable from the sample it returns.

## 13. Performance constraints

At most four Git invocations: repository description, HEAD/ref resolution,
status, and upstream counts. `git status --porcelain=v2` supplies all three
categories of change in one call, so state is one process rather than three.

## 14. Definition of Done

Implementation, integration tests against real Git for every acceptance
criterion, exports, documentation and validation evidence. No indexing, no
emission and no diff content is claimed here.

## 15. Governance alignment

- **§6 Evidence Before Inference** — absent is absent; nothing is fabricated
  for a detached HEAD or a missing upstream.
- **§9 Context Is First-Class** — this is the context every other answer is
  relative to, and repository and worktree stay distinct.
- **§10 Time and History Are First-Class** — the working tree is the one part of
  a repository that is *not* history, and is reported as the present state.
- **§12 Security** — hardened runner, no diff content, paths as data.
- **§22 Change Management** — stays within the two approved capabilities.
