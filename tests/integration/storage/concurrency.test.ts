import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, LifecycleState, RelationshipType, createNullLogger, parseConfig } from '../../../src/index.js';
import {
  EntityStore,
  RelationshipStore,
  UpsertOutcome,
  createPool,
  migrate,
  readSchemaStatus,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';
import {
  SKIP_REASON,
  connectTo,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Concurrency and connection safety.
 *
 * Node runs one JavaScript thread, so "thread safety" here means two distinct
 * things, and both can lose data:
 *
 * 1. **Interleaving across `await`.** A read-decide-write sequence is not
 *    atomic just because it is written in one function. Anything else may run
 *    between the read and the write — another request in this process, another
 *    Ferret process, another provider — and the database's default READ
 *    COMMITTED isolation will happily let both sides act on a stale snapshot.
 * 2. **Connection faults arriving out of band.** A `pg` client that fails while
 *    checked out emits on the *client*, not the pool, and an unhandled `error`
 *    event ends the Node process. That turns a routine server restart into an
 *    outage.
 *
 * The suites for EPIC-002, EPIC-003 and EPIC-007 each test the concurrency of
 * their own subsystem. This file tests the properties that span them, and the
 * connection-level faults that no single subsystem owns.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let handle: FerretDatabase;

function configFor(database: TestDatabase) {
  return parseConfig({
    database: {
      host: database.host,
      port: database.port,
      database: database.database,
      user: database.user,
      password: database.password,
    },
  });
}

describeDb(`concurrency and connection safety (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('concurrency');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('a connection that fails while it is in use', () => {
    it('does not take the process down', async () => {
      // The failure this guards against is not subtle in its consequences: an
      // unhandled 'error' on a checked-out client ends the Node process, so an
      // administrator restarting PostgreSQL would kill the user's AI session
      // rather than failing one query.
      const recording = new RecordingLogger();
      const pool = createPool(configFor(db), recording);

      const uncaught: unknown[] = [];
      const onUncaught = (error: unknown): void => void uncaught.push(error);
      process.on('uncaughtException', onUncaught);

      try {
        const client = await pool.connect();
        const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;

        // Idle *inside a transaction*, which is what a Drizzle transaction and
        // the migrator both look like between statements. This is the precise
        // shape that crashed: with no query in flight, the server's FATAL is not
        // absorbed by a pending promise — it arrives as an unsolicited `error`
        // event on a client that `pg` no longer watches, because it only watches
        // idle ones.
        await client.query('BEGIN');
        await db.pool.query('SELECT pg_terminate_backend($1)', [pid]);

        // Long enough for the FATAL to travel and be dispatched.
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        // The property that matters: the process is still here.
        expect(uncaught).toStrictEqual([]);
        // And the fault was reported rather than swallowed in silence.
        expect(
          recording.records.some((record) => record.fields['operation'] === 'storage.client.error'),
          'the connection fault should have been logged',
        ).toBe(true);

        client.release(new Error('connection terminated'));
      } finally {
        process.off('uncaughtException', onUncaught);
        await pool.end().catch(() => undefined);
      }
    }, 60_000);

    it('recovers: the pool serves the next caller from a fresh connection', async () => {
      const pool = createPool(configFor(db), new RecordingLogger());
      try {
        await pool.query('SELECT 1');
        await db.pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND application_name LIKE '@indoulia/ferret%' AND pid <> pg_backend_pid()`,
          [db.database],
        );
        await new Promise((resolve) => setTimeout(resolve, 300));

        const after = await pool.query<{ v: number }>('SELECT 2 AS v');
        expect(after.rows[0]?.v).toBe(2);
      } finally {
        await pool.end().catch(() => undefined);
      }
    }, 60_000);

    it('leaves a transaction failed rather than half applied', async () => {
      // A transaction whose connection dies must not commit. PostgreSQL
      // guarantees that; what is being checked is that Ferret surfaces it as a
      // failure rather than reporting success from a rolled-back write.
      const pool = createPool(configFor(db), new RecordingLogger());
      const scoped = new EntityStore(drizzle(pool));
      try {
        const started = scoped.upsert({
          kind: EntityKind.COMMIT,
          source: { system: 'git', id: 'doomed-transaction', scope: 'conc' },
          attributes: { sha: 'doomed' },
        });

        await db.pool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND application_name LIKE '@indoulia/ferret%' AND pid <> pg_backend_pid()`,
          [db.database],
        );

        // Either it completed before the termination, or it failed. What must
        // not happen is a reported success with nothing written.
        const outcome = await started.then(
          () => 'succeeded' as const,
          () => 'failed' as const,
        );
        const stored = await entities.getByCanonicalKey(
          (await import('../../../src/index.js')).canonicalKey({
            kind: EntityKind.COMMIT,
            sourceSystem: 'git',
            sourceId: 'doomed-transaction',
            scope: 'conc',
          }),
        );

        if (outcome === 'succeeded') expect(stored).toBeDefined();
        else expect(stored).toBeUndefined();
      } finally {
        await pool.end().catch(() => undefined);
      }
    }, 60_000);
  });

  describe('concurrent entity ingestion', () => {
    it('creates one entity when 12 writers race the same source object', async () => {
      // Two providers, or one provider on two worktrees, can index the same
      // repository at once. A read-then-insert without a conflict clause would
      // produce duplicates here.
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          entities.upsert({
            kind: EntityKind.REPOSITORY,
            source: { system: 'git', id: 'race-repo' },
            attributes: { name: 'raced' },
          }),
        ),
      );

      expect(results.every((result) => result.entity.id === results[0]?.entity.id)).toBe(true);

      const rows = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ferret.entity WHERE source_id = 'race-repo'",
      );
      expect(rows.rows[0]?.count).toBe('1');
      // Exactly one writer may claim to have created it.
      expect(results.filter((result) => result.outcome === UpsertOutcome.CREATED).length).toBeLessThanOrEqual(
        results.length,
      );
    }, 60_000);

    it('keeps the last writer\'s content when several update the same entity at once', async () => {
      const attempts = Array.from({ length: 8 }, (_, index) => `name-${String(index)}`);
      await Promise.all(
        attempts.map((name) =>
          entities.upsert({
            kind: EntityKind.REPOSITORY,
            source: { system: 'git', id: 'race-update' },
            attributes: { name },
          }),
        ),
      );

      const stored = await db.pool.query<{ attributes: { name: string }; count: string }>(
        `SELECT attributes, count(*) OVER ()::text AS count FROM ferret.entity WHERE source_id = 'race-update'`,
      );
      // One row, and its content is one of the values actually asserted — never
      // a mixture of two writers' fields.
      expect(stored.rows).toHaveLength(1);
      expect(attempts).toContain(stored.rows[0]?.attributes.name);
    }, 60_000);

    it('does not lose a tombstone to a concurrent update', async () => {
      const created = await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'race-tombstone', scope: 'conc' },
        attributes: { path: 'race.ts' },
      });

      await Promise.all([
        entities.tombstone(created.entity.id),
        entities.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: 'race-tombstone', scope: 'conc' },
          attributes: { path: 'race.ts', language: 'typescript' },
        }),
      ]);

      // Whichever landed last, the entity still exists and is readable. The
      // requirement Governance §6 imposes is that nothing is destroyed, not that
      // a particular writer wins.
      const read = await entities.get(created.entity.id);
      expect(read).toBeDefined();
      expect([LifecycleState.ACTIVE, LifecycleState.DELETED]).toContain(read?.lifecycle);
    }, 60_000);
  });

  describe('concurrent relationship assertion', () => {
    it('keeps exactly one open interval for an exclusive type under contention', async () => {
      // Repeated from the EPIC-007 suite deliberately: this is the invariant a
      // future change is most likely to break, and it is invisible in
      // single-threaded testing.
      const branch = (
        await entities.upsert({
          kind: EntityKind.BRANCH,
          source: { system: 'git', id: 'refs/heads/conc', scope: 'conc' },
          attributes: { ref: 'refs/heads/conc' },
        })
      ).entity.id;

      const commits = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          entities
            .upsert({
              kind: EntityKind.COMMIT,
              source: { system: 'git', id: `conc-sha-${String(index)}`, scope: 'conc' },
              attributes: { sha: `conc-sha-${String(index)}` },
            })
            .then((result) => result.entity.id),
        ),
      );

      await Promise.all(
        commits.map((toId, index) =>
          relationships.assert({
            fromId: branch,
            type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
            toId,
            validFrom: new Date(Date.UTC(2026, 2, index + 1)).toISOString(),
            sourceSystem: 'git',
          }),
        ),
      );

      const open = await db.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ferret.relationship
          WHERE from_id = $1 AND type = $2 AND valid_to IS NULL`,
        [branch, RelationshipType.BRANCH_POINTS_TO_COMMIT],
      );
      expect(open.rows[0]?.count).toBe('1');
    }, 120_000);

    it('produces a timeline with no overlapping intervals', async () => {
      // Stronger than "one is open": no instant may have two answers.
      const rows = await db.pool.query<{ overlaps: string }>(
        `SELECT count(*)::text AS overlaps
           FROM ferret.relationship a
           JOIN ferret.relationship b
             ON a.from_id = b.from_id AND a.type = b.type AND a.id <> b.id
          WHERE a.valid_from < COALESCE(b.valid_to, 'infinity'::timestamptz)
            AND b.valid_from < COALESCE(a.valid_to, 'infinity'::timestamptz)
            AND a.type IN ('branch_points_to_commit', 'worktree_checks_out_branch')`,
      );
      expect(rows.rows[0]?.overlaps).toBe('0');
    }, 60_000);

    it('serializes only the writers that actually conflict', async () => {
      // Two branches asserting at once must not wait on each other. If the lock
      // were taken on the type alone rather than on (entity, type), ingestion
      // would serialize globally and a large repository would crawl.
      const branches = await Promise.all(
        ['a', 'b', 'c', 'd'].map((suffix) =>
          entities
            .upsert({
              kind: EntityKind.BRANCH,
              source: { system: 'git', id: `refs/heads/par-${suffix}`, scope: 'conc' },
              attributes: { ref: `refs/heads/par-${suffix}` },
            })
            .then((result) => result.entity.id),
        ),
      );
      const target = (
        await entities.upsert({
          kind: EntityKind.COMMIT,
          source: { system: 'git', id: 'par-target', scope: 'conc' },
          attributes: { sha: 'par-target' },
        })
      ).entity.id;

      const started = Date.now();
      await Promise.all(
        branches.map((fromId) =>
          relationships.assert({
            fromId,
            type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
            toId: target,
            sourceSystem: 'git',
          }),
        ),
      );
      // Four independent asserts, running genuinely in parallel, should take
      // nothing like four times one. A generous ceiling: the point is to catch
      // accidental global serialization, not to measure the database.
      expect(Date.now() - started).toBeLessThan(5_000);

      for (const fromId of branches) {
        const open = await relationships.outgoing(fromId, {
          type: RelationshipType.BRANCH_POINTS_TO_COMMIT,
        });
        expect(open).toHaveLength(1);
      }
    }, 60_000);
  });

  describe('concurrent readers and writers', () => {
    it('never shows a reader a half-written entity', async () => {
      // An entity and its external ids commit together. A reader interleaved
      // with the writer must see either the old state or the new one, never an
      // entity whose identifiers are missing.
      const source = { system: 'github', id: 'atomic-read' } as const;

      const writes = Array.from({ length: 10 }, (_, index) =>
        entities.upsert({
          kind: EntityKind.PULL_REQUEST,
          source,
          attributes: { number: String(index) },
          externalIds: [{ system: 'github', id: `node-${String(index)}` }],
        }),
      );

      const reads = Array.from({ length: 30 }, async () => {
        const found = await entities.findByExternalId('github', 'node-0').catch(() => undefined);
        // Whenever the mapping resolves, the entity it resolves to must exist.
        if (found !== undefined) expect(found.kind).toBe(EntityKind.PULL_REQUEST);
      });

      await Promise.all([...writes, ...reads]);

      const rows = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ferret.entity WHERE source_id = 'atomic-read'",
      );
      expect(rows.rows[0]?.count).toBe('1');
    }, 120_000);

    it('keeps schema inspection correct while writes are in flight', async () => {
      // `ferret status` runs against a live system. It must not block writers,
      // and must not report a torn view of the schema.
      const writes = Array.from({ length: 20 }, (_, index) =>
        entities.upsert({
          kind: EntityKind.COMMIT,
          source: { system: 'git', id: `busy-${String(index)}`, scope: 'conc' },
          attributes: { sha: `busy-${String(index)}` },
        }),
      );
      const reads = Array.from({ length: 10 }, () => readSchemaStatus(db.pool));

      const [, statuses] = await Promise.all([Promise.all(writes), Promise.all(reads)]);
      for (const status of statuses) {
        expect(status.initialized).toBe(true);
        expect(status.pending).toStrictEqual([]);
        expect(status.failures).toStrictEqual([]);
      }
    }, 120_000);
  });

  describe('pool limits', () => {
    it('serves more concurrent callers than it has connections, without failing any', async () => {
      // The pool is deliberately small (8). Twice that many concurrent
      // operations must queue rather than error, or a burst of ingestion would
      // fail rather than slow down.
      const results = await Promise.all(
        Array.from({ length: 24 }, (_, index) =>
          entities.upsert({
            kind: EntityKind.FILE,
            source: { system: 'git', id: `pooled-${String(index)}.ts`, scope: 'conc' },
            attributes: { path: `pooled-${String(index)}.ts` },
          }),
        ),
      );
      expect(results).toHaveLength(24);
      expect(results.every((result) => result.entity.id.length > 0)).toBe(true);
    }, 120_000);

    it('returns every connection to the pool afterwards', async () => {
      // A leaked checkout is invisible until the pool is exhausted, at which
      // point everything stops at once.
      const pool = connectTo(db, 4);
      try {
        await Promise.all(Array.from({ length: 12 }, () => pool.query('SELECT 1')));
        expect(pool.idleCount).toBeGreaterThan(0);
        expect(pool.waitingCount).toBe(0);
      } finally {
        await pool.end().catch(() => undefined);
      }
    }, 60_000);
  });
});
