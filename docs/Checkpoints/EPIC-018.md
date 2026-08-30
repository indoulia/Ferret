# Development Checkpoint — EPIC-018

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-018 — Branch & Worktree Discovery (P0, Source Discovery & Git)

**Branch:** `feat/epic-018-branch-worktree-discovery`, cut from `main` at
`8a1a233`.

**Epic status:** VALIDATED — 11/11 acceptance criteria PASS. Evidence in
[`docs/EPICs/validation/EPIC-018-VALIDATION.md`](../EPICs/validation/EPIC-018-VALIDATION.md).

---

## Completed

- `listWorktrees` — every checkout, primary first, with detached, locked,
  prunable and bare reported as states.
- `listBranches` — paged, with head commit, upstream, checked-out status and the
  default ref when the repository records one.
- `emitGraph` — `worktree` and `branch` entities plus
  `repository_contains_branch`, `repository_contains_worktree` and
  `worktree_checks_out_branch`, all sharing one observation instant.
- Control-character stripping and length bounds on everything taken from a
  repository.

## Files

```text
docs/EPICs/EPIC-018-Branch-Worktree-Discovery.md   the specification
src/git/refs.ts                                    worktree and branch readers
tests/integration/git/refs.test.ts                 26 cases
```

Modified: `src/providers/contracts/source-repository.ts` (worktree and branch
shapes, two new operations), `src/git/provider.ts` (`listWorktrees`,
`listBranches`, `emitGraph`), `src/git/index.ts`, `src/providers/index.ts`,
`src/index.ts`, `src/providers/sdk/rate-limit.ts` (a real defect — see below),
`tests/integration/provider-sdk/concurrency.test.ts`,
`tests/integration/packaging.test.ts`, `tsconfig.build.json`, `package.json`.

## Tests

`npm run verify` — **1,059 passed, 3 skipped** across 42 files against live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` — 0.

## The defects this Epic caught (three of them outside its own code)

1. **`RateLimiter`'s drain timer was `unref()`d.** It is only ever scheduled when
   somebody is waiting, and an awaited promise does not keep the event loop
   alive — so a process whose only outstanding work was a rate-limited request
   could exit with it unresolved. Found by rewriting a flaky test to use a frozen
   clock, which removed the timer noise that had been masking it.
2. **Relationship identity includes `validFrom`,** so a provider that lets it
   default mints a new id per edge per emission. `emitGraph` now takes the
   observation instant explicitly. The residual — two runs, two ids for one edge
   — is EPIC-031's to collapse, and is the most important line in the validation
   document.
3. **The published package shipped 107 kB of declaration maps** pointing at
   sources it does not contain, and `npm run build` did not clean, so they
   survived the config change that stopped producing them. Both fixed.
4. **A premise of mine was wrong:** Git forbids spaces in ref names. The
   NUL-separated format is still right, for the better reason that `%(upstream)`
   is empty and `%(HEAD)` is a space.

## Notes for whoever picks this up

- **`listWorktrees` takes a repository, not a path,** and asks the *common* Git
  directory. A linked worktree and its primary share one repository; if the
  answer depended on which directory a walk reached first, the graph would
  disagree with itself.
- **Pass `observedAt` to `emitGraph`** whenever you emit more than one graph in a
  run, or the edges will disagree about when they were seen.
- **Never guess a default branch.** `refs/remotes/origin/HEAD` or unknown.
  `main` is wrong for every repository that predates 2020.
- **Ref text is untrusted.** `sanitizeRefText` for anything a repository
  supplied, including lock reasons and upstream names.
- **Do not emit an edge to an entity nobody will create.** That is why
  `branch_points_to_commit` is absent despite the SHA being right there.

## Blockers

None.

## Known limitations

Full table in the validation evidence §8. The one that matters:

- **Two runs at two instants emit the same edge with two relationship ids.**
  Unbounded row growth for unchanged content unless ingestion treats an open
  interval with identical endpoints as a no-op → **EPIC-031**

Also carried: no `branch_points_to_commit` → **EPIC-019/020**; no tags or remote
refs → **EPIC-020**; no reflog, so no valid-time for a checkout → **EPIC-019**;
submodules → **EPIC-019**; macOS → **EPIC-105**.

## Next step

**EPIC-019 — Git History Ingestion**, then **EPIC-020 — Commit & Reference
Modeling**. They are close enough that they may share a branch: EPIC-019 reads
commits and their changes, EPIC-020 gives them canonical identity and connects
them to branches, files and developers. Together they close
`branch_points_to_commit`, `commit_parent_of_commit`, `commit_modifies_file` and
`developer_authored_commit`.

The things to get right there:

- **`git log` output is unbounded.** A repository with a million commits must be
  read incrementally, with a cursor, and never buffered whole. EPIC-017's runner
  has a 16 MiB output cap that will fire long before memory does — that is a
  feature, and the reader must page rather than raise it.
- **Author identity is not an email address.** One person commits as several,
  and EPIC-036 resolves them. EPIC-006's `developer` kind already models
  `emails` as a list for exactly this reason; do not collapse it.
- **Commit identity is the SHA, but scoped.** The same commit exists in a fork
  and in its upstream, which are different repositories by EPIC-017's rules.
  Whether that is one commit entity or two is a real decision, and it belongs in
  EPIC-020's specification rather than being made by accident.
