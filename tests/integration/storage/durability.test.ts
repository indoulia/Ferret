import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger, parseConfig } from '../../../src/index.js';
import {
  ADVISORY_LOCK_CLASS,
  ADVISORY_LOCK_MIGRATIONS,
  PostgresStorageProvider,
  allMigrations,
  migrate,
  readSchemaStatus,
  targetSchemaVersion,
} from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

const HANG_FIXTURE = fileURLToPath(new URL('../../fixtures/migrate-then-hang.mjs', import.meta.url));

function configFor(db: TestDatabase) {
  return parseConfig({
    database: {
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.user,
      password: db.password,
    },
  });
}

/** How many sessions hold Ferret's migration lock *in this database*. */
async function advisoryLockCount(db: TestDatabase): Promise<number> {
  const result = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = $1 AND objid = $2 AND granted
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    [ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Waits until `predicate` holds, or throws after `timeoutMs`. */
async function waitFor(label: string, timeoutMs: number, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeDb(`storage durability (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  describe('a process killed mid-migration', () => {
    let db: TestDatabase;
    let child: ChildProcess | undefined;

    beforeAll(async () => {
      db = await createTestDatabase('crash');
    });
    afterAll(async () => {
      child?.kill('SIGKILL');
      await db.drop();
    });

    it('leaves the database at its last good schema version, with no partial DDL', async () => {
      child = spawn(process.execPath, [HANG_FIXTURE], {
        env: { ...process.env, ...db.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      // Wait until the migration transaction is genuinely in flight: the child's
      // backend is executing the `pg_sleep` that follows its CREATE TABLE. Timing
      // by sleep alone would make this test prove nothing on a slow machine.
      await waitFor('the child migration to reach its slow statement', 60_000, async () => {
        const result = await db.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
            WHERE datname = $1 AND query LIKE '%pg_sleep%' AND state = 'active' AND pid <> pg_backend_pid()`,
          [db.database],
        );
        return result.rows[0]?.count !== '0';
      });

      // Confirm the preconditions: the child holds the migration lock, and it has
      // created its table inside the uncommitted transaction.
      // Advisory locks are database-scoped, and other suites migrate their own
      // databases in parallel, so the count must be scoped too.
      expect(await advisoryLockCount(db)).toBe(1);

      // SIGKILL: no shutdown hook runs, no ROLLBACK is sent, no unlock is sent.
      // This is the power-cut case, not a graceful stop.
      child.kill('SIGKILL');
      await new Promise((resolve) => child?.once('exit', resolve));

      // `client_connection_check_interval` makes the server notice the dead
      // client mid-statement and abort it, releasing the lock. Without it the
      // backend would run `pg_sleep` to completion still holding the lock, and
      // every other Ferret process would wait out its full lock timeout.
      await waitFor('PostgreSQL to reap the dead session', 30_000, async () => {
        return (await advisoryLockCount(db)) === 0;
      });

      // The migrations that completed before the kill are durably applied.
      const status = await readSchemaStatus(db.pool);
      expect(status.schemaVersion).toBe(targetSchemaVersion());

      // The killed migration left nothing behind. Its CREATE TABLE was inside
      // the transaction the server aborted when the connection died.
      const marker = await db.pool.query<{ exists: boolean }>(
        "SELECT to_regclass('ferret.crash_marker') IS NOT NULL AS exists",
      );
      expect(marker.rows[0]?.exists).toBe(false);

      // And no bookkeeping row claims it ran.
      const claimed = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.schema_migrations WHERE name = $1',
        ['hangs_forever'],
      );
      expect(claimed.rows[0]?.count).toBe('0');
    }, 120_000);

    it('is immediately usable again by the next Ferret process', async () => {
      const report = await migrate(db.pool, { logger, lockTimeoutMs: 10_000 });
      expect(report.schemaVersion).toBe(targetSchemaVersion());
      expect(report.applied).toStrictEqual([]);

      const status = await readSchemaStatus(db.pool);
      expect(status.failures).toStrictEqual([]);
      expect(status.drift).toStrictEqual([]);
    });
  });

  describe('repeated startup', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('repeat');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('keeps schema version, instance identity and applied-at timestamps stable across 5 cycles', async () => {
      const observed: Array<{ version: number; instanceId: string | undefined; appliedAt: string }> = [];

      for (let cycle = 0; cycle < 5; cycle += 1) {
        const provider = new PostgresStorageProvider();
        await provider.initialize({
          logger,
          config: configFor(db),
          environment: {} as never,
          signal: new AbortController().signal,
        });
        const rows = await provider.pool.query<{ applied_at: Date }>(
          'SELECT applied_at FROM ferret.schema_migrations ORDER BY version LIMIT 1',
        );
        observed.push({
          version: provider.report.schema.schemaVersion,
          instanceId: provider.report.schema.instanceId,
          appliedAt: rows.rows[0]?.applied_at.toISOString() ?? '',
        });
        await provider.shutdown();
      }

      const first = observed[0];
      expect(first?.version).toBe(targetSchemaVersion());
      expect(first?.instanceId).toMatch(/^[0-9a-f-]{36}$/);
      for (const entry of observed) {
        expect(entry.version).toBe(first?.version);
        // Identity is durable: everything EPIC-009 scopes to this instance would
        // be orphaned by a new id, and everything indexed would look foreign.
        expect(entry.instanceId).toBe(first?.instanceId);
        // Applied migrations are a historical record, never rewritten in place.
        expect(entry.appliedAt).toBe(first?.appliedAt);
      }
    }, 60_000);

    it('creates exactly one row of bookkeeping per migration, however often it starts', async () => {
      const rows = await db.pool.query<{ version: number; count: string }>(
        'SELECT version, count(*)::text AS count FROM ferret.schema_migrations GROUP BY version',
      );
      expect(rows.rows).toHaveLength(allMigrations().length);
      for (const row of rows.rows) expect(row.count).toBe('1');
    });
  });

  describe('committed data', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('persist');
      await migrate(db.pool, { logger });
    });
    afterAll(async () => {
      await db.drop();
    });

    it('survives closing and reopening the whole pool', async () => {
      const before = await readSchemaStatus(db.pool);

      const provider = new PostgresStorageProvider();
      await provider.initialize({
        logger,
        config: configFor(db),
        environment: {} as never,
        signal: new AbortController().signal,
      });
      const during = provider.report.schema.instanceId;
      await provider.shutdown();

      const second = new PostgresStorageProvider();
      await second.initialize({
        logger,
        config: configFor(db),
        environment: {} as never,
        signal: new AbortController().signal,
      });
      try {
        expect(second.report.schema.instanceId).toBe(during);
        expect(second.report.schema.instanceId).toBe(before.instanceId);
      } finally {
        await second.shutdown();
      }
    });

    it('survives the server terminating every Ferret backend', async () => {
      const before = await readSchemaStatus(db.pool);
      await db.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      const after = await readSchemaStatus(db.pool);
      expect(after.schemaVersion).toBe(before.schemaVersion);
      expect(after.instanceId).toBe(before.instanceId);
    });

    it('leaves the pool fully closed after shutdown, holding no server session', async () => {
      const provider = new PostgresStorageProvider();
      await provider.initialize({
        logger,
        config: configFor(db),
        environment: {} as never,
        signal: new AbortController().signal,
      });
      await provider.shutdown();
      // Idempotent: shutting down twice must not throw.
      await provider.shutdown();

      await waitFor('Ferret sessions to close', 10_000, async () => {
        const result = await db.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
            WHERE datname = $1 AND application_name LIKE '@indoulia/ferret%'`,
          [db.database],
        );
        return result.rows[0]?.count === '0';
      });

      // The handles are gone with it, so nothing can keep using a closed pool.
      expect(() => provider.pool).toThrow(/before initialization/);
    });
  });
});
