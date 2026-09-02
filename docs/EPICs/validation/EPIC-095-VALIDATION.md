# EPIC-095 — Operational Diagnostics · Validation Evidence

**Assessed against:** working tree on top of `e40a64b`
**Date:** 2026-09-02
**Environment:** Windows 11, real PostgreSQL 17, and Ferret's own index.

## The finding this Epic was written for

Ferret's remediation for a held migration lock read:

> *"Wait for the other Ferret process to finish starting. If none is running,
> inspect `pg_locks` for a stale session holding the advisory lock."*

That is the exact instruction Governance §13 exists to prevent — *"without
requiring the user to become a database administrator"* — written by us, in our
own error text. And it was avoidable, because the database can be asked.

It now says who:

```
The Ferret migration lock is held: process 4242 (psql) has held it for 7200s, idle in transaction
→ Process 4242 is idle inside an open transaction, so it is holding the lock without doing work.
  That is a stuck client rather than a slow migration: end that process, then run `ferret init` again.
```

The two cases call for opposite responses — wait, or go and end that process —
and `state` is the only thing that separates them. A single remediation covering
both would be advice for neither.

## A defect found while building it

**`findLockHolder` would have named a session in the wrong database.** `pg_locks`
is cluster-wide; an advisory lock is per-database. Without a database predicate,
Ferret would have identified a session holding the same lock id on some *other*
database on the same server and told an operator to go and end it.

Found by the full test suite rather than by the file's own run: two suites
against two test databases took the same advisory lock, and each saw the other's
holder. Fixed with a `l.database = current_database()` predicate. Worth
recording because it is a diagnosis that would have been confidently wrong — the
worst kind for a tool whose job is to be believed.

## What `ferret doctor` now answers

Against Ferret's own index, through the CLI:

```
index
  code_symbol       1910
  file_version      688
  file              586
  commit            141
  branch            14
  developer         1
  repository        1
  worktree          1
  relationships     3963
  evidence          1445
  content           120 blob(s), 1242969 byte(s) of text
  last run          succeeded for github.com/indoulia/Ferret, 378s ago

capabilities
  storage             available
  source.repository   available
```

Every number already existed — `content_blob` since EPIC-087, the run journal
since EPIC-094, entity counts since EPIC-006 — and **nothing assembled them**.
The run journal in particular had recorded every index attempt since EPIC-094
and been read by exactly one caller, looking only for runs that never closed.
This is the other half: what did happen, and when.

The capability section uses EPIC-093's optional registration, which is what
makes it safe to build a registry inside `ferret doctor` at all: a provider that
cannot start is a recorded fact rather than a thrown error, so the diagnostic
survives the thing it is diagnosing.

## Acceptance criteria

| AC | verdict | evidence |
| --- | --- | --- |
| AC-1 the error names the holding session | MET | integration test takes the advisory lock on a second real connection and asserts pid, application and duration — the only way to prove this rather than assert a query shape |
| AC-2 unidentifiable holder stays actionable, claims no pid | MET | `remediationForHolder(undefined)` says "could not identify" and is asserted not to match `process \d` |
| AC-3 no remediation names SQL or a catalogue | MET | `tests/security/no-dba-remediations.test.ts` over **130** remediation strings enumerated from `src/`; the removed `pg_locks` string would have failed it |
| AC-4 entity, evidence, content counts | MET | shown above; integration-tested |
| AC-5 the last completed run | MET | repository, outcome and age; asserted absent on a database that has never indexed |
| AC-6 capability availability with reasons | MET | `unregistered`, `disabled`, `failed`, derived from `describe()` and EPIC-093's `failures()` |
| AC-7 absent, not zero, with no database | MET | `readInventory` returns `undefined` against an unmigrated database; `doctor` still produces its report |
| AC-8 no inventory number changes the verdict | MET | the inventory is added to the payload after `countBySeverity`; exit code comes from `exitCodeForHealth` untouched |
| AC-9 a throwing query is unknown, not fatal | MET | integration test against a database with no `ferret` schema |
| AC-10 `ferret status` unchanged | MET | no change to `status.ts` beyond EPIC-091's; the inventory is `doctor`'s |

## Verification

`npm run verify` green: 119 files, 2 515 passed, 3 skipped. New:
`src/storage/diagnostics.ts`, `tests/integration/storage/diagnostics.test.ts`
(6), `tests/security/no-dba-remediations.test.ts` (5).

## Raised, not absorbed

- **An existing test asserted the behaviour this Epic removes.**
  `reliability.test.ts` required the remediation to *contain* `pg_locks`,
  pinning in place the instruction §13 forbids. Replaced with the stronger
  property — the error names the holder and a Ferret command, and no remediation
  anywhere names a catalogue. Recorded because updating a test to match new code
  deserves to be visible, and because this one was asserting the wrong thing
  rather than merely a different thing.
- **A flaky test was found and filed, not fixed — #109.**
  `evidence-store > uses the subject index rather than scanning` reads a query
  plan and fails intermittently under full-suite load. Not caused by this Epic
  and not this Epic's to fix, but worth naming: a gate people re-run by reflex
  stops catching things, and this session already had a CI container restart
  produce the same reflex.
- **`pg_stat_activity` is privileged.** A restricted role sees limited columns
  for other sessions, so the quality of the lock diagnosis depends on the role
  Ferret connects as. AC-2 covers the degraded case; the dependency is real and
  is stated rather than hidden.
- **The holder's query text is redacted but still disclosed.** Another session's
  SQL can carry a literal credential, and this string is one an operator pastes
  into a ticket. It goes through EPIC-091's redactor, which is the same
  protection every other outbound value gets — no more, and worth knowing.
- **The inventory will grow.** Every Epic that adds a table will want a line.
  Left as a flat set of counts rather than a registration framework, because
  machinery for four numbers is more than the problem has.
