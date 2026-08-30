import { randomBytes } from 'node:crypto';

import { Pool } from 'pg';
import { inject } from 'vitest';

/**
 * Real PostgreSQL for integration tests.
 *
 * Governance §19 and EPIC-002's Definition of Done require the migration suite
 * to run against a real server. Nothing here is mocked: a mocked advisory lock
 * proves nothing about concurrency, and a mocked transaction proves nothing
 * about durability.
 *
 * The server comes from one of two places, in order:
 *
 * 1. `FERRET_TEST_DATABASE_URL` — what CI sets, pointing at a service container.
 * 2. A `pgvector/pgvector:pg17` container started once per run by
 *    `tests/global-setup.ts` (the image EPIC-005 measured against).
 *
 * When neither is available the suites skip *loudly*, with the reason in the
 * test name. Governance §17 forbids turning "not verified" into a pass.
 */

export interface TestDatabase {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** Environment that points a Ferret process at this database. */
  readonly env: Record<string, string>;
  /** A pool connected to this database. */
  readonly pool: Pool;
  /** Drops the database and closes every pool this helper opened. */
  drop(): Promise<void>;
}

interface AdminConnection {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

function parseUrl(url: string): AdminConnection {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port === '' ? 5432 : parsed.port),
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

/** The base connection URL, or `undefined` when no server is available. */
export function baseUrl(): string | undefined {
  const fromEnv = process.env['FERRET_TEST_DATABASE_URL'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const provided = inject('ferretTestDatabaseUrl');
  return provided === null ? undefined : provided;
}

/** True when integration tests that need a database can run. */
export function databaseAvailable(): boolean {
  return baseUrl() !== undefined;
}

/**
 * Why the database suites are skipped, for use in a test title so the reason is
 * visible in the report rather than inferred from an absence.
 */
export const SKIP_REASON =
  'no PostgreSQL available: set FERRET_TEST_DATABASE_URL or start Docker so a pgvector/pgvector:pg17 container can be used';

function requireBaseUrl(): AdminConnection {
  const url = baseUrl();
  if (url === undefined) throw new Error(SKIP_REASON);
  return parseUrl(url);
}

/**
 * Creates an empty database dedicated to one test.
 *
 * A per-test database rather than a per-test schema, because "a fresh database
 * can be initialized automatically" is the acceptance criterion under test:
 * reusing a database that another test has already migrated would quietly test
 * the wrong thing.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const admin = requireBaseUrl();
  const name = `ferret_t_${label.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 24)}_${randomBytes(4).toString('hex')}`;

  const adminPool = new Pool({ ...admin, max: 2 });
  adminPool.on('error', () => undefined);
  // Identifier is generated from a sanitized label plus hex, and CREATE
  // DATABASE cannot take a bind parameter for the name.
  await adminPool.query(`CREATE DATABASE "${name}"`);

  const pool = new Pool({ ...admin, database: name, max: 8 });
  pool.on('error', () => undefined);

  const env: Record<string, string> = {
    FERRET_DATABASE_HOST: admin.host,
    FERRET_DATABASE_PORT: String(admin.port),
    FERRET_DATABASE_NAME: name,
    FERRET_DATABASE_USER: admin.user,
    FERRET_DATABASE_PASSWORD: admin.password,
  };

  return {
    host: admin.host,
    port: admin.port,
    database: name,
    user: admin.user,
    password: admin.password,
    env,
    pool,
    async drop(): Promise<void> {
      await pool.end().catch(() => undefined);
      try {
        // Any session still attached would block the drop. Tests that leave one
        // open are a defect, but failing to clean up would cascade into every
        // later run, so the sessions are terminated first.
        await adminPool.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [name],
        );
        await adminPool.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await adminPool.end().catch(() => undefined);
      }
    },
  };
}

/** A second, independent pool on the same database, for concurrency tests. */
export function connectTo(database: TestDatabase, max = 4): Pool {
  const pool = new Pool({
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    max,
  });
  pool.on('error', () => undefined);
  return pool;
}

/** Server major version, for tests whose expectations depend on it. */
export async function serverMajor(pool: Pool): Promise<number> {
  const result = await pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  return Math.floor(Number(result.rows[0]?.v ?? '0') / 10_000);
}
