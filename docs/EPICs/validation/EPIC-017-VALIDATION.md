# EPIC-017 — Validation Evidence

**Epic:** EPIC-017 — Local Repository Discovery
**Branch:** `feat/epic-017-local-repository-discovery`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it.

> **Specification note.** EPIC-017 had no specification file — the registry
> approved the capability by name, domain and priority. The specification was
> written first, to the approved standard, from the registry entry, Governance
> §9, §10 and §12, and TECHNOLOGY-DECISIONS §5, and is part of this change. **The
> acceptance criteria validated below are therefore ones this work authored.**
> The specification is in the diff for review.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Repositories are discovered under declared roots, including bare repositories and linked worktrees | **PASS** | `discovery.test.ts` → "finds a repository under a root", "finds a bare repository, which has no working tree", "treats five worktrees of one clone as one repository with five checkouts". All against repositories created by real `git`. |
| AC-2 | A canonical key is identical across clones of one remote and different for different repositories | **PASS** | "gives two clones of one remote the same identity, at different paths" (SSH and HTTPS forms of one remote → one key); `git-identity.test.ts` → "unifies every form of the same repository", "keeps two remoteless repositories apart". |
| AC-3 | Discovery honours exclusions, a depth bound and a result bound, and reports what it skipped | **PASS** | "honours exclusion rules", "stops at its depth bound and says that it did", "reports a root that does not exist rather than failing the walk". Each asserts the *skip report*, not just the omission. |
| AC-4 | Discovery is cancellable and resumable | **PASS** | "stops a walk when it is cancelled"; "pages through repositories and stops when the enumeration ends"; "refuses a cursor issued for a different set of roots"; "refuses a cursor issued by a different provider". |
| AC-5 | Git is never executed through a shell, nor with a caller-controlled command string | **PASS** | `boundaries.test.ts` → "never runs a subprocess through a shell" reads the source and asserts no `exec`/`execSync` and an explicit `shell: false`; "can start a subprocess from exactly two modules, both named". Behaviourally: "treats a directory named like a shell command as a directory". |
| AC-6 | Executing Git in an untrusted repository cannot run a program that repository chose | **PASS** | "does not run a program a repository nominates in its own configuration" — a real repository with `core.hooksPath`, `core.pager`, `core.fsmonitor` and `credential.helper` all pointing at a marker-writing script. The test carries a **control** that runs ordinary Git first, to prove the fixture really can execute, before concluding anything from Ferret's behaviour. See §3.4. |
| AC-7 | A credential in a remote URL is never emitted, stored or logged | **PASS** | "never emits a token that was sitting in .git/config" — a real repository whose `origin` carries a token; the token appears in neither the discovery result, the entity, nor the evidence, and identity still unifies with the clean form. Plus 6 unit cases. |
| AC-8 | A symlink cannot leave the root or cause a loop | **PASS** | "does not follow a symbolic link out of its root" (both with and without following enabled) and "does not loop on a symbolic link back up its own tree" — the latter does not terminate without the visited set. |
| AC-9 | Missing Git, an unreadable directory, or a corrupt repository degrade to a reported state | **PASS** | "reports a directory that is not a repository, and keeps walking"; "reports a root that does not exist rather than failing the walk"; the whole suite skips **loudly** when `git` is absent, and `checkDependencies` reports it. |
| AC-10 | Repositories are emitted as canonical entities with attributed evidence | **PASS** | "produces a repository entity with attributed evidence" — every record carries producer, producer version, source system and `observed`; "emits the same canonical id however the repository was reached". |
| AC-11 | The core cannot reach the Git provider, enforced by test | **PASS** | `boundaries.test.ts` → "git source provider boundary" (7 cases): the core reaches no `git/` module, the contract reaches no implementation, and Git adds no dependency of its own. |

**11 / 11 PASS.**

---

## 2. Test requirements

| Required test | Status | Location |
| --- | --- | --- |
| Unit — URL normalization, identity, argument and environment construction | PASS | `tests/unit/git-identity.test.ts`, 40 cases |
| Integration against real repositories | PASS | `tests/integration/git/discovery.test.ts`, 38 cases — clone, bare, linked worktree, nested repository, no remote, several remotes |
| Security | PASS | §4 |
| Failure — Git absent, unreadable directory, invalid `.git`, relative root | PASS | "degrading rather than breaking" (6 cases) |
| Concurrency | PASS | "runs many discoveries concurrently without interfering" (8 in flight); cancellation mid-walk |
| Durability — deep tree, wide tree, loop termination | PASS | depth bound, 500-directory walk, symlink loop |
| Performance | PASS | §6 |
| Architecture | PASS | `boundaries.test.ts` → "git source provider boundary" |

`npm run verify` — **1,032 passed, 3 skipped** across 41 files against a live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**.

---

## 3. Defects these tests caught

### 3.1 No bare repository was ever discovered

`looksBare` only fired when the directory under examination **was the scan
root**, so a walk of `/srv/git` full of `*.git` mirrors — the layout every Git
server on earth uses — found nothing at all. Fixed to Git's own test (`objects/`,
`refs/`, a `HEAD` file) applied at any depth.

### 3.2 …and then a bare repository still failed, for a second reason

With detection fixed, every bare repository was reported as *not a repository*.
`git rev-parse --show-toplevel` fails in a bare repository — there is no work
tree — and it was the last of five options in a single invocation, so the whole
call exited 128 and the partial answer was discarded.

The fix accepts the partial answer, because it is unambiguous: `rev-parse` has
already printed `--is-bare-repository true` by the time it refuses. The
alternative — asking separately — would cost a third subprocess for every
ordinary repository to accommodate the rare one.

Both defects were found by a single fixture: a bare repository created by real
`git`. Neither would have been found by a fake.

### 3.3 A security test that passed for the wrong reason on one platform

The first version of the hostile-configuration test applied its configuration
**before** the fixture's first commit — so the fixture's own `git add` ran the
file-system monitor it had just installed, and the marker file appeared. On
Windows a `#!/bin/sh` script does not run, so nothing happened and the test
passed locally. On Linux CI it failed.

That is the worst possible way round: green where the vector cannot fire, red
where it can. Two fixes, and the second is the important one:

- the fixture applies hostile configuration **last**, so the only invocations
  that meet it are Ferret's;
- the test now runs a **control** — an ordinary `git status` with none of
  Ferret's overrides — and asserts the marker appears, *before* concluding
  anything from Ferret's behaviour. Where the control does not fire, the test
  says so on stderr rather than reporting a protection it did not observe.

Without a control, this test would have passed just as happily if Ferret had no
protection at all. That is the version that was written first, and it is worth
recording that CI caught it rather than review.

### 3.4 An architectural control that quietly found nothing

The first version of the "exactly one module executes subprocesses" rule matched
call syntax — `execFile(`, `spawn(` — and therefore missed
`environment/detect.ts` entirely, because it calls a promisified alias. A control
that finds nothing reports success either way, which is worse than not having it.
Rewritten to detect the **import** of `node:child_process`, which nothing can
launch a process without.

---

## 4. Security

The first Epic in which Ferret runs a program next to content it does not trust.

| Threat | Handling | Test |
| --- | --- | --- |
| **Shell injection through a path.** `exec('git -C ' + path)` makes a directory named `foo; rm -rf ~` into a command. | There is no command *string* anywhere in this Epic. `execFile` with an argument vector and `shell: false`. | Source-level assertion, plus a fixture directory literally named with shell metacharacters. |
| **Argument injection.** A directory named `--upload-pack=evil` is not a shell problem — Git reads it as an option. | Paths are resolved absolute and passed through `-C`, where Git takes the next token as a value. | A fixture directory named `--upload-pack=evil`. |
| **Arbitrary execution through repository configuration.** `core.hooksPath`, `core.fsmonitor`, `core.pager`, `credential.helper`, `core.sshCommand` each name *a program to run*, and a repository sets them in its own config. A repository Ferret clones for indexing can execute code by being looked at. | Every invocation overrides all of them with `-c key=value`, which is the highest-precedence configuration layer Git has. | A real repository configured to run a marker-writing script. A **control** runs ordinary Git first and asserts the marker *does* appear, so the test cannot pass merely because the platform could not execute it — which is exactly how its first version passed on Windows (§3.3). |
| **Environment redirection.** `GIT_DIR` and friends silently point Git at a different repository, so every fact Ferret records attaches to the wrong entity. | Twenty variables removed from the inherited environment; three forced. | "ignores an environment variable trying to redirect Git" — `GIT_DIR` set to a decoy repository, and Ferret still answers about the real one. |
| **Credentials in remote URLs.** `git clone` with a token writes it into `.git/config`, where it stays. Ferret reads that config. | Userinfo stripped during normalization, before the URL reaches an entity, a log or an error. The runner also masks userinfo in its trace log. | 7 cases; the token appears in nothing. |
| **Escaping the scan root.** A link to `/` turns "index my projects" into "index this machine". | Links are not followed by default. When following is enabled, every candidate is resolved and refused if it leaves the root — by path arithmetic, not string prefix. | 2 cases; `isWithin` unit-tested against the `/home/user2` prefix trap. |
| **A walk that never ends.** | Depth, a 250,000-directory backstop, a per-invocation timeout, an output-size cap, and a set of visited real paths. | Symlink-loop case does not terminate without the visited set. |
| **Credential prompting as a hang.** | `GIT_TERMINAL_PROMPT=0`, ask-pass helpers removed. | Asserted on the scrubbed environment. |
| **Ownership.** | Git's `safe.directory` refusal is surfaced as a skip with a reason. Ferret does **not** set `safe.directory=*`. | "does not disable Git's own ownership check" asserts the absence. |
| **Lock contention.** | `GIT_OPTIONAL_LOCKS=0` — a background index must not compete with the developer in the same repository. | Asserted. |

---

## 5. Concurrency

| Property | How it is proven |
| --- | --- |
| Walks do not share state | 8 concurrent discoveries over one tree return identical results |
| A walk stops when cancelled | An aborted context raises `E_INTERRUPTED` rather than completing |
| Lifecycle is inherited, not rewritten | The provider extends `BaseProvider`, so EPIC-012's concurrency suite covers its initialize/shutdown behaviour |

---

## 6. Performance

Regression ceilings, not targets: this walks a filesystem Ferret does not
control, and spawns processes, on CI hardware that varies. Observed figures are
from a Windows development machine, where process creation is expensive.

| Measurement | Observed | Budget |
| --- | --- | --- |
| Walking a 500-directory tree for one repository | ~2.1 s | 30 s |
| Identifying 25 repositories (2 Git invocations each) | ~24 s | 60 s |

The second figure is dominated entirely by process creation — roughly 480 ms per
`git` invocation on Windows. It is the number to watch: an Epic that adds a third
invocation per repository will show here immediately.

---

## 7. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| The capability interface is pinned and exported from the core | **PASS** | `src/providers/contracts/source-repository.ts`, exported from `src/index.ts`; EPIC-012 §8 said the consuming Epic would pin it, and this is that Epic. |
| The Git provider implements it, extends `BaseProvider`, declares its capability and limits, and ships under its own subpath | **PASS** | `src/git/`, `@indoulia/ferret/git`; "is selected by capability, never by name". |
| Every security requirement has a test that would fail without it | **PASS** | §4 — each row names its test. |
| Integration tests run against real `git`, and skip loudly | **PASS** | `tests/support/git-fixtures.ts`; the skip writes an explicit warning naming what is not covered. |
| Validation evidence records every criterion | **PASS** | This document. |

---

## 8. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| **A page is not a snapshot.** Paging re-walks the tree to the last repository returned, rather than carrying the walk's frontier. A repository created between two pages may appear; one deleted may vanish. | Declared in the provider's `limits.notes` rather than hidden. Carrying a frontier in a cursor would be unbounded in size and stale the moment a directory changed — and a cursor travels to an AI client and returns minutes later. A caller needing a snapshot takes one walk with no limit. | — |
| **Machine-local paths are not canonical attributes.** EPIC-006 models `attributes.path`, and this Epic deliberately does not populate it. | Two machines sharing one Ferret database would overwrite each other's copy of the same row for ever. Governance §9 has the better home: a checkout is a *worktree*, which is its own entity. The paths are carried verbatim in `unknownFields` so nothing is lost. | **EPIC-018** |
| Only `origin` (or the first remote) decides identity. A repository whose `origin` points at a personal fork will not unify with one pointing at upstream. | Correct today — they *are* different repositories to Git — and resolving them is a deliberate judgement, not a discovery one. | **EPIC-051** (Cross-Source Entity Resolution) |
| Submodules are found only when `includeNested` is set. | A submodule is reachable from its parent's configuration, which EPIC-018/019 will read directly. Descending through every repository looking for a stray nested one turns a one-second walk into a minute. | **EPIC-018** |
| No `defaultBranch` is reported, although the canonical model has the attribute. | Refs are EPIC-018's subject, and reading one here would be a second invocation for a fact the next Epic is about to read properly. | **EPIC-018** |
| No incremental discovery: Ferret cannot say which repositories appeared since a given moment. | Not claimed — `supportsIncremental` is deliberately absent from the declared limits. It needs a filesystem watcher. | **EPIC-032** |
| Discovery is not wired to a CLI command. | The provider is composable and tested through the registry; a `ferret index` command belongs with the Epic that has something to index *into*. | **EPIC-031** |
| The `safe.directory` refusal surfaces as a generic "not a repository" skip rather than naming ownership as the cause. | The reason reaches the skip's `detail` from Git's own stderr, so the information is present but not classified. | **EPIC-018** |
| macOS unvalidated. | Inherited from EPIC-001/EPIC-005. Symlink tests self-report when the platform refuses link creation. | **EPIC-105** |
