# EPIC-018 — Validation Evidence

**Epic:** EPIC-018 — Branch & Worktree Discovery
**Branch:** `feat/epic-018-branch-worktree-discovery`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

> **Specification note.** EPIC-018 had no specification file — the registry
> approved the capability by name, domain and priority. The specification was
> written first, to the approved standard, and is part of this change. **The
> acceptance criteria validated below are therefore ones this work authored.**

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Every checkout reported, primary first | **PASS** | `refs.test.ts` → "reports the primary worktree of an ordinary repository", "reports every linked worktree, primary first" (3 checkouts). |
| AC-2 | Any checkout of a repository gives the same answer | **PASS** | "gives the same answer whichever checkout it is asked about" — asked of a linked worktree and of the primary; identical lists. |
| AC-3 | Detached, locked, prunable and bare reported as states | **PASS** | 4 cases, each against a real fixture — including a worktree whose directory was deleted behind Git's back. |
| AC-4 | Branches with ref, short name, head commit, upstream, checked-out status | **PASS** | "lists local branches with their head commits", "marks the branch this checkout is on", "reports an upstream when one is configured". |
| AC-5 | Default branch reported when recorded, unknown when not — never guessed | **PASS** | "reports the default branch as unknown when the repository records none" and "…when the repository does record one". Guessing `main` is wrong for every repository that predates 2020. |
| AC-6 | Branch listing paged and deterministic | **PASS** | "pages through branches deterministically" — 10 branches in pages of 3, asserted sorted and complete; "refuses a branch cursor from a different provider". |
| AC-7 | A connected graph with the three declared relationship types | **PASS** | "connects a repository to its branches and its checkouts" — exact entity kinds and exact relationship types asserted. |
| AC-8 | A detached worktree is connected to no branch | **PASS** | "does not connect a detached worktree to a branch it is not on". |
| AC-9 | Two worktrees are two entities; two repositories' `main` are two branches | **PASS** | "gives two worktrees of one repository two different identities", "scopes a branch to its repository, so two `main`s are two branches". |
| AC-10 | Identical entity ids on re-read; identical relationship ids for one instant | **PASS** | "emits identical entity ids for an unchanged repository read twice", "emits identical relationship ids for one observation instant". See §3.2 for what this does *not* claim. |
| AC-11 | Control characters removed, repository-derived text bounded | **PASS** | "strips control characters from repository-controlled text" (ANSI escapes), "bounds the length of anything it takes from a repository", "does not emit a branch whose head is not a commit id". |

**11 / 11 PASS.**

---

## 2. Test requirements

| Required test | Status | Location |
| --- | --- | --- |
| Integration against real repositories | PASS | `tests/integration/git/refs.test.ts`, 26 cases |
| Graph shape and exclusivity behaviour | PASS | 7 cases, including a branch switch over one worktree |
| Idempotence | PASS | 3 cases |
| Security — control characters, bounds, malformed head | PASS | 3 cases |
| Failure — unreadable repository degrades to an empty list | PASS | `listWorktrees`/`listBranches` return `[]` on non-zero exit; exercised by the bare-repository and prunable fixtures |

`npm run verify` — **1,059 passed, 3 skipped** across 42 files against a live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**.

---

## 3. Defects and design problems these tests caught

### 3.1 A rate-limiter timer that could let a process exit mid-request

Found by a test written for *this* Epic's idempotence work, in EPIC-012's code.

`RateLimiter`'s drain timer was `unref()`d, on the reasoning that a pending
refill should not keep the process alive. That reasoning is wrong: the timer is
only ever scheduled when somebody is **waiting**, and an awaited promise does not
keep the event loop alive by itself. A Ferret process whose only outstanding work
was a rate-limited request could therefore exit with that request unresolved —
silently, and only under exactly the conditions where the rate limit was doing
its job.

It surfaced because a flaky test was rewritten to use an injected frozen clock,
which removed the incidental timer activity that had been masking it.
`withDeadline` keeps its `unref()`, correctly: a deadline is a bound on work, not
work.

### 3.2 Relationship identity includes `validFrom`, and a provider must not let it default

`createRelationship` puts `validFrom` in the relationship's identity and defaults
it to `new Date()`. A provider that lets it default therefore mints a **new
relationship id for every edge in a single emission** — so a graph read in one
pass would not even be internally consistent, let alone idempotent, and a repeated
index of an unchanged repository would insert new rows for ever.

Fixed here by making the observation instant an explicit parameter of
`emitGraph`, threaded through every relationship. What remains is recorded rather
than hidden: two runs at two instants still describe the same edge with two ids,
and collapsing that is the ingestion layer's job. See §7.

### 3.3 A flaky test in the reliability suite

"loses no budget to waiters that gave up" used real time at 100 tokens a second,
so tokens refilled while twenty waiters were being queued and aborted and the
head was sometimes granted before its abort arrived. It passed alone and failed
under load. A reliability suite that is itself unreliable teaches nobody
anything; rewritten with an injected clock held still, so any grant is the
limiter losing track of its budget rather than the clock moving.

### 3.4 A published package full of maps that could not work

The tarball shipped 107 kB of `.d.ts.map` files pointing at `../src/**.ts`, which
is not in the package. A declaration map to a file that is not there is worse
than none — an editor asked to "go to definition" fails to resolve rather than
falling back to the declaration. Stopped emitting them, and added an assertion
that no `.map` ships.

Fixing it revealed a second thing: `npm run build` did not clean, so the stale
maps survived the config change that stopped producing them. **A build that
leaves removed artifacts behind will eventually publish a file the source no
longer produces.** `build` now cleans first.

### 3.5 A premise of mine that was simply wrong

The first branch test asserted that Git permits a space in a branch name. It does
not — ref names forbid space, `~`, `^`, `:`, `?`, `*`, `[` and control
characters. The NUL-separated `for-each-ref` format is still right, but for a
different and better reason: `%(upstream)` is *empty* for an untracked branch and
`%(HEAD)` is a single space for one that is not checked out, so a
whitespace-delimited parse silently shifts every field along. The test now
asserts that.

---

## 4. Security

| Concern | Handling | Test |
| --- | --- | --- |
| ANSI escapes in repository-controlled text reaching a terminal | Control characters stripped from every ref, upstream and lock reason. | "strips control characters from repository-controlled text" |
| Unbounded text from a repository | 512 characters. | "bounds the length of anything it takes from a repository" |
| A repository with a million refs | Bounded read (10,000) with a cursor; a bounded `--count` is passed to Git so it does not produce the output either. | Paging cases |
| A `%(objectname)` that is not a commit id | Dropped rather than emitted as though observed. | "does not emit a branch whose head is not a commit id" |
| Subprocess safety | Inherited from EPIC-017's runner, which is the only module that executes Git. | `boundaries.test.ts` |

---

## 5. Concurrency

`worktree_checks_out_branch` is exclusive from the worktree (EPIC-007), which is
the constraint that makes a branch switch *history* rather than a contradiction.
"produces a different checkout relationship after a branch switch" asserts the
emission side: the worktree entity is unchanged, the branch it points at is not.
The reconciliation that enforces exactly one open interval under concurrent
writers is EPIC-007's, and is already covered by its own advisory-lock suite.

---

## 6. Performance

No new budget. The figure that matters is Git invocations per repository, and
EPIC-017's "identifies repositories at a bounded cost per repository" is where an
added one becomes visible — process creation is roughly 480 ms on Windows and
dominates everything else. This Epic adds three invocations, but only for
repositories a caller explicitly asks about, not for every one discovered.

---

## 7. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Both operations declared on the capability and implemented | **PASS** | `RepositoryOperation.LIST_WORKTREES` / `LIST_BRANCHES` in the declaration; `GitSourceProvider` implements `RepositorySource`. |
| `emitGraph` produces entities, relationships and evidence together | **PASS** | "connects a repository to its branches and its checkouts". |
| Integration tests against real `git`, skipping loudly | **PASS** | `refs.test.ts` writes an explicit warning naming what is not covered. |
| Validation evidence records every criterion | **PASS** | This document. |

---

## 8. Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Two runs at two instants emit the same edge with two relationship ids.** Identity includes `validFrom` and Git cannot say when a branch came to be contained by its repository. | Within one run everything is consistent, and entity ids are stable for ever. But a repeated index of an *unchanged* repository would insert new relationship rows each time — unbounded growth for content that did not change, which Governance §10 forbids. The ingestion layer must treat an open interval with identical endpoints and metadata as a no-op. **This is the most important thing in this document.** | **EPIC-031** |
| `branch_points_to_commit` is not emitted, although the head commit is known. | There is no commit entity to point at yet, and emitting a relationship to an id nothing will ever create would be a dangling edge. The SHA is carried on the branch's attributes so nothing is lost. | **EPIC-019/EPIC-020** |
| Remote-tracking branches and tags are not listed. | Only `refs/heads/`. A repository's tags and its remote refs are a different question, asked by a different Epic. | **EPIC-020** |
| Ferret cannot say *when* a checkout moved to a branch, only that it has. | The reflog knows, and reading it is EPIC-019's subject. Until then `validFrom` is Ferret's observation time, which is stated rather than dressed up. | **EPIC-019** |
| A worktree's path is taken from Git's own metadata and is not checked for containment. | Ferret records it; it does not traverse it, so a path outside any scan root is a reported fact rather than an action. Traversal of worktree paths would need EPIC-017's containment check applied. | **EPIC-022** |
| Submodules are still not modelled. | `.gitmodules` is the right source and is EPIC-019's to read. | **EPIC-019** |
| macOS unvalidated. | Inherited. | **EPIC-105** |
