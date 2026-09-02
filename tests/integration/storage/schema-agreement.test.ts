import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger } from '../../../src/index.js';
import {
  contentBlob,
  derivedArtifact,
  entity,
  entityExternalId,
  evidence,
  evidenceDerivation,
  identityAlias,
  indexRun,
  migrate,
  relationship,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-086 — the two descriptions of the schema agree.
 *
 * Ferret defines its physical schema twice, deliberately: hand-written SQL
 * migrations, so the DDL a reviewer reads is the DDL PostgreSQL executes, and
 * Drizzle table definitions, so the query layer can type itself. Both choices
 * are right. **Nothing checked they agree**, and the failure is silent in the
 * direction that matters — a Drizzle column the database does not have fails at
 * runtime, on the query that needs it, in whichever command reached it first.
 *
 * Twice in one session an index was written into a table definition that no
 * migration created. Both were caught by a person reading a diff, which is the
 * control this file exists to replace.
 *
 * **The comparison runs against a migrated database, not against parsed DDL.**
 * Parsing SQL to compare it to a table definition would be a *third* description
 * of the schema with its own bugs; asking the database what it has is the only
 * comparison that cannot be wrong about itself.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;

/**
 * Every table the query layer types itself against.
 *
 * Listed rather than reflected because Drizzle offers no registry of declared
 * tables — but the *other* direction is enumerated from the database below, so
 * a table added to a migration and forgotten here fails AC-3. The two lists
 * check each other.
 */
const DRIZZLE_TABLES: readonly PgTable[] = [
  contentBlob,
  derivedArtifact,
  entity,
  entityExternalId,
  evidence,
  evidenceDerivation,
  identityAlias,
  indexRun,
  relationship,
];

/**
 * Tables the migrations create that Drizzle deliberately does not declare.
 *
 * A declared absence, not merely an absence — §8. Both of these are legitimate
 * and neither was written down anywhere before this Epic, so a reader could not
 * tell a deliberate omission from a forgotten one.
 */
const RAW_SQL_ONLY: Readonly<Record<string, { reason: string; conditional?: boolean }>> = {
  embedding: {
    // Also *conditional*: migration 0008 creates it only when `to_regtype('vector')`
    // resolves, because pgvector is optional (EPIC-002). A database without the
    // extension legitimately has no such table, so the staleness check below
    // must not treat its absence as a stale exemption.
    reason:
      "Uses pgvector's `vector` type, which Drizzle has no representation for, and is created conditionally on the extension being installed. EPIC-054's queries are written out rather than built for that reason.",
    conditional: true,
  },
  instance: {
    reason:
      'Bootstrap metadata, written by the migrator before the query layer exists. Typing it in Drizzle would create a dependency from bootstrap onto the thing bootstrap sets up.',
  },
  schema_migrations: {
    reason:
      'The migration ledger itself, owned entirely by EPIC-002. Read with raw SQL by design: the component that applies migrations must not depend on a schema those migrations define.',
  },
  schema_migration_failures: {
    // Found by this check on its first run, and the reason is a good one.
    reason:
      'Created by `bookkeeping.ts` with CREATE TABLE IF NOT EXISTS rather than by a migration, because it records migrations that *failed* — a table that depended on a migration succeeding could not record the case it exists for.',
  },
};

interface Column {
  readonly name: string;
  readonly nullable: boolean;
}

async function tablesInDatabase(): Promise<string[]> {
  const { rows } = await db.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'ferret' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

async function columnsOf(table: string): Promise<Map<string, Column>> {
  const { rows } = await db.pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'ferret' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((row) => [row.column_name, { name: row.column_name, nullable: row.is_nullable === 'YES' }]));
}

describeDb(`schema agreement (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('schema-agreement');
    await migrate(db.pool, { logger });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  it('finds tables on both sides — AC-4', async () => {
    // Failing closed. An empty list on either side would make every assertion
    // below a no-op that still reports green.
    const inDatabase = await tablesInDatabase();

    expect(DRIZZLE_TABLES.length).toBeGreaterThanOrEqual(9);
    expect(inDatabase.length).toBeGreaterThanOrEqual(DRIZZLE_TABLES.length);
    process.stderr.write(
      `[EPIC-086] ${String(DRIZZLE_TABLES.length)} declared tables, ${String(inDatabase.length)} in the migrated schema\n`,
    );
  });

  it('every declared table exists in the migrated schema — AC-1', async () => {
    const inDatabase = new Set(await tablesInDatabase());

    for (const table of DRIZZLE_TABLES) {
      const name = getTableName(table);
      expect(inDatabase.has(name), `${name} is declared in Drizzle and no migration creates it`).toBe(true);
    }
  });

  it('every declared column exists, with the nullability declared — AC-2, AC-6', async () => {
    let compared = 0;
    for (const table of DRIZZLE_TABLES) {
      const name = getTableName(table);
      const actual = await columnsOf(name);

      for (const [property, column] of Object.entries(getTableColumns(table))) {
        const columnName = column.name;
        const found = actual.get(columnName);

        // Named in the failure, so a disagreement is actionable without opening
        // this file.
        expect(found, `${name}.${columnName} (${property}) is declared in Drizzle and absent from the database`).toBeDefined();
        if (found === undefined) continue;

        // Nullability, not type. Comparing types would compare Drizzle's
        // vocabulary to PostgreSQL's and fail on synonyms rather than on drift
        // — a check people learn to ignore is worse than none. A column that is
        // unexpectedly required is a real defect and this catches it.
        expect(found.nullable, `${name}.${columnName}: Drizzle says notNull=${String(column.notNull)}`).toBe(
          !column.notNull,
        );
        compared += 1;
      }
    }

    expect(compared).toBeGreaterThan(50);
    process.stderr.write(`[EPIC-086] ${String(compared)} columns compared\n`);
  });

  it('every migrated table is declared or explained — AC-3, AC-5', async () => {
    const declared = new Set(DRIZZLE_TABLES.map((table) => getTableName(table)));

    for (const name of await tablesInDatabase()) {
      if (declared.has(name)) continue;
      const entry = RAW_SQL_ONLY[name];
      expect(
        entry,
        `ferret.${name} exists in the schema, is not declared in Drizzle, and is not listed as raw-SQL-only. ` +
          'Declare it in src/storage/schema/, or add it to RAW_SQL_ONLY with the reason it is not typed.',
      ).toBeDefined();
      // A reason, not a placeholder — an unexplained exemption is how a real
      // gap hides.
      expect((entry?.reason ?? '').length, name).toBeGreaterThan(60);
    }
  });

  it('lists no raw-SQL-only table that does not exist', async () => {
    // The other direction of the same honesty: a stale exemption would quietly
    // license a table that is no longer there, and hide the next one.
    const inDatabase = new Set(await tablesInDatabase());

    for (const [name, entry] of Object.entries(RAW_SQL_ONLY)) {
      // A conditional table is legitimately absent — `embedding` exists only
      // where pgvector does, and this suite's database has no extension
      // enabled. Skipping it here is why `conditional` is a declared flag
      // rather than a special case buried in a condition.
      if (entry.conditional === true) continue;
      expect(inDatabase.has(name), `${name} is listed as raw-SQL-only and nothing creates it`).toBe(true);
    }
  });
});
