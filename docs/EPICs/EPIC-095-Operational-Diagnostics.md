# EPIC-095 — Operational Diagnostics

**Status: APPROVED | Priority: P0 | Domain: Reliability & Operations**

> **Specification note.** Four documents park work here by name: a migration
> lock wait that reports a symptom rather than a cause
> (`validation/EPIC-004-VALIDATION.md:153`, `Checkpoints/EPIC-004.md:112`),
> "the wider diagnostics surface" (EPIC-094 §4), and diagnostics commands
> (EPIC-091 §4, EPIC-093 §4).
>
> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).

## 1. Objective

Answer an operator's next question, not just their first one: when Ferret
reports a problem, say what is causing it and what is in the index — without
anyone opening `psql`.

## 2. Problem, measured

Governance §13: *"Corrupt or stale derived indexes must be detectable and
recoverable without requiring the user to become a database administrator."*
EPIC-094 made integrity detectable that way. Three things are still not.

**Ferret's own error text tells an operator to run a DBA query.**
`src/storage/migrator.ts:215`:

> `'Wait for the other Ferret process to finish starting. If none is running,
> inspect pg_locks for a stale session holding the advisory lock.'`

That is the exact instruction §13 exists to prevent, in Ferret's own remediation
string. And it is avoidable: PostgreSQL can be asked who holds the lock. The
answer — a pid, how long it has held it, what it is running — is a query Ferret
could make itself and does not.

**Two things this repository built have no operator surface.** EPIC-094 added a
run journal recording every index attempt and its outcome; EPIC-093 added
`ProviderRegistry.failures()`. Both are read by exactly one caller each — the
integrity sweep and `checkAll` — and neither appears anywhere an operator looks.
A record nobody can read is a record that exists for its author.

**`ferret doctor` reports faults and never inventory.** It answers "is anything
wrong". It cannot answer "what does Ferret know", which is the question asked
immediately after every clean bill of health: how many entities, of what kinds,
how much content, indexed when, by which run. Every number exists — `stats()`
in EPIC-087, counts in the stores, the journal in EPIC-094 — and nothing
assembles them.

**What is already right, and is not this Epic's to redo.** The health model
(EPIC-004), the component statuses and exit codes, `index-integrity`
(EPIC-032/094), the structured records `ferret doctor` now emits (EPIC-091), and
the `ferret verify` sweep (EPIC-094). This adds findings and an inventory to
that surface; it does not build a second one.

## 3. Scope

1. **Name the lock holder.** When the migration lock cannot be taken, report
   which session holds it, for how long, and what it is doing — instead of
   naming a system catalogue.
2. **An index inventory** in `ferret doctor`: entity counts by kind, evidence,
   content blobs and stored bytes, and the last completed index run with its
   outcome and age.
3. **Capability availability with reasons** — which declared capabilities are
   usable, and for each that is not, whether it is unregistered, disabled, or
   failed to start.
4. **No remediation names SQL, a table, or a catalogue.** EPIC-094 AC-10 set
   that bar for integrity findings; this extends it to the diagnostics surface
   and fixes the one place that breaks it today.

## 4. Non-scope

- **Metrics, counters, histograms, tracing or history over time** — EPIC-092.
  Everything here is point-in-time, which is what EPIC-004 already established
  and `Checkpoints/EPIC-004.md:113` recorded.
- **Repairing anything.** `ferret verify --repair` exists; this reports.
- **Killing a session that holds a lock.** Ferret names the holder; terminating
  another process's backend is a destructive act against something Ferret does
  not own, and no record asks for it.
- **A new command.** `ferret doctor` and `ferret status` are the surfaces
  (EPIC-004); adding a third would split where an operator looks.
- **Provider restart or health polling** — EPIC-014. **Half delivered
  2026-09-03:** recovery of a failed optional provider exists and its state is
  in the health report; **polling does not**, and EPIC-014 §8.6 keeps it out for
  the reason this Epic would care about — nothing runs on a timer.
- **Audit events** — EPIC-085. A diagnostic is best-effort and discardable.
- **Changing the health model, statuses or exit codes** — EPIC-004, VALIDATED.

## 5. Inputs

`probeHealth` and the health model (EPIC-004); the migrator's advisory-lock
constants (EPIC-002); `IndexRunStore` (EPIC-094); `ContentStore.stats`
(EPIC-087); `ProviderRegistry.failures()`, `capabilities()` and `describe()`
(EPIC-013, EPIC-093); `describeConfigProtection` (EPIC-081).

## 6. Outputs

- A lock-holder diagnosis on the migration path.
- An inventory section in `ferret doctor`, in both output modes.
- Capability availability with a reason per unavailable capability.

## 7. Dependencies

EPIC-002, EPIC-004, EPIC-013, EPIC-087, EPIC-091, EPIC-093, EPIC-094 — all
VALIDATED or IMPLEMENTED. This Epic reads what they built and changes none of
their acceptance criteria.

## 8. Contracts

### A remediation is an action, not a lookup

"Inspect `pg_locks`" is a research task delegated to someone who came here to
be told the answer. Every remediation this Epic produces names a Ferret command
or a decision the operator can act on, and none names a catalogue, a table or a
query. The one existing violation is fixed rather than grandfathered.

### Inventory is not health

A count is not a verdict. The inventory reports what Ferret holds and never
turns a number into a status: "412 entities" is not degraded, and deciding it
were would invent a threshold nobody argued for. Findings stay findings.

### A diagnostic never fails the thing it is diagnosing

Every query here is read-only and every failure is swallowed into an `unknown`.
`ferret doctor` is what an operator runs when things are broken; a diagnostic
that throws in that state is worse than one that says it could not tell.

### The unknown is reported, never inferred

Where a count cannot be read — no database, an older schema without
`index_run` — the inventory says so rather than reporting zero. Governance §6:
"nothing indexed" and "could not ask" are different facts, and this Epic exists
partly because the health probe once confused them.

## 9. Acceptance criteria

- **AC-1** When the migration lock is held, the error names the holding session
  — its pid, how long it has held the lock, and its state — and does not name
  `pg_locks` or any other catalogue.
- **AC-2** When the holder cannot be identified, the error says so and remains
  actionable; it never claims a pid it did not read.
- **AC-3** No remediation string in the diagnostics path contains a SQL keyword,
  a `ferret.` table name, or a system catalogue, asserted by a test over the
  strings the code produces.
- **AC-4** `ferret doctor` reports entity counts by kind, evidence count,
  content blob count and stored bytes.
- **AC-5** It reports the last completed index run: when, for which repository,
  and its outcome.
- **AC-6** It reports each declared capability as available or not, and for each
  unavailable one, whether it is unregistered, disabled or failed.
- **AC-7** Inventory is absent, not zero, when there is no database to ask —
  and `ferret doctor` still produces its report.
- **AC-8** No inventory number changes the health verdict or the exit code.
- **AC-9** A diagnostic query that throws is reported as unknown and does not
  fail the command.
- **AC-10** `ferret status` is unchanged in shape; the inventory is `doctor`'s,
  because `status` answers "is it working" and this answers "what is in it".

## 10. Test requirements

- **Integration, real PostgreSQL** — the inventory over a populated index;
  absent-not-zero with no database (AC-7); the lock diagnosis with a second
  session genuinely holding the advisory lock, which is the only way to prove
  AC-1 rather than assert it.
- **Unit** — AC-3 over the produced strings; capability reasons for each of the
  three cases; a throwing query yielding unknown.
- **No new fixture that needs a second Ferret process.** The lock test takes the
  advisory lock directly on a second connection, which is what a stuck process
  looks like to the database.

## 11. Security requirements

- The lock diagnosis reads `pg_stat_activity`, which carries other sessions'
  query text. Ferret reports the holder's **pid, state and duration**, and the
  query only after it has been through EPIC-091's redaction — another session's
  SQL can contain a literal credential, and this is a surface an operator pastes
  into a ticket.
- The inventory reports counts and kinds. It reports no path, no attribute value
  and no statement — the rule EPIC-094 §11 set for findings, applied here.
- Every query is read-only.

## 12. Observability

The diagnostics surface *is* the observability. It emits `diagnostics.*` records
through EPIC-091's logger at debug, so a `doctor` run leaves the same trace as
any other command.

## 13. Performance constraints

- The inventory is a small number of aggregate queries and must not turn
  `ferret doctor` into something an operator avoids running. Counts are
  `count(*)` over indexed columns; nothing scans content.
- The lock diagnosis runs only on the failure path.

## 14. Definition of Done

Every acceptance criterion satisfied; `npm run verify` green; a validation
document; the registry updated; the two EPIC-004 records that park the lock
finding here discharged or restated.

## 15. Governance alignment

- **§13** — the sentence this Epic exists for, and the one Ferret's own
  remediation currently breaks.
- **§6** — absent rather than zero; unknown rather than inferred.
- **§20** — `ferret status` and `ferret doctor` dependable, and now informative.

## 16. Raised, not absorbed

- **`pg_stat_activity` is privileged.** A non-superuser sees its own queries and
  only limited columns for others. Where the holder's detail is not visible,
  AC-2 applies: say what is known and do not invent the rest. Recorded because
  it means the quality of this diagnosis depends on the role Ferret connects as.
- **The inventory will grow.** Every Epic that adds a table will want a line in
  it. Left as a flat set of counts rather than a framework, because a
  registration mechanism for four numbers is more machinery than the problem
  has.
