# EPIC-019 & EPIC-020 — Validation Evidence

**Epics:** EPIC-019 — Git History Ingestion; EPIC-020 — Commit & Reference Modeling
**Branch:** `feat/epic-019-020-git-history`
**Recorded:** 2026-08-30

Two Epics, one branch: EPIC-020 has nothing to model until EPIC-019 has read it,
and EPIC-019 has no consumer until EPIC-020 emits. Each has its own
specification and its own criteria, evidenced separately below.

> **Specification note.** Neither Epic had a specification file. Both were
> written first, to the approved standard. **The acceptance criteria validated
> below are therefore ones this work authored.**

---

## 1. EPIC-019 acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Commits read newest first with metadata and parentage | **PASS** | `history.test.ts` → "reads commits newest first, with their metadata" — order, author address, and a root commit with no parents. |
| AC-2 | A multi-line commit message survives intact | **PASS** | "reads a multi-line commit message intact"; `git-history-parser.test.ts` → "reads a multi-line body without treating a newline as a boundary". |
| AC-3 | Add, modify, delete, rename and copy distinguished; a rename carries both paths | **PASS** | Parser: "reads a rename, which is three tokens where everything else is two", "reads a copy the same way", 4 status cases. Integration: "reads a rename as a rename, with both paths" (similarity 100), "reads a deletion". |
| AC-4 | A merge reports two parents and no changes | **PASS** | "reads a merge commit's parents, and reports no changes for it"; parser: "gives a merge commit no changes, because Git reports none". |
| AC-5 | Paged, and an incremental read reads only what is newer | **PASS** | "pages through history" (6 commits in pages of 2); "reads only what is new when given an instant". |
| AC-6 | An option-shaped revision is refused | **PASS** | "refuses a revision that would be read as an option"; 4 unit cases on `assertSafeRevision`. |
| AC-7 | A ref that does not exist answers with nothing | **PASS** | "answers with nothing for a ref that does not exist". |
| AC-8 | Control characters stripped; fields and paths bounded | **PASS** | 5 unit cases: ANSI escapes stripped from a subject, newlines and tabs kept, 8 KiB field bound, 4 KiB path bound, separators normalised. |
| AC-9 | A malformed region costs only the commits it touches | **PASS** | "recovers from a malformed region instead of abandoning the page". |
| AC-10 | Reading history cannot execute a repository's program | **PASS** | "does not execute a program a repository nominates, while reading history" — `core.pager` and `core.fsmonitor` pointed at a marker-writing script, exercised through `git log`. |

**10 / 10 PASS.**

## 2. EPIC-020 acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | Commits, developers and files emitted as canonical entities | **PASS** | "emits commits, their authors and the files they touched" — all three kinds and all four relationship types. |
| AC-2 | A commit has the same identity in every repository that holds it | **PASS** | "gives a commit the same identity in every repository that holds it" — a **real clone** with a rewritten origin, so the two repositories have different identities by EPIC-017's rules, and identical commit entity ids. |
| AC-3 | Two repositories' files at one path are two entities | **PASS** | "scopes a file to its repository, so two READMEs are two files". |
| AC-4 | One address collapses across commits; two addresses do not | **PASS** | "collapses many commits by one address into one developer, and keeps two addresses apart" — 4 authorship edges from one developer, 2 developers in total. |
| AC-5 | No author address produces no developer | **PASS** | "does not invent a developer for a commit with no author address". |
| AC-6 | Both paths of a rename are reachable | **PASS** | "keeps both paths of a rename reachable". |
| AC-7 | Parentage, authorship and modification emitted with declared types | **PASS** | AC-1's test asserts each type. |
| AC-8 | Identical entity ids, and identical commit-derived relationship ids, on re-emission | **PASS** | "emits identical entity ids for the same history read twice" — and, unlike EPIC-018, the *relationship* ids are stable too, because a commit's valid time is a fact Git knows. |

**8 / 8 PASS.**

---

## 3. Tests

`npm run verify` — **1,108 passed, 3 skipped** across 44 files against live
PostgreSQL 17 + pgvector and real `git`, zero unhandled errors. `npm audit` —
**0 vulnerabilities**. 49 new cases: 30 parser, 19 integration.

The parser is unit-tested against the **actual** output shape, captured from
real `git log -z --name-status` output rather than taken from documentation.
That mattered: the observed shape has a newline prefixed to the *first* status
token of each commit and not the rest, which a specification-derived fixture
would not have contained.

---

## 4. What these tests caught

### 4.1 Two wrong premises of mine, both corrected

**The canonical model has no `displayName`.** It has `name`, on every entity
kind. Emission failed loudly at the schema rather than silently storing a field
nobody would read — which is what `.strict()` on the attribute schemas is for,
and the first time it has earned its keep.

**"One developer per repository" was the wrong assertion.** The fixture's initial
commit is authored by the fixture identity and the rest by Ada, so two addresses
are two developers — which is *correct*. Deciding two addresses are one person is
EPIC-036's job, and making it here by accident is precisely the mistake the
specification warns against. The test now asserts both halves: many commits by one
address collapse, and two addresses do not.

### 4.2 A racy test, caught before it reached CI

The incremental-read test used a cutoff one second in the future, and creating a
commit on a busy Windows runner takes longer than that. Widened to an hour. A
racy test in a suite whose purpose is reliability is worse than no test.

### 4.3 One unexplained intermittent, recorded rather than dismissed

The first full `npm run verify` after this work reported **1 failure out of
1,111** and the name was not captured. Two subsequent full runs and two repeated
runs of the Git and SDK suites (108 cases each) were clean.

This is recorded because a single unreproduced failure is not the same as a clean
suite, and saying so is the point. CI runs the suite on Ubuntu and Windows, and
the storage job runs it a third time; if it recurs there, the name will be
captured and the cause pursued. It is **not** being treated as resolved.

---

## 5. Security

| Concern | Handling | Test |
| --- | --- | --- |
| ANSI escapes in a commit subject reaching a terminal or an AI client | Control characters stripped, newlines and tabs kept. | Parser: "strips control characters from a subject" |
| Unbounded fields | 8 KiB per field, 64 KiB per body, 4 KiB per path. | 2 parser cases |
| A revision read as an option | Refused if it begins with `-`, is empty, exceeds 512 characters, or contains a control character. A NUL truncates at the OS boundary, so what Git receives would not be what was inspected. | 4 unit cases + 1 integration |
| Repository configuration executing a program during `git log` | EPIC-017's overrides, exercised through this command too. | "does not execute a program a repository nominates, while reading history" |
| A credential committed into a message | EPIC-008's redaction runs on emission. | Inherited; covered by `emit.ts`'s own suite |
| Unbounded output | 16 MiB runner cap plus a 1,000-commit read limit. The cap is a feature: page, never raise it. | Bound enforced in `readHistory` |

---

## 6. Performance

| Measurement | Observed | Budget |
| --- | --- | --- |
| Reading and emitting 26 commits with changes | ~1.5 s | 10 s |

The figure that matters is **invocations per page, not per commit**. At roughly
450 ms per process on Windows, a regression to per-commit reading could not fit
in this budget — which is how the budget was chosen.

---

## 7. Known limitations

| Limitation | Impact | Owner |
| --- | --- | --- |
| **Offset paging is O(offset).** `git log --skip` walks the history to reach the offset. | Fine for the first pages, wrong for the ten-thousandth. The read that matters for a running Ferret is the incremental one (`since`), which walks only what is new. | ~~EPIC-032~~ — accepted, see Owner correction |
| **A SHA-1 collision would merge two commits.** Commit identity is the object id. | Git's own SHA-1 carries collision detection and rejects known-colliding inputs, and repositories are migrating to SHA-256 — but a deliberate collision against a repository Ferret indexes is a real threat model, not a theoretical one. | **EPIC-082** |
| A merge commit's changes are absent. | Git reports none, because the answer depends which parent you compare against. `-m` or `--first-parent` would produce *an* answer; choosing which is a modelling decision, not a parsing one. | ~~EPIC-032~~ **unassigned** — see Owner correction |
| A rename produces two file entities linked by a relationship, not one entity. | Matches what Git recorded — a similarity score, not an identity claim. Following a file across renames is a traversal, which is what the graph is for. | **EPIC-049** |
| Two addresses are two developers. | Deliberate. Resolution is a decision with evidence behind it. | **EPIC-036** |
| Tags, remote-tracking refs and `branch_points_to_commit` still absent. | Commit entities now exist, so the last of these is finally *possible* — it was blocked on exactly that. | **EPIC-020's successors / EPIC-031** |
| File entities carry only a path and extension. | No content, no media type, no language, no version. Those are the next Epics' subject, and this Epic's file identity is what they must agree with. | **EPIC-022, EPIC-023** |
| ~~macOS unvalidated.~~ **Measured 2026-09-03 by EPIC-105:** macOS passes — 112 test files and 2 463 tests on `macos-latest`, including the packaging suite and all seven signal tests. The database suites skip there (no Linux containers), so PostgreSQL behaviour stays validated on Linux only. | Inherited. | **EPIC-105** |

---

## Owner correction — 2026-09-02

**Rows above whose Owner read `EPIC-032` have had that owner struck.** The
limitations themselves are unchanged and still true; only the assignment was
wrong, and it is struck rather than overwritten so the original claim stays
readable.

EPIC-032 — Index Lifecycle & Tombstones — is VALIDATED, and its scope never
covered any of this. Its §4 (Non-scope) says so directly: "**Scheduled or
unattended indexing.** Not this Epic and not this registry entry; EPIC-075/076
own synchronization." Nine rows across four validation documents were parked on
it anyway, and EPIC-076 added one more while assigning the file tree back to
EPIC-032 — two closed Epics pointing at each other over live work.

This is the class of defect EPIC-076 named and did not have scope to fix:
"Nothing sweeps limitation tables for records the code has outgrown, so the next
stale one will also wait for an Epic to be pointed at it."

**Nothing was absorbed into EPIC-032.** Each row was re-read and given the owner
its own recorded reasoning implies, and where that reasoning does not determine
one, it says `unassigned` rather than guessing:

| row | new owner | why |
| --- | --- | --- |
| rate limiter is per-process | **EPIC-078** | the row's own parenthetical read "EPIC-032 *(scheduling)*" — it was naming the scheduling Epic by the wrong number, and Periodic Reconciliation is that Epic |
| no circuit breaker | **EPIC-078** | "Suppressing work across operations is a scheduling decision, not a provider one" — which also rules out EPIC-014 |
| ~~no incremental repository discovery~~ **Delivered 2026-09-03 by EPIC-077:** `RepositoryWatcher` emits a `SourceEvent` per quiet burst, debounced per root. A hint rather than a source of truth — `fs.watch` drops events under load and says nothing about what happened while the process was not running — so EPIC-078 stays what is correct. | **EPIC-077** | "It needs a filesystem watcher", and Event & Webhook Ingestion is where event-driven sources belong |
| indexing is sequential, no back-pressure | **EPIC-078** | "Parallelism across repositories is a scheduling decision" |
| offset paging is O(offset) | *none — accepted* | the row's own Impact settles it: "The read that matters for a running Ferret is the incremental one (`since`)." An accepted cost, not parked work |
| a failed run repeats rather than resumes | *none — accepted* | "Deliberate: resuming from a position never reached would leave a permanent gap." A design decision, recorded as one |
| a merge commit's changes are absent | **unassigned** | "choosing which is a modelling decision" — commit modelling is EPIC-020, which is closed, so this is a new criterion and needs governance |
| the file tree is read in full every run | **unassigned** | EPIC-076 assigned it here; EPIC-032's non-scope assigns synchronization to EPIC-075/076. Both are closed and neither claims it |
| no untracked working-directory state | **unassigned** | "'What am I working on right now' is a different read." No Epic in the registry covers it |

The three `unassigned` rows are tracked in
[#117](https://github.com/indoulia/Ferret/issues/117). They are **not** new P0
scope: no P0 acceptance criterion depends on any of them, which is why they were
parked rather than built.
