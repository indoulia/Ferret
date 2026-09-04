import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import {
  Direction,
  PUBLIC_ACCESS,
  ParserFramework,
  ProviderRegistry,
  RepositoryIndexer,
  createNullLogger,
  type IndexerDependencies,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { discoverProviders } from '../../../src/providers/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  RelationshipStore,
  RetrievalStore,
  SymbolStore,
  allMigrations,
  migrate,
  readSchemaStatus,
  targetSchemaVersion,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  FERRET_PARSERS_MODULE,
  loadFerretParsers,
} from '../../../src/cli/commands/parser-composition.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * **The deployment path, not the migration step.**
 *
 * `compatibility.test.ts` already upgrades a database from every prior version
 * and proves the resulting *schema* is identical however many steps it took.
 * That is the migration, and it is not the deployment: what an operator actually
 * does is upgrade a database **that already holds data**, start the application
 * against it, index into it, and read back out. Every one of those steps can
 * fail on a schema that migrated perfectly.
 *
 * `0013` is the interesting boundary because it is the migration EPIC-002's F-16
 * fix added — the one that provisions pgvector before migrating and repairs
 * installations already past that point. An installation created before it is
 * exactly the population the finding said grows with every day the defect ships,
 * so "does a pre-`0013` database still work end to end" is the question the
 * release turns on rather than "does the DDL apply".
 *
 * Deliberately **not** a new migration and not a change to the upgrade path.
 * This asserts what the shipped one already does; if it were to fail, the fix
 * would belong in the migrator, not here.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeDb = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[deployment path] SKIPPING: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

const logger = createNullLogger();

/** The schema version immediately before `0013_embedding_repair.sql`. */
const BEFORE_EMBEDDING_REPAIR = 12;

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let registry: ProviderRegistry;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (!runnable) return;
  workspace = await createWorkspace('ferret-deploy-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
  registry = new ProviderRegistry();
  await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);
}, 180_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
});

function dependencies(db: TestDatabase, handle: FerretDatabase): IndexerDependencies {
  const compatibility = new CompatibilityService(handle, db.pool);
  return {
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: compatibility,
    lifecycle: new IndexLifecycleStore(handle),
    content: provider,
    symbols: new SymbolStore(handle),
    parser: new ParserFramework({ registry }),
    artifacts: compatibility,
  };
}

describeDb(`the deployment path from a pre-0013 database (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  it('upgrades a populated pre-0013 database, then indexes and retrieves against it', async () => {
    const db = await createTestDatabase('deploy-pre-0013');
    try {
      // 1. An installation as it stood before the embedding repair, with rows in
      //    it. An empty database migrates in ways a populated one does not.
      await migrate(db.pool, {
        logger,
        migrations: allMigrations().slice(0, BEFORE_EMBEDDING_REPAIR),
      });
      const before = await readSchemaStatus(db.pool);
      expect(before.schemaVersion, 'the fixture is not at the pre-0013 version').toBe(
        BEFORE_EMBEDDING_REPAIR,
      );

      const handleBefore = drizzle(db.pool);
      const legacy = await new EntityStore(handleBefore).upsert({
        kind: 'repository',
        source: { system: 'git', id: '/legacy' },
        attributes: { path: '/legacy' },
      });
      expect(legacy.entity.id).toBeDefined();

      // 2. The upgrade an operator runs.
      const report = await migrate(db.pool, { logger });
      expect(report.schemaVersion).toBe(targetSchemaVersion());

      const after = await readSchemaStatus(db.pool);
      expect(after.pending, 'the upgrade left work outstanding').toStrictEqual([]);
      expect(after.drift, 'the upgraded schema drifted from the declared one').toStrictEqual([]);
      expect(after.failures).toStrictEqual([]);

      // 3. The data written before the upgrade is still there and still readable.
      //    A migration that dropped and recreated a table would pass every
      //    assertion above and lose this.
      const handle = drizzle(db.pool);
      const survived = await handle.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.entity WHERE source_id = '/legacy'`,
      );
      expect(survived.rows[0]?.n, 'the pre-upgrade row did not survive').toBe('1');

      // 4. The application starts against it and indexes a real repository —
      //    the step a schema test cannot reach.
      const root = join(workspace.path, 'deployed');
      await mkdir(root, { recursive: true });
      const path = await createRepository(root, 'deployed', {
        origin: 'https://github.com/indoulia/deployed.git',
      });
      const file = join(path, 'src/mod.ts');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'export function deployed(): number {\n  return 1;\n}\n', 'utf8');
      await git(path, ['add', 'src/mod.ts']);
      await git(path, ['commit', '-m', 'add a file']);

      const discovered = await provider.describeRepository(path, context);
      const indexed = await new RepositoryIndexer(dependencies(db, handle)).index(
        discovered,
        { withContent: true },
        context,
      );
      expect(indexed.filesRead, 'the upgraded database indexed nothing').toBeGreaterThan(0);

      // 5. And a read comes back out of it.
      const retrieval = new RetrievalStore(handle);
      const files = await retrieval.findEntities({ kind: 'file', limit: 10 }, PUBLIC_ACCESS);
      expect(files.entities.length, 'nothing was retrievable after the upgrade').toBeGreaterThan(0);

      const neighbours = await retrieval.neighbours(
        { from: indexed.repositoryId, direction: Direction.OUT, limit: 10 },
        PUBLIC_ACCESS,
      );
      expect(neighbours.neighbours.length, 'the repository had no edges').toBeGreaterThan(0);
    } finally {
      await db.drop();
    }
  }, 300_000);

  it('reaches the same schema as a database created fresh today', async () => {
    // The property that makes an upgraded installation supportable: an operator
    // who upgraded and one who installed today are running the same thing, so a
    // bug report from either means the same. `compatibility.test.ts` asserts this
    // for an empty database; this one carries data across the boundary, which is
    // where a repair migration is most likely to behave differently.
    const upgraded = await createTestDatabase('deploy-upgraded');
    const fresh = await createTestDatabase('deploy-fresh');
    try {
      await migrate(upgraded.pool, {
        logger,
        migrations: allMigrations().slice(0, BEFORE_EMBEDDING_REPAIR),
      });
      await new EntityStore(drizzle(upgraded.pool)).upsert({
        kind: 'repository',
        source: { system: 'git', id: '/carried' },
        attributes: { path: '/carried' },
      });
      await migrate(upgraded.pool, { logger });
      await migrate(fresh.pool, { logger });

      const shapeOf = async (pool: TestDatabase['pool']): Promise<string> => {
        const rows = await pool.query<{ shape: string }>(
          `SELECT table_name || '.' || column_name || ':' || data_type AS shape
             FROM information_schema.columns
            WHERE table_schema = 'ferret'
            ORDER BY table_name, column_name`,
        );
        return rows.rows.map((row) => row.shape).join('\n');
      };

      expect(await shapeOf(upgraded.pool)).toBe(await shapeOf(fresh.pool));
    } finally {
      await upgraded.drop();
      await fresh.drop();
    }
  }, 300_000);
});
