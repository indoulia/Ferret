# EPIC-106 — Upgrade & Migration UX

**Status: VALIDATED | Priority: P1 | Domain: Distribution**

> Authored to the [Epic Specification Standard](EPIC-SPECIFICATION-STANDARD.md).
> Registered in the [Epic registry](README.md) under Distribution; only the
> specification is new.

## 1. Objective

Tell a user what upgrading will do **before** it does it — and say what to do
when the database is from a newer Ferret than the one they are holding.

## 2. Value

`validation/EPIC-010-VALIDATION.md` states the gap exactly:

> *"**No user-facing upgrade experience.** `ferret init` applies migrations and
> `ferret doctor` reports state; nothing guides an upgrade."*

Both halves of that are true and neither is an upgrade. `ferret init` migrates
as a side effect of provisioning, so an operator upgrading a production database
runs a command named *init* and hopes. `ferret doctor` reports the state
afterwards. Nothing between them says *this is what is about to change*.

The sharpest missing case is the one nobody plans for. A database migrated by a
**newer** Ferret than the binary now running is refused by the migrator — which
is correct, EPIC-002's reasoning — with an error, and nothing tells the operator
that `ferret export` is the path out. `COMPATIBILITY.md` §7 has named that
experience as this Epic's since it was written.

- **`COMPATIBILITY.md` §7** — "The upgrade *experience* — what a user sees and
  is asked → **EPIC-106**."
- **EPIC-010's validation** — the row above.
- **EPIC-102/103/104's validation** — "No upgrade path documented for a database
  migrated by an older Ferret. The migrator handles it; the *documentation* does
  not describe it."
- **EPIC-089 §16** — "A restore into a different major version is not tested
  here — that needs two versions installed, which is EPIC-106's environment."

## 3. Scope

- **`ferret upgrade`** — the plan, then the confirmed apply.
- **Naming the pending migrations**, by version and name, before anything runs.
- **The newer-database case** — refused, with the export path named.
- **Drift and prior failures** surfaced where an operator is already looking.
- **The backup line** — EPIC-089's `pg_dump` command, printed before an apply.
- **Documenting the upgrade**, which EPIC-102/103/104's row asks for.

## 4. Non-scope

- **A second migration path.** `migrate()` is EPIC-002's and stays the only
  writer: the lock, the ordering, the checksum check and the failure journal are
  its. This command produces a *plan* from `readSchemaStatus` and then calls the
  same function `ferret init` calls. §8.2, and the argument EPIC-066 made about
  `ConfigStore`.
- **A downgrade.** A migration runs forward and there is no `down`. §8.4 names
  the path — export, install the older Ferret, import — and refuses to pretend
  a `--downgrade` flag could exist.
- **Taking a backup.** EPIC-089 §8.1 already decided Ferret does not wrap
  `pg_dump`; this prints the command, which is the same answer one step earlier.
- **Automatic upgrade on start.** `ferret init` migrates because provisioning is
  its job (Governance §15). A long-running `ferret mcp` runs under
  `MigrationPolicy.VERIFY` and refuses a stale schema rather than silently
  changing one, and that stays true.
- **Migrating *data* rather than schema.** An entity-envelope rewrite is a
  migration like any other; EPIC-010 owns the envelope's versioning.

## 5. Inputs

`readSchemaStatus` — version, target, pending, drift, unknown, failures — all of
which exist and none of which has a user-facing surface.

## 6. Outputs

`src/cli/commands/upgrade.ts`, and an upgrade section in the README.

## 7. Dependencies

EPIC-002 (the migrator), EPIC-010 (compatibility and the surface policies),
EPIC-089 (the export path and the backup command), EPIC-069/088 (the
plan-then-confirm shape).

## 8. Contracts

### 8.1 A plan is produced first, and names every migration

`ferret upgrade` with no flag reports the current version, the target, and each
pending migration **by version and name** — then changes nothing. An operator
who cannot see what is about to run has not been offered an upgrade; they have
been offered a leap.

### 8.2 The apply is EPIC-002's `migrate`, not a second implementation

The plan comes from `readSchemaStatus`; the apply calls `migrate` with
`MigrationPolicy.AUTO`. So the advisory lock, the ordering, the checksum
verification and the failure journal all apply identically whether a schema
changed from `init` or from here. A second writer would be a second set of
durability bugs, and EPIC-002 already paid for the first set.

### 8.3 `--yes`, not a prompt

`verify --repair`'s shape and `prune`'s, for the reason both record: Ferret is
spawned by an AI client as often as by a person, and a prompt would hang in a
pipe.

### 8.4 A newer database is refused, and the way out is named

When the database carries applied versions this build does not ship, it was
migrated by a **newer** Ferret. The migrator already refuses — correctly, since
reading a newer schema under the old meaning applies an interpretation the
writer never intended. What is missing is the sentence after the refusal, and
this Epic supplies it:

> Export from the newer Ferret, install it again, or import the document into a
> database this build can read.

`ferret export` exists (EPIC-089) and refuses a document whose schema version it
cannot read (EPIC-090 §8.2). This is the first place those two are joined into
an instruction.

### 8.5 Drift and a prior failure are shown, because both change what to do next

**Drift** — an applied migration whose file no longer matches its recorded
checksum — means the database and the build disagree about history, and applying
more migrations on top is the wrong move. **A recorded failure** means a previous
attempt died partway. Both are in `readSchemaStatus` and neither has ever been
surfaced outside `doctor`.

An upgrade plan that omitted them would be telling an operator "three
migrations pending" while withholding "and the last attempt failed."

### 8.6 The backup line comes before the apply, not after

EPIC-089's `--backup-command` printed in the plan. Not wrapped, not run — the
reason EPIC-089 §8.1 gives holds one step earlier too — but *named*, at the
moment it matters, because the operator reading an upgrade plan is the one who
still has time to take a backup.

### 8.7 An upgrade with nothing pending says so and exits `0`

"Already current" is a success. A command that exited non-zero because there was
nothing to do would make an idempotent upgrade unsafe to run from a script,
which is exactly where an upgrade belongs.

## 9. Acceptance criteria

- **AC-1** `ferret upgrade` reports the current and target schema versions.
- **AC-2** The plan names every pending migration by version and name.
- **AC-3** Without `--yes`, nothing is applied.
- **AC-4** With `--yes`, the pending migrations are applied and reported.
- **AC-5** An already-current database reports so and exits `0`.
- **AC-6** A database from a newer Ferret is refused, naming the export path.
- **AC-7** The refusal in AC-6 happens **before** anything is applied.
- **AC-8** Drift is reported, and refused rather than migrated on top of —
  §17 records that this needed an outcome of its own.
- **AC-9** A recorded prior failure is reported in the plan.
- **AC-10** The plan names the `pg_dump` backup command.
- **AC-11** `upgrade` refuses without the `INDEX` permission.
- **AC-12** The apply goes through `migrate`, not a second write path — as a
  test.
- **AC-13** Running `upgrade --yes` twice applies nothing the second time.
- **AC-14** An uninitialized database is reported as needing `ferret init`
  rather than an upgrade.
- **AC-15** The README documents the upgrade, which EPIC-102/103/104's row asks
  for.

## 10. Test requirements

**Integration (real PostgreSQL)** — a database migrated to an earlier version
and upgraded; an already-current one; one carrying an unknown applied version,
which is the newer-Ferret case constructed directly.

**Security** — AC-11.

**Failure** — a recorded failure row; drift injected by rewriting a checksum.

**Regression** — EPIC-002's migrator suite unchanged.

## 11. Security requirements

An upgrade changes the schema, so it takes the `INDEX` grant — the same one
`index` and `reconcile` need. No credential appears in the plan: the connection
is described through `describeConnection`, which redacts.

## 12. Observability

The plan *is* the observability, and it is the same shape in both modes — the
difference is whether the migrations ran.

## 13. Performance constraints

One `readSchemaStatus` for the plan, one `migrate` for the apply. Neither is new
work.

## 14. Definition of Done

Scope implemented; AC-1 to AC-15 with evidence in
`validation/EPIC-106-VALIDATION.md`; `npm run verify` green; the registry
updated; EPIC-010's "no user-facing upgrade experience" row,
`COMPATIBILITY.md` §7's upgrade-experience row and EPIC-102/103/104's
undocumented-upgrade row struck with dated notes.

## 15. Governance alignment

- **§6 Evidence Before Inference** — §8.5: the plan does not withhold drift or a
  prior failure.
- **§13 Diagnosability** — §8.4: a refusal that names the way out.
- **§5 Reuse Before Reinvent** — §8.2: one migrator; §8.6: EPIC-089's backup
  line rather than a second one.
- **§15 Self-Provisioning** — unchanged: `init` still migrates, and this does
  not become a required step.

## 16. Raised, not absorbed

- **A downgrade is still not tested end to end.** EPIC-089 §16 asked for two
  installed versions, and this Epic does not create that environment: it names
  the path and refuses the impossible one. Actually running an older Ferret
  against a document a newer one exported needs two `npm install`s in CI, which
  is EPIC-105's territory now that it has a matrix to add legs to.
- **`ferret upgrade` cannot upgrade Ferret.** It upgrades the *schema* to match
  the installed build; installing the build is `npm install -g`, and a command
  that tried to replace its own binary mid-run is a class of bug this project
  does not need.
- **Drift is reported and not repaired.** A checksum mismatch means the database
  and the build disagree about what already ran, and the only safe fixes are a
  restore or an export-and-import. Offering a "force" flag would offer a way to
  apply migrations on top of a history nobody can reconstruct.
- **No estimate of how long a migration will take.** The plan names what will
  run, not what it will cost. A row-count-based estimate would be a guess
  presented as a number, and the migrations shipped so far are DDL on empty or
  small tables.

## 17. Recorded during implementation

**`migrate` calls `assertUsable` even under `MigrationPolicy.OFF`**, so the
storage provider refuses to initialize against a database that has drifted or
was migrated by a newer Ferret. That is correct for every other command and
fatal for this one: those are precisely the two situations an upgrade exists to
explain, and a command that could not start against them could never report
them.

So `ferret upgrade` is composed with **no storage provider**. The runtime
supplies configuration, logging and the authorization context; the command opens
its own pool and reads `readSchemaStatus` directly. `migrate` is still the only
writer — §8.2 holds — but nothing asserts usability before the plan exists. This
also added a `drifted` outcome the specification had not foreseen: §8.5 assumed
drift would appear *in* a plan, and it turned out to need a refusal of its own,
with its own remediation.

**The `--json` envelope leaked the driver's message.** Returning `SchemaStatus`
verbatim put `failures[].errorMessage` into the response. The human rendering had
always printed only the code, for EPIC-093's reason — *a message can carry a path
or a value* — and the JSON path quietly did not, which is the worse of the two to
get wrong because a machine caller is the one most likely to log it. The response
is now shaped rather than forwarded, so a future field on `SchemaStatus` cannot
leak by default. Found by test.

Full evidence in [validation](validation/EPIC-106-VALIDATION.md).
