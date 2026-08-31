import { randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PROVIDER_SETTINGS, createNullLogger, parseConfig } from '../../../src/index.js';
import {
  ADVISORY_LOCK_CLASS,
  ADVISORY_LOCK_MIGRATIONS,
  PostgresStorageProvider,
  allMigrations,
  checksumOf,
  createPool,
  migrate,
  readSchemaStatus,
  targetSchemaVersion,
  type Migration,
} from '../../../src/storage/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';
import {
  SKIP_REASON,
  connectTo,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** A migration whose second statement fails, for exercising the failure path. */
function poisonedMigration(version: number): Migration {
  const sql = `CREATE TABLE ferret.half_applied (id integer PRIMARY KEY);\nINSERT INTO ferret.half_applied (id) VALUES (1), (1);\n`;
  return { version, name: 'poisoned', filename: `${String(version).padStart(4, '0')}_poisoned.sql`, sql, checksum: checksumOf(sql) };
}

function goodMigration(version: number, name: string, sql: string): Migration {
  return { version, name, filename: `${String(version).padStart(4, '0')}_${name}.sql`, sql, checksum: checksumOf(sql) };
}

describeDb(`storage reliability (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  describe('concurrent migration', () => {
    let db: TestDatabase;
    const pools: Pool[] = [];

    beforeAll(async () => {
      db = await createTestDatabase('concurrent');
    });
    afterAll(async () => {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      await db.drop();
    });

    it('applies each migration exactly once when 8 starters race a fresh database', async () => {
      const racers = 8;
      for (let i = 0; i < racers; i += 1) pools.push(connectTo(db, 2));

      const reports = await Promise.all(pools.map((pool) => migrate(pool, { logger })));

      // Every starter must succeed and agree on the resulting version.
      for (const report of reports) {
        expect(report.schemaVersion).toBe(targetSchemaVersion());
        expect(report.pending).toStrictEqual([]);
      }

      // Exactly one of them did the work; the rest found nothing to do. This is
      // the property the advisory lock exists for — without it, two starters
      // would both run migration 1 and one would fail on a duplicate object.
      const totalApplied = reports.flatMap((report) => report.applied);
      expect(totalApplied).toHaveLength(allMigrations().length);

      const rows = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.schema_migrations',
      );
      expect(rows.rows[0]?.count).toBe(String(allMigrations().length));

      const instances = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.instance',
      );
      expect(instances.rows[0]?.count).toBe('1');
    });

    it('leaves no advisory lock held once every starter has finished', async () => {
      // Scoped to this database: advisory locks are per-database, and other
      // suites migrate their own databases at the same time.
      const held = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid = $1 AND objid = $2
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
        [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS],
      );
      expect(held.rows[0]?.count).toBe('0');
    });
  });

  describe('the migration lock', () => {
    let db: TestDatabase;
    let holder: Pool;

    beforeAll(async () => {
      db = await createTestDatabase('lock');
      holder = connectTo(db, 1);
    });
    afterAll(async () => {
      await holder.end().catch(() => undefined);
      await db.drop();
    });

    it('makes a second starter wait, then fail with an actionable retryable error', async () => {
      const client = await holder.connect();
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [
        ADVISORY_LOCK_CLASS,
        ADVISORY_LOCK_MIGRATIONS,
      ]);

      try {
        const started = Date.now();
        const failure = await migrate(db.pool, { logger, lockTimeoutMs: 750 }).catch((error: unknown) => error);
        const waited = Date.now() - started;

        expect(failure).toMatchObject({ code: 'E_MIGRATION_LOCKED', retryable: true });
        expect((failure as { remediation?: string }).remediation).toContain('pg_locks');
        // It really waited rather than failing instantly.
        expect(waited).toBeGreaterThanOrEqual(700);

        // Nothing was changed by the attempt.
        const status = await readSchemaStatus(db.pool);
        expect(status.initialized).toBe(false);
      } finally {
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
          ADVISORY_LOCK_CLASS,
          ADVISORY_LOCK_MIGRATIONS,
        ]);
        client.release();
      }
    });

    it('is released by the server when the holding session dies, so a crash does not wedge Ferret', async () => {
      const doomed = connectTo(db, 1);
      const client = await doomed.connect();
      const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [
        ADVISORY_LOCK_CLASS,
        ADVISORY_LOCK_MIGRATIONS,
      ]);

      // Kill the session outright, as an OS-level crash of a Ferret process would.
      await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      client.release(new Error('terminated'));
      await doomed.end().catch(() => undefined);

      // The next starter must simply succeed. Session-scoped advisory locks are
      // chosen precisely so no stale lock can survive the process that took it.
      const report = await migrate(db.pool, { logger, lockTimeoutMs: 5_000 });
      expect(report.schemaVersion).toBe(targetSchemaVersion());
    });
  });

  describe('a failing migration', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('failing');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('leaves the database at its last good version and records why it failed', async () => {
      const first = allMigrations()[0];
      expect(first).toBeDefined();
      const set = [first as Migration, poisonedMigration(2)];

      const failure = await migrate(db.pool, { logger, migrations: set }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'E_MIGRATION_FAILED' });
      expect((failure as { message: string }).message).toContain('poisoned');

      // The good migration before it is still applied; the failed one is not.
      const status = await readSchemaStatus(db.pool, set);
      expect(status.schemaVersion).toBe(1);
      expect(status.pending.map((entry) => entry.version)).toStrictEqual([2]);

      // Explicit, recoverable state — not a log line that may never be read.
      expect(status.failures).toHaveLength(1);
      expect(status.failures[0]).toMatchObject({ version: 2, name: 'poisoned' });
      expect(status.failures[0]?.errorMessage.length).toBeGreaterThan(0);
    });

    it('rolls back the whole migration, not just the statement that failed', async () => {
      // The poisoned migration creates a table before its failing INSERT. If
      // migrations were not atomic, that table would survive the failure and the
      // retry would then fail for a different, confusing reason.
      const leaked = await db.pool.query<{ exists: boolean }>(
        "SELECT to_regclass('ferret.half_applied') IS NOT NULL AS exists",
      );
      expect(leaked.rows[0]?.exists).toBe(false);
    });

    it('reports the failure through the provider health check', async () => {
      const provider = new PostgresStorageProvider({ policy: 'off' });
      await provider.initialize({
        logger,
        config: parseConfig({
          database: {
            host: db.host,
            port: db.port,
            database: db.database,
            user: db.user,
            password: db.password,
            migrate: 'off',
          },
        }),
        environment: {} as never,
        signal: new AbortController().signal,
        settings: DEFAULT_PROVIDER_SETTINGS,
      });
      try {
        const checks = await provider.checkDependencies();
        const schema = checks.find((check) => check.name === 'postgres-schema');
        expect(schema?.status).toBe('unavailable');
        expect(schema?.detail).toContain('poisoned');
        expect(schema?.remediation).toContain('ferret init');
      } finally {
        await provider.shutdown();
      }
    });

    it('recovers on retry once the cause is fixed, and clears the recorded failure', async () => {
      const first = allMigrations()[0];
      const fixed = [
        first as Migration,
        goodMigration(2, 'poisoned', 'CREATE TABLE ferret.half_applied (id integer PRIMARY KEY);\n'),
      ];

      const report = await migrate(db.pool, { logger, migrations: fixed });
      expect(report.applied.map((entry) => entry.version)).toStrictEqual([2]);

      const status = await readSchemaStatus(db.pool, fixed);
      expect(status.schemaVersion).toBe(2);
      // The failure record must not outlive the failure; a permanently red
      // `ferret doctor` teaches operators to ignore it.
      expect(status.failures).toStrictEqual([]);
    });
  });

  describe('connection faults', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('faults');
      await migrate(db.pool, { logger });
    });
    afterAll(async () => {
      await db.drop();
    });

    it('recovers transparently when the server terminates Ferret\'s backends', async () => {
      const recording = new RecordingLogger();
      const pool = createPool(
        parseConfig({
          database: {
            host: db.host,
            port: db.port,
            database: db.database,
            user: db.user,
            password: db.password,
          },
        }),
        recording,
      );

      try {
        expect((await pool.query<{ v: number }>('SELECT 1 AS v')).rows[0]?.v).toBe(1);

        // Server-side restart, connection reset by a firewall, admin kill: all
        // present as the backend disappearing. It must not crash the process,
        // and the next query must simply work.
        await db.pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND application_name LIKE '@indoulia/ferret%' AND pid <> pg_backend_pid()`,
          [db.database],
        );
        await new Promise((resolve) => setTimeout(resolve, 250));

        const after = await pool.query<{ v: number }>('SELECT 2 AS v');
        expect(after.rows[0]?.v).toBe(2);

        const status = await readSchemaStatus(pool);
        expect(status.schemaVersion).toBe(targetSchemaVersion());
      } finally {
        await pool.end().catch(() => undefined);
      }
    });

    it('classifies an unreachable server as retryable and says what to check', async () => {
      const provider = new PostgresStorageProvider();
      const failure = await provider
        .initialize({
          logger,
          // Port 1 is reserved and never listening.
          config: parseConfig({
            database: { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x' },
          }),
          environment: {} as never,
          signal: new AbortController().signal,
          settings: DEFAULT_PROVIDER_SETTINGS,
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'E_STORAGE_UNAVAILABLE', retryable: true });
      expect((failure as { remediation?: string }).remediation).toContain('FERRET_DATABASE_HOST');
    });

    it('classifies wrong credentials as a permission problem, not an outage', async () => {
      const provider = new PostgresStorageProvider();
      const failure = await provider
        .initialize({
          logger,
          config: parseConfig({
            database: {
              host: db.host,
              port: db.port,
              database: db.database,
              user: db.user,
              password: `wrong-${randomBytes(4).toString('hex')}`,
            },
          }),
          environment: {} as never,
          signal: new AbortController().signal,
          settings: DEFAULT_PROVIDER_SETTINGS,
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'E_STORAGE_PERMISSION_DENIED' });
    });
  });

  describe('an under-privileged role', () => {
    let db: TestDatabase;
    let role: string;
    const password = 'limited_password';

    beforeAll(async () => {
      db = await createTestDatabase('privilege');
      role = `ferret_limited_${randomBytes(3).toString('hex')}`;
      await db.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    });
    afterAll(async () => {
      await db.pool.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      await db.drop();
    });

    it('fails with a permission error naming the grant it needs, not a stack trace', async () => {
      const provider = new PostgresStorageProvider();
      const failure = await provider
        .initialize({
          logger,
          config: parseConfig({
            database: {
              host: db.host,
              port: db.port,
              database: db.database,
              user: role,
              password,
            },
          }),
          environment: {} as never,
          signal: new AbortController().signal,
          settings: DEFAULT_PROVIDER_SETTINGS,
        })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'E_STORAGE_PERMISSION_DENIED' });
      expect((failure as { remediation?: string }).remediation).toContain('CREATE');
      // Nothing was half-created by the attempt.
      const status = await readSchemaStatus(db.pool);
      expect(status.initialized).toBe(false);
    });
  });

  describe('credential safety', () => {
    let db: TestDatabase;
    afterEach(async () => {
      await db.drop();
    });

    it('never writes the database password to any log record, at any level', async () => {
      db = await createTestDatabase('secrets');
      const recording = new RecordingLogger();
      const provider = new PostgresStorageProvider();

      await provider.initialize({
        logger: recording,
        config: parseConfig({
          database: {
            host: db.host,
            port: db.port,
            database: db.database,
            user: db.user,
            password: db.password,
          },
        }),
        environment: {} as never,
        signal: new AbortController().signal,
        settings: DEFAULT_PROVIDER_SETTINGS,
      });
      await provider.checkDependencies();
      await provider.shutdown();

      expect(recording.records.length).toBeGreaterThan(0);
      expect(recording.dump()).not.toContain(db.password);
    });

    it('never writes the password into the recorded failure of a migration', async () => {
      db = await createTestDatabase('secrets2');
      const first = allMigrations()[0];
      await migrate(db.pool, { logger, migrations: [first as Migration, poisonedMigration(2)] }).catch(
        () => undefined,
      );

      const rows = await db.pool.query<{ error_message: string }>(
        'SELECT error_message FROM ferret.schema_migration_failures',
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.error_message).not.toContain(db.password);
    });
  });
});
