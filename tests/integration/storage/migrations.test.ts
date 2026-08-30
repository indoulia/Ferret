import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger, parseConfig } from '../../../src/index.js';
import {
  MigrationPolicy,
  PostgresStorageProvider,
  allMigrations,
  checksumOf,
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

function configFor(database: TestDatabase, overrides: Record<string, unknown> = {}) {
  return parseConfig({
    database: {
      host: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
      password: database.password,
      ...overrides,
    },
  });
}

describeDb(`schema migration against real PostgreSQL (${databaseAvailable() ? 'available' : SKIP_REASON})`, () => {
  describe('a fresh database', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('fresh');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('reports itself uninitialized before Ferret has touched it', async () => {
      const status = await readSchemaStatus(db.pool);
      expect(status.initialized).toBe(false);
      expect(status.schemaVersion).toBe(0);
      expect(status.instanceId).toBeUndefined();
      expect(status.pending).toHaveLength(allMigrations().length);
    });

    it('initializes automatically, reaching the target schema version', async () => {
      const report = await migrate(db.pool, { logger });

      expect(report.applied.map((entry) => entry.version)).toStrictEqual(
        allMigrations().map((migration) => migration.version),
      );
      expect(report.schemaVersion).toBe(targetSchemaVersion());
      expect(report.pending).toStrictEqual([]);
    });

    it('makes the schema version queryable', async () => {
      const status = await readSchemaStatus(db.pool);
      expect(status.initialized).toBe(true);
      expect(status.schemaVersion).toBe(targetSchemaVersion());
      expect(status.targetVersion).toBe(targetSchemaVersion());
      expect(status.pending).toStrictEqual([]);
      expect(status.drift).toStrictEqual([]);
      expect(status.unknown).toStrictEqual([]);
      expect(status.failures).toStrictEqual([]);
      expect(status.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('records every applied migration with its checksum and the version that applied it', async () => {
      const rows = await db.pool.query<{
        version: number;
        name: string;
        checksum: string;
        applied_by: string;
        duration_ms: number;
      }>('SELECT version, name, checksum, applied_by, duration_ms FROM ferret.schema_migrations ORDER BY version');

      expect(rows.rows).toHaveLength(allMigrations().length);
      for (const [index, migration] of allMigrations().entries()) {
        const row = rows.rows[index];
        expect(row?.version).toBe(migration.version);
        expect(row?.name).toBe(migration.name);
        expect(row?.checksum).toBe(migration.checksum);
        expect(row?.applied_by).toMatch(/^@indoulia\/ferret@/);
        expect(row?.duration_ms).toBeGreaterThanOrEqual(0);
      }
    });

    it('is idempotent — re-running applies nothing and preserves instance identity', async () => {
      const before = await readSchemaStatus(db.pool);

      const second = await migrate(db.pool, { logger });
      const third = await migrate(db.pool, { logger });

      expect(second.applied).toStrictEqual([]);
      expect(third.applied).toStrictEqual([]);

      const after = await readSchemaStatus(db.pool);
      expect(after.schemaVersion).toBe(before.schemaVersion);
      // Identity must survive re-initialization: EPIC-009 will hang scope on it,
      // and a new id on every start would orphan everything indexed before.
      expect(after.instanceId).toBe(before.instanceId);

      const instances = await db.pool.query<{ count: string }>('SELECT count(*)::text AS count FROM ferret.instance');
      expect(instances.rows[0]?.count).toBe('1');
    });
  });

  describe('an existing database', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('existing');
      await migrate(db.pool, { logger });
    });
    afterAll(async () => {
      await db.drop();
    });

    it('migrates forward without manual SQL when a migration is added', async () => {
      // Simulate a database one version behind by removing the newest applied
      // record and the object it created, then letting the migrator catch up.
      const newest = allMigrations().at(-1);
      expect(newest).toBeDefined();
      await db.pool.query('DELETE FROM ferret.schema_migrations WHERE version = $1', [newest?.version]);
      await db.pool.query('DROP TABLE IF EXISTS ferret.instance');

      const pending = await readSchemaStatus(db.pool);
      expect(pending.pending.map((entry) => entry.version)).toStrictEqual([newest?.version]);

      const report = await migrate(db.pool, { logger });
      expect(report.applied.map((entry) => entry.version)).toStrictEqual([newest?.version]);
      expect(report.schemaVersion).toBe(targetSchemaVersion());
    });

    it('refuses a database migrated by a newer Ferret rather than guessing', async () => {
      const future = targetSchemaVersion() + 1;
      await db.pool.query(
        `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
         VALUES ($1, 'from_the_future', 'unknown', 0, '@indoulia/ferret@99.0.0')`,
        [future],
      );

      const status = await readSchemaStatus(db.pool);
      expect(status.unknown).toStrictEqual([future]);

      await expect(migrate(db.pool, { logger })).rejects.toMatchObject({
        code: 'E_SCHEMA_UNSUPPORTED',
      });
      await expect(migrate(db.pool, { logger })).rejects.toMatchObject({
        remediation: expect.stringContaining('Upgrade Ferret') as unknown as string,
      });

      await db.pool.query('DELETE FROM ferret.schema_migrations WHERE version = $1', [future]);
    });

    it('refuses when an applied migration was edited after the fact', async () => {
      const first = allMigrations()[0];
      expect(first).toBeDefined();
      await db.pool.query('UPDATE ferret.schema_migrations SET checksum = $1 WHERE version = $2', [
        checksumOf('-- tampered'),
        first?.version,
      ]);

      const status = await readSchemaStatus(db.pool);
      expect(status.drift).toHaveLength(1);
      expect(status.drift[0]?.version).toBe(first?.version);

      await expect(migrate(db.pool, { logger })).rejects.toMatchObject({ code: 'E_SCHEMA_DRIFT' });

      await db.pool.query('UPDATE ferret.schema_migrations SET checksum = $1 WHERE version = $2', [
        first?.checksum,
        first?.version,
      ]);
      await expect(migrate(db.pool, { logger })).resolves.toMatchObject({ applied: [] });
    });
  });

  describe('migration policy', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('policy');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('"off" changes nothing and reports what is outstanding', async () => {
      const report = await migrate(db.pool, { logger, policy: MigrationPolicy.OFF });
      expect(report.applied).toStrictEqual([]);
      expect(report.pending).toHaveLength(allMigrations().length);

      const status = await readSchemaStatus(db.pool);
      expect(status.initialized).toBe(false);
    });

    it('"verify" refuses to start against a database that is behind', async () => {
      await expect(migrate(db.pool, { logger, policy: MigrationPolicy.VERIFY })).rejects.toMatchObject({
        code: 'E_MIGRATION_PENDING',
      });
    });

    it('"verify" succeeds once the database is current', async () => {
      await migrate(db.pool, { logger, policy: MigrationPolicy.AUTO });
      const report = await migrate(db.pool, { logger, policy: MigrationPolicy.VERIFY });
      expect(report.applied).toStrictEqual([]);
      expect(report.schemaVersion).toBe(targetSchemaVersion());
    });
  });

  describe('the storage provider', () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase('provider');
    });
    afterAll(async () => {
      await db.drop();
    });

    it('brings a database up and reports what it found', async () => {
      const provider = new PostgresStorageProvider();
      await provider.initialize({
        logger,
        config: configFor(db),
        environment: {} as never,
        signal: new AbortController().signal,
      });

      try {
        expect(provider.report.server.supported).toBe(true);
        expect(provider.report.schema.schemaVersion).toBe(targetSchemaVersion());
        expect(provider.report.connection).toMatchObject({
          host: db.host,
          database: db.database,
          user: db.user,
        });
        // The connection description is what reaches logs and AI clients.
        expect(JSON.stringify(provider.report.connection)).not.toContain(db.password);

        const checks = await provider.checkDependencies();
        const byName = new Map(checks.map((check) => [check.name, check]));
        expect(byName.get('postgres')?.status).toBe('ok');
        expect(byName.get('postgres-schema')?.status).toBe('ok');
        // pgvector is optional: present in the test image, but never required.
        expect(byName.get('postgres-extension-vector')?.required).toBe(false);
      } finally {
        await provider.shutdown();
      }
    });

    it('reports a pending schema as degraded rather than healthy', async () => {
      const newest = allMigrations().at(-1);
      await db.pool.query('DELETE FROM ferret.schema_migrations WHERE version = $1', [newest?.version]);

      const provider = new PostgresStorageProvider({ policy: MigrationPolicy.OFF });
      await provider.initialize({
        logger,
        config: configFor(db, { migrate: 'off' }),
        environment: {} as never,
        signal: new AbortController().signal,
      });
      try {
        const checks = await provider.checkDependencies();
        const schema = checks.find((check) => check.name === 'postgres-schema');
        expect(schema?.status).toBe('degraded');
        expect(schema?.remediation).toContain('ferret init');
      } finally {
        await provider.shutdown();
      }
    });

    it('refuses to start without database configuration, naming what is missing', async () => {
      const provider = new PostgresStorageProvider();
      await expect(
        provider.initialize({
          logger,
          config: parseConfig({}),
          environment: {} as never,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
    });
  });
});
