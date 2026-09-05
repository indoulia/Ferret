# Ferret — Reconstructed Engineering Roadmap

**Status: AWAITING DECISIONS** · Base: `0717325` · Reconstructed: 2026-09-05 ·
Four Epics landed and are now recorded in the registry with validation evidence.
The autonomous queue is **exhausted**: every remaining item needs a product
decision or an infrastructure approval, and each is stated in the
[decision queue](#decision-queue) in the form a decision needs.

## Why this document exists

Registry v3.0 closed 108 Epics: 107 `VALIDATED`, 1 `DONE`, 76/76 P0. It is a
delivery map for work that is finished, and it does not say what comes next.
This document derives the next roadmap **from the repository itself** — the
implementation, the tests, the Epic non-scope statements, the CLI surface and
the open issues — rather than from any external plan.

Nothing here is approved scope. Each entry carries a classification, and only
`CONTINUATION` and `HARDENING` entries may proceed autonomously. An entry marked
`PRODUCT DECISION REQUIRED` or `INFRASTRUCTURE REQUIRED` stops at the decision
and names it. No classification here was changed to unblock an item, and no
architecture or product semantics were altered to make one executable.

## Method

Every entry below is anchored to evidence already in the tree. The strongest
class of evidence is an Epic that **excluded a capability by name** and assigned
it elsewhere: that is a deferral the repository made explicitly, and closing it
is continuation, not invention.

The two `(planned)` CLI rows are the repository's own statement of what it does
not yet do. `src/cli/commands/planned.ts` names them, exits `5` with
`E_NOT_IMPLEMENTED`, and cites the owning Epics.

## Status

| Priority | Epic | Classification | Status | Evidence | Dependencies | Next action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | EPIC-109 — Session & Memory Persistence | CONTINUATION | **VALIDATED** | 28 integration cases against real PostgreSQL; migration `0015`; latent hashing defect fixed — [record](validation/EPIC-109-VALIDATION.md) | EPIC-039–043, EPIC-086 | Done |
| 2 | EPIC-110 — `ferret session` command surface | CONTINUATION | **VALIDATED** | 20 integration cases driving the built binary; planned entry retired — [record](validation/EPIC-110-VALIDATION.md) | EPIC-109 | Done |
| 3 | EPIC-111 — Session recall over MCP | CONTINUATION | **VALIDATED** | 13 protocol cases against a fake port; boundary gate green — [record](validation/EPIC-111-VALIDATION.md) | EPIC-109, EPIC-110 | Done |
| 4 | EPIC-112 — Session retention & redaction | HARDENING | **VALIDATED** | A `sessions` prune target; and a redaction gap on the explicit memory path, found and closed — [record](validation/EPIC-112-VALIDATION.md) | EPIC-109, EPIC-082, EPIC-088 | Done |
| 5 | EPIC-113 — Provider sync transport (`ferret sync`) | PRODUCT DECISION REQUIRED | BLOCKED | `planned.ts` sync entry; EPIC-021/071/072 each excluded transport by name; `cursors.ts` exists | EPIC-075, EPIC-021, EPIC-071 | [D-113.1–.3](#epic-113--provider-sync-transport-ferret-sync) |
| 6 | EPIC-114 — PostgreSQL version coverage | INFRASTRUCTURE REQUIRED | BLOCKED | EPIC-002 validation: minimum supported major is 14, **only 17 measured** | EPIC-002 | [Infrastructure decisions](#epic-114--postgresql-version-coverage) — needs CI approval |
| 7 | EPIC-115 — macOS packaging validation | INFRASTRUCTURE REQUIRED | BLOCKED | EPIC-105 **measured** macOS on 2026-09-03; the 2026-09-05 owner decision dropped it from CI, so nothing measures it now | EPIC-105 | [Infrastructure decisions](#epic-115--macos-packaging-validation) — needs a runner decision |
| 8 | EPIC-116 — Session export fidelity | PRODUCT DECISION REQUIRED | BLOCKED | The four session tables are declared excluded from `ferret export`; the loss is stated in the manifest | EPIC-109, EPIC-089 | [D-116.1–.3](#epic-116--session-export-fidelity) |
| 9 | EPIC-117 — Recording a session over MCP | PRODUCT DECISION REQUIRED | BLOCKED | EPIC-111 shipped recall read-only; a write path needs a lifecycle owner | EPIC-111 | [D-117.1–.3](#epic-117--recording-a-session-over-mcp) |
| — | #138 registry hygiene | MIXED | OPEN | Three limitation rows with no owning Epic; two are product decisions in their own right | — | [Not in this queue](#not-in-this-queue) |
| — | #130 packaging gate flake | DEFERRED | OPEN | Gate failed once, passed twice on one tree; cause not established, has not recurred | — | [Not in this queue](#not-in-this-queue) — instrumented, awaiting a recurrence |

## EPIC-109 — Session & Memory Persistence

**Classification:** CONTINUATION · **Priority:** P0 · **Domain:** Session & Agent Memory

### Problem

Ferret describes itself as a *persistent* engineering context layer. The Session
& Agent Memory domain — session identity, transcript capture, checkpoints,
extracted engineering memory and recovery — is fully modelled, validated and
tested, and **none of it survives the process**. A session that ended still
takes its context with it, which is the exact failure EPIC-043 was written to
prevent.

### Existing evidence

- `EPIC-041` non-scope: *"Database tables, retention policy, or encryption
  implementation; those belong to storage/security Epics."* The deferral is
  explicit and the receiving Epic was never written.
- `EPIC-041` scope: *"Serialization suitable for durable storage by later
  storage/integration work."*
- `EPIC-039` outcome: *"…so later capture, checkpoint, memory, and recovery
  capabilities can **persist and retrieve** useful context."*
- `src/domain/session-recovery.ts` defines `SessionRecoveryPort`
  (`getSession`, `latestCheckpoint`, `memoriesFor`). Repository-wide search
  finds **one** implementation — a test double in
  `tests/unit/session-recovery.test.ts`. There is no production adapter.
- `src/cli/commands/planned.ts`: *"the session and memory model exists and is
  tested as a library; **no store persists it** and no command reaches it."*
- No `session` table exists in any of the 14 migrations.

### Current implementation baseline

Four immutable, validated domain values with deterministic canonical ids and
content hashes — `Session`, `SessionCapture`, `SessionCheckpoint`,
`EngineeringMemory` — plus `recoverSession`/`resumeSession` orchestration over
the port. 986 lines of domain code, exercised by five unit suites.

### User/product value

Session memory that outlives the session: a later agent recovers what an earlier
one decided, constrained and left unfinished, without replaying a transcript.

### Engineering scope

- Migration `0015_session_store.sql`: four tables in the `ferret` schema.
- Drizzle schema `src/storage/schema/sessions.ts`.
- `SessionStore` in `src/storage/sessions.ts`, implementing `SessionRecoveryPort`.
- Export through `src/storage/index.ts`.

### Non-scope

- The `ferret session` command (EPIC-110).
- MCP surfacing (EPIC-111).
- Retention and redaction of session rows (EPIC-112).
- Any change to the domain model. Persistence adapts to the domain, never the reverse.

### Dependencies

EPIC-039, EPIC-040, EPIC-041, EPIC-042, EPIC-043, EPIC-086.

### Risks

- **Domain drift.** A store that re-validates or re-derives risks two
  definitions of a session. Mitigated by reconstructing through the domain
  constructors on read, never by hand.
- **Identity mismatch.** Canonical ids are content-derived; a store that
  generates its own would break `recoverSession`. Mitigated by persisting the
  domain id as the primary key.
- **Sequence races.** Capture and checkpoint sequences are monotonic per
  session. Enforced in the database, not only in the domain.

### Acceptance criteria

1. A session round-trips through the store unchanged, including optional scope and lineage.
2. Session lifecycle persists; a terminal session cannot be reopened by a write.
3. Captures persist with their sequence, kind and content hash; a duplicate `(session, sequence)` is rejected by the database.
4. Checkpoints persist; `(session, checkpoint_sequence)` is unique and monotonic.
5. Engineering memories persist with origin, confidence, evidence links and supersession.
6. `SessionStore` satisfies `SessionRecoveryPort` and `recoverSession` works against it unmodified.
7. A recovered session reconstructs values equal to what was written, hashes included.
8. Rows are scoped to the `ferret` schema and participate in the existing migration and compatibility machinery.
9. Storage failures classify through `classifyDatabaseError`.
10. Integration tests run against real PostgreSQL.

### Expected tests

Integration (real PostgreSQL): round-trip for each of the four values; duplicate
sequence rejection; monotonic checkpoint enforcement; supersession; lineage walk
through the real store via `recoverSession`; empty-recovery reporting; error
classification. Unit: none new — the domain is already covered and must not be
re-tested through the store.

## Decision queue

Every remaining roadmap item is blocked on a decision that repository evidence
cannot make. This section states each one in the form a decision needs: the
question, why the tree cannot answer it, the smallest answer that unblocks, the
options, what each costs, and a recommendation **labelled as a recommendation**.

Nothing here is an assumed requirement. An option is not selected by being
listed, and the recommendation is not a default.

### Product decisions

#### EPIC-113 — Provider sync transport (`ferret sync`)

The GitHub and Jira providers, PR/review modelling, release/deployment modelling
and sync cursors all exist and are tested. `ferret sync` is the one remaining
`(planned)` entry, and it is blocked on three questions rather than on code.

**D-113.1 — May a long-running sync hold a credential at rest?**

*Why the tree cannot answer it.* EPIC-081 isolates credentials in memory and
never writes them; EPIC-015 resolves provider secrets from configuration at use.
Neither Epic is about durability, so the two are silent rather than in conflict —
there is no precedent to read off, and inventing one would settle a security
posture by implication.

*Minimum decision.* Whether `sync` re-resolves its credential on every invocation
or may cache it, and if it may, where.

| Option | Consequence |
| --- | --- |
| **A — Re-resolve per invocation. Never persist.** | EPIC-081's posture is unchanged and nothing new is at rest. A daemon re-reads configuration each cycle; an interactive credential would be re-prompted, which effectively rules out interactive credentials for unattended sync. |
| **B — Cache in process memory for the lifetime of one `sync`, never on disk.** | A single long run holds one token in memory, which EPIC-081 already permits for the duration of an operation. A restarted daemon re-resolves. No new storage, no new threat surface beyond what a running process already has. |
| **C — Persist encrypted, with a key from the OS keychain.** | Unattended sync works across restarts with no configuration re-read. It adds a secret store, a key-management story, a platform matrix (Windows/macOS/Linux keychains) and an EPIC-081 amendment — a significant surface for a capability nothing has yet asked for. |

**Recommendation (a recommendation, not a requirement): B.** It is the smallest
answer that makes sync work, it changes no security posture, and it leaves C
available if unattended cross-restart sync is later required. C should not be
built before something needs it.

**D-113.2 — Is `sync` a command, a daemon, or both?**

*Why the tree cannot answer it.* Two adjacent Epics chose opposite shapes for
their own reasons: EPIC-078 reconciliation is an operator command, and EPIC-077
webhook ingestion **explicitly declined to be a server**. Neither chose for
`sync`, and picking the nearer neighbour would be a coin toss dressed as
inference.

| Option | Consequence |
| --- | --- |
| **A — One-shot command only.** | Matches EPIC-078 and every other Ferret command; scheduling is the operator's (`cron`, Task Scheduler, CI). Nothing long-running to supervise, no new failure mode. Freshness is only as good as whatever the operator sets up. |
| **B — Daemon only.** | Continuous freshness. Requires supervision, restart policy, health surface, a shutdown contract on a platform where `SIGTERM` is undeliverable (EPIC-001's recorded limitation), and reverses EPIC-077's decision not to be a server. |
| **C — Command now, daemon later behind a flag.** | Ships the useful half immediately and keeps the door open. The risk is the usual one: "later" arrives with the command's assumptions baked in. Mitigated by deciding D-113.1 as B, which a daemon can also live with. |

**Recommendation: C, with the daemon explicitly out of scope for the first
Epic.** A one-shot `ferret sync` is independently useful, is what every existing
command already looks like, and does not commit the project to running a server.

**D-113.3 — On re-ingest, does a remote edit overwrite local evidence or fork
it?**

*Why the tree cannot answer it.* EPIC-080 guarantees **idempotent** ingestion:
the same input twice writes one row. A remotely edited issue is a *different*
input for the same remote object, which is exactly the case EPIC-080 does not
cover. EPIC-007's temporal model and EPIC-047's conflict detection both offer
machinery, and neither is a policy.

| Option | Consequence |
| --- | --- |
| **A — Last write wins; the remote is authoritative.** | Simplest, and matches how an issue tracker behaves. History of the prior text is lost unless EPIC-007 intervals are used, so "what did this ticket say when we decided X" becomes unanswerable. |
| **B — Supersede: close the prior evidence interval, open a new one.** | Uses EPIC-007 and EPIC-008 as designed; the old text stays queryable and EPIC-048 traceability keeps working across an edit. Costs storage growth proportional to remote edit churn. |
| **C — Fork and report a conflict through EPIC-047.** | Nothing is lost and disagreement is surfaced. But a remote edit is not a conflict — it is an update — so this would report normal activity as a problem and train operators to ignore the conflict surface. |

**Recommendation: B.** It is the option the canonical model was built for, it
keeps EPIC-048 answers stable across remote edits, and A is recoverable from B
whereas B is not recoverable from A.

#### EPIC-116 — Session export fidelity

EPIC-109 declared all four session tables **excluded** from `ferret export` and
stated the loss in the manifest rather than exporting them partially. `pg_dump`
is the stated recovery, which is what EPIC-089 §8.1 already assigns it.

*The exact question.* `ferret export` narrows a scoped export **by entity id**,
and a session is not an entity: `session.repository_id` is free text precisely so
a session can be recorded outside any repository Ferret has indexed (EPIC-039
AC-3). So there is no defined meaning for "the sessions in this scope".

*Why the tree cannot answer it.* Carrying sessions in a full export while
silently dropping them from a scoped one is the exact silence F-45 was about, so
the safe reading was to exclude and say so. EPIC-089 was written before sessions
existed and never considered a transcript; nothing in it decides this.

**D-116.1 — Does a repository-scoped export carry sessions?**

| Option | Consequence |
| --- | --- |
| **A — Never. Sessions are full-export only.** | No silent partial. A scoped export is honest and incomplete in a stated way. An operator moving one repository's knowledge leaves its session history behind. |
| **B — Match `repository_id` as text.** | Scoped exports carry the obvious sessions. The column may hold something that is not an entity id at all, so the match is a heuristic and a session recorded against an unindexed path is silently omitted — the F-45 shape again, one level down. |
| **C — Carry sessions whose `repository_id` resolves to an in-scope entity, and state the count that did not resolve.** | Keeps the narrowing honest: what travelled and what did not are both reported. Costs a resolution step and a manifest field. |

**Recommendation: C.** It is the only option that neither drops silently nor
pretends free text is an identifier, and the manifest already exists to carry
exactly this kind of statement.

**D-116.2 — Does a transcript belong in a portable document?**

| Option | Consequence |
| --- | --- |
| **A — Export sessions, checkpoints and memories; never captures.** | The derived knowledge travels and the raw transcript does not. Smallest export, lowest disclosure risk. But EPIC-042 forbids a memory whose evidence did not arrive — see D-116.3, which this forces. |
| **B — Export captures too.** | Full fidelity; a restored export can re-derive. A transcript is a different kind of record from indexed file content, may contain anything a person typed, and is only pattern-redacted (EPIC-112's limitation). |
| **C — Export captures only when `--include-transcripts` is passed, and state their absence otherwise.** | Default is conservative, full fidelity is available, and the manifest says which was taken. Costs one flag and one manifest field. |

**Recommendation: C**, with the default off. `content_blob` is precedent for
carrying indexed content, but a transcript is a record of what a person said, and
that difference should be an explicit choice rather than a default.

**D-116.3 — If memories travel, must their captures travel with them?**

EPIC-042 forbids an extracted memory whose evidence did not arrive, and the table
enforces it (`engineering_memory_extracted_has_evidence`). A restore of memories
without captures would therefore be **rejected by the constraint**, not merely
lossy — so this is not a preference.

| Option | Consequence |
| --- | --- |
| **A — Extracted memories require their captures; explicit memories do not.** | Honours EPIC-042 exactly. Under D-116.2/A or C-with-default-off, extracted memories are then dropped from a transcript-free export, and the manifest must say so. |
| **B — Carry the cited captures only, not the whole transcript.** | Extracted memories survive a transcript-free export, and only the evidence actually cited travels. Costs a selection pass; the partial transcript could mislead a reader who expects the whole. |

**Recommendation: B**, with the manifest stating that the transcript is partial
and why. It satisfies EPIC-042 without exporting everything, and it is the option
that keeps a restored memory traceable — which is the whole point of EPIC-048.

#### EPIC-117 — Recording a session over MCP

EPIC-111 shipped recall read-only. A client that can read what the last session
decided but cannot record what this one decided is half a memory, and the missing
half is the one an autonomous agent needs most. **The plumbing is not what
blocks it** — the store and the domain both support a write today.

*The exact question.* Who owns a session's identity and lifetime.

*Why the tree cannot answer it.* Every write on the MCP surface today is
configuration or provider administration, not knowledge, so there is no
precedent for an agent writing a record of its own reasoning. Recording without
deciding this produces sessions nothing closes, and memories attached to sessions
that were never opened — where the foreign key refuses the very first call.

**D-117.1 — Does the client supply the session id, or does the server mint one?**

| Option | Consequence |
| --- | --- |
| **A — Client supplies.** | A reconnecting client continues its own session, which is what an editor restart should mean. A buggy or hostile client can collide with, or write into, another client's session id. |
| **B — Server mints and returns it.** | Ids are unforgeable and unique. A reconnecting client has lost its handle and starts a new session, so an editor restart silently fragments one piece of work into two. |
| **C — Server mints; the client may supply an idempotency key it chooses, scoped to the calling principal.** | A reconnect resolves to the same session for the same principal, and no client can reach another's. Costs one column and a lookup. |

**Recommendation: C.** It is the only option that makes reconnect work without
making session ids a shared namespace.

**D-117.2 — When does a session end?**

| Option | Consequence |
| --- | --- |
| **A — Only an explicit `session.end` ends it.** | Truthful: Ferret never guesses. An agent that crashes leaves an `active` row forever, and EPIC-112 AC-4 will never reclaim it — the limitation that Epic recorded. |
| **B — Transport close ends it.** | Nothing is left open. But a transport closing is not a session ending; an editor restarting is the common case, and this would end a session the user is still in the middle of. |
| **C — Explicit end, plus an idle timeout that marks a session `abandoned` after a configured period with no activity.** | Crashed sessions become reclaimable, and `abandoned` already exists in the status set (`session_status_known`) and already carries exactly this meaning. Costs one configuration value and a sweep — the sweep EPIC-112 already built for `sessions`. |

**Recommendation: C.** It uses the status the domain already defines, it closes
EPIC-112's recorded limitation rather than deepening it, and it never ends a
session that is still doing something.

**D-117.3 — Which permission does an agent recording its own memory need?**

| Option | Consequence |
| --- | --- |
| **A — Reuse `INDEX`.** | No permission-model change. But `INDEX` means "may cause Ferret to ingest sources", and session recording is not ingestion — the grant would then mean two things, and an operator granting one would be granting the other. |
| **B — A new permission, e.g. `RECORD`.** | The grant says what it does, and an operator can allow recall without allowing writes. EPIC-068's set is declared closed, so this is a governance amendment and must be raised as one. |
| **C — Reuse `WRITE`/administration.** | No new permission, but it conflates recording a decision with reconfiguring Ferret — the strictly worse version of A. |

**Recommendation: B**, raised explicitly as an EPIC-068 amendment rather than
slipped in. The whole value of a closed permission set is that adding to it is a
visible decision.

### Infrastructure decisions

#### EPIC-114 — PostgreSQL version coverage

**Current coverage.** One job, `storage integration (PostgreSQL 17 + pgvector)`,
on `ubuntu-latest`, against the service image `pgvector/pgvector:pg17` — the
image EPIC-005 benchmarked pgvector 0.8.6 against. Measured **4m48s** on
[#160](https://github.com/indoulia/Ferret/pull/160). The `verify` matrix is
Windows-only and runs with `FERRET_SKIP_DOCKER_POSTGRES=1`, because GitHub's
Windows runners cannot run Linux containers; a skip that read as a pass is what
Governance §17 forbids, which is why the database job is separate.

**Declared minimum.** `MINIMUM_POSTGRES_MAJOR = 14`, in
`src/storage/connection.ts`, enforced at runtime.

**What has actually been validated.** PostgreSQL **17 only**. EPIC-002's own
limitation table says so: *"Only PostgreSQL 17 is measured. The floor is 14 and
is enforced at runtime, but 14–16 are unvalidated."* Ferret therefore refuses 13
and accepts 14, 15 and 16 having never run against any of them.

**Ways to add a major, with cost.**

| Approach | CI impact | What it buys |
| --- | --- | --- |
| **A — Matrix the `storage` job over `pg14` and `pg17`.** | One more parallel job of roughly 4–5 minutes on `ubuntu-latest`. Wall clock is unchanged (it runs alongside the ~9-minute Windows `verify`); runner minutes roughly double for that job. Fails a PR when the floor breaks. | Both ends of the supported range on every change. A version-specific regression is caught by the author, not by a user. |
| **B — Scheduled compatibility job over 14/15/16, nightly.** | Zero added time on any pull request. Uses the `schedule` trigger the workflow already has. | Broad coverage, cheaply. A break is found after merge, and attributing it to a commit costs a bisect. |
| **C — Both: `pg14` on the PR gate, 15/16 nightly.** | One added PR job (~4–5 min parallel, wall clock unchanged) plus a nightly run. | The floor is defended where breaking it is cheapest to fix; the middle of the range is covered without paying for it per PR. |

**Recommendation: C**, and if only one may be added, the floor (`pg14`) — a claim
Ferret enforces in code and has never tested is the more valuable of the two to
close.

**Preferring minimal normal-CI impact:** the added job runs in parallel with a
~9-minute Windows job, so wall-clock cost is approximately zero and the real cost
is runner minutes.

**This needs approval because** it changes the CI matrix, which the 2026-09-05
owner decision deliberately narrowed to Windows-only for `verify`. Widening any
job without that approval would reverse a decision by side effect.

#### EPIC-115 — macOS packaging validation

**What is missing, exactly.** Nothing about macOS was ever unmeasurable — it was
measured. EPIC-105 ran `macos-latest` on
[#140](https://github.com/indoulia/Ferret/pull/140): **112 test files and 2 463
tests passed**, including the full packaging suite (`npm pack`, a global install,
and the installed binary running) and all seven signal tests. The owner decision
of 2026-09-05 then dropped macOS from the `verify` matrix, and the workflow says
so plainly: *"this workflow no longer measures macOS, and no record should claim
it does."*

So the gap is not knowledge; it is **ongoing coverage**. Today's tree has never
been run on macOS, and the nineteen validation records that cite EPIC-105's
measurement describe 2026-09-03, not now.

**What packaging behaviour needs validating.** The parts of `packaging.test.ts`
and `distribution.test.ts` that are platform-dependent rather than assertions
about the tarball's contents: the global-install path (`lib/node_modules` on
POSIX versus `node_modules` on Windows, already branched in the suite), the bin
shim and its shebang, executable permissions the Windows runner cannot express,
and line endings. Plus the seven signal tests — macOS is the only platform in
reach that delivers both `SIGTERM` and `SIGINT`, which Windows cannot.

**Runner capability required.** A GitHub-hosted `macos-latest` runner. No
container, no service, no database: the database suites skip on macOS anyway (no
Linux containers), so this is packaging, CLI and signals only. EPIC-105 measured
the job at **3m47s**.

**Can it be isolated from the PR gate?** Yes, and more cleanly than most.

| Approach | CI impact | What it buys |
| --- | --- | --- |
| **A — macOS back on the `verify` matrix.** | ~3m47s in parallel with the ~9-minute Windows job. Wall clock unchanged; runner minutes added on every PR. | A macOS break is found before merge. This is what EPIC-105 argued for and what the owner decision reversed. |
| **B — Scheduled nightly macOS job.** | Zero on every pull request. The workflow already has a `schedule` trigger and already uses it for exactly this reason. | Ongoing coverage restored at no per-PR cost. A break is found within a day, after merge. |
| **C — macOS on `push: main` only.** | Zero on pull requests; one run per merge. | Attribution is exact — every commit on `main` gets its own run — but it costs a run per merge rather than one per night. |

**Recommendation: B.** It restores the coverage the 2026-09-05 decision gave up
while honouring what that decision was actually about — pull-request wait time —
and it needs no new capability, only the `schedule` trigger that is already in
the file. If exact attribution matters more than cost, C.

**This needs approval because** it partly reverses a 2026-09-05 owner decision,
and because the honest recording rule cuts both ways: no record may claim macOS
coverage until a job measures it again.

### Not in this queue

- **[#138](https://github.com/indoulia/Ferret/issues/138) — three limitation rows
  with no owning Epic.** Two of the three are product decisions in their own
  right (what a merge commit's *changes* are; whether untracked working-directory
  state is modelled at all), and the third is an incremental-read optimisation
  whose owner the registry does not determine. None is P0 and none is unblocked
  by anything above.
- **[#130](https://github.com/indoulia/Ferret/issues/130) — the packaging gate
  flake.** Cause **not established**, and it has not recurred. The diagnostic
  that a recurrence needs is already in place: the assertion now compares the
  uncompressed tar before the gzip framing, so the next occurrence says which
  layer differed instead of printing a bare digest. Chasing a cause that has not
  reproduced would be guessing; the instrumentation is the correct state.

## Completion record

Filled in as Epics land.

| Epic | Commit | PR | Merge | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| EPIC-109 | `452980d` | [#156](https://github.com/indoulia/Ferret/pull/156) | `ec0a376` | [record](validation/EPIC-109-VALIDATION.md) | COMPLETE |
| EPIC-110 | `2e7ce50` | [#157](https://github.com/indoulia/Ferret/pull/157) | `533b603` | [record](validation/EPIC-110-VALIDATION.md) | COMPLETE |
| EPIC-111 | `818fdfc` | [#158](https://github.com/indoulia/Ferret/pull/158) | `39a23ca` | [record](validation/EPIC-111-VALIDATION.md) | COMPLETE |
| EPIC-112 | `b137094` | [#159](https://github.com/indoulia/Ferret/pull/159) | `5faab0c` | [record](validation/EPIC-112-VALIDATION.md) | COMPLETE |

All four merged **without** a validation record and without a registry catalog
entry; both were added on 2026-09-05 and every cited suite re-run to confirm the
evidence still holds. The reconciliation, and the fact that the records were
written after the merges rather than alongside them, is recorded in
[the registry](README.md#catalog-reconciliation--2026-09-05).
