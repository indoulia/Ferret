import type { Pool, PoolClient } from 'pg';

import { ErrorCode, FerretError } from '../errors/index.js';
import { describeLockHolder, findLockHolder, remediationForHolder } from './diagnostics.js';
import type { Logger } from '../logging/index.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

import {
  clearFailure,
  ensureBookkeeping,
  readApplied,
  readFailures,
  readInstanceId,
  recordApplied,
  recordFailure,
  type AppliedMigrationRow,
  type MigrationFailureRow,
} from './bookkeeping.js';
import { classifyDatabaseError, isMissingRelation } from './connection.js';
import { allMigrations, type Migration } from './migration-source.js';

/**
 * Schema migration.
 *
 * Three properties are load-bearing, and each is covered by an integration test
 * against a real PostgreSQL:
 *
 * 1. **Atomicity.** A migration and the record that it ran commit in one
 *    transaction. There is no window in which the database has the DDL but not
 *    the bookkeeping, or the reverse.
 * 2. **Mutual exclusion.** Concurrent starters serialize on a PostgreSQL
 *    advisory lock held on a dedicated session, so N processes racing to
 *    migrate a fresh database apply each migration exactly once.
 * 3. **Recoverability.** A failure — including a killed process — leaves the
 *    database at the last good version, with the reason recorded where
 *    `ferret doctor` can find it. Retrying is always safe.
 */

/**
 * Advisory lock identity, as a (class, object) pair.
 *
 * `0x46455252` is ASCII `FERR`, which makes Ferret's lock recognizable in
 * `pg_locks` during an incident. Object `1` is the migration lock; later
 * subsystems that need their own lock take a different object id under the same
 * class rather than inventing a second namespace.
 */
export const ADVISORY_LOCK_CLASS = 0x46455252;
export const ADVISORY_LOCK_MIGRATIONS = 1;

/** How long a starter waits for another process to finish migrating. */
export const DEFAULT_LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MIN_MS = 25;
const LOCK_POLL_MAX_MS = 250;

/**
 * How often the server checks that the migrating client is still connected.
 *
 * Without this, a Ferret process killed *during* a long migration leaves its
 * backend running the statement to completion, still holding the advisory lock,
 * because PostgreSQL only notices a vanished client when it next reads the
 * socket — which a busy backend does not do. Every other Ferret process then
 * waits out the full lock timeout for a process that no longer exists.
 * `tests/integration/storage/durability.test.ts` reproduces exactly that.
 *
 * `client_connection_check_interval` (PostgreSQL 14+, Ferret's minimum) makes
 * the backend poll for a disconnected client mid-statement and abort when one
 * is found, which releases the lock. It is a no-op on servers whose platform
 * cannot poll the socket — notably PostgreSQL running on Windows — so it is set
 * best-effort and the lock timeout remains the backstop.
 */
const CLIENT_LIVENESS_CHECK = '5s';

/**
 * What to do when the database is behind the code.
 *
 * `auto` is the default because Governance §15 requires Ferret to provision
 * itself; the others exist for operators who need a change window and for
 * `ferret status`, which must be able to inspect without mutating.
 */
export const MigrationPolicy = {
  /** Apply every pending migration. */
  AUTO: 'auto',
  /** Fail if anything is pending; change nothing. */
  VERIFY: 'verify',
  /** Do not migrate and do not complain. */
  OFF: 'off',
} as const;

export type MigrationPolicy = (typeof MigrationPolicy)[keyof typeof MigrationPolicy];

export interface PendingMigration {
  readonly version: number;
  readonly name: string;
}

export interface AppliedInThisRun extends PendingMigration {
  readonly durationMs: number;
}

/** A migration whose recorded checksum no longer matches the shipped file. */
export interface SchemaDrift extends PendingMigration {
  readonly appliedChecksum: string;
  readonly shippedChecksum: string;
}

export interface SchemaStatus {
  /** True once the bookkeeping tables exist — i.e. Ferret has touched this database. */
  readonly initialized: boolean;
  /** Highest applied version. `0` when nothing has been applied. */
  readonly schemaVersion: number;
  /** The version a fully migrated database reaches for this build. */
  readonly targetVersion: number;
  readonly pending: readonly PendingMigration[];
  readonly drift: readonly SchemaDrift[];
  /** Applied versions this build does not ship — the database is from a newer Ferret. */
  readonly unknown: readonly number[];
  readonly failures: readonly MigrationFailureRow[];
  readonly instanceId: string | undefined;
}

export interface MigrationReport {
  readonly policy: MigrationPolicy;
  readonly schemaVersion: number;
  readonly targetVersion: number;
  readonly applied: readonly AppliedInThisRun[];
  readonly pending: readonly PendingMigration[];
  readonly lockWaitMs: number;
  readonly durationMs: number;
}

export interface MigrateOptions {
  readonly logger: Logger;
  readonly policy?: MigrationPolicy;
  readonly lockTimeoutMs?: number;
  /** Aborted when the runtime shuts down; stops the lock wait promptly. */
  readonly signal?: AbortSignal;
  /**
   * The migration set to apply. Defaults to the migrations this build ships.
   *
   * Overriding it lets EPIC-010 apply a compatibility subset, and lets the
   * migration engine be tested against synthetic migrations — a failure path
   * has to be exercised with SQL that actually fails, and Ferret's real
   * migrations are not permitted to.
   */
  readonly migrations?: readonly Migration[];
}

const APPLIED_BY = `${PACKAGE_NAME}@${VERSION}`;

/**
 * A migration marked `-- ferret:no-transaction` runs outside a transaction.
 *
 * Needed for statements PostgreSQL forbids in one, notably
 * `CREATE INDEX CONCURRENTLY`, which EPIC-031 will want when adding an index to
 * a populated table without blocking indexing. It costs the atomicity property
 * above, so the bookkeeping row is written afterwards and a crash in between
 * leaves the migration pending: such a migration must be written to tolerate
 * being re-run.
 */
const NO_TRANSACTION_MARKER = /^\s*--\s*ferret:no-transaction\s*$/m;

function runsInTransaction(migration: Migration): boolean {
  return !NO_TRANSACTION_MARKER.test(migration.sql);
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
  });
}

/**
 * Takes the migration lock, or throws `E_MIGRATION_LOCKED`.
 *
 * Polling `pg_try_advisory_lock` rather than blocking in `pg_advisory_lock`
 * keeps the wait cancellable: a user pressing Ctrl-C during startup must not
 * have to wait out another process's migration.
 *
 * @returns milliseconds spent waiting, which the caller records so a slow start
 * can be attributed to contention rather than to Ferret.
 */
async function acquireLock(
  client: PoolClient,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let backoff = LOCK_POLL_MIN_MS;

  for (;;) {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired',
      [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS],
    );
    if (result.rows[0]?.acquired === true) return Date.now() - startedAt;

    if (signal?.aborted === true) {
      throw new FerretError(ErrorCode.INTERRUPTED, 'Interrupted while waiting for the migration lock', {
        details: { waitedMs: Date.now() - startedAt },
      });
    }
    if (Date.now() >= deadline) {
      // EPIC-095 AC-1. This used to end with "inspect pg_locks for a stale
      // session holding the advisory lock" — the exact DBA instruction
      // Governance §13 exists to prevent, in Ferret's own remediation string,
      // and avoidable because the database can simply be asked.
      //
      // The holder may be unidentifiable: a restricted role sees limited
      // columns for other sessions in `pg_stat_activity`. That case says so
      // rather than claiming a pid it did not read (AC-2).
      const holder = await findLockHolder(client, ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS);
      const who = describeLockHolder(holder);
      throw new FerretError(
        ErrorCode.MIGRATION_LOCKED,
        who === undefined
          ? `The Ferret migration lock has been held by another session for more than ${String(timeoutMs)} ms`
          : `The Ferret migration lock is held: ${who}`,
        {
          details: {
            timeoutMs,
            lockClass: ADVISORY_LOCK_CLASS,
            lockObject: ADVISORY_LOCK_MIGRATIONS,
            ...(holder === undefined
              ? {}
              : {
                  holderPid: holder.pid,
                  holderState: holder.state,
                  holderHeldForSeconds: holder.heldForSeconds,
                }),
          },
          remediation: remediationForHolder(holder),
          retryable: true,
        },
      );
    }

    // Jitter so a thundering herd of starters does not poll in lockstep.
    await delay(backoff * (0.5 + Math.random()), signal);
    backoff = Math.min(backoff * 2, LOCK_POLL_MAX_MS);
  }
}

async function releaseLock(client: PoolClient, logger: Logger): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
      ADVISORY_LOCK_CLASS,
      ADVISORY_LOCK_MIGRATIONS,
    ]);
  } catch (error) {
    // The session is about to be returned to the pool. Losing the unlock would
    // strand the lock on a pooled session, so this is worth a warning even
    // though PostgreSQL releases it when the session eventually ends.
    logger.warn(
      { operation: 'storage.migrate.unlock', err: { message: (error as Error).message } },
      'Failed to release the migration advisory lock',
    );
  }
}

/**
 * Compares what the database has applied with what this build ships.
 *
 * Two conditions are refused rather than repaired, because both mean the
 * operator's mental model of the database is wrong and guessing would compound
 * it: an applied version this build does not ship (the database came from a
 * newer Ferret), and an applied version whose checksum no longer matches (the
 * migration file was edited after it was applied).
 */
function reconcile(applied: readonly AppliedMigrationRow[], shipped: readonly Migration[]) {
  const byVersion = new Map(shipped.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set(applied.map((row) => row.version));

  const unknown: number[] = [];
  const drift: SchemaDrift[] = [];

  for (const row of applied) {
    const migration = byVersion.get(row.version);
    if (migration === undefined) {
      unknown.push(row.version);
      continue;
    }
    if (migration.checksum !== row.checksum) {
      drift.push({
        version: row.version,
        name: row.name,
        appliedChecksum: row.checksum,
        shippedChecksum: migration.checksum,
      });
    }
  }

  const pending = shipped
    .filter((migration) => !appliedVersions.has(migration.version))
    .map((migration): PendingMigration => ({ version: migration.version, name: migration.name }));

  const schemaVersion = applied.reduce((highest, row) => Math.max(highest, row.version), 0);

  return { unknown, drift, pending, schemaVersion };
}

function assertUsable(status: Pick<SchemaStatus, 'unknown' | 'drift' | 'targetVersion'>): void {
  if (status.unknown.length > 0) {
    throw new FerretError(
      ErrorCode.SCHEMA_UNSUPPORTED,
      `The database is at schema version ${String(Math.max(...status.unknown))}, which this Ferret build (target ${String(status.targetVersion)}) does not know`,
      {
        details: { unknownVersions: status.unknown, targetVersion: status.targetVersion },
        remediation:
          'This database was migrated by a newer Ferret. Upgrade Ferret (`npm install -g @indoulia/ferret@latest`) rather than downgrading the database.',
      },
    );
  }
  if (status.drift.length > 0) {
    const first = status.drift[0];
    throw new FerretError(
      ErrorCode.SCHEMA_DRIFT,
      `Migration ${String(first?.version)} ("${first?.name ?? 'unknown'}") was applied from different SQL than this build ships`,
      {
        details: { drift: status.drift },
        remediation:
          'An applied migration was edited. Restore the original migration file, or roll the database forward with a new migration; never edit an applied one.',
      },
    );
  }
}

/**
 * Reads schema state without changing anything.
 *
 * Safe against a database Ferret has never touched: a missing `ferret` schema
 * reports `initialized: false` rather than raising, because `ferret status` must
 * work before `ferret init` has ever run (EPIC-004).
 */
export async function readSchemaStatus(
  pool: Pool,
  migrations?: readonly Migration[],
): Promise<SchemaStatus> {
  const client = await pool.connect().catch((error: unknown) => {
    throw classifyDatabaseError(error, 'storage.status.connect');
  });
  try {
    const shipped = migrations ?? allMigrations();
    const target = shipped.at(-1)?.version ?? 0;

    let applied: readonly AppliedMigrationRow[];
    let failures: readonly MigrationFailureRow[];
    try {
      applied = await readApplied(client);
      failures = await readFailures(client);
    } catch (error) {
      if (isMissingRelation(error)) {
        return {
          initialized: false,
          schemaVersion: 0,
          targetVersion: target,
          pending: shipped.map((migration) => ({ version: migration.version, name: migration.name })),
          drift: [],
          unknown: [],
          failures: [],
          instanceId: undefined,
        };
      }
      throw classifyDatabaseError(error, 'storage.status.read');
    }

    const { unknown, drift, pending, schemaVersion } = reconcile(applied, shipped);
    const instanceId = await readInstanceId(client).catch((error: unknown) =>
      isMissingRelation(error) ? undefined : Promise.reject(classifyDatabaseError(error, 'storage.status.instance')),
    );

    return {
      initialized: true,
      schemaVersion,
      targetVersion: target,
      pending,
      drift,
      unknown,
      failures,
      instanceId,
    };
  } finally {
    client.release();
  }
}

async function applyOne(
  client: PoolClient,
  migration: Migration,
  logger: Logger,
): Promise<AppliedInThisRun> {
  const transactional = runsInTransaction(migration);
  const startedAt = Date.now();

  if (transactional) await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    const durationMs = Date.now() - startedAt;
    // Inside the transaction when there is one: DDL and bookkeeping commit together.
    await recordApplied(client, migration, durationMs, APPLIED_BY);
    if (transactional) await client.query('COMMIT');
    await clearFailure(client, migration.version);

    logger.info(
      {
        operation: 'storage.migrate.apply',
        version: migration.version,
        name: migration.name,
        durationMs,
        transactional,
      },
      `Applied migration ${String(migration.version)} (${migration.name})`,
    );
    return { version: migration.version, name: migration.name, durationMs };
  } catch (error) {
    if (transactional) {
      // Undo the DDL before anything else touches the session. Without this the
      // connection stays in a failed-transaction state and every later
      // statement — including the failure record — is rejected with 25P02.
      await client.query('ROLLBACK').catch(() => undefined);
    }

    const classified = classifyDatabaseError(error, `storage.migrate.apply:${String(migration.version)}`);
    const sqlstate = (error as { code?: unknown }).code;
    await recordFailure(
      client,
      migration,
      APPLIED_BY,
      typeof sqlstate === 'string' ? sqlstate : undefined,
      classified.message,
    ).catch(() => undefined);

    throw new FerretError(
      ErrorCode.MIGRATION_FAILED,
      `Migration ${String(migration.version)} ("${migration.name}") failed: ${classified.message}`,
      {
        details: {
          version: migration.version,
          name: migration.name,
          transactional,
          ...(typeof sqlstate === 'string' ? { sqlstate } : {}),
        },
        remediation: transactional
          ? 'The database is unchanged and still at the previous schema version. Fix the cause and retry; the failure is recorded in ferret.schema_migration_failures.'
          : 'This migration runs outside a transaction and may be partially applied. Inspect ferret.schema_migration_failures and the affected objects before retrying.',
        cause: error,
      },
    );
  }
}

/**
 * Migrations that repair a state an earlier ordering defect could leave behind.
 *
 * Named rather than inferred, because being safe to re-run is a property of the
 * SQL: every statement in one of these is guarded, so applying it to a healthy
 * database does nothing.
 */
const REPAIR_MIGRATIONS: readonly string[] = ['embedding_repair'];

/**
 * Re-applies the repair migrations, outside the ledger.
 *
 * A conditional migration whose precondition was not yet true is recorded as
 * applied all the same, and forward-only migrations never revisit it — which is
 * the whole of the defect. A *repair* written as an ordinary migration inherits
 * that flaw one level down: run it once while pgvector is still absent and it is
 * spent, on exactly the installations that need it.
 *
 * So it runs here instead, at the one moment its precondition can newly become
 * true: immediately after provisioning. The SQL is the migration's own, read
 * from the file the migrator applies, so there is one definition of the table
 * and it is reviewed as DDL rather than buried in TypeScript.
 */
export async function applyRepairs(pool: Pool, logger: Logger): Promise<void> {
  for (const migration of allMigrations()) {
    if (!REPAIR_MIGRATIONS.includes(migration.name)) continue;
    try {
      await pool.query(migration.sql);
    } catch (error) {
      // A repair that cannot run leaves the database as it was. Reported, never
      // fatal: refusing to start because a repair failed would turn a
      // recoverable state into an unusable one.
      logger.warn(
        {
          operation: 'storage.repair',
          migration: migration.name,
          reason: error instanceof Error ? error.message : 'the repair failed',
        },
        `Could not apply the "${migration.name}" repair; the database is unchanged`,
      );
    }
  }
}

/**
 * Brings the database up to the newest version in the migration set.
 *
 * Idempotent: with nothing pending it takes the lock, reads, and returns having
 * changed nothing. Concurrency-safe: callers serialize on the advisory lock, so
 * running N Ferret processes against one fresh database applies each migration
 * exactly once.
 */
export async function migrate(pool: Pool, options: MigrateOptions): Promise<MigrationReport> {
  const policy = options.policy ?? MigrationPolicy.AUTO;
  const logger = options.logger;
  const startedAt = Date.now();
  const shipped = options.migrations ?? allMigrations();
  const target = shipped.at(-1)?.version ?? 0;

  if (policy === MigrationPolicy.OFF) {
    const status = await readSchemaStatus(pool, shipped);
    assertUsable(status);
    logger.debug({ operation: 'storage.migrate', policy }, 'Migration policy is off; schema left unchanged');
    return {
      policy,
      schemaVersion: status.schemaVersion,
      targetVersion: target,
      applied: [],
      pending: status.pending,
      lockWaitMs: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const client = await pool.connect().catch((error: unknown) => {
    throw classifyDatabaseError(error, 'storage.migrate.connect');
  });

  let locked = false;
  try {
    // Applies to this session only, and only while it is migrating, so an
    // unsupported server or an insufficient privilege costs nothing.
    await client
      .query(`SET client_connection_check_interval = '${CLIENT_LIVENESS_CHECK}'`)
      .catch(() => undefined);

    // The lock is taken before the bookkeeping DDL: `CREATE TABLE IF NOT EXISTS`
    // is not safe against a concurrent creator, and an advisory lock needs no
    // schema of its own to exist first.
    const lockWaitMs = await acquireLock(client, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, options.signal);
    locked = true;

    try {
      await ensureBookkeeping(client);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.migrate.bootstrap');
    }

    const applied = await readApplied(client).catch((error: unknown) => {
      throw classifyDatabaseError(error, 'storage.migrate.read');
    });
    const reconciled = reconcile(applied, shipped);
    assertUsable({ ...reconciled, targetVersion: target });

    if (policy === MigrationPolicy.VERIFY && reconciled.pending.length > 0) {
      throw new FerretError(
        ErrorCode.MIGRATION_PENDING,
        `${String(reconciled.pending.length)} migration(s) are pending and the migration policy is "verify"`,
        {
          details: { pending: reconciled.pending, schemaVersion: reconciled.schemaVersion, targetVersion: target },
          remediation: 'Run `ferret init` to apply them, or set FERRET_DATABASE_MIGRATE=auto.',
        },
      );
    }

    const pendingSet = new Set(reconciled.pending.map((entry) => entry.version));
    const appliedNow: AppliedInThisRun[] = [];
    for (const migration of shipped) {
      if (!pendingSet.has(migration.version)) continue;
      if (options.signal?.aborted === true) {
        throw new FerretError(ErrorCode.INTERRUPTED, 'Interrupted before applying the remaining migrations', {
          details: { appliedInThisRun: appliedNow.map((entry) => entry.version) },
        });
      }
      appliedNow.push(await applyOne(client, migration, logger));
    }

    const schemaVersion = appliedNow.reduce(
      (highest, entry) => Math.max(highest, entry.version),
      reconciled.schemaVersion,
    );

    const report: MigrationReport = {
      policy,
      schemaVersion,
      targetVersion: target,
      applied: appliedNow,
      pending: [],
      lockWaitMs,
      durationMs: Date.now() - startedAt,
    };

    logger.info(
      {
        operation: 'storage.migrate',
        policy,
        schemaVersion,
        targetVersion: target,
        appliedCount: appliedNow.length,
        lockWaitMs,
        durationMs: report.durationMs,
      },
      appliedNow.length === 0
        ? `Schema is up to date at version ${String(schemaVersion)}`
        : `Applied ${String(appliedNow.length)} migration(s); schema is at version ${String(schemaVersion)}`,
    );
    return report;
  } finally {
    if (locked) await releaseLock(client, logger);
    client.release();
  }
}
