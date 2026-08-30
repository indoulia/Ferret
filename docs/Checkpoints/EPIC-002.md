# Development Checkpoint — EPIC-002

Durable handover record per Governance §17 and AI Development Rule §18. Another
agent should be able to continue from this file alone, without the originating
conversation.

**Last updated:** 2026-08-30

---

**Project:** Ferret — `https://github.com/indoulia/Ferret`

**Epic:** EPIC-002 — Database Bootstrap & Migrations (P0, Foundation & Runtime)

**Objective:** Make PostgreSQL provisioning and schema evolution automatic, safe,
repeatable and recoverable.

**Branch:** `feat/epic-002-database-bootstrap-and-migrations`, cut from `main` at
`e68a310`.

**Epic status:** VALIDATED — 7/7 acceptance criteria PASS, 8/8 required tests
PASS, evidence in [`docs/EPICs/validation/EPIC-002-VALIDATION.md`](../EPICs/validation/EPIC-002-VALIDATION.md).

---

## Completed

- **Connection handling.** `pg` pool built from configuration, with Ferret's
  ceilings (8 connections — this is a single-user local service, not a web tier),
  TCP keepalives, an `application_name` that identifies Ferret in
  `pg_stat_activity`, and an idle-error listener so a server restart cannot take
  the process down.
- **Error classification.** 11 SQLSTATE and socket codes mapped to
  `E_STORAGE_UNAVAILABLE` / `E_STORAGE_PERMISSION_DENIED` with remediation and
  retryability. Unrecognized errors are *not* given an invented remediation.
- **Migrations.** Versioned `.sql` files, checksummed, applied under a PostgreSQL
  advisory lock, each in its own transaction together with its bookkeeping row.
- **Failure state.** `ferret.schema_migration_failures` records why a migration
  failed and is cleared when it later succeeds.
- **Schema version.** `readSchemaStatus()` reports applied version, target,
  pending, drift, unknown versions, failures and instance id — without mutating.
- **Migration policy.** `database.migrate` = `auto` (default) | `verify` | `off`.
- **Optional extensions.** pgvector probed on every start, provisioned
  best-effort by `ferret init`, degraded rather than fatal when unavailable.
- **Storage provider.** `PostgresStorageProvider` implementing the EPIC-001
  contract; exposes the Drizzle handle later Epics query through.
- **CLI.** `ferret init`, with `--check` (read-only), `--no-extensions` and
  `--lock-timeout`. Removed from the `(planned)` list.
- **Exit codes.** New `ExitCode.STORAGE = 6` for a reachable database whose
  schema is unusable; an unreachable database stays 4 (dependency).
- **CI.** New `storage` job runs the full suite against a pinned
  `pgvector/pgvector:pg17` service container and uploads the performance baseline.

## Files

```text
src/storage/connection.ts          pool, SQLSTATE classification, server version
src/storage/migration-source.ts    load + checksum the shipped .sql files
src/storage/bookkeeping.ts         schema_migrations, schema_migration_failures
src/storage/migrator.ts            advisory lock, atomic apply, drift/unsupported
src/storage/capabilities.ts        pgvector probe and best-effort provisioning
src/storage/provider.ts            PostgresStorageProvider + health checks
src/storage/index.ts               @indoulia/ferret/storage entry point
src/storage/migrations/0001_bootstrap.sql
src/cli/commands/init.ts           `ferret init`
scripts/copy-migrations.mjs        .sql -> dist (tsc does not copy them)

tests/support/postgres.ts          per-test database, container or CI service
tests/support/recording-logger.ts  captures log input for redaction assertions
tests/fixtures/migrate-then-hang.mjs  child process killed mid-migration
tests/unit/storage.test.ts                        25 cases
tests/integration/storage/migrations.test.ts      14 cases
tests/integration/storage/reliability.test.ts     14 cases
tests/integration/storage/durability.test.ts       7 cases
tests/integration/storage/performance.test.ts      7 cases
tests/integration/storage/init-cli.test.ts        10 cases
```

Modified: `src/errors/codes.ts` (7 codes), `src/cli/exit-codes.ts`,
`src/config/schema.ts` + `resolve.ts` (migration policy), `src/cli/program.ts`,
`src/cli/commands/planned.ts`, `src/providers/registry.ts` (see D-014),
`package.json`, `.github/workflows/ci.yml`, `tests/global-setup.ts`,
`tests/unit/boundaries.test.ts`, `tests/unit/config.test.ts`,
`tests/unit/providers.test.ts`, `tests/integration/packaging.test.ts`.

## Tests

`npm run verify` — lint, typecheck, build, 19 files, **336 passed, 3 skipped**
(the 3 are EPIC-001's POSIX-signal cases, skipped on Windows). 52 of those are
database cases against real PostgreSQL 17 + pgvector.

Performance recorded to `docs/Performance/EPIC-002-storage-baseline-win32.json`.
Provider startup is ~40 ms — 8% of the 496 ms MCP cold start EPIC-005 measured.

`npm audit` — **0 vulnerabilities**.

## Decisions

Full rationale in [`docs/Architecture/EPIC-002-DECISIONS.md`](../Architecture/EPIC-002-DECISIONS.md).

- **D-001** storage is a provider; `pg`/Drizzle unreachable from the core entry point
- **D-002** bookkeeping tables created by the migrator, not by a migration
- **D-003** advisory lock taken before the bootstrap DDL
- **D-004** polling `pg_try_advisory_lock` so the wait stays cancellable
- **D-005** migration + bookkeeping commit in one transaction
- **D-006** `client_connection_check_interval` so a killed process frees the lock
- **D-007** failure recorded in the database, not only in a log
- **D-008** checksums make an edited applied migration a hard failure
- **D-009** pgvector optional, reported honestly, never fatal
- **D-010** `ferret init` overrides the configured policy (Governance §16)
- **D-011** minimum PostgreSQL 14; only 17 measured
- **D-012** migrations ship as `.sql`, copied by a build step, asserted in the tarball
- **D-013** `drizzle-orm@^0.45.2` to clear a high advisory; `drizzle-kit` deferred to EPIC-006
- **D-014** provider errors keep their own diagnosis (corrects EPIC-001)
- **D-015** a per-test database, not a per-test schema

## Two defects found by the new tests

- **The durability suite** killed a process mid-migration and proved the advisory
  lock was never released — PostgreSQL does not notice a dead client while a
  backend is busy. Fixed by D-006; recovery went from unbounded to ~5 s.
- **The CLI suite** asserted real exit codes and proved every storage failure
  exited 1, because `ProviderRegistry` relabelled all provider errors. Fixed by
  D-014; a missing password now exits 3 and names the variable to set.

Neither would have been visible to a unit test with a mocked database.

## Blockers

None.

## Known limitations

Full table in the validation evidence. Carried forward:

- Only PostgreSQL **17** measured; floor is 14, enforced but 14–16 unvalidated
- `client_connection_check_interval` is a no-op on a Windows-hosted **server** → EPIC-004 should surface a long lock wait
- Database tests skip on Windows CI runners (no Linux containers) → **EPIC-105**
- macOS unvalidated, inherited from EPIC-001/005 → **EPIC-105**
- No `down` migrations; recovery is fix-and-roll-forward → **EPIC-010**
- `-- ferret:no-transaction` migrations are not atomic; none ship → **EPIC-031**
- `drizzle-kit` not yet added → **EPIC-006**

## Next step

**EPIC-003 — Configuration Engine** and **EPIC-004 — Runtime Health &
Diagnostics** are both unblocked and can proceed in parallel; each extends a
contract that already exists.

For **EPIC-003**: the `ConfigSource` interface and the Governance §16 precedence
ladder are published, with only the environment rung populated. It needs the
file/user, repository-policy and session-scope sources, configuration
persistence, exclusions that do not delete historical evidence, and change
auditing. `ferret init` is the natural place for persistence to land, and
`ferret config` is still `(planned)`.

For **EPIC-004**: `DependencyCheck`, `DependencyStatus` and the storage provider's
four health results already exist, as do the failure states EPIC-002 records.
`ferret status` and `ferret doctor` are still `(planned)` and exit 5. `doctor`
should surface: a pending or failed migration, schema drift, an unsupported
schema version, a long migration lock wait (see the D-006 gap), an absent
pgvector, a PostgreSQL older than 14, and a missing `git` executable.

After those, **EPIC-006 — Canonical Entity Model** is the critical path toward a
usable vertical slice, and it is the point at which `drizzle-kit` should be added.
