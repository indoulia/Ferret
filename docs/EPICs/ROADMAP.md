# Ferret — Reconstructed Engineering Roadmap

**Status: QUEUE EXHAUSTED** · Base: `ae77c10` · Reconstructed: 2026-09-05 ·
Completed: 2026-09-05. All five blocked items were decided by the owner and
delivered — EPIC-113, 116, 117 and 114 implemented and validated; EPIC-115's
coverage declined and its false claim corrected. The
[decision queue](#decision-queue) is kept in full: each entry records the
decision taken beside the options it was choosing between, because a decision
read without its alternatives is indistinguishable from a default.

**Epics were directed after the queue was exhausted.** EPIC-118 — Ferret
Self-Dogfood — EPIC-119 — Universal Source Connector Contract — EPIC-120 —
Repository Connector — EPIC-121 — GitHub Connector — EPIC-122 — Jira Connector —
EPIC-123 — Confluence Connector — and EPIC-124 — Unified Cross-Source Context.
None came from this document and none is an entry invented to keep it alive; all
were directed by the owner. See
[after the queue](#after-the-queue--epic-118),
[EPIC-119](#after-the-queue--epic-119),
[EPIC-120](#after-the-queue--epic-120),
[EPIC-121](#after-the-queue--epic-121),
[EPIC-122](#after-the-queue--epic-122),
[EPIC-123](#after-the-queue--epic-123) and
[EPIC-124](#after-the-queue--epic-124).

**Nothing implementation-ready remains.** What is left is listed under
[not in this queue](#not-in-this-queue), and every item there needs a decision,
a runner, or a recurrence before it can move. No entry was invented to keep the
queue alive.

## Why this document exists

Registry v3.0 closed 108 Epics when this document was reconstructed: 107
`VALIDATED`, 1 `DONE`, 76/76 P0. The catalog now carries 133 rows — EPIC-109 to
EPIC-134 delivered since — of which 131 are `VALIDATED`, 1 `DONE` and 1 `CLOSED`
with coverage deferred, and 81/81 P0. EPIC-125 is the one number in that range
with no catalog row: it shipped as [#198](https://github.com/indoulia/Ferret/pull/198)
with its evidence recorded on EPIC-119 and EPIC-120 rather than under its own
number, and the completion record below says so. It is a
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
| 5 | EPIC-113 — Provider sync transport (`ferret sync`) | CONTINUATION | **VALIDATED** | 14 unit, 5 storage-integration and 8 CLI cases against the built binary; the last `(planned)` entry retired — [record](validation/EPIC-113-VALIDATION.md) | EPIC-075, EPIC-021, EPIC-071 | Done — [decisions D-113.1–.3](#epic-113--provider-sync-transport-ferret-sync) taken 2026-09-05 |
| 6 | EPIC-114 — PostgreSQL version coverage | INFRASTRUCTURE | **VALIDATED** | 14, 15 and 16 measured on a scheduled lane — 187 files each, zero pull-request cost — [record](validation/EPIC-114-VALIDATION.md) | EPIC-002 | Done — [decision](#epic-114--postgresql-version-coverage) taken 2026-09-05 |
| 7 | EPIC-115 — macOS packaging validation | INFRASTRUCTURE | **CLOSED — coverage DEFERRED** | No runner enabled, by owner decision. The README claimed macOS was verified on every pull request and it was not; that is corrected — [record](validation/EPIC-115-VALIDATION.md) | EPIC-105 | Owner decision 2026-09-05: not a priority. Revisit needs a runner approval |
| 8 | EPIC-116 — Session export fidelity | CONTINUATION | **VALIDATED** | 10 integration and 3 CLI cases, including a restore into a second database — [record](validation/EPIC-116-VALIDATION.md) | EPIC-109, EPIC-089 | Done — [decisions D-116.1–.3](#epic-116--session-export-fidelity) taken 2026-09-05 |
| 9 | EPIC-117 — Recording a session over MCP | CONTINUATION | **VALIDATED** | 29 protocol cases and 3 CLI authorization cases; `record` amended onto EPIC-068's closed set — [record](validation/EPIC-117-VALIDATION.md) | EPIC-111 | Done — [decisions D-117.1–.3](#epic-117--recording-a-session-over-mcp) taken 2026-09-05 |
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

**DECIDED 2026-09-05 · IMPLEMENTED.** The owner answered all three questions;
the answers and what was built from them are in
[the Epic](EPIC-113-Provider-Sync-Transport.md) and
[its validation record](validation/EPIC-113-VALIDATION.md). The questions and
options are kept below unchanged, because a decision is only readable beside what
it was choosing between.

**Decisions taken.** D-113.1 — persistence at rest is *authorised*; it is not
used, because D-113.2 makes sync a one-shot command and there is nothing for a
stored credential to outlive. D-113.2 — explicit command; no daemon, and
scheduling documented rather than built. D-113.3 — a remote edit supersedes
through EPIC-047's existing evidence model rather than a new one.

The GitHub and Jira providers, PR/review modelling, release/deployment modelling
and sync cursors all exist and are tested. `ferret sync` was the one remaining
`(planned)` entry, and it was blocked on three questions rather than on code.

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

**DECIDED 2026-09-05 · IMPLEMENTED.** See
[the Epic](EPIC-116-Session-Export-Fidelity.md) and
[its validation record](validation/EPIC-116-VALIDATION.md). The questions and
options below are unchanged, because a decision is only readable beside what it
was choosing between.

**Decisions taken.** D-116.1 — a session travels only when it is *explicitly* in
scope, named through `--session`, which is EPIC-009's `ScopeKind.SESSION` at the
command boundary; membership is never inferred from `repository_id`. D-116.2 —
the transcript travels, with the provenance that makes it readable away from the
installation that wrote it. D-116.3 — memories travel with their evidence, and
`engineering_memory_extracted_has_evidence` is untouched; what the constraint
cannot see is measured and reported, never repaired.

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

**DECIDED 2026-09-05 · IMPLEMENTED.** See
[the Epic](EPIC-117-Recording-Over-MCP.md) and
[its validation record](validation/EPIC-117-VALIDATION.md). The questions and
options below are unchanged, because a decision is only readable beside what it
was choosing between.

**Decisions taken.** D-117.1 — the server mints and owns the session identity;
a client participates by naming the id it was given, and the input schema offers
no field it could supply one in. The idempotency key of option C is *not* built:
the decision requires server ownership and nothing more. D-117.2 — a closed
transport never ends a session; only an explicit `ferret_session_end` does, and
the idle sweep of option C is not built for the same reason. D-117.3 —
`Permission.RECORD`, amended onto EPIC-068's closed set in the open and recorded
at [EPIC-068 §17](EPIC-068-AI-Authorization-Model.md#17-amendment--2026-09-05-record-epic-117).

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

**DECIDED 2026-09-05 · IMPLEMENTED.** See
[the Epic](EPIC-114-PostgreSQL-Version-Coverage.md) and
[its validation record](validation/EPIC-114-VALIDATION.md). The options below
are unchanged, because a decision is only readable beside what it was choosing
between.

**Decision taken.** A scheduled compatibility lane over 14, 15 and 16 —
option B's cost with more of option C's coverage. The pull-request path is
untouched: 17 still gates every change through the `storage` job, and the
compatibility lane never runs on a pull request. `MINIMUM_POSTGRES_MAJOR` stays
14. The lane was **dispatched and run before merge**, because the decision says
no compatibility claim is made without running the suite: 14.24, 15.19 and 16.15
all pass 187 test files.

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

**DECIDED 2026-09-05 · COVERAGE DEFERRED.** See
[the Epic](EPIC-115-macOS-Packaging-Validation.md) and
[its validation record](validation/EPIC-115-VALIDATION.md). The options below
are unchanged, because a decision is only readable beside what it was choosing
between — and because this one may be revisited.

**Decisions taken, in order.** First: add genuine macOS packaging validation,
preferably on a scheduled lane, and *"do not pretend macOS is validated unless
the packaging path actually ran on macOS"*. Then, superseding the runner half:
**do not enable remote CI for macOS** — the owner's last priority.

The second decision removes option A, B and C alike. What it leaves standing is
the first decision's final clause, which is not optional and is what EPIC-115
delivers: the README claimed macOS was *"verified on every pull request"* three
days after that stopped being true, and claimed Windows ran only on a push to
`main` in the same table. Both are corrected. macOS now reads **not currently
measured**, which is a different claim from unsupported and is the true one.

**To revisit**, the cost is known: EPIC-105 measured the job at 3m47s, and what
it buys is named in the Epic — the POSIX global-install path and the shutdown
contract, the second of which nothing else measures at all.

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

### What the run itself found

Three defects, and the shape of each is worth keeping: **none was visible from
the test suite**, and two were found by running the product rather than by
reading it.

- **Both project providers declared configuration they never read.**
  `GithubProvider` and `JiraProvider` declared `configSchema` and
  `secretOptions` from the day they were written and never consulted
  `context.settings`, so every configured option — the token included — did
  nothing. Unreachable until EPIC-113 became the first caller to build a
  provider from configuration. Fixed there.
- **A review ceiling was blocking the cursor a page limit is meant to block.**
  Found by running `ferret sync` against Ferret's own repository: 139 pull
  requests, the ceiling bit on every pass, and the cursor could never advance —
  so every sync would have re-read the whole tracker for ever. Every fixture was
  small enough to miss it. Fixed in [#168](https://github.com/indoulia/Ferret/pull/168).
- **`ferret export --session` was documented as producing a session-only
  document** and produces the whole index alongside the named session, because
  the two scope dimensions are independent by design. The behaviour is right and
  the wording was not; corrected in
  [#170](https://github.com/indoulia/Ferret/pull/170).

And one filed rather than fixed, because it needs a decision:
[#169](https://github.com/indoulia/Ferret/issues/169) — an unresolvable
`$secret` in one provider's options fails *every* command, including `ferret
init`. Older than the Epic that exposed it, and closing it means choosing when
configuration secrets resolve.

## After the queue — EPIC-118

**Ferret Self-Dogfood**, directed by the owner on 2026-09-05, after this queue
was exhausted. Recorded here rather than added above because it was never a
queue entry: nothing in the repository named it, and inventing an entry to
receive it after the fact would misrepresent where it came from.

It found one defect, and the shape is the same one
[the run itself found](#what-the-run-itself-found) three times over: **not
visible from the test suite, and reachable only by running the product against
something the fixtures are not.**

`ferret_find` — the tool whose stated purpose is *"every file in this
repository"* — had no offset, and `MAX_LIMIT` is 500. Ferret tracks 830 files.
Nothing in the store was missing: `EntityQuery.offset` had existed since
EPIC-052 and `findEntities` had passed it to `OFFSET` all along, and no caller
reached it — so the store could page and no client could ask it to.

The consequence was not a short answer. Ferret's own oracle read 487 files and
reported the other **343 as tracked files absent from the index**. The index was
complete; the retrieval was truncated; from the call site those are
indistinguishable. Every fixture in the tree is smaller than one page, so
nothing could have caught it.

A second defect came out of fixing the first: the paged query ordered by
`(kind, source_id)`, which nothing constrains to be unique — Ferret's own index
holds 178 tied groups on `code_symbol`, whose source id is the symbol's name.
An untotal order is invisible in a single page and corrupts every paged read.

Recorded because it changed the shape of the evidence: the behavioural test for
that second defect **passes with the fix reverted**, because PostgreSQL returns
insertion order for a small table. The reordering is latitude the planner has,
not behaviour it always exhibits, so the control is source-level. A test that
passes either way is not a control, and that was measured rather than assumed.

## After the queue — EPIC-119

**Universal Source Connector Contract**, directed by the owner on 2026-09-05.
Recorded here for the same reason EPIC-118 is: it was never a queue entry, and
inventing one to receive it after the fact would misrepresent where it came
from.

The premise it was given — that adding a source meant adding an ingestion path —
was **checked against the repository rather than assumed**, by asking Ferret. The
answer named `src/indexing/ports.ts`, whose own comment already says the
converters were duplicated *"once inside the indexer and once inside
`project/sync.ts`"* until a second caller made it real. The converters had been
shared. The loop around them had not, and the loop is what holds the rules: the
write order the foreign keys demand, the `ifAbsent` placeholder rule from issue
#48, and the `reconcileConflicts` sweep EPIC-047 had to add to the sync path five
Epics after the indexer's. `writeContribution` is that loop, lifted out once.

It found two defects, both of the shape EPIC-118 and the queue itself kept
producing — **invisible from the suite, reachable only by running the product**:

- The connector cursor was keyed by the identity string. PostgreSQL answered
  `22P02`; `SyncCursorStore`'s scope is a canonical id. The suite's cursor fake
  took any string, so nothing in 2261 unit tests could have said so.
- The contract did not require a connector to scope its records to the source
  entity, so the same page slug on two wiki instances collapsed into one entity.
  Visible in a live run as `created=1 updated=2` where `created=3` was expected;
  invisible in a suite where every fixture uses one instance.

No production connector was built. EPIC-120 onward is where a source is
connected; this Epic is only the boundary it connects through, and the GitHub
and Jira providers already on that boundary are the proof it fits a real one.

## After the queue — EPIC-120

**Repository Connector**, directed by the owner on 2026-09-05, and the first
source actually connected through EPIC-119's boundary.

EPIC-119 proved the contract with a tracker, which is the easy case: a board is
one flat collection, so the adapter is a projection. A repository is five —
description, checkouts, refs, tree, history — four of which page independently
and none of which is shaped like an issue. If the boundary could not carry that,
it was not universal, and the honest place to find out was the *second*
connector rather than the fifth.

It carried it. `src/connectors/ingest.ts` and `src/connectors/write.ts` are
byte-identical to EPIC-119; the whole of the Epic is one adapter that calls the
operations the Git provider already declares and the modelling
`RepositoryIndexer` already calls. No second model of a commit was written.

Two things it found, and both are the shape this queue keeps producing —
**invisible from the suite, reachable only by exercising the product**:

- `GitSourceProvider.listFiles` returned a paging cursor it would not accept
  back. Nothing had ever paged a tree: the indexer reads the whole listing in
  one page and uses the cursor only as a truncation signal. The connector is the
  first caller that pages, and the failure was silent — a partial ingestion
  indistinguishable from a successful bounded one.
- The connector reached into `src/git/` for its record types. `src/connectors`
  is core, and EPIC-017's rule is that core never knows Git exists.
  `boundaries.test.ts` refused it by name — the control working exactly as
  intended, on the first draft rather than after a release.

Dogfooded against Ferret's own repository as an oracle: 844 of 844 tracked files
and 201 of 201 commits, with the 14-entity difference between the file count and
`git ls-files` accounted for exactly by the 14 paths deleted over Ferret's
history.

## After the queue — EPIC-121

**GitHub Connector**, directed by the owner on 2026-09-05.

EPIC-119 read *issues* from the GitHub provider and said why it stopped:
widening "would mean paging three collections against one cursor". EPIC-120
paged five collections of a repository behind one staged cursor without the
ingestor changing, so the reason expired and this Epic widened it to issues,
pull requests, reviews and comments.

The gap underneath was larger than the widening. **`listComments` has been
implemented by every project provider since EPIC-021 and nothing had ever called
it.** The capability was declared, the transport was written, the suites passed,
and not one comment had ever reached the graph — which for a context layer means
the issue was indexed and the discussion on it, where the reasoning actually
lives, was thrown away.

Both defects it found came from running against the **live GitHub API**, and
both are the same shape: *a fixture that agrees with the code cannot test it.*

- Every comment was an orphan. The provider addresses comments by number and
  synthesises `parentId` as `owner/repo#123`; it identifies the same issue by
  its GraphQL `node_id`. Twenty-five acquired, twenty-five skipped. A fixture
  without a `node_id` falls back to exactly the synthesised form, so every
  fixture in the repository agreed with the bug.
- `Fixes #N` linked to a phantom. Found the moment the fixtures were given the
  `node_id` the real API sends: a closing reference minted a placeholder issue
  even when the real issue was in the same batch, producing two entities for one
  issue and hanging the `resolves` edge off the stub. That one was in
  `modelProject`, so `ferret sync` had it too.

No canonical model change was needed. A comment is a `document` and the edge to
its parent is `DOCUMENT_DESCRIBES_ENTITY` — both already in the model, for the
reason EPIC-119 gave when it scoped sources to `repository` rather than minting
a `source` kind.

## After the queue — EPIC-122

**Jira Connector**, directed by the owner on 2026-09-05. No new connector was
written: `projectSourceConnector` now serves GitHub and Jira alike, which is
what EPIC-119's boundary was for.

**Jira ingestion had never worked end to end.** Jira reports
`2026-09-01T00:00:00.000-0500` — a numeric offset with no colon — and `instant`
is `z.iso.datetime({ offset: true })`, which rejects it. So `createEntity`
refused every Jira issue and `modelProject` did the right thing with a record it
cannot model: skipped it and counted it. A whole board arrived as a skip count,
through `ferret sync` or anything else. EPIC-071's suite never saw it because it
asserts what the *provider* returns and never carries that across the seam into
the model — and its fixture has had the real Jira spelling since the day it was
written.

Three smaller gaps of the same family came with it, each one a value that three
layers agreed mattered and no line carried between them: `ProjectRecord.key` was
added by EPIC-071 so Jira issues would not lose `FER-12`, and `modelProject`
read only `number`; `issuetype` and `priority` were requested on every search
since EPIC-071, paid for in every response, and discarded; and a tracker that
declares two of four operations spent two of the ingestor's twenty pages
arriving at collections it would never run.

One relationship type was added — `ISSUE_LINKS_ISSUE`, generic, with the
vendor's own word in `metadata`. The evidence is empirical rather than
aesthetic: a live Jira instance was sampled, and 50 issues carried 144 links of
**fourteen** distinct types, most configured for that instance. A fixed
enumeration would have carried 33 of the 144.

## After the queue — EPIC-123

**Confluence Connector**, directed by the owner on 2026-09-05, and the first
source that could only be reached through EPIC-119's boundary.

The three connectors before it are *adapters* over contracts that already
existed — `source.repository` and `source.project`. Each proved the universal
boundary convenient; none proved it necessary, because in every case a narrower
contract would have served. A wiki page is neither a checkout nor an issue and
there is no third contract to adapt, so `ConfluenceProvider` declares
`source.connector` and implements the three verbs itself. EPIC-119 predicted its
first declarer would be EPIC-120's; it was not, because a repository already had
a contract worth adapting.

It also had nothing to build on: **no Confluence provider existed**, so this
Epic wrote one — and moved the Jira HTTP client into `src/atlassian` rather than
copying it, since Jira and Confluence Cloud are the same host, the same
credential and the same retry semantics. EPIC-071's 149 tests exercise that
client through its old name and were not rewritten, which is what proves the
lift was faithful.

The defect it found could only have been found here. `Provider.contractVersion`
and `SourceConnector.contractVersion` mean different things — the provider
platform's version and the connector contract's — so a class implementing both
has one field for two facts. Both are `1` today, so the first draft compiled and
would have passed everything; it is wrong the moment either moves, and the
failure then is silent and years late. The provider now exposes a connector
rather than being one.

Two relationship types were added, `DOCUMENT_CONTAINS_DOCUMENT` and
`DOCUMENT_LINKS_DOCUMENT`, kept apart on the reasoning EPIC-007 already used for
the branch and the worktree: "what is under this page" and "what mentions this
page" are different questions, and one edge with a flag makes the difference
unqueryable.

Two gates earned their keep. The conformance harness refused the new provider
before it had been run against the suite, and was answered by running it rather
than by an exemption. The boundary suite gained the assertion that matters for a
shared transport: sharing one must not become one provider importing another.

## After the queue — EPIC-124

**Unified Cross-Source Context**, directed by the owner on 2026-09-05, and the
Epic the four connectors before it existed for.

Three of the four hops already resolved after EPIC-120 to EPIC-123 — pull
request to commit to file. The **cross-source** hops did not, and could not, for
a reason that is structural rather than an oversight: `normalize` is pure by
contract and cannot read a store, so a pull request body saying `Fixes FER-12`
had a key and no way to reach the issue that key names. The join belongs after
ingestion, and now happens there.

**Two mechanisms had been built and joined neither time.** `proposeResolutions`
(EPIC-051) carries a `QUOTED_KEY` rule for exactly this and has never had a
caller. `externalIds` (EPIC-006) is on every entity, persisted, queryable and
surfaced over MCP, and no provider had ever populated one. Both are now wired.

**And the text the join needs was being thrown away.** `ProjectRecord.body` is
fetched by both providers and `modelProject` dropped it — *while reading it*, to
find closing references. Ferret knew what a pull request said for exactly long
enough to pull one edge out of it, and then forgot the sentence. That is the
fifth member of a family this arc kept finding, after `listComments`,
`ProjectRecord.key`, `issuetype`/`priority` and `externalIds`: a value three
layers agreed mattered with no line carrying it between them, surviving because
the suites tested one side of a seam.

**No relationship type was added**, and that is asserted rather than claimed:
every cross-source hop uses an edge the model already had. A pull request that
merely *mentions* an issue yields none, because there is no
`pull_request_mentions_issue` and saying nothing beats saying the wrong thing
about whether work is done.

The false positive worth recording: `UTF-8`, `HTTP-2` and `RFC-7540` all have
the shape of `FER-12`, and no pattern separates them because nothing about the
text does. What separates them is whether anybody has a project called `UTF` —
so the pass learns which projects it holds first and filters on that, which
turns an unanswerable question about English into a lookup.

## Not in this queue

- **[#138](https://github.com/indoulia/Ferret/issues/138) — three limitation rows
  with no owning Epic.** Two of the three are product decisions in their own
  right (what a merge commit's *changes* are; whether untracked working-directory
  state is modelled at all), and the third is an incremental-read optimisation
  whose owner the registry does not determine. None is P0 and none is unblocked
  by anything above.
- **[#169](https://github.com/indoulia/Ferret/issues/169) — an unresolvable
  `$secret` fails every command.** Found by dogfooding, filed with three options
  and a recommendation. It is a configuration-semantics decision — when a secret
  reference resolves — not an implementation detail, so it waits for one.
- **macOS coverage.** Declined by the owner on 2026-09-05; see
  [EPIC-115](EPIC-115-macOS-Packaging-Validation.md). The cost of restoring it is
  known (3m47s) and what it buys is named, so revisiting is a decision rather
  than a rediscovery.
- **A gate on the platform table.** `distribution.test.ts` asserts the README's
  command and tool tables against the code; there is no equivalent for the
  platform table, because CI configuration is not importable. EPIC-115 records
  it as a candidate and deliberately did not build it: inventing a gate for a
  decision that had just been made would have been scope nobody asked for.
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
| EPIC-113 | `6122ad4` | [#163](https://github.com/indoulia/Ferret/pull/163) | `b2cfb37` | [record](validation/EPIC-113-VALIDATION.md) | COMPLETE |
| EPIC-116 | `899bfef` | [#164](https://github.com/indoulia/Ferret/pull/164) | `318dcfe` | [record](validation/EPIC-116-VALIDATION.md) | COMPLETE |
| EPIC-117 | `80f9e42` | [#165](https://github.com/indoulia/Ferret/pull/165) | `76e2522` | [record](validation/EPIC-117-VALIDATION.md) | COMPLETE |
| EPIC-114 | `78406f6` | [#166](https://github.com/indoulia/Ferret/pull/166) | `c9916bd` | [record](validation/EPIC-114-VALIDATION.md) | COMPLETE |
| EPIC-115 | `bf02fd2` | [#167](https://github.com/indoulia/Ferret/pull/167) | `1072c3d` | [record](validation/EPIC-115-VALIDATION.md) | CLOSED — coverage deferred |
| EPIC-118 | `4aa5fae` | [#173](https://github.com/indoulia/Ferret/pull/173) | `f4e5997` | [record](validation/EPIC-118-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-119 | `2bf1afa` | [#176](https://github.com/indoulia/Ferret/pull/176) | `1aeffcc` | [record](validation/EPIC-119-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-120 | `6c810c8` | [#178](https://github.com/indoulia/Ferret/pull/178) | `6c810c8` | [record](validation/EPIC-120-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-121 | `62f6c89` | [#180](https://github.com/indoulia/Ferret/pull/180) | `62f6c89` | [record](validation/EPIC-121-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-122 | `7db2ba9` | [#182](https://github.com/indoulia/Ferret/pull/182) | `7db2ba9` | [record](validation/EPIC-122-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-123 | `5b7c6fd` | [#184](https://github.com/indoulia/Ferret/pull/184) | `5b7c6fd` | [record](validation/EPIC-123-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-124 | `8cfee5a` | [#186](https://github.com/indoulia/Ferret/pull/186) | `8cfee5a` | [record](validation/EPIC-124-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-125 | `745a3f1` | [#198](https://github.com/indoulia/Ferret/pull/198) | `745a3f1` | recorded in [EPIC-119](validation/EPIC-119-VALIDATION.md) and [EPIC-120](validation/EPIC-120-VALIDATION.md) | COMPLETE — ingestion continuation; evidence landed on the two Epics it corrected rather than under its own number |
| EPIC-126 | `659c69b` | [#199](https://github.com/indoulia/Ferret/pull/199) | `659c69b` | [record](validation/EPIC-126-VALIDATION.md), [decisions](../Architecture/EPIC-126-DECISIONS.md) | COMPLETE — directed outside this queue |
| EPIC-127 | `31b504f` | [#201](https://github.com/indoulia/Ferret/pull/201) | `31b504f` | [record](validation/EPIC-127-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-128 | `b1a5516` | [#202](https://github.com/indoulia/Ferret/pull/202) | `b1a5516` | [record](validation/EPIC-128-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-129 | `31e392c` | [#203](https://github.com/indoulia/Ferret/pull/203) | `31e392c` | [record](validation/EPIC-129-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-130 | `8830d20` | [#204](https://github.com/indoulia/Ferret/pull/204) | `8830d20` | [record](validation/EPIC-130-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-131 | `a5a8049` | [#205](https://github.com/indoulia/Ferret/pull/205) | `a5a8049` | [record](validation/EPIC-131-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-132 | `7899ef7` | [#207](https://github.com/indoulia/Ferret/pull/207) | `7899ef7` | [record](validation/EPIC-132-VALIDATION.md) | COMPLETE — directed outside this queue |
| EPIC-133 | `cacad40` | [#208](https://github.com/indoulia/Ferret/pull/208) | `cacad40` | [record](validation/EPIC-133-VALIDATION.md) | COMPLETE — directed outside this queue |

Two follow-ups came out of dogfooding the Epics above rather than out of the
queue, and are recorded here because they changed shipped behaviour:

| Change | Commit | PR | Merge |
| --- | --- | --- | --- |
| The sync cursor defect — a review ceiling blocking what a page limit blocks | `69766e9` | [#168](https://github.com/indoulia/Ferret/pull/168) | `ea586db` |
| `ferret export --session` narrows sessions, and the README promised otherwise | `ae0211f` | [#170](https://github.com/indoulia/Ferret/pull/170) | `09f5624` |

All four merged **without** a validation record and without a registry catalog
entry; both were added on 2026-09-05 and every cited suite re-run to confirm the
evidence still holds. The reconciliation, and the fact that the records were
written after the merges rather than alongside them, is recorded in
[the registry](README.md#catalog-reconciliation--2026-09-05).
