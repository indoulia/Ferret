# EPIC-078 — Periodic Reconciliation

**Status: VALIDATED | Priority: P1 | Domain: Synchronization**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Synchronization; only the
> specification is new.

## 1. Objective

Make Ferret a **safe thing to schedule**, and give a scheduler one command to
run: bring every repository Ferret already knows up to date, unattended.

## 2. Value

Seven Epics defer scheduling here, and three of them defer a *decision* rather
than a mechanism:

- **EPIC-075 §4, EPIC-076 §4** — "Scheduling, timers, unattended runs —
  EPIC-078."
- **EPIC-094 §4** — "Nothing here runs on a timer. Cadence, drift between
  scheduled passes and unattended operation are EPIC-078."
- **EPIC-088 §4/§16** — a scheduled *prune* "would need to decide, separately,
  whether a scheduled delete is ever acceptable."
- **EPIC-089 §4** — scheduling an export.
- **EPIC-014 §4** — a poll that *recovers a provider* unattended "is a decision
  that Epic has to take."
- **EPIC-099 §4** — scheduling the conformance harness.

So there are two questions. *What runs periodically* — answered by §8.2 — and
*what must never run periodically*, which §8.5 answers with a no and a reason
for each.

Today the gap is concrete: `ferret index <path>` indexes **one** repository, so
an operator with six of them writes six cron lines and maintains that list by
hand. Ferret already knows which repositories it has indexed; nothing asks it.

## 3. Scope

- **`ferret reconcile`** — an incremental pass over every repository Ferret
  already knows.
- **A staleness threshold** — cadence expressed as "older than this", which is
  how a schedule is honoured without Ferret owning a timer.
- **Per-repository isolation** — one repository's failure does not end the pass.
- **A drift report** — how long since each repository was last indexed.
- **Saying that Ferret does not schedule itself**, and what to use instead.

## 4. Non-scope

- **A daemon, a timer, or a background thread.** §8.1. `cron`, `systemd`
  timers and Task Scheduler are mature, observable, and already in the
  operator's toolchain; Governance §5 is explicit about which of those Ferret
  should reimplement, and the answer is none of them.
- **Scheduled pruning** — §8.5, and the answer is no. EPIC-088 §8.1: "a
  scheduled delete is the silent version of this Epic."
- **Scheduled export** — §8.5. EPIC-089's document is everything Ferret knows in
  one cleartext file, and writing one unattended on a timer is a data-exposure
  decision an operator makes, not a default.
- **Unattended provider recovery** — §8.5. EPIC-014 §8.6 already refused a poll,
  and this Epic is the one that was supposed to reconsider: it declines too.
- **Discovering repositories Ferret has never seen.** A pass reconciles what is
  *indexed*; adding a repository is `ferret index <path>`, deliberately.
- **Webhooks or event-driven sync** — EPIC-077.
- **Changing what an incremental run reads.** EPIC-075/076 own the cursor and
  the loop; this calls them once per repository.

## 5. Inputs

`entity` rows of kind `repository` — their path and `last_indexed_at`;
`IndexRunStore.unfinished` for a run already in flight.

## 6. Outputs

`src/indexing/reconcile.ts` — the pass and the drift report. `ferret reconcile`.

## 7. Dependencies

EPIC-031 (the indexer), EPIC-075/076 (cursors and incremental reads),
EPIC-080 (idempotence — what makes an overlapping pass harmless),
EPIC-093 (the isolation grain), EPIC-085 (the audit event).

## 8. Contracts

### 8.1 Ferret does not schedule itself

No daemon, no timer, no background thread. The scheduler is `cron`, a `systemd`
timer, or Task Scheduler — each of which already solves the problems a
hand-rolled scheduler would have to solve badly: surviving a reboot, not
overlapping with itself, logging when it ran, and being visible to an operator
who did not write it.

What this Epic owes them is a command that is *safe to run unattended*: no
prompt, no interactive output, an exit code that means something, and a pass
that is harmless when it overlaps with another.

This is the same answer EPIC-089 §8.1 gave about `pg_dump` and EPIC-088 §4 gave
about `dropdb`. Ferret is a well-behaved thing to run, not a platform.

### 8.2 A pass reconciles every repository Ferret already knows

`ferret reconcile` reads the `repository` entities and runs an **incremental**
index of each — the same path `ferret index` takes, once per repository, with
EPIC-076's cursor deciding what to re-read. An operator with six repositories
writes one cron line, and adding a seventh needs no cron change.

Order is by staleness, oldest first, so a pass that is interrupted has done the
most useful work rather than the alphabetically earliest.

### 8.3 Cadence is a threshold, not a timer

`--stale-after <duration>` skips a repository indexed more recently than that.
Cadence then lives in the scheduler *and* is enforced here, which is what makes
an hourly cron line safe to point at a `--stale-after 6h` pass: the schedule can
be more frequent than the work without doing the work more frequently.

A skipped repository is reported as skipped, never as done. "Nothing needed
doing" and "it was done" are different facts, and a report that conflated them
would make a broken pass indistinguishable from a quiet one.

### 8.4 A repository with a run in flight is skipped, not queued

Reusing `IndexRunStore.unfinished` rather than adding a lock: Ferret has no
per-repository index lock, because EPIC-080 proved the write paths idempotent
and EPIC-079 retries a conflict — so an overlapping pass is *harmless* and
merely wasteful. Skipping it makes it not wasteful either.

The evidence is age, and it is stated as such: `unfinished` reports runs open
longer than any plausible run, not runs known to be dead. A pass that skips a
repository because a run *looks* in flight says so.

### 8.4a A checkout on another machine is not a failure

A repository's local path is deliberately **not** a canonical attribute.
`src/git/provider.ts` records why: *"where this checkout happens to live is a
fact about **this machine**, not about the repository, so two machines sharing
one Ferret database would otherwise overwrite each other's copy of the same row
for ever."* The path lives in `unknownFields.localRoot`, and that is what a
local pass reads.

So a pass against a shared database legitimately meets repositories it cannot
reach. Those are reported `elsewhere` and counted as skips: calling them
failures would make every such pass exit non-zero for ever, and §8.7 exists to
keep a non-zero exit meaningful.

### 8.5 A pass reads and re-derives. It never deletes, exports, or recovers

The three decisions deferred here, each answered no:

- **Pruning.** EPIC-088 §8.1: "Governance §6 forbids silently rewriting
  evidence, and a scheduled delete is the silent version of this Epic." A prune
  that ran unattended would delete rows nobody watched it choose. `ferret prune`
  stays explicit and confirmed.
- **Export.** EPIC-089's document is everything Ferret knows, in cleartext, in
  one file. Writing one on a timer decides where that file lives and who can
  read it — a data-exposure decision an operator makes deliberately.
- **Provider recovery.** EPIC-014 §8.6 refused a poll and named this Epic as the
  one that would have to decide. It declines: recovery re-runs an `initialize`
  that already failed, and doing that on a timer converts a misconfiguration
  into a log full of identical warnings. EPIC-014's circuit exists precisely
  because repeated unattended attempts are the wrong shape.

Each is available as an explicit command. None is a default.

### 8.6 One repository's failure does not end the pass

Per repository, which is EPIC-093's isolation grain applied to a loop: a
repository whose remote is gone must not stop the other five from being
indexed. Every failure is reported with the repository it belongs to.

### 8.7 The exit code distinguishes "nothing to do" from "something failed"

`0` when every repository the pass attempted succeeded — **including** a pass
that skipped all of them as fresh, because that is the pass working. Non-zero
when a repository failed, so a scheduler's failure mail means something. A pass
that reports a skip is not a failure.

### 8.8 Drift is reported, because a schedule that stopped is invisible

Every repository's age since last index, and which exceed the threshold. The
failure mode a schedule has is *silence* — a cron line that was removed, a timer
that never fired — and the only way to notice is to ask how stale things are.

## 9. Acceptance criteria

- **AC-1** `reconcile` indexes every known repository, without being given a
  path.
- **AC-2** Repositories are attempted oldest-first.
- **AC-3** A repository indexed more recently than `--stale-after` is skipped.
- **AC-4** A skipped repository is reported as skipped, not as indexed.
- **AC-5** With no `--stale-after`, every repository is attempted.
- **AC-6** A repository with an unfinished run is skipped and reported.
- **AC-7** One repository's failure does not prevent the others.
- **AC-8** A failure names the repository it belongs to.
- **AC-9** Exit `0` when everything attempted succeeded.
- **AC-10** Exit `0` when everything was skipped as fresh.
- **AC-11** Non-zero when a repository failed.
- **AC-12** The drift report names each repository's age and whether it is
  overdue.
- **AC-13** `reconcile` prompts for nothing and reads no stdin.
- **AC-14** `reconcile` never deletes, exports, or recovers a provider — §8.5,
  as a test.
- **AC-15** `reconcile` starts no timer and registers no interval — §8.1, as a
  test.
- **AC-16** An empty index reconciles as a no-op and exits `0`.
- **AC-17** `--dry-run` reports the plan and indexes nothing.
- **AC-18** A repository whose checkout is not on this machine is reported
  `elsewhere` and counted as a skip, not as a failure — §8.4a.

## 10. Test requirements

**Unit** — staleness selection and ordering; the exit-code mapping; the drift
report.

**Integration (real PostgreSQL and git)** — a pass over two real repositories,
one fresh and one stale; a failing repository beside a working one.

**Security** — AC-13, AC-14.

**Failure** — a repository whose path no longer exists; an unfinished run.

**Regression** — EPIC-031's and EPIC-076's suites unchanged.

## 11. Security requirements

An unattended run is the one nobody is watching, so §8.5's three refusals are
the security contract: nothing destructive and nothing that writes an export
happens without a person asking. `reconcile` needs the `INDEX` permission, like
`index`.

## 12. Observability

The report: per repository, the outcome and the age. One audit event for the
pass, naming the counts.

## 13. Performance constraints

Sequential, one repository at a time. Parallel passes would multiply the
database connections an unattended run holds, and the work is I/O against
remotes that are not Ferret's to hammer.

## 14. Definition of Done

Scope implemented; AC-1 to AC-18 with evidence in
`validation/EPIC-078-VALIDATION.md`; `npm run verify` green; the registry
updated; the deferrals in EPIC-075, EPIC-076, EPIC-088, EPIC-089, EPIC-094,
EPIC-099 and EPIC-014 struck with dated notes — three of them recording that
this Epic *declined* the schedule.

## 15. Governance alignment

- **§5 Reuse Before Reinvent** — §8.1: the scheduler already exists, three times
  over, and §8.4 reuses `unfinished` rather than adding a lock.
- **§6 Evidence Before Inference** — §8.4 states that age is the evidence, not
  liveness; §8.3 keeps "skipped" and "done" distinct.
- **§12 Security** — §8.5's three refusals.
- **§13 Diagnosability** — §8.8: a schedule that stopped is invisible unless
  something reports staleness.

## 16. Raised, not absorbed

- **Ferret cannot tell a removed cron line from a healthy quiet period.** §8.8
  reports staleness and an operator reads it; nothing alerts. Alerting needs a
  destination, which is a product decision no Epic owns.
- **A pass is sequential**, so twenty repositories take twenty times as long as
  one. Parallelism is a knob nobody has asked for, and the work is mostly I/O
  against remotes.
- **`--stale-after` is compared against `last_indexed_at`,** which records when
  Ferret last *looked* rather than when the source last changed. A repository
  that changes hourly and one that never changes are treated identically. Using
  source change instead would need a cheap remote probe, which is EPIC-076's
  territory.
- **No jitter.** Ten Ferret installs pointed at one Git host with the same cron
  line will hit it at the same second. The scheduler is where jitter belongs,
  and `cron` has `RANDOM_DELAY`.
- **Nothing resumes a pass.** An interrupted pass is re-run from the start;
  oldest-first ordering (§8.2) is what makes that cheap rather than a cursor of
  its own.

## 17. Recorded during implementation

**A repository's local path is deliberately not a canonical attribute**, and
that added §8.4a and AC-18. `src/git/provider.ts` puts it in
`unknownFields.localRoot` because "where this checkout happens to live is a fact
about **this machine**" — so a pass against a shared database legitimately meets
repositories it cannot reach, and the first version called those failures. That
would have made every such pass exit non-zero for ever, defeating §8.7's
purpose. The first implementation also read `attributes->>'path'` and found
nothing at all: it reported "no repositories are indexed" against a database
holding two.

**There is no per-repository index lock, and adding one would have been wrong.**
The first design assumed a lock and a new exit code for contention. EPIC-080
proved the write paths idempotent and EPIC-079 retries a conflict, so an
overlapping pass is already harmless — §8.4 reuses `IndexRunStore.unfinished`
rather than introducing a primitive.

Full evidence in [validation](validation/EPIC-078-VALIDATION.md).
