import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  Compatibility,
  ENTITY_SCHEMA_VERSION,
  EntityKind,
  VersionedSurface,
  createNullLogger,
} from '../../../src/index.js';
import {
  ArtifactState,
  CompatibilityService,
  EntityStore,
  allMigrations,
  migrate,
  readSchemaStatus,
  targetSchemaVersion,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Compatibility against a real PostgreSQL.
 *
 * The Epic's headline requirement is that upgrade paths are **deterministic and
 * tested from every supported prior version**. That is only meaningful against a
 * real database: it means building the schema as it stood at each historical
 * point and bringing it forward, which is exactly what a user upgrading from an
 * old install does and exactly what no unit test can simulate.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let service: CompatibilityService;
let entities: EntityStore;
let handle: FerretDatabase;

describeDb(`schema compatibility (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('compat');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    service = new CompatibilityService(handle, db.pool);
    entities = new EntityStore(handle);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('upgrading from every supported prior version', () => {
    // The core requirement, exercised generically so it keeps holding as
    // migrations are added rather than needing a new case each time.
    const versions = Array.from({ length: allMigrations().length + 1 }, (_, index) => index);

    it.each(versions)('upgrades a database at version %i to the current version', async (from) => {
      const stepped = await createTestDatabase(`upgrade-from-${String(from)}`);
      try {
        // Build the schema as it stood at that version...
        if (from > 0) {
          await migrate(stepped.pool, { logger, migrations: allMigrations().slice(0, from) });
        }
        const before = await readSchemaStatus(stepped.pool);
        expect(before.schemaVersion).toBe(from);

        // ...then bring it forward, the way an upgrading user does.
        const report = await migrate(stepped.pool, { logger });

        expect(report.schemaVersion).toBe(targetSchemaVersion());
        expect(report.applied.map((entry) => entry.version)).toStrictEqual(
          Array.from({ length: targetSchemaVersion() - from }, (_, index) => from + index + 1),
        );

        const after = await readSchemaStatus(stepped.pool);
        expect(after.pending).toStrictEqual([]);
        expect(after.drift).toStrictEqual([]);
        expect(after.failures).toStrictEqual([]);
      } finally {
        await stepped.drop();
      }
    }, 120_000);

    it('reaches an identical schema however many steps it took', async () => {
      // Determinism: upgrading from 0 and upgrading from N-1 must leave the same
      // database, or the version a user happened to be on would change what they
      // end up with.
      const shapes: string[] = [];

      for (const from of [0, allMigrations().length - 1]) {
        const stepped = await createTestDatabase(`shape-from-${String(from)}`);
        try {
          if (from > 0) await migrate(stepped.pool, { logger, migrations: allMigrations().slice(0, from) });
          await migrate(stepped.pool, { logger });

          const columns = await stepped.pool.query<{ shape: string }>(
            `SELECT table_name || '.' || column_name || ':' || data_type || ':' || is_nullable AS shape
               FROM information_schema.columns
              WHERE table_schema = 'ferret'
              ORDER BY table_name, column_name`,
          );
          shapes.push(columns.rows.map((row) => row.shape).join('\n'));
        } finally {
          await stepped.drop();
        }
      }

      expect(shapes[1]).toBe(shapes[0]);
    }, 180_000);
  });

  describe('reading the versions an installation holds', () => {
    it('reports every surface as current on a freshly migrated database', async () => {
      const report = await service.check();
      expect(report.safeToWrite).toBe(true);
      expect(report.upgradable).toStrictEqual([]);
      expect(report.blocking).toStrictEqual([]);

      const database = report.verdicts.find((v) => v.surface === VersionedSurface.DATABASE_SCHEMA);
      expect(database?.compatibility).toBe(Compatibility.CURRENT);
      expect(database?.found).toBe(targetSchemaVersion());
    });

    it('reports the entity envelope version actually present', async () => {
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: 'compat-repo' },
        attributes: { name: 'compat' },
      });

      const report = await service.check();
      const entityVerdict = report.verdicts.find((v) => v.surface === VersionedSurface.ENTITY_SCHEMA);
      expect(entityVerdict?.found).toBe(ENTITY_SCHEMA_VERSION);
      expect(entityVerdict?.compatibility).toBe(Compatibility.CURRENT);
    });
  });

  describe('an incompatible installation', () => {
    afterEach(async () => {
      await db.pool.query('DELETE FROM ferret.schema_migrations WHERE name = $1', ['from_the_future']);
      await db.pool.query('UPDATE ferret.entity SET schema_version = $1', [ENTITY_SCHEMA_VERSION]);
    });

    it('refuses to write when the database is newer than this build', async () => {
      // AC-3: fail clearly *before* unsafe writes.
      await db.pool.query(
        `INSERT INTO ferret.schema_migrations (version, name, checksum, duration_ms, applied_by)
         VALUES ($1, 'from_the_future', 'unknown', 0, '@indoulia/ferret@99.0.0')`,
        [targetSchemaVersion() + 1],
      );

      const report = await service.check();
      expect(report.safeToWrite).toBe(false);
      expect(report.blocking).toContain(VersionedSurface.DATABASE_SCHEMA);

      await expect(service.assertSafeToWrite()).rejects.toMatchObject({ code: 'E_SCHEMA_UNSUPPORTED' });
      const failure = await service.assertSafeToWrite().catch((error: unknown) => error);
      expect((failure as { remediation: string }).remediation).toContain('Upgrade Ferret');
    });

    it('refuses to write when an entity was written by a newer build', async () => {
      // One row is enough. A check that sampled rather than taking the maximum
      // would be worse than no check.
      await db.pool.query('UPDATE ferret.entity SET schema_version = 99');

      const report = await service.check();
      const entityVerdict = report.verdicts.find((v) => v.surface === VersionedSurface.ENTITY_SCHEMA);
      expect(entityVerdict?.compatibility).toBe(Compatibility.TOO_NEW);
      await expect(service.assertSafeToWrite()).rejects.toMatchObject({ code: 'E_SCHEMA_UNSUPPORTED' });
    });

    it('refuses to write when a migration is pending', async () => {
      const behind = await createTestDatabase('compat-behind');
      try {
        await migrate(behind.pool, { logger, migrations: allMigrations().slice(0, -1) });
        const scoped = new CompatibilityService(drizzle(behind.pool), behind.pool);

        const report = await scoped.check();
        expect(report.upgradable).toContain(VersionedSurface.DATABASE_SCHEMA);
        expect(report.safeToWrite).toBe(false);

        // A different code from "too new": one is fixed by running init, the
        // other by installing a different Ferret.
        await expect(scoped.assertSafeToWrite()).rejects.toMatchObject({ code: 'E_MIGRATION_PENDING' });
      } finally {
        await behind.drop();
      }
    }, 60_000);
  });

  describe('an interrupted upgrade', () => {
    it('leaves the database at its last good version and can be resumed', async () => {
      // EPIC-002 proved the mechanism against a killed process; here the point
      // is that compatibility reporting stays truthful mid-upgrade rather than
      // claiming a version the database has not reached.
      const partial = await createTestDatabase('compat-interrupted');
      try {
        await migrate(partial.pool, { logger, migrations: allMigrations().slice(0, 1) });

        const scoped = new CompatibilityService(drizzle(partial.pool), partial.pool);
        const midway = await scoped.check();
        const verdict = midway.verdicts.find((v) => v.surface === VersionedSurface.DATABASE_SCHEMA);

        expect(verdict?.found).toBe(1);
        expect(verdict?.compatibility).toBe(Compatibility.UPGRADABLE);
        expect(midway.safeToWrite).toBe(false);

        // Resuming completes it.
        await migrate(partial.pool, { logger });
        expect((await scoped.check()).safeToWrite).toBe(true);
      } finally {
        await partial.drop();
      }
    }, 60_000);
  });

  describe('derived artefacts', () => {
    it('records what produced an artefact, and at which version', async () => {
      const artifact = await service.recordArtifact({
        kind: 'index',
        producer: 'ferret.parser.pdf',
        producerVersion: '6.3.289',
        sourceContentHash: 'source-v1',
      });

      expect(artifact.producer).toBe('ferret.parser.pdf');
      expect(artifact.producerVersion).toBe('6.3.289');
      expect(artifact.schemaVersion).toBe(ENTITY_SCHEMA_VERSION);
      expect(artifact.state).toBe(ArtifactState.VALID);
    });

    it('replaces rather than accumulating when rebuilt', async () => {
      // A stale artefact left alongside a fresh one could still be selected.
      await service.recordArtifact({
        kind: 'index',
        producer: 'ferret.parser.pdf',
        producerVersion: '7.0.0',
        sourceContentHash: 'source-v1',
      });

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.derived_artifact WHERE kind = 'index' AND scope_id IS NULL`,
      );
      expect(rows.rows[0]?.count).toBe('1');
      expect((await service.getArtifact('index'))?.producerVersion).toBe('7.0.0');
    });

    it('detects an artefact built by a superseded producer version', async () => {
      // The mismatch test the Epic requires. Governance §21: an index built by
      // an older parser is not interchangeable with one the current parser would
      // build, and serving it means serving a result nobody could reproduce.
      const scoped = (
        await entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'compat-file.pdf', scope: 'compat' },
          attributes: { path: 'compat-file.pdf' },
        })
      ).entity.id;

      await service.recordArtifact({
        kind: 'embedding',
        scopeId: scoped,
        producer: 'ferret.embedding.local',
        producerVersion: 'model-v1',
      });

      const stale = await service.staleArtifacts('ferret.embedding.local', 'model-v2');
      expect(stale.map((artifact) => artifact.scopeId)).toContain(scoped);

      // And nothing is reported stale when the version still matches.
      expect(await service.staleArtifacts('ferret.embedding.local', 'model-v1')).toStrictEqual([]);
    });

    it('says why an artefact is stale, not just that it is', async () => {
      // "The parser changed" and "the file changed" call for the same action but
      // mean different things, and an operator asking why everything is
      // rebuilding deserves the real answer.
      const artifact = await service.recordArtifact({
        kind: 'summary',
        producer: 'ferret.summarizer',
        producerVersion: '1.0.0',
        sourceContentHash: 'content-v1',
      });

      expect(
        service.validateArtifact(artifact, { producer: 'ferret.summarizer', producerVersion: '1.0.0' }).valid,
      ).toBe(true);

      const producerChanged = service.validateArtifact(artifact, {
        producer: 'ferret.summarizer',
        producerVersion: '2.0.0',
      });
      expect(producerChanged.valid).toBe(false);
      expect(producerChanged.reason).toContain('current is ferret.summarizer@2.0.0');

      const sourceChanged = service.validateArtifact(artifact, {
        producer: 'ferret.summarizer',
        producerVersion: '1.0.0',
        sourceContentHash: 'content-v2',
      });
      expect(sourceChanged.valid).toBe(false);
      expect(sourceChanged.reason).toContain('source content has changed');
    });

    it('marks a whole producer generation stale, so a rebuild can find them', async () => {
      await service.recordArtifact({ kind: 'sweep-a', producer: 'ferret.sweeper', producerVersion: '1.0.0' });
      await service.recordArtifact({ kind: 'sweep-b', producer: 'ferret.sweeper', producerVersion: '1.0.0' });
      await service.recordArtifact({ kind: 'sweep-c', producer: 'ferret.sweeper', producerVersion: '2.0.0' });

      const marked = await service.markStale('ferret.sweeper', '2.0.0');
      expect(marked).toBe(2);

      const rows = await db.pool.query<{ kind: string; state: string }>(
        `SELECT kind, state FROM ferret.derived_artifact WHERE producer = 'ferret.sweeper' ORDER BY kind`,
      );
      expect(rows.rows.map((row) => row.state)).toStrictEqual(['stale', 'stale', 'valid']);
    });
  });

  describe('concurrency', () => {
    it('records one artefact when several rebuilds race', async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          service.recordArtifact({
            kind: 'raced-index',
            producer: 'ferret.indexer',
            producerVersion: `1.0.${String(index)}`,
          }),
        ),
      );

      const rows = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.derived_artifact WHERE kind = 'raced-index'`,
      );
      expect(rows.rows[0]?.count).toBe('1');
    }, 60_000);

    it('answers compatibility consistently while writes are in flight', async () => {
      const writes = Array.from({ length: 15 }, (_, index) =>
        entities.upsert({
          kind: EntityKind.COMMIT,
          source: { system: 'git', id: `compat-busy-${String(index)}`, scope: 'compat' },
          attributes: { sha: `busy-${String(index)}` },
        }),
      );
      const checks = Array.from({ length: 8 }, () => service.check());

      const [, reports] = await Promise.all([Promise.all(writes), Promise.all(checks)]);
      for (const report of reports) {
        expect(report.safeToWrite).toBe(true);
        expect(report.blocking).toStrictEqual([]);
      }
    }, 120_000);
  });
});
