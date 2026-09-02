# EPIC-002 — Validation Evidence

**Epic:** EPIC-002 — Database Bootstrap & Migrations
**Branch:** `feat/epic-002-database-bootstrap-and-migrations`
**Recorded:** 2026-08-30

Evidence for every acceptance criterion and every Definition-of-Done item. No
criterion is marked PASS without a named artefact that demonstrates it, and every
artefact runs against a **real PostgreSQL 17 with pgvector** — nothing about
migration, locking or durability is mocked, because a mocked advisory lock proves
nothing about concurrency and a mocked transaction proves nothing about atomicity.

The Epic specification is unchanged. No criterion was reworded to fit the
implementation.

---

## 1. Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC-1 | A fresh database can be initialized automatically | **PASS** | `migrations.test.ts` → "a fresh database" (5 cases): an untouched database reports `initialized: false` without raising, then `migrate()` applies every migration and reaches the target version. End to end through the CLI in `init-cli.test.ts` → "provisions the database, reaching the target schema version". |
| AC-2 | Existing compatible databases migrate without manual SQL | **PASS** | `migrations.test.ts` → "an existing database" → "migrates forward without manual SQL when a migration is added": a database rolled back one version is brought current by `ferret init` alone. |
| AC-3 | Concurrent startup cannot corrupt migration state | **PASS** | `reliability.test.ts` → "concurrent migration": 8 independent pools race a fresh database; all 8 succeed, each migration is applied exactly **once** in total, `ferret.instance` holds exactly one row, and no advisory lock remains held. |
| AC-4 | Re-running initialization is idempotent | **PASS** | `migrations.test.ts` → "is idempotent — re-running applies nothing and preserves instance identity". `durability.test.ts` → "repeated startup" runs 5 full provider cycles and asserts schema version, instance id and `applied_at` are unchanged, with exactly one bookkeeping row per migration. CLI level: `init-cli.test.ts` → "is idempotent". |
| AC-5 | Failed migrations leave an explicit recoverable state | **PASS** | `reliability.test.ts` → "a failing migration" (4 cases): the database stays at its last good version, the whole migration rolls back (not just the failing statement), the reason is recorded in `ferret.schema_migration_failures`, the provider health check reports it as `unavailable` with remediation, and a corrected retry succeeds and clears the record. |
| AC-6 | Schema version is queryable | **PASS** | `readSchemaStatus()` returns applied version, target version, pending, drift, unknown versions and failures; asserted in `migrations.test.ts` → "makes the schema version queryable". Exposed to operators and AI clients as JSON via `ferret init --check --json` (`init-cli.test.ts`). |
| AC-7 | Credentials are never logged | **PASS** | `reliability.test.ts` → "credential safety" (2 cases): the password appears in no log record at any level, and not in a stored migration failure message. `init-cli.test.ts` → "never prints the database password, at any log level or output mode" checks real process stdout **and** stderr at `--log-level trace`, and confirms `[redacted]` is present so the field was masked rather than merely absent. Unit level: `storage.test.ts` → `describeConnection` and message redaction. |

**7 / 7 PASS.**

---

## 2. Required tests

The Epic names eight test scenarios. All eight exist and pass.

| Required test | Status | Location |
| --- | --- | --- |
| Fresh DB | PASS | `migrations.test.ts` → "a fresh database" |
| Existing DB | PASS | `migrations.test.ts` → "an existing database" |
| Concurrent migration | PASS | `reliability.test.ts` → 8 racing starters |
| Failed migration | PASS | `reliability.test.ts` → "a failing migration" |
| Interrupted process | PASS | `durability.test.ts` → "a process killed mid-migration": a real child process is `SIGKILL`ed mid-transaction |
| Repeated startup | PASS | `durability.test.ts` → "repeated startup", 5 cycles |
| Unsupported schema version | PASS | `migrations.test.ts` → "refuses a database migrated by a newer Ferret"; CLI exit code 6 in `init-cli.test.ts` |
| Permission failure | PASS | `reliability.test.ts` → "an under-privileged role": a real role without `CREATE` on the database |

### Coverage beyond the required list

- **Schema drift** — an applied migration edited after the fact is refused with
  `E_SCHEMA_DRIFT` rather than silently re-applied or ignored.
- **Lock contention** — a second starter waits, then fails with a retryable
  `E_MIGRATION_LOCKED` naming `pg_locks`; nothing is changed by the attempt.
- **Lock release on session death** — a killed lock holder does not wedge Ferret.
- **Connection loss** — the server terminating every Ferret backend does not
  crash the process; the next query transparently reconnects.
- **Error classification** — 8 SQLSTATE / socket codes mapped, retryability
  asserted, unrecognized errors explicitly *not* given an invented remediation.
- **Migration set integrity** — versions gap-free from 1, checksums distinct and
  stable across CRLF/LF checkouts.
- **Packaging** — `packaging.test.ts` asserts every `.sql` migration reaches the
  published tarball, because `tsc` alone does not copy them.
- **Architecture** — `boundaries.test.ts` gains a "storage provider boundary"
  block proving `pg` and Drizzle are unreachable from the core entry point.

---

## 3. Performance

Budgets are regression ceilings asserted by `performance.test.ts`, with measured
figures written to `docs/Performance/EPIC-002-storage-baseline-<platform>.json`
and uploaded as a CI artefact.

| Measurement | Measured (win32, median / p95) | Budget | Headroom |
| --- | --- | --- | --- |
| Fresh migration, empty database | 128 ms | 5 000 ms | 39× |
| No-op migration (schema current) | 7.1 ms / 12.1 ms | 750 ms | 62× |
| `readSchemaStatus` (read-only) | 4.4 ms / 5.2 ms | 400 ms | 77× |
| Pool acquire + release (warm) | 0.02 ms / 0.03 ms | 50 ms | 1 600× |
| `SELECT 1` round trip | 1.18 ms | 25 ms | 21× |
| Provider initialize + shutdown | 39.8 ms / 43.5 ms | 2 000 ms | 46× |

The figure that matters is the last one. Governance §3 makes MCP the primary
interface and the AI client spawns Ferret **per session**, so provider startup is
paid on every session. At ~40 ms it is 8% of the 496 ms MCP cold start EPIC-005
measured — storage does not dominate startup.

A connection-leak check is asserted alongside: after repeated
initialize/shutdown cycles, zero sessions named `@indoulia/ferret%` remain in
`pg_stat_activity`. An AI client that restarts Ferret per session would otherwise
exhaust `max_connections` within a working day.

---

## 4. Durability and reliability findings

Two defects were found **by these tests** and fixed, rather than being discovered
in production:

### F-1 — A killed process wedged the migration lock (fixed)

`durability.test.ts` `SIGKILL`s a child mid-migration. The lock was not released:
PostgreSQL only notices a vanished client when it next reads the socket, and a
backend executing a long statement never does. Every other Ferret process then
waited out the full lock timeout for a process that no longer existed.

**Fix:** the migration session sets `client_connection_check_interval = '5s'`
(PostgreSQL 14+, Ferret's minimum), so the backend polls for a disconnected
client mid-statement and aborts, releasing the lock. Measured recovery is ~5 s
where it was previously unbounded. Set best-effort — it is a no-op on servers
whose platform cannot poll the socket, notably PostgreSQL on Windows — with the
lock timeout remaining the backstop. See [known limitations](#6-known-limitations).

### F-2 — Provider errors lost their diagnosis (fixed)

`init-cli.test.ts` asserted process exit codes end to end and found every storage
failure exiting `1`. `ProviderRegistry.initializeAll` wrapped **every** provider
error as `E_PROVIDER_INIT_FAILED`, discarding the code, the remediation and the
retryability. A missing database password reported "a provider failed to
initialize" instead of "set `FERRET_DATABASE_HOST`", and exited 1 instead of 3.

**Fix:** the registry now preserves a `FerretError` a provider raised — code,
remediation and retryable — and adds the provider identity to `details` rather
than replacing the diagnosis. `E_PROVIDER_INIT_FAILED` remains for providers
that throw unclassified errors. Covered by `providers.test.ts` → "keeps the
diagnosis a provider made, instead of relabelling it".

This was an EPIC-001 defect that only an end-to-end exit-code assertion could
expose, and it would have degraded every future provider's diagnostics.

---

## 5. Definition of Done

| Item | Status | Evidence |
| --- | --- | --- |
| Migration suite passes against supported PostgreSQL versions | **PASS** for PostgreSQL 17 | 45 database integration cases green against `pgvector/pgvector:pg17`, locally and in the CI `storage` job. Minimum supported major is 14; **only 17 has been measured** — see limitations. |
| Recovery behaviour is documented | **PASS** | This document §4; `docs/Architecture/EPIC-002-DECISIONS.md` D-005/D-006; remediation text on every storage error, asserted by test. |
| Schema changes are reproducible in CI | **PASS** | `.github/workflows/ci.yml` → `storage` job runs the full suite against a pinned service container on every push and pull request. Checksums make an edited migration a hard failure, so an applied migration cannot drift silently. |

---

## 6. Known limitations

Recorded rather than glossed over, per Governance §6 and AI Development Rule §10.

| Limitation | Impact | Owner |
| --- | --- | --- |
| Only PostgreSQL **17** is measured. The floor is 14 and is enforced at runtime, but 14–16 are unvalidated. | A version-specific incompatibility in 14–16 would not be caught. | EPIC-002 follow-up — widen the CI matrix; low risk, no version-specific syntax is used. |
| `client_connection_check_interval` is a no-op when the **server** runs on Windows. | A Ferret process killed mid-migration against a Windows-hosted server holds the lock until the statement finishes or TCP keepalives expire. The lock timeout still bounds the wait for others. | EPIC-004 — surface a long lock wait in `ferret doctor`. |
| Database tests are skipped on Windows CI runners (no Linux containers). **Widened 2026-09-03 by EPIC-105:** the same is true of `macos-latest`, so the database suites are validated on Linux only and skip on both other platforms. Stated rather than struck, because adding a platform made this row *broader* and not narrower. | Storage behaviour is validated on Linux only in CI; it is validated on Windows locally, and this run was recorded on `win32/x64`. | EPIC-105 — cross-platform packaging. |
| ~~macOS remains unvalidated.~~ **Measured 2026-09-03 by EPIC-105:** macOS passes — 112 test files and 2 463 tests on `macos-latest`, including the packaging suite and all seven signal tests. The database suites skip there (no Linux containers), so PostgreSQL behaviour stays validated on Linux only. | Inherited from EPIC-001/EPIC-005; no macOS host available. | EPIC-105 |
| A migration marked `-- ferret:no-transaction` is not atomic. | No such migration ships today. The escape hatch exists for `CREATE INDEX CONCURRENTLY` in EPIC-031, and is documented as requiring re-runnable SQL. | EPIC-031 |
| Rollback is forward-only. | Ferret has no `down` migrations; recovery is "fix and roll forward", which is what the failure record supports. | EPIC-010 — schema versioning and compatibility. |

---

## 7. Security

| Concern | Handling |
| --- | --- |
| Credential leakage | Passwords never enter a log, an error, a stored failure record or CLI output. Asserted at unit, integration and real-process level. Connection descriptions are constructed without the password rather than redacted after the fact. |
| SQL injection | Every value is a bind parameter. The only interpolated identifiers are the test database name (generated from a sanitized label plus hex) and extension names, which are constrained to the `OPTIONAL_EXTENSIONS` allowlist because `CREATE EXTENSION` cannot take a parameter. |
| Dependency advisories | `npm audit` reports **0 vulnerabilities**. `drizzle-orm` was pinned to `^0.45.2` on introduction because `<0.45.2` carries GHSA-gpj5-g38j-94v9 (high, SQL injection via improperly escaped identifiers); `testcontainers` to `^12` to clear the transitive `uuid` advisory. |
| Least privilege | Ferret does not require superuser. `CREATE EXTENSION` is attempted best-effort and its failure is a degraded capability, never a startup failure, so an ordinary database role is a supported deployment. |
| Untrusted input | No repository or document content reaches the database in this Epic. |
