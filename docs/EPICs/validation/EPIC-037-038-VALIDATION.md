# EPIC-037 — Repository Context · EPIC-038 — Worktree Context: validation evidence

**Status: VALIDATED (both)** · no new dependency, no writes. Four local Git
reads, all through EPIC-017's hardened runner.

## What the Epics do

`describeEngineeringContext(cwd, options)` answers *where am I*: the repository
containing a directory, the checkout it is happening in, that checkout's
working-tree state, its upstream position, and the local Git identity classified
through EPIC-036.

Repository and worktree are separate fields of the result, not one flattened
record. Governance §9 forbids conflating them, and the shape of the answer is
where that either holds or quietly stops holding.

## Acceptance criteria

All rows are `tests/integration/git/engineering-context.test.ts`, against real
Git.

| AC | Result | Evidence |
| --- | --- | --- |
| AC-1 a nested directory resolves to its repository | PASS | `resolves a nested directory to its repository` — asserts the identity key *and* that the worktree path is the checkout root, not the directory asked about |
| AC-2 outside a repository yields nothing, not a failure | PASS | `answers with nothing outside a repository, rather than failing`; plus `refuses a relative directory`, which is a usage error and is different |
| AC-3 path, HEAD commit and ref | PASS | `reports the branch and the HEAD commit` |
| AC-4 detached HEAD reports no fabricated branch | PASS | `reports a detached HEAD as detached, with no fabricated branch` |
| AC-5 a clean tree is clean | PASS | `reports a clean tree as clean` — all four counts zero |
| AC-6 staged, unstaged and untracked counted separately | PASS | `counts staged, unstaged and untracked separately`; `counts a file staged and then modified again in both` |
| AC-7 the sample is bounded and says so | PASS | `bounds the sample and says it was truncated` — 60 untracked files, exact count, 50 sampled, `sampleTruncated` true |
| AC-8 a rename is staged, with the new path | PASS | `reports a rename as staged, with the new path` — and asserts the *original* path is not counted as a second change |
| AC-9 upstream present and absent | PASS | `is absent when a branch tracks nothing`; `reports ahead and behind against a tracked ref`, against a real clone |
| AC-10 local identity normalized and classified | PASS | `is normalized and classified`; `reports a machine account as an agent`; `is absent when Git has no address to give` |
| AC-11 reading state never changes it | PASS | `leaves every ref and HEAD exactly as they were` — full ref set, symbolic HEAD and porcelain status compared before and after two calls; plus `does not run a program the repository nominates` |
| AC-12 awkward paths survive intact | PASS | `reports awkward paths intact` — a space, a single quote and non-ASCII |

Four parser cases are unit-level within the same file — initial commit,
unmerged path, a path containing spaces, and ahead/behind — because those are
states that are awkward to arrange and trivial to express as input.

## Design decisions worth recording

**One `git status`, not three commands.** `--porcelain=v2 --branch -z` reports
the branch, the upstream, the ahead/behind counts *and* every change category in
a single invocation. The whole context is four processes rather than seven.

**`-z`, so paths are never unescaped.** The line-based format quotes a path
containing a space or a non-ASCII byte, and un-quoting it correctly is a step
that is easy to get subtly wrong. With `-z` a path is the rest of its record,
verbatim. The awkward-paths test is what holds that.

**Counts and a sample, never a diff.** A diff is unbounded, is the most
sensitive thing in a working tree, and is not what "am I on a clean tree" asks.
The counts are exact; only the path list is bounded, and it says when it was cut.

**A conflicted path is counted on its own.** Not as staged and not as modified:
an unmerged entry is neither, and reporting it as either would make "is this
tree ready to commit" answer wrongly.

**A file staged and then modified again is counted in both.** That is what
`git status` itself shows, and it is the honest answer — the file has a staged
version and a different working copy.

**`--show-toplevel` rather than walking up for `.git`.** The naive walk is wrong
for a linked worktree, where `.git` is a file, and wrong for a submodule, where
it finds the parent.

**`describeRepository` is injected, not imported.** Otherwise this module would
depend on the provider that depends on it, and EPIC-017's identity derivation
would end up with a second implementation.

**`signal` is optional here and required everywhere else.** "Where am I" is four
local reads that finish in milliseconds, and an AI client asking it at the start
of a session has no signal to thread through. Every other Git entry point keeps
it required, because every other one can run for a long time. The first run of
the suite failed with `Cannot read properties of undefined (reading 'aborted')`,
which is what made the decision explicit rather than accidental.

**The local identity is classified, not trusted.** `user.email` is whatever the
user set, so a machine account running CI is reported as an agent rather than as
the person at the keyboard.

## A test that had to be rewritten

`is absent when nothing is configured` originally ran `git config --unset
user.email` and asserted no identity. That passes on a machine with no global
Git identity and fails on every developer's laptop — and *the failure was
right*: with a global identity configured, Git still has an answer, and
reporting it is correct, because that is who a commit there would be attributed
to. The test now sets the address to empty, which is the deterministic form of
"no address" and exercises the branch that actually matters.

## Limitations

- **Nothing consumes this yet.** No MCP tool exposes it and no session records
  it. That is the point at which it becomes useful, and it belongs to EPIC-059
  and EPIC-039 respectively.
- **Nothing is emitted.** This Epic reads the present state; it creates no
  entities, so "what did the tree look like an hour ago" is unanswerable. The
  working tree is deliberately not history.
- **`--untracked-files=all` walks the whole tree.** On a repository with a large
  ignored-but-not-listed directory this is the slowest of the four calls. It is
  the right default — an untracked file count that stops at directory level is
  misleading — but it is not free.
- **The sample is Git's order, not a chosen one.** The first fifty paths are
  whatever `git status` lists first, which is roughly alphabetical and is not a
  judgement about which fifty matter.
- **Stash, in-progress rebase and bisect state are not reported.** `status`
  supplies some of this and none of it is read yet.
- **Submodule status is collapsed.** A dirty submodule appears as one changed
  path, with no detail about what is dirty inside it.
- **Only the current worktree.** EPIC-018 lists the others; this describes the
  one the directory is in, and does not relate them.

## Suite

`npm run lint`, `npm run typecheck` and `npm run build` clean.
`vitest run tests/unit`: 36 files, 1023 passed.
`vitest run tests/integration/git/engineering-context.test.ts`: 22 passed,
against real Git.
