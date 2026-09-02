# EPIC-078 — Periodic Reconciliation · Validation Evidence

**Assessed against:** working tree on top of `2cd84e8`
**Date:** 2026-09-03
**Environment:** real PostgreSQL 17 + pgvector and real Git repositories, driven
through the built CLI as a child process — because the claim is that *one
command* reconciles what Ferret knows, and a service-level test would prove the
loop rather than the claim.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 reconciles every known repository with no path | **MET** | `reconcile.test.ts` "reconciles every known repository without being given a path" — two real repositories, both indexed |
| AC-2 oldest first | **MET** | integration "goes oldest first" — one repository re-indexed alone, then attempted second; unit "orders by staleness" and "breaks a tie stably" |
| AC-3 skips what is fresher than the threshold | **MET** | integration "skips a repository indexed more recently than the threshold"; unit covers the boundary |
| AC-4 a skip is not an index | **MET** | integration asserts `indexed: 0` with two `fresh`; unit "never counts a fresh repository as indexed" |
| AC-5 no threshold attempts everything | **MET** | integration "attempts everything when no threshold is given"; unit for both extremes |
| AC-6 refused without the `INDEX` permission | **MET** | `cli-authorization.test.ts` "refuses to reconcile when configuration withholds index", with the granting control beside it |
| AC-7 one failure does not prevent the others | **MET** | integration "keeps going when one repository fails" — the healthy repositories still indexed |
| AC-8 a failure names its repository | **MET** | same test — the failed entry carries the path, and a `failureCode` and no message |
| AC-9 exit `0` when everything attempted succeeded | **MET** | integration AC-1; unit "is a success when everything attempted succeeded" |
| AC-10 exit `0` when everything was skipped as fresh | **MET** | integration and unit — the one that matters, since a scheduler mailing hourly about a working pass trains an operator to ignore the mail |
| AC-11 non-zero when a repository failed | **MET** | integration "keeps going when one repository fails" asserts a non-`OK` exit |
| AC-12 the report names age and overdue | **MET** | integration "reports each repository by path" |
| AC-13 prompts for nothing, reads no stdin | **MET** | unit "reads no stdin" — asserted over the command's source against `process.stdin`, `readline`, `createInterface` and `question(` |
| AC-14 never deletes, exports, or recovers | **MET** | unit "names no timer, and no destructive operation, in the pass module" and "does not reach a destructive service from the command either" |
| AC-15 starts no timer | **MET** | same unit tests, plus integration "names the scheduler rather than becoming one" over the human rendering |
| AC-16 an empty index is a no-op exiting `0` | **MET** | integration "reconciles an empty index as a no-op" against a second, empty database |
| AC-17 `--dry-run` indexes nothing | **MET** | integration "reports the plan and indexes nothing with --dry-run" |
| AC-18 a checkout on another machine is `elsewhere`, not failed | **MET** | integration "reports a checkout that is not on this machine as elsewhere, not failed" |

Eighteen of eighteen MET. `npm run verify` green: 145 files, 3 002 passed,
3 skipped.

## Found while implementing

**A repository's local path is deliberately not a canonical attribute**, and
that changed the Epic. `src/git/provider.ts` records the reason where it puts
the path in `unknownFields.localRoot` instead: *"where this checkout happens to
live is a fact about **this machine**, not about the repository, so two machines
sharing one Ferret database would otherwise overwrite each other's copy of the
same row for ever."*

The first implementation read `attributes->>'path'` and found nothing at all —
the report said "no repositories are indexed" against a database holding two.
Reading `unknown_fields->>'localRoot'` is correct, and a local pass wants
exactly the machine-specific fact.

But it follows that **a pass against a shared database legitimately meets
repositories it cannot reach**, and the first version reported those as
`failed`. That would make every such pass exit non-zero for ever, which defeats
§8.7's whole purpose — a non-zero exit has to mean something. So §8.4a and AC-18
were added: `elsewhere` is its own outcome, counted as a skip. The distinction is
real and testable: a path that is *gone* is `elsewhere`; a path that is *there
and is not a repository* is a failure.

**There is no per-repository index lock, and adding one would have been wrong.**
The first design assumed a lock and a new exit code for contention. Ferret has
neither, because EPIC-080 proved the write paths idempotent and EPIC-079 retries
a conflict — so an overlapping pass is already *harmless*, just wasteful.
`IndexRunStore.unfinished` already answers "is a run open", so §8.4 reuses it and
skips rather than queuing. Governance §5, and one fewer primitive.

The evidence is stated as what it is: `unfinished`'s own comment says it reports
"runs that have been open longer than any plausible run, not runs that are known
to be dead", and the report says *skipped because a run looks in flight* rather
than claiming certainty.

## Decisions worth recording

**Ferret does not schedule itself, and that is the Epic's central answer.** No
daemon, no timer, no background thread. `cron`, a `systemd` timer and Task
Scheduler each already solve what a hand-rolled scheduler would solve badly:
surviving a reboot, not overlapping with itself, logging when it ran, and being
visible to an operator who did not write it. The same answer EPIC-089 §8.1 gave
about `pg_dump` and EPIC-088 §4 gave about `dropdb` — Ferret is a well-behaved
thing to run, not a platform.

What it owes a scheduler is being *safe to run unattended*, and that is the
testable part: no prompt, an exit code that distinguishes "nothing to do" from
"something failed", and a pass that is harmless when it overlaps.

**Three deferrals were decisions, and all three are declined.** Each Epic that
sent a schedule here said the decision was this Epic's to take:

- **A scheduled prune** — EPIC-088 §8.1's own words answer it: "a scheduled
  delete is the silent version of this Epic."
- **A scheduled export** — EPIC-089's document is everything Ferret knows, in
  cleartext, in one file; writing one on a timer decides where it lives and who
  can read it.
- **Unattended provider recovery** — EPIC-014 §8.6 refused a poll and named this
  Epic as the one that would reconsider. It re-runs an `initialize` that already
  failed, and on a timer that is a log full of identical warnings, which is
  exactly why EPIC-014's circuit exists.

Two tests assert the module and the command reach none of the three services,
matched on the imported names — so a future author who adds one has to delete a
test and say why.

**Cadence is a threshold, not a timer.** `--stale-after 6h` lets an hourly cron
line be safe: the schedule can be more frequent than the work without doing the
work more frequently. The boundary is *stale*, not fresh — a 6h cadence that
skipped at exactly 6h would drift a little later every pass.

**A duration is parsed, not counted in seconds.** `--stale-after 21600` is a
cron line nobody can check at a glance; `6h` is. An unreadable value is a usage
error rather than a default, because a silently-misparsed threshold is a pass
that quietly does nothing — or everything.

**Sequential, one repository at a time.** Parallelism would multiply the
connections an unattended run holds, and the work is I/O against remotes that
are not Ferret's to hammer.

## Limitations, recorded

- **Ferret cannot tell a removed cron line from a healthy quiet period.** §8.8
  reports staleness and an operator reads it; nothing alerts. Alerting needs a
  destination, which is a product decision no Epic owns.
- **`--stale-after` is measured against `last_indexed_at`,** which records when
  Ferret last *looked* rather than when the source last changed. A repository
  that changes hourly and one that never changes are treated identically. Using
  source change would need a cheap remote probe, which is EPIC-076's territory.
- **No jitter.** Ten installs pointed at one Git host with the same cron line
  will hit it at the same second. The scheduler is where jitter belongs, and
  `cron` has `RANDOM_DELAY`.
- **Nothing resumes a pass.** An interrupted pass re-runs from the start;
  oldest-first ordering is what makes that cheap rather than a cursor of its own.
- **A pass reconciles what is indexed and discovers nothing.** Adding a
  repository is `ferret index <path>`, deliberately: a pass that went looking
  would index whatever happened to be on the disk.
- **`elsewhere` is decided by `existsSync`**, so a repository on a temporarily
  unmounted volume reads as living on another machine. Both are "not reachable
  now" and neither is a failure, so the outcome is right and the *name* is
  approximate.
