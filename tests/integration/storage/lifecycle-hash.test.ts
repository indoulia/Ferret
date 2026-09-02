import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  IntegrityFindingKind,
  LifecycleState,
  RelationshipType,
  createNullLogger,
} from '../../../src/index.js';
import {
  EntityStore,
  IndexLifecycleStore,
  IntegrityService,
  RelationshipStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * Issue #118 — a lifecycle write must recompute the content hash.
 *
 * EPIC-006's entity hash covers `lifecycle` and EPIC-007's relationship hash
 * covers `validTo`, and EPIC-032's lifecycle writes changed both by raw SQL
 * without re-deriving either. Measured on Ferret's own index at `5293434`:
 * **17 of 17** retired entities reported `content-hash-mismatch`, so a healthy
 * index with tombstones read as corrupt.
 *
 * That is the failure mode EPIC-094 itself named when it excluded
 * `content-index` artefacts from its staleness check — "exactly how a real
 * finding gets trained out of an operator."
 *
 * Against a real database, because the hash has to be recomputable **from the
 * row** and only a real column round trip proves that: the instant PostgreSQL
 * stores is not the string that was handed to it.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let lifecycle: IndexLifecycleStore;
let integrity: IntegrityService;
let repository: string;

async function mismatchesFor(entityId: string): Promise<string[]> {
  const sweep = await integrity.sweep({ logger });
  return sweep.findings
    .filter((finding) => finding.id === entityId)
    .map((finding) => finding.kind);
}

async function hashOf(entityId: string): Promise<string | undefined> {
  const rows = await handle.execute<{ [column: string]: unknown; content_hash: string }>(
    sql`SELECT content_hash FROM ferret.entity WHERE id = ${entityId}`,
  );
  return rows.rows[0]?.content_hash;
}

async function file(path: string): Promise<string> {
  const created = await entities.upsert({
    kind: EntityKind.FILE,
    source: { system: 'git', id: path, scope: repository },
    attributes: { path },
  });
  await relationships.assert({
    fromId: repository,
    type: RelationshipType.REPOSITORY_CONTAINS_FILE,
    toId: created.entity.id,
    sourceSystem: 'git',
  });
  return created.entity.id;
}

describeDb(`lifecycle writes and the content hash (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('lifecycle-hash');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
    lifecycle = new IndexLifecycleStore(handle);
    integrity = new IntegrityService(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/hash-repo' },
        attributes: { path: '/hash-repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  it('leaves a tombstoned entity verifying — issue #118', async () => {
    const id = await file('src/tombstoned.ts');
    const before = await hashOf(id);

    await entities.tombstone(id);

    // The hash *changed*, which is the point: the derived content did.
    expect(await hashOf(id)).not.toBe(before);
    // And it is the hash the sweep re-derives, so the row is not a finding.
    expect(await mismatchesFor(id)).not.toContain(IntegrityFindingKind.CONTENT_HASH_MISMATCH);
  });

  it('leaves a retired entity and its closed edge verifying — issue #118', async () => {
    const id = await file('src/retired.ts');

    const changed = await lifecycle.retire(id, repository, new Date());
    expect(changed).toBe(true);

    const sweep = await integrity.sweep({ logger });
    const mismatches = sweep.findings.filter(
      (finding) => finding.kind === IntegrityFindingKind.CONTENT_HASH_MISMATCH,
    );

    // Neither the entity nor the relationship whose interval just closed.
    expect(mismatches.map((finding) => finding.id)).not.toContain(id);
    expect(mismatches).toStrictEqual([]);
  });

  it('leaves a reinstated entity verifying — issue #118, the other direction', async () => {
    const id = await file('src/returns.ts');
    await lifecycle.retire(id, repository, new Date());
    const retiredHash = await hashOf(id);

    expect(await lifecycle.reinstate(id)).toBe(true);

    // Back to `active`, and back to the hash `active` derives to — which is
    // what makes a delete-then-re-add round trip rather than accumulate drift.
    expect(await hashOf(id)).not.toBe(retiredHash);
    expect(await mismatchesFor(id)).not.toContain(IntegrityFindingKind.CONTENT_HASH_MISMATCH);
  });

  it('reports the lifecycle it wrote, so the returned entity is not stale', async () => {
    const id = await file('src/returned-shape.ts');

    const tombstoned = await entities.tombstone(id);

    expect(tombstoned.lifecycle).toBe(LifecycleState.DELETED);
    // The caller gets the hash that is on the row, not the one that was.
    expect(tombstoned.contentHash).toBe(await hashOf(id));
  });

  it('finds no mismatch across a whole index that has retired things', async () => {
    // The measurement from the issue, inverted: every retired row verifying,
    // asserted over the sweep rather than row by row.
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      const id = await file(`src/sweep-${path}`);
      await lifecycle.retire(id, repository, new Date());
    }

    const sweep = await integrity.sweep({ logger });
    const retired = await handle.execute<{ [column: string]: unknown; n: string }>(
      sql`SELECT count(*)::text AS n FROM ferret.entity WHERE lifecycle = ${LifecycleState.DELETED}`,
    );

    // Non-vacuous: there are retired rows to get wrong.
    expect(Number(retired.rows[0]?.n ?? '0')).toBeGreaterThan(3);
    expect(
      sweep.findings.filter((finding) => finding.kind === IntegrityFindingKind.CONTENT_HASH_MISMATCH),
    ).toStrictEqual([]);
  });
});
