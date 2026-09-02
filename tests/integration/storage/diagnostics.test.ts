import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger } from '../../../src/index.js';
import {
  ADVISORY_LOCK_CLASS,
  ADVISORY_LOCK_MIGRATIONS,
  describeLockHolder,
  findLockHolder,
  migrate,
  readInventory,
  remediationForHolder,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-095 — the diagnosis, not the symptom.
 *
 * Ferret's remediation for a held migration lock used to end: *"inspect
 * pg_locks for a stale session holding the advisory lock."* That is the exact
 * DBA instruction Governance §13 exists to prevent, in Ferret's own error text,
 * and it was avoidable because the database can be asked.
 *
 * The lock test takes the advisory lock on a **second real connection**,
 * because that is what a stuck process looks like to PostgreSQL. Asserting the
 * query shape instead would prove that a string was written, not that Ferret
 * can identify a holder.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;

describeDb(`operational diagnostics (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('diagnostics');
    await migrate(db.pool, { logger });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  describe('naming who holds the migration lock — AC-1, AC-2', () => {
    it('identifies a session holding the advisory lock', async () => {
      const holder = new Client({
        host: db.host,
        port: db.port,
        database: db.database,
        user: db.user,
        password: db.password,
        application_name: 'ferret-test-holder',
      });
      await holder.connect();
      try {
        await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [
          ADVISORY_LOCK_CLASS,
          ADVISORY_LOCK_MIGRATIONS,
        ]);

        const found = await findLockHolder(db.pool, ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS);

        expect(found).toBeDefined();
        expect(found?.pid).toBeGreaterThan(0);
        expect(found?.application).toBe('ferret-test-holder');
        expect(describeLockHolder(found)).toContain('has held it');
      } finally {
        await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [
          ADVISORY_LOCK_CLASS,
          ADVISORY_LOCK_MIGRATIONS,
        ]);
        await holder.end();
      }
    });

    it('reports nothing when nobody holds it, rather than guessing', async () => {
      const found = await findLockHolder(db.pool, ADVISORY_LOCK_CLASS, ADVISORY_LOCK_MIGRATIONS);

      expect(found).toBeUndefined();
      expect(describeLockHolder(found)).toBeUndefined();
      // Still actionable — AC-2. "Could not tell" is not "nobody".
      expect(remediationForHolder(undefined)).toContain('could not identify');
    });
  });

  describe('the inventory — AC-4, AC-5, AC-7', () => {
    it('counts what Ferret holds', async () => {
      const inventory = await readInventory(db.pool);

      expect(inventory).toBeDefined();
      expect(Array.isArray(inventory?.entities)).toBe(true);
      expect(typeof inventory?.evidence).toBe('number');
      expect(typeof inventory?.relationships).toBe('number');
      expect(typeof inventory?.contentBlobs).toBe('number');
      expect(typeof inventory?.contentBytes).toBe('number');
    });

    it('reports no completed run on a database that has never indexed', async () => {
      // Absent, not a fabricated zero-date. The distinction is the one EPIC-094
      // found the health probe getting wrong.
      const inventory = await readInventory(db.pool);

      expect(inventory?.lastRun).toBeUndefined();
    });

    it('reports the last completed run once there is one', async () => {
      await db.pool.query(
        `INSERT INTO ferret.index_run (id, repository_key, ferret_version, host_pid, finished_at, outcome)
         VALUES (gen_random_uuid(), '/repo', '0.0.0', 1, now() - interval '30 seconds', 'succeeded')`,
      );

      const inventory = await readInventory(db.pool);

      expect(inventory?.lastRun?.repository).toBe('/repo');
      expect(inventory?.lastRun?.outcome).toBe('succeeded');
      expect(inventory?.lastRun?.ageSeconds).toBeGreaterThanOrEqual(29);
    });
  });

  describe('a diagnostic never fails the thing it diagnoses — AC-9', () => {
    it('returns undefined rather than throwing when the schema is absent', async () => {
      const empty = await createTestDatabase('diagnostics-bare');
      try {
        // No migration: `ferret.entity` does not exist. A diagnostic run
        // against a database Ferret has never touched must report that it
        // cannot tell, not crash the command that is trying to explain why
        // things are broken.
        expect(await readInventory(empty.pool)).toBeUndefined();
      } finally {
        await empty.drop();
      }
    }, 120_000);
  });
});
