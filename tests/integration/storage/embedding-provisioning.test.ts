import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNullLogger } from '../../../src/index.js';
import { migrate, readSchemaStatus } from '../../../src/storage/index.js';
import { ExitCode } from '../../../src/cli/exit-codes.js';
import { runCli } from '../../helpers/cli.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * The embedding table, and the order that decides whether it exists — F-16.
 *
 * Migration `0008` is conditional on pgvector, deliberately: EPIC-002 makes the
 * extension optional and failing without it would break `ferret init` for every
 * installation that never wanted semantic search. The conditional is right. What
 * was wrong is the *order* — the migration ran before anything installed the
 * extension, took its early-return branch, and was then recorded as applied.
 *
 * That is the failure mode a version number exists to prevent: the schema says
 * 12 of 12 with nothing pending, and the table the twelfth migration describes
 * is not there. Migrations are forward-only and gap-free, so no later run could
 * create it — every database provisioned this way was permanently missing a
 * table while reporting itself complete.
 *
 * Both halves are asserted here: a fresh install ends up with the table, and an
 * install already in the broken state is repaired rather than left behind.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

async function tableExists(db: TestDatabase, name: string): Promise<boolean> {
  const rows = await db.pool.query<{ present: string | null }>(
    `SELECT to_regclass('ferret.${name}')::text AS present`,
  );
  return (rows.rows[0]?.present ?? null) !== null;
}

async function vectorInstalled(db: TestDatabase): Promise<boolean> {
  const rows = await db.pool.query<{ present: string | null }>(`SELECT to_regtype('vector')::text AS present`);
  return (rows.rows[0]?.present ?? null) !== null;
}

describeDb(`embedding provisioning (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let fresh: TestDatabase;
  let broken: TestDatabase;

  beforeAll(async () => {
    fresh = await createTestDatabase('embed-fresh');
    broken = await createTestDatabase('embed-broken');
  }, 180_000);

  afterAll(async () => {
    await fresh.drop();
    await broken.drop();
  });

  it('creates the embedding table on a fresh install — F-16', async () => {
    // Nothing has installed pgvector: this is what a new database looks like.
    expect(await vectorInstalled(fresh)).toBe(false);

    const result = await runCli(['init', '--json'], { env: fresh.env });
    expect(result.code).toBe(ExitCode.OK);

    expect({
      vector: await vectorInstalled(fresh),
      embedding: await tableExists(fresh, 'embedding'),
    }).toStrictEqual({ vector: true, embedding: true });
  }, 180_000);

  it('does not report a complete schema over a table it did not create — F-16', async () => {
    // The claim under test is the pairing, not either half: a run that reports
    // `pending: 0` is claiming every migration's effect is present.
    const status = await readSchemaStatus(fresh.pool);

    expect({
      complete: status.schemaVersion === status.targetVersion && status.pending.length === 0,
      embedding: await tableExists(fresh, 'embedding'),
    }).toStrictEqual({ complete: true, embedding: true });
  }, 180_000);

  it('repairs an installation whose conditional migration already ran without pgvector — F-16', async () => {
    // Exactly the state every installation provisioned before the fix is in:
    // migrated to the target version with pgvector absent, so `0008` — and any
    // repair written as an ordinary migration — is already spent.
    await migrate(broken.pool, { logger });
    expect({
      vector: await vectorInstalled(broken),
      embedding: await tableExists(broken, 'embedding'),
    }).toStrictEqual({ vector: false, embedding: false });

    // The operator asks Ferret to provision, which is what `ferret init` is.
    // Driven through the CLI rather than through `migrate` because `migrate` was
    // never the provisioning path: a test that called it twice would asserting
    // the behaviour of the wrong layer, and would pass or fail for reasons that
    // have nothing to do with what an operator can actually do.
    const result = await runCli(['init', '--json'], { env: broken.env });
    expect(result.code).toBe(ExitCode.OK);

    expect({
      vector: await vectorInstalled(broken),
      embedding: await tableExists(broken, 'embedding'),
    }).toStrictEqual({ vector: true, embedding: true });
  }, 180_000);
});
