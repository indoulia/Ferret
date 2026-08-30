import type { PoolClient } from 'pg';

import { redactString } from '../errors/index.js';

import type { Migration } from './migration-source.js';

/**
 * The migrator's own tables.
 *
 * These are created by the migrator rather than by a migration, because a
 * migration that fails must have somewhere to record that it failed. Bootstrap
 * DDL that creates the place failures are recorded cannot itself be one of the
 * things that records a failure.
 *
 * Everything here is `IF NOT EXISTS`, and every call site runs it while holding
 * the migration advisory lock — `CREATE ... IF NOT EXISTS` is not safe against
 * a concurrent creator on its own (PostgreSQL can still raise `42P07`).
 */

export const FERRET_SCHEMA = 'ferret';
export const MIGRATIONS_TABLE = 'ferret.schema_migrations';
export const FAILURES_TABLE = 'ferret.schema_migration_failures';

const BOOTSTRAP_DDL = `
CREATE SCHEMA IF NOT EXISTS ferret;

CREATE TABLE IF NOT EXISTS ferret.schema_migrations (
    version     integer     PRIMARY KEY,
    name        text        NOT NULL,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer     NOT NULL,
    applied_by  text        NOT NULL
);

CREATE TABLE IF NOT EXISTS ferret.schema_migration_failures (
    version       integer     PRIMARY KEY,
    name          text        NOT NULL,
    failed_at     timestamptz NOT NULL DEFAULT now(),
    attempted_by  text        NOT NULL,
    error_code    text,
    error_message text        NOT NULL
);
`;

/** Creates the schema and bookkeeping tables. Idempotent. Requires the lock. */
export async function ensureBookkeeping(client: PoolClient): Promise<void> {
  await client.query(BOOTSTRAP_DDL);
}

export interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
  readonly appliedBy: string;
}

/** Every migration the database believes it has applied, oldest first. */
export async function readApplied(client: PoolClient): Promise<readonly AppliedMigrationRow[]> {
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
    applied_by: string;
  }>(
    `SELECT version, name, checksum, applied_at, duration_ms, applied_by
       FROM ferret.schema_migrations
      ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
    appliedBy: row.applied_by,
  }));
}

/**
 * Records a migration as applied.
 *
 * Called *inside* the migration's own transaction, so the schema change and the
 * record of it commit together. A crash between the two is therefore not
 * representable: the database can never believe it applied DDL it did not, nor
 * forget DDL it did.
 */
export async function recordApplied(
  client: PoolClient,
  migration: Migration,
  durationMs: number,
  appliedBy: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [migration.version, migration.name, migration.checksum, Math.round(durationMs), appliedBy],
  );
}

export interface MigrationFailureRow {
  readonly version: number;
  readonly name: string;
  readonly failedAt: Date;
  readonly attemptedBy: string;
  readonly errorCode: string | undefined;
  readonly errorMessage: string;
}

/**
 * Records that a migration failed, in its own transaction after the rollback.
 *
 * This is what makes a failed migration an *explicit recoverable state* rather
 * than a silent one: the next start, and `ferret doctor`, can see exactly which
 * migration failed and why without reading a log file that may not exist.
 *
 * The message is redacted before it is stored. A PostgreSQL error can quote the
 * offending statement, and a future migration may carry a literal.
 */
export async function recordFailure(
  client: PoolClient,
  migration: Migration,
  attemptedBy: string,
  errorCode: string | undefined,
  errorMessage: string,
): Promise<void> {
  await client.query(
    `INSERT INTO ferret.schema_migration_failures (version, name, attempted_by, error_code, error_message)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (version) DO UPDATE
        SET failed_at = now(),
            attempted_by = EXCLUDED.attempted_by,
            error_code = EXCLUDED.error_code,
            error_message = EXCLUDED.error_message`,
    [migration.version, migration.name, attemptedBy, errorCode ?? null, redactString(errorMessage)],
  );
}

/** Clears a recorded failure once the migration succeeds on a later attempt. */
export async function clearFailure(client: PoolClient, version: number): Promise<void> {
  await client.query('DELETE FROM ferret.schema_migration_failures WHERE version = $1', [version]);
}

/** Unresolved migration failures, oldest version first. */
export async function readFailures(client: PoolClient): Promise<readonly MigrationFailureRow[]> {
  const result = await client.query<{
    version: number;
    name: string;
    failed_at: Date;
    attempted_by: string;
    error_code: string | null;
    error_message: string;
  }>(
    `SELECT version, name, failed_at, attempted_by, error_code, error_message
       FROM ferret.schema_migration_failures
      ORDER BY version`,
  );
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    failedAt: row.failed_at,
    attemptedBy: row.attempted_by,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message,
  }));
}

/** The instance identity written by migration 0001, or `undefined` before it runs. */
export async function readInstanceId(client: PoolClient): Promise<string | undefined> {
  const result = await client.query<{ instance_id: string }>(
    'SELECT instance_id FROM ferret.instance LIMIT 1',
  );
  return result.rows[0]?.instance_id;
}
