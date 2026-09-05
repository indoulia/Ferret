# EPIC-002 — Architecture Decisions

Decisions taken while implementing Database Bootstrap & Migrations, with the
alternatives considered and the reason for selection (Governance §22, AI
Development Rule §19). Decisions that affect later Epics are marked.

---

## D-001 — Storage is a provider, not core

**Decision.** PostgreSQL reaches Ferret through `PostgresStorageProvider`, an
implementation of the EPIC-001 `Provider` contract with kind `storage`. It is
exported from a separate entry point, `@indoulia/ferret/storage`, and is **not**
reachable from `@indoulia/ferret`.

**Alternatives.** Import `pg` directly in the runtime; export storage from the
core entry point.

**Reason.** Governance §4 puts every replaceable implementation behind a provider
contract. Keeping `pg` and Drizzle out of the core import graph means replacing
PostgreSQL later is writing another provider, not editing the core.
`tests/unit/boundaries.test.ts` enforces it by walking the import graph, so the
boundary cannot erode by accident.

**Consequence.** The provider is not registered by default. `ferret env` and
`ferret --version` work on a machine with no database; only commands that need
storage register it. *Affects every later Epic that needs the database.*

---

## D-002 — Bookkeeping tables are created by the migrator, not by a migration

**Decision.** `ferret.schema_migrations` and `ferret.schema_migration_failures`
are created by idempotent bootstrap DDL the migrator runs before any migration.
Migration `0001` owns the first piece of real schema instead.

**Reason.** A migration that fails must have somewhere to record that it failed.
DDL that creates the place failures are recorded cannot itself be a thing that
records a failure. Splitting them removes the bootstrap paradox.

---

## D-003 — The advisory lock is taken before the bootstrap DDL

**Decision.** `pg_try_advisory_lock(0x46455252, 1)` is acquired on a dedicated
session before `CREATE SCHEMA IF NOT EXISTS` runs.

**Reason.** `CREATE ... IF NOT EXISTS` is *not* safe against a concurrent
creator — PostgreSQL can still raise `42P07`. An advisory lock needs no schema of
its own, so it can order the very DDL that creates everything else.

`0x46455252` is ASCII `FERR`, which makes Ferret's lock recognizable in `pg_locks`
during an incident. Object `1` is migrations; later subsystems take a different
object id under the same class rather than inventing a second namespace.

---

## D-004 — Polling `pg_try_advisory_lock`, not blocking on `pg_advisory_lock`

**Decision.** The lock is acquired by polling with jittered exponential backoff
up to a timeout, rather than blocking in `pg_advisory_lock`.

**Reason.** A blocking wait is not cancellable. A user pressing Ctrl-C during
startup must not have to wait out another process's migration, and the runtime's
`AbortSignal` has to be able to end the wait. Jitter stops a herd of starters
polling in lockstep. The cost is a few extra round trips on a contended start,
which the recorded lock wait time makes visible.

---

## D-005 — A migration and its bookkeeping row commit in one transaction

**Decision.** `recordApplied()` is called **inside** the migration's own
transaction.

**Reason.** This makes the dangerous states unrepresentable: the database can
never believe it applied DDL it did not, nor forget DDL it did. It is what turns
a killed process into a safe retry instead of an investigation.
`durability.test.ts` proves it by `SIGKILL`ing a real process mid-transaction.

**Escape hatch.** A migration whose text contains `-- ferret:no-transaction` runs
outside a transaction, for statements PostgreSQL forbids in one — notably
`CREATE INDEX CONCURRENTLY`, which EPIC-031 will want. Such a migration loses
atomicity and must therefore be written to tolerate being re-run. No migration
uses it today. *Affects EPIC-031.*

---

## D-006 — The migration session enables `client_connection_check_interval`

**Decision.** The migrating session sets `client_connection_check_interval = '5s'`,
best-effort.

**Reason.** Found by test, not by reasoning. `durability.test.ts` `SIGKILL`ed a
child mid-migration and the advisory lock was never released: PostgreSQL notices
a vanished client only when it next reads the socket, which a backend running a
long statement never does. Every other Ferret process then waited out the full
lock timeout for a process that no longer existed.

With the setting, the backend polls for a disconnected client mid-statement and
aborts, releasing the lock in ~5 s.

**Known gap.** The parameter is a no-op on servers whose platform cannot poll the
socket — notably PostgreSQL running on Windows. It is therefore set best-effort
and the lock timeout remains the backstop. Recorded in the validation evidence
rather than presented as a complete solution.

---

## D-007 — Failure is recorded in the database, not only in a log

**Decision.** A failed migration writes a row to
`ferret.schema_migration_failures` in a fresh transaction after the rollback, and
that row is cleared when the migration later succeeds.

**Alternatives.** Log the failure; leave a marker file; leave no state.

**Reason.** "Failed migrations leave an explicit recoverable state" (AC-5) is not
satisfied by a log line that may never be read, on a machine the operator may not
have. The state has to live where `ferret doctor` (EPIC-004) and the MCP surface
(EPIC-065) can find it, which is the database itself. Clearing it on success
matters as much: a permanently red `ferret doctor` teaches operators to ignore it.

Stored messages are redacted before insert — a PostgreSQL error can quote the
offending statement. *Affects EPIC-004.*

---

## D-008 — Checksums make an edited migration a hard failure

**Decision.** Each migration's SHA-256 (over text with line endings normalized)
is stored when applied and re-verified on every start. A mismatch is
`E_SCHEMA_DRIFT`; an applied version this build does not ship is
`E_SCHEMA_UNSUPPORTED`.

**Reason.** Both mean the operator's mental model of the database is wrong, and
guessing would compound it. Refusing is the honest response. Line endings are
normalized because Git may rewrite them on checkout, and hashing raw bytes would
make a database migrated on Linux look tampered with from a Windows checkout.

*Affects EPIC-010, which owns schema versioning and compatibility.*

---

## D-009 — pgvector is an optional capability, not a requirement

**Decision.** The `vector` extension is *probed* on every start and reported as
`installed`, `available`, `absent` or `unknown`. `ferret init` attempts to create
it best-effort; failure is a degraded capability, never a startup failure.

**Reason.** Installing an extension needs privileges an ordinary database role
may not have, and Ferret's deterministic retrieval path (EPIC-052, EPIC-053) does
not need pgvector at all — only semantic retrieval (EPIC-054) does. Making it
mandatory would exclude supported deployments to buy nothing. Governance §6
requires unavailable to be representable, so the state is reported rather than
assumed. *Affects EPIC-054.*

---

## D-010 — `ferret init` overrides the configured migration policy

**Decision.** `database.migrate` (`auto` | `verify` | `off`, default `auto`)
governs ordinary startup. `ferret init` applies migrations regardless.

**Reason.** Governance §16 ranks an explicit operation above stored
configuration. `ferret init` *is* the request to provision; a `verify` or `off`
policy exists to stop an ordinary start from migrating, not to stop the operator
who asked. `--check` is the read-only mode, and it must not mutate — the same
guarantee EPIC-004 requires of health checks.

---

## D-011 — Minimum PostgreSQL is 14

**Decision.** `MINIMUM_POSTGRES_MAJOR = 14`, checked at startup and reported by
the health check rather than only enforced.

**Reason.** 14 is the oldest release providing everything EPIC-002 relies on,
including `client_connection_check_interval` (D-006). pgvector requires 13+.
Reporting rather than only enforcing lets `ferret doctor` say "your PostgreSQL is
too old" instead of failing to start and saying nothing.

**Gap — closed 2026-09-05 by EPIC-114.** Only PostgreSQL 17 was measured, and
the floor was a claim in code with nothing behind it. A scheduled compatibility
lane now runs the full suite against 14, 15 and 16; all three pass. See
[EPIC-114's record](../EPICs/validation/EPIC-114-VALIDATION.md). The decision
itself is unchanged: the minimum is still 14.

---

## D-012 — Migrations ship as `.sql` files, copied by a build step

**Decision.** Migrations live in `src/storage/migrations/*.sql` and are copied to
`dist/` by `scripts/copy-migrations.mjs`, which runs as part of `npm run build`.

**Alternatives.** Generate a TypeScript module of SQL strings at build time.

**Reason.** The DDL a reviewer reads is byte-for-byte the DDL PostgreSQL
executes, and `drizzle-kit` output (EPIC-006 onwards) drops in unmodified. The
risk of a build step is shipping a migrator with no migrations — an installation
that works until the first `ferret init`. `packaging.test.ts` therefore asserts
the files are present in the published tarball. *Affects EPIC-006.*

---

## D-013 — `drizzle-orm` pinned to `^0.45.2` on introduction

**Decision.** Introduced at `^0.45.2`, not the `^0.44` that was current.

**Reason.** `npm audit` flagged `drizzle-orm <0.45.2` as **high** severity —
GHSA-gpj5-g38j-94v9, SQL injection via improperly escaped identifiers. Governance
§18 forbids knowingly introducing a vulnerable dependency. `testcontainers` was
likewise taken at `^12` to clear a transitive `uuid` advisory. The tree audits
clean.

TECHNOLOGY-DECISIONS §3 also names `drizzle-kit` as a devDependency; it is
**deferred to EPIC-006**, which is the first Epic with a schema for it to
generate migrations from. Adding it now would be an unused dependency.

---

## D-014 — Provider errors keep their own diagnosis

**Decision.** `ProviderRegistry.initializeAll` preserves the code, remediation
and retryability of a `FerretError` a provider raised, adding the provider
identity to `details`. `E_PROVIDER_INIT_FAILED` remains for unclassified errors.

**Reason.** This is a correction to EPIC-001, found by asserting real process
exit codes end to end. The registry wrapped every provider failure, so a missing
database password reported "a provider failed to initialize" and exited 1 instead
of reporting `E_CONFIG_MISSING`, exiting 3 and telling the user which environment
variable to set. The registry should add context, not destroy it — and the loss
would have degraded every future provider's diagnostics. *Affects EPIC-004 and
every provider Epic.*

---

## D-015 — A per-test database, not a per-test schema

**Decision.** Each database integration test creates and drops its own
PostgreSQL **database**.

**Reason.** "A fresh database can be initialized automatically" is the criterion
under test. Reusing a database another test has already migrated would quietly
test something else. Advisory locks are database-scoped, which also lets the
suites run in parallel without contending — provided `pg_locks` queries filter on
the current database, which cost one debugging cycle to learn.
