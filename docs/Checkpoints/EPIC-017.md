# Development Checkpoint — EPIC-017

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-017 — Local Repository Discovery (P0, Source Discovery & Git)

**Objective:** Find the Git repositories on a machine, identify each one
canonically, and emit them as canonical entities — through the provider contract,
without the core knowing Git exists.

**Branch:** `feat/epic-017-local-repository-discovery`, cut from `main` at
`c162986`.

**Epic status:** VALIDATED — 11/11 acceptance criteria PASS. Evidence in
[`docs/EPICs/validation/EPIC-017-VALIDATION.md`](../EPICs/validation/EPIC-017-VALIDATION.md).

---

## Why this Epic came before EPIC-013–016

Registry order would put Provider Registry & Discovery, Lifecycle & Health,
Configuration & Secrets and Conformance Testing next. The delivery brief directs
otherwise: build the first complete vertical slice as soon as the dependency
chain permits, rather than waiting for all 107 Epics.

EPIC-017 is the first *real* provider, and it is what turns EPIC-011 and EPIC-012
from contracts into something demonstrable. EPIC-016 (Conformance Testing) in
particular is close to untestable before two real providers exist — which is
exactly why EPIC-011 recorded two of its own test areas as NOT APPLICABLE and
pointed at it.

---

## Completed

- **A safe Git runner** — the single point at which Ferret executes `git`, with
  argument vectors, configuration overrides for every key that names a program,
  and a scrubbed environment.
- **Filesystem discovery** — bounded in depth, breadth, count and time;
  symlink-safe; exclusion-aware; and it reports every skip with a reason.
- **Repository identity** — normalized remote, falling back to the real path of
  the common Git directory, with the fallback reported.
- **The `source.repository` capability interface**, pinned in the core as
  EPIC-012 §8 said the consuming Epic would.
- **The Git source provider** — extends `BaseProvider`, emits through an
  `Emitter`, pages through the SDK's cursor protocol, published at
  `@indoulia/ferret/git`.

## Files

```text
docs/EPICs/EPIC-017-Local-Repository-Discovery.md   the specification
src/providers/contracts/source-repository.ts       the capability interface (core)
src/git/runner.ts                                  the only place Ferret runs git
src/git/discovery.ts                               the bounded, symlink-safe walk
src/git/identity.ts                                identity and credential stripping
src/git/provider.ts                                the provider
src/git/index.ts

tests/support/git-fixtures.ts                      real repositories, created by real git
tests/unit/git-identity.test.ts                    40 cases
tests/integration/git/discovery.test.ts            39 cases
```

Modified: `src/providers/index.ts`, `src/index.ts` (contract exports),
`tests/unit/boundaries.test.ts` (Git boundary, 7 rules), `package.json`
(`./git`).

## Tests

`npm run verify` — **1,033 passed, 3 skipped** across 41 files against a live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**.

## The defects these tests caught

1. **No bare repository was ever found.** The bare check only fired when the
   directory *was* the scan root, so `/srv/git` full of `*.git` mirrors — the
   layout every Git server uses — found nothing.
2. **…and then still failed**, because `rev-parse --show-toplevel` exits 128 in a
   bare repository and the partial answer was discarded.
3. **An architecture rule that quietly found nothing** — it matched call syntax
   and so missed a promisified `execFile`. Rewritten to detect the import.

## Notes for whoever picks this up

- **Never call `child_process` from a Git module.** Use `runGit`. The safety
  overrides and the environment scrub are the reason it exists, and the boundary
  test will stop you.
- **Never build a command string.** There is no quoting or escaping anywhere in
  this Epic, because there is nothing to quote.
- **Never set `safe.directory=*`.** Git's ownership refusal is a protection, and
  it is surfaced as a reported skip.
- **Identity comes from `repositoryIdentity`,** not from an inline `replace` at a
  call site. Getting it wrong does not fail here; it fails in EPIC-051 as two
  entities that should have been one.
- **Remote URLs are masked at parse time.** Never store or log a raw one.
- **Adding a Git invocation per repository is visible** in the performance test:
  process creation is ~480 ms on Windows and dominates everything else.

## Blockers

None.

## Known limitations

Full table in the validation evidence §8. Carried forward:

- A page is not a snapshot; paging re-walks to the last returned repository
- Machine-local paths stay in `unknownFields` — a checkout is a worktree →
  **EPIC-018**
- Identity uses `origin` only; a fork and its upstream stay separate →
  **EPIC-051**
- Submodules only with `includeNested` → **EPIC-018**
- No `defaultBranch`, because refs are the next Epic's subject → **EPIC-018**
- No incremental discovery → **EPIC-032**
- Not wired to a CLI command → **EPIC-031**
- `safe.directory` refusals surface as a generic skip → **EPIC-018**

## Next step

**EPIC-018 — Branch & Worktree Discovery.** It has the most to build on here:
`DiscoveredRepository` already carries `gitDir`, `commonGitDir` and
`linkedWorktree`, which is exactly the material a worktree entity needs, and
three of this Epic's limitations close with it.

Governance §9 is the thing to get right: a branch, a worktree and a repository
are three different entities, and the distinction is the whole reason Ferret can
answer "what was I working on" rather than "what is checked out". EPIC-006
already ships `branch` and `worktree` kinds and EPIC-007 ships
`repository_contains_worktree`, `worktree_checks_out_branch` and
`branch_points_to_commit` — including the exclusivity constraint that a worktree
checks out exactly one branch at a time, which EPIC-007's advisory-lock
reconciliation exists to enforce.

Then **EPIC-019/020** (history and commit modelling), **EPIC-022/023** (files),
and the slice reaches storage at **EPIC-031**.
