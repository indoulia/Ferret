# EPIC-106 — Upgrade & Migration UX · Validation Evidence

**Assessed against:** working tree on top of `90094b2`
**Date:** 2026-09-03
**Environment:** real PostgreSQL 17 + pgvector, through the built CLI as a child
process, against databases migrated **only part of the way** — because a plan
naming zero pending migrations would prove nothing.

## Acceptance criteria

| AC | Verdict | Evidence |
| --- | --- | --- |
| AC-1 current and target versions | **MET** | `upgrade-cli.test.ts` "names the versions and every pending migration" — schema 4, target higher |
| AC-2 every pending migration by version and name | **MET** | same test, asserting each has a non-empty name |
| AC-3 nothing applied without `--yes` | **MET** | same test — the schema version is unchanged afterwards |
| AC-4 the pending migrations are applied | **MET** | "applies the pending migrations and reports them" — version reaches target, `pending` empty |
| AC-5 already current reports so and exits `0` | **MET** | "says so and exits 0", and "says so in the human rendering too" |
| AC-6 a newer database is refused, naming the export path | **MET** | "is refused, names the export path, and applies nothing" — a version 9999 row recorded as applied, which is exactly the state a newer Ferret leaves |
| AC-7 the refusal precedes any apply | **MET** | same test, run **with `--yes`**: `applied` is empty |
| AC-8 drift is reported and refused | **MET** | "reports drift rather than migrating on top of it" — outcome `drifted`, exit `STORAGE`, nothing applied |
| AC-9 a prior failure is reported | **MET** | "reports a previous failure, because it changes what to do next" |
| AC-10 the backup command is named | **MET** | "names the pg_dump backup command in the human rendering" |
| AC-11 refused without `INDEX` | **MET** | `cli-authorization.test.ts` "refuses to apply an upgrade when configuration withholds index", with a read-only *plan* as the control |
| AC-12 the apply goes through `migrate` | **MET** | "records the run in the migrator s own bookkeeping" — every applied row carries a checksum only the migrator writes, and a following `readSchemaStatus` reports no drift |
| AC-13 twice applies nothing the second time | **MET** | "applies nothing the second time" |
| AC-14 an unprovisioned database points at `init` | **MET** | "points at ferret init rather than reporting zero pending" — and exits `0`, because an empty database is a fact rather than a fault |
| AC-15 the README documents the upgrade | **MET** | an "Upgrade" section, including the newer-database case |

Fifteen of fifteen MET. `npm run verify` green: 151 files, 3 074 passed,
3 skipped.

## Found while implementing

**`migrate` calls `assertUsable` even under `MigrationPolicy.OFF`**, so the
storage provider refuses to initialize against a database that has drifted or
was migrated by a newer Ferret. That is correct for every other command and
**fatal for this one**: those are precisely the two situations an upgrade exists
to explain, and a command that could not start against them could never report
them. The first implementation used `createStorageProvider({ policy: OFF })` and
never reached its own plan for either case.

So `ferret upgrade` is composed with **no storage provider**. The runtime
supplies configuration, logging and the authorization context; the command opens
its own pool and calls `readSchemaStatus` directly. `migrate` is still the only
writer — §8.2 holds — but nothing asserts usability before the plan exists.

That also produced an outcome the specification had not foreseen. §8.5 assumed
drift would appear *inside* a plan; it turned out to need a refusal of its own,
with its own remediation, because applying migrations on top of a history nobody
can reconstruct is the wrong move and a plan that merely mentioned it would
still offer `--yes`. AC-8 was restated to match.

**The `--json` envelope leaked the driver's message.** Returning `SchemaStatus`
verbatim put `failures[].errorMessage` — "disk full", in the test — into the
response. The human rendering had always printed only the code, for EPIC-093's
reason: *a message can carry a path or a value.* The JSON path quietly did not,
which is the worse of the two to get wrong, because a machine caller is the one
most likely to log it somewhere.

The response is now **shaped** rather than forwarded: `ReportedStatus` carries
the failure's code, name and instant and no message, so a future field on
`SchemaStatus` cannot leak by default. Found by a test asserting the message was
absent — which is the assertion worth writing, because the positive one
(`toContain('E_MIGRATION_FAILED')`) passed the whole time.

**Two test fixtures were wrong about the schema.** `schema_migrations.duration_ms`
is `NOT NULL`, and the bookkeeping tables are `ferret.schema_migrations` and
`ferret.schema_migration_failures` rather than the `__ferret_`-prefixed names the
first draft guessed. Both corrected against `bookkeeping.ts`.

## Decisions worth recording

**Already current is a success.** A command that exited non-zero because there
was nothing to do would make an idempotent upgrade unsafe to run from a script,
which is exactly where an upgrade belongs. Same for an unprovisioned database:
that is a fact, not a fault, and the remediation is `ferret init`.

**`STORAGE` for both refusals.** "The database is reachable but its schema is
not usable" is precisely what a newer schema and a drifted one are, and it is
the code `ferret status` already reports — so a script branching on the exit
code sees one answer rather than two.

**The backup line is in the plan, not after the apply.** The operator reading a
plan is the one who still has time to take a backup. Ferret does not wrap
`pg_dump` — EPIC-089 §8.1's decision — so it prints the command, which is that
same answer one step earlier.

**The newer-database remediation joins two Epics into an instruction.**
`ferret export` exists and an import refuses a document whose schema version it
cannot read. Those were two Epics an operator would have had to find; this is
the first place they are one sentence.

**A prior failure is reported even when the schema is current.** It says an
earlier attempt died, which an operator wants to know even though the schema
caught up afterwards.

## Limitations, recorded

- **A downgrade is still not tested end to end.** EPIC-089 §16 asked for two
  installed versions, and this Epic names the path rather than creating that
  environment. Running an older Ferret against a document a newer one exported
  needs two `npm install`s in CI, which is EPIC-105's territory now that it has
  a matrix to add legs to.
- **`ferret upgrade` cannot upgrade Ferret.** It upgrades the *schema* to match
  the installed build; installing the build is `npm install -g`. A command that
  tried to replace its own binary mid-run is a class of bug this project does
  not need.
- **Drift is reported and not repaired.** The only safe fixes are restoring the
  migration file or restoring the database, and a `--force` would offer a way to
  apply migrations on top of a history nobody can reconstruct.
- **No estimate of how long a migration will take.** The plan names what will
  run, not what it will cost. A row-count-based estimate would be a guess
  presented as a number.
- **The command opens its own pool**, so it does not benefit from the storage
  provider's connection settings beyond what `poolConfigFor` derives. That is
  the price of working against a database the provider refuses, and it is the
  right trade for this one command only.
