import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_PROVIDER_SETTINGS, createNullLogger, parseConfig } from '../../../src/index.js';
import { runConformance } from '../../../src/providers/sdk/testing.js';
import { MigrationPolicy, PostgresStorageProvider } from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-016 against a provider that really connects to something.
 *
 * The Git provider's conformance run is a unit test because its `initialize` is
 * pure. This one is the other half: a provider whose lifecycle opens a
 * connection pool, runs migrations and has a real resource to leak. Every
 * lifecycle invariant the suite checks — a second `initialize`, concurrent
 * initialization, `shutdown` before `initialize`, `shutdown` twice, `shutdown`
 * after abort — is a way to leak that pool.
 */
const describeDb = databaseAvailable() ? describe : describe.skip;

function configFor(db: TestDatabase): ReturnType<typeof parseConfig> {
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

describeDb(`storage provider conformance (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('conformance');
    // Migrated once here so the suite's repeated lifecycles run against a
    // current schema and `verify` is a no-op rather than a race.
    const migrator = new PostgresStorageProvider({ policy: MigrationPolicy.AUTO });
    await migrator.initialize({
      logger: createNullLogger(),
      config: configFor(db),
      environment: {} as never,
      signal: new AbortController().signal,
      settings: DEFAULT_PROVIDER_SETTINGS,
    });
    await migrator.shutdown();
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('the PostgreSQL storage provider is conformant', async () => {
    const report = await runConformance({
      // `verify` rather than the default, so the suite's repeated lifecycles do
      // not race each other applying the same migrations.
      create: () => new PostgresStorageProvider({ policy: MigrationPolicy.VERIFY }),
      config: configFor(db),
    });

    expect(
      report.checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`),
    ).toStrictEqual([]);
    expect(report.conformant).toBe(true);
  }, 120_000);
});
