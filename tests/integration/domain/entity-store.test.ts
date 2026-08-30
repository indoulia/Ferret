import { performance } from 'node:perf_hooks';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, LifecycleState, createNullLogger, type EntityInput } from '../../../src/index.js';
import { EntityStore, UpsertOutcome, migrate, type FerretDatabase } from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * Canonical entity persistence, against a real PostgreSQL.
 *
 * The property that matters most is idempotency: indexing the same source twice
 * must not duplicate anything, must not rewrite what did not change, and must
 * not make "when did this last change" unanswerable. None of that can be
 * demonstrated against a mock.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let store: EntityStore;
let handle: FerretDatabase;

function repository(id = 'https://github.com/indoulia/Ferret.git') {
  return {
    kind: EntityKind.REPOSITORY,
    source: { system: 'git', id },
    attributes: { name: 'Ferret', defaultBranch: 'main' },
  } as const;
}

describeDb(`canonical entity persistence (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('entities');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    store = new EntityStore(handle);
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('the schema the migration created', () => {
    it('matches the columns the Drizzle schema declares', async () => {
      // Guards against the generated migration and the TypeScript schema
      // drifting apart. Drizzle types the queries; only the migration shapes the
      // database, and nothing else notices when they disagree until a query
      // fails in production.
      const columns = await db.pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'ferret' AND table_name = 'entity'
          ORDER BY column_name`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row]));

      expect([...byName.keys()]).toStrictEqual([
        'attributes',
        'canonical_key',
        'content_hash',
        'first_indexed_at',
        'id',
        'kind',
        'last_indexed_at',
        'lifecycle',
        'schema_version',
        'source_id',
        'source_observed_at',
        'source_scope',
        'source_system',
        'source_url',
        'unknown_fields',
      ]);
      expect(byName.get('id')?.data_type).toBe('uuid');
      expect(byName.get('attributes')?.data_type).toBe('jsonb');
      expect(byName.get('source_observed_at')?.data_type).toBe('timestamp with time zone');
      // Nullability is part of the contract, not an accident.
      expect(byName.get('content_hash')?.is_nullable).toBe('NO');
      expect(byName.get('source_url')?.is_nullable).toBe('YES');
    });

    it('indexes the lookups ingestion and retrieval actually perform', async () => {
      const indexes = await db.pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'ferret' AND tablename IN ('entity', 'entity_external_id')`,
      );
      const names = indexes.rows.map((row) => row.indexname);

      expect(names).toContain('entity_canonical_key_idx');
      expect(names).toContain('entity_kind_idx');
      expect(names).toContain('entity_source_idx');
      expect(names).toContain('entity_external_lookup_idx');
    });

    it('cascades external ids when an entity is removed, leaving no orphans', async () => {
      const result = await store.upsert({
        ...repository('cascade-test'),
        externalIds: [{ system: 'github', id: 'node-cascade' }],
      });
      await db.pool.query('DELETE FROM ferret.entity WHERE id = $1', [result.entity.id]);

      const orphans = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.entity_external_id WHERE entity_id = $1',
        [result.entity.id],
      );
      expect(orphans.rows[0]?.count).toBe('0');
    });
  });

  describe('idempotent ingestion', () => {
    it('creates an entity the first time it is seen', async () => {
      const result = await store.upsert(repository('idem-1'));
      expect(result.outcome).toBe(UpsertOutcome.CREATED);
      expect(result.entity.attributes).toStrictEqual({ name: 'Ferret', defaultBranch: 'main' });
    });

    it('reports the second identical ingestion as unchanged, without rewriting the row', async () => {
      // Governance §10: reprocessing unchanged content must not create duplicate
      // logical entities — and must not destroy the record of when the content
      // actually last changed.
      const first = await store.upsert(repository('idem-2'));
      const before = await db.pool.query<{ first_indexed_at: Date; content_hash: string }>(
        'SELECT first_indexed_at, content_hash FROM ferret.entity WHERE id = $1',
        [first.entity.id],
      );

      const second = await store.upsert(repository('idem-2'));
      expect(second.outcome).toBe(UpsertOutcome.UNCHANGED);
      expect(second.entity.id).toBe(first.entity.id);

      const after = await db.pool.query<{ first_indexed_at: Date; content_hash: string }>(
        'SELECT first_indexed_at, content_hash FROM ferret.entity WHERE id = $1',
        [first.entity.id],
      );
      expect(after.rows[0]?.first_indexed_at.toISOString()).toBe(before.rows[0]?.first_indexed_at.toISOString());
      expect(after.rows[0]?.content_hash).toBe(before.rows[0]?.content_hash);
    });

    it('still records that Ferret looked, so staleness stays measurable', async () => {
      const first = await store.upsert(repository('idem-3'), new Date('2026-01-01T00:00:00Z'));
      await store.upsert(repository('idem-3'), new Date('2026-06-01T00:00:00Z'));

      const row = await db.pool.query<{ first_indexed_at: Date; last_indexed_at: Date }>(
        'SELECT first_indexed_at, last_indexed_at FROM ferret.entity WHERE id = $1',
        [first.entity.id],
      );
      expect(row.rows[0]?.first_indexed_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(row.rows[0]?.last_indexed_at.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    });

    it('never creates a second row for the same source object', async () => {
      for (let i = 0; i < 10; i += 1) await store.upsert(repository('idem-4'));

      const rows = await db.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ferret.entity WHERE source_id = 'idem-4'",
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('updates in place when the content changes, keeping the same id', async () => {
      const before = await store.upsert(repository('idem-5'));
      const after = await store.upsert({
        ...repository('idem-5'),
        attributes: { name: 'Ferret', defaultBranch: 'develop' },
      });

      expect(after.outcome).toBe(UpsertOutcome.UPDATED);
      expect(after.entity.id).toBe(before.entity.id);
      expect(after.entity.attributes).toStrictEqual({ name: 'Ferret', defaultBranch: 'develop' });
      // A changed id would orphan every relationship pointing at the old one.
      expect(await store.get(before.entity.id)).toMatchObject({ id: before.entity.id });
    });

    it('preserves when Ferret first saw something across an update', async () => {
      const first = await store.upsert(repository('idem-6'), new Date('2026-01-01T00:00:00Z'));
      await store.upsert(
        { ...repository('idem-6'), attributes: { name: 'Renamed' } },
        new Date('2026-06-01T00:00:00Z'),
      );

      const row = await db.pool.query<{ first_indexed_at: Date }>(
        'SELECT first_indexed_at FROM ferret.entity WHERE id = $1',
        [first.entity.id],
      );
      // When Ferret first observed something is a historical fact. An update
      // must not rewrite it.
      expect(row.rows[0]?.first_indexed_at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  describe('reading back', () => {
    it('returns exactly what was stored, including unknown source fields', async () => {
      const stored = await store.upsert({
        ...repository('read-1'),
        unknownFields: { githubStars: 42, nested: { a: [1, 2] } },
        externalIds: [{ system: 'github', id: 'R_node', url: 'https://github.com/x' }],
        sourceObservedAt: '2026-05-01T12:00:00.000Z',
      });

      const read = await store.get(stored.entity.id);
      expect(read?.attributes).toStrictEqual({ name: 'Ferret', defaultBranch: 'main' });
      expect(read?.unknownFields).toStrictEqual({ githubStars: 42, nested: { a: [1, 2] } });
      expect(read?.externalIds).toStrictEqual([
        { system: 'github', id: 'R_node', url: 'https://github.com/x' },
      ]);
      expect(read?.sourceObservedAt).toBe('2026-05-01T12:00:00.000Z');
      expect(read?.contentHash).toBe(stored.entity.contentHash);
    });

    it('finds an entity by the identity its id was derived from', async () => {
      const stored = await store.upsert(repository('read-2'));
      const found = await store.getByCanonicalKey(stored.entity.canonicalKey);
      expect(found?.id).toBe(stored.entity.id);
    });

    it('returns undefined for an entity that does not exist, rather than throwing', async () => {
      expect(await store.get('00000000-0000-8000-8000-000000000000')).toBeUndefined();
      expect(await store.getByCanonicalKey('no-such-key')).toBeUndefined();
    });

    it('lists by kind', async () => {
      const before = await store.count(EntityKind.ISSUE);
      await store.upsert({
        kind: EntityKind.ISSUE,
        source: { system: 'jira', id: 'FER-100' },
        attributes: { key: 'FER-100', title: 'A thing' },
      });

      const issues = await store.listByKind(EntityKind.ISSUE);
      expect(issues.length).toBe(before + 1);
      expect(issues.every((issue) => issue.kind === EntityKind.ISSUE)).toBe(true);
    });
  });

  describe('cross-source identity', () => {
    it('resolves an identifier another system uses for the same thing', async () => {
      // The question EPIC-051 and every synchronization Epic asks: "which entity
      // does this external id refer to". A stored array would make it a scan.
      const stored = await store.upsert({
        ...repository('xsource-1'),
        externalIds: [
          { system: 'github', id: 'R_kgDONODE' },
          { system: 'jira', id: 'FERRET' },
        ],
      });

      expect((await store.findByExternalId('github', 'R_kgDONODE'))?.id).toBe(stored.entity.id);
      expect((await store.findByExternalId('jira', 'FERRET'))?.id).toBe(stored.entity.id);
      expect(await store.findByExternalId('github', 'not-a-node')).toBeUndefined();
    });

    it('stops reporting an identifier the source no longer returns', async () => {
      // A stale mapping resolves to the wrong entity, which is worse than none.
      const stored = await store.upsert({
        ...repository('xsource-2'),
        externalIds: [{ system: 'github', id: 'old-node' }],
      });
      await store.upsert({
        ...repository('xsource-2'),
        attributes: { name: 'Changed' },
        externalIds: [{ system: 'github', id: 'new-node' }],
      });

      expect(await store.findByExternalId('github', 'old-node')).toBeUndefined();
      expect((await store.findByExternalId('github', 'new-node'))?.id).toBe(stored.entity.id);
    });
  });

  describe('tombstones', () => {
    it('marks an entity deleted without discarding it', async () => {
      // Governance §6: source evidence is not silently rewritten. "What happened
      // to this file, and when" is exactly what Ferret exists to answer.
      const stored = await store.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/gone.ts', scope: 'repo-1' },
        attributes: { path: 'src/gone.ts' },
      });

      const tombstoned = await store.tombstone(stored.entity.id);
      expect(tombstoned.lifecycle).toBe(LifecycleState.DELETED);

      const read = await store.get(stored.entity.id);
      expect(read?.lifecycle).toBe(LifecycleState.DELETED);
      // The content is still there, which is the whole point.
      expect(read?.attributes).toStrictEqual({ path: 'src/gone.ts' });
    });

    it('fails clearly when asked to tombstone something that was never indexed', async () => {
      await expect(store.tombstone('00000000-0000-8000-8000-000000000000')).rejects.toMatchObject({
        code: 'E_ENTITY_NOT_FOUND',
      });
    });
  });

  describe('validation reaches the database boundary', () => {
    it('rejects an invalid entity before writing anything', async () => {
      const before = await store.count();
      await expect(
        store.upsert({
          kind: EntityKind.BRANCH,
          source: { system: 'git', id: 'refs/heads/x' },
          attributes: {},
        }),
      ).rejects.toMatchObject({ code: 'E_ENTITY_INVALID' });
      expect(await store.count()).toBe(before);
    });

    it('refuses to read an entity written by a newer Ferret', async () => {
      const stored = await store.upsert(repository('newer-1'));
      await db.pool.query('UPDATE ferret.entity SET schema_version = 99 WHERE id = $1', [stored.entity.id]);

      await expect(store.get(stored.entity.id)).rejects.toMatchObject({ code: 'E_SCHEMA_UNSUPPORTED' });

      await db.pool.query('UPDATE ferret.entity SET schema_version = 1 WHERE id = $1', [stored.entity.id]);
    });
  });

  describe('batch ingestion', () => {
    it('applies a whole batch', async () => {
      const results = await store.upsertMany([
        { kind: EntityKind.COMMIT, source: { system: 'git', id: 'sha-1', scope: 'r' }, attributes: { sha: 'sha-1' } },
        { kind: EntityKind.COMMIT, source: { system: 'git', id: 'sha-2', scope: 'r' }, attributes: { sha: 'sha-2' } },
      ]);
      expect(results.map((result) => result.outcome)).toStrictEqual([
        UpsertOutcome.CREATED,
        UpsertOutcome.CREATED,
      ]);
    });

    it('validates the whole batch before writing any of it', async () => {
      // A batch that failed half way would leave the index in a state no re-run
      // could reason about, because what did land would look current.
      const before = await store.count(EntityKind.COMMIT);
      await expect(
        store.upsertMany([
          { kind: EntityKind.COMMIT, source: { system: 'git', id: 'sha-ok', scope: 'r' }, attributes: { sha: 'sha-ok' } },
          { kind: EntityKind.COMMIT, source: { system: 'git', id: 'sha-bad', scope: 'r' }, attributes: {} },
        ]),
      ).rejects.toMatchObject({ code: 'E_ENTITY_INVALID' });

      expect(await store.count(EntityKind.COMMIT)).toBe(before);
    });
  });

  describe('performance', () => {
    // Ingestion writes entities in bulk, so per-entity cost is multiplied by the
    // size of a repository. A ceiling, not a target.
    const BUDGET = { upsertMs: 250, getMs: 100, externalLookupMs: 100 } as const;

    it(`upserts an entity in under ${String(BUDGET.upsertMs)} ms at p95`, async () => {
      const durations: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const started = performance.now();
        await store.upsert({
          kind: EntityKind.FILE,
          source: { system: 'git', id: `perf/${String(i)}.ts`, scope: 'perf-repo' },
          attributes: { path: `perf/${String(i)}.ts` },
        });
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.upsertMs);
    }, 60_000);

    it(`reads an entity in under ${String(BUDGET.getMs)} ms at p95`, async () => {
      const stored = await store.upsert(repository('perf-read'));
      const durations: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const started = performance.now();
        await store.get(stored.entity.id);
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.getMs);
    }, 60_000);

    it(`resolves an external id in under ${String(BUDGET.externalLookupMs)} ms at p95`, async () => {
      await store.upsert({
        ...repository('perf-external'),
        externalIds: [{ system: 'github', id: 'perf-node' }],
      });
      const durations: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const started = performance.now();
        await store.findByExternalId('github', 'perf-node');
        durations.push(performance.now() - started);
      }
      durations.sort((a, b) => a - b);
      expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(BUDGET.externalLookupMs);
    }, 60_000);

    it('uses the canonical-key index rather than scanning', async () => {
      // A scan would be invisible at test scale and fatal at repository scale.
      const stored = await store.upsert(repository('perf-plan'));
      const plan = await db.pool.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM ferret.entity WHERE canonical_key = $1`,
        [stored.entity.canonicalKey],
      );
      const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(text).toContain('entity_canonical_key_idx');
    });
  });

  describe('durability', () => {
    it('commits an entity and its external ids together', async () => {
      // A crash between the two would leave an entity whose identifiers are
      // missing, which resolves to nothing and looks like a source that never
      // reported them.
      const stored = await store.upsert({
        ...repository('durable-1'),
        externalIds: [{ system: 'github', id: 'durable-node' }],
      });

      const rows = await db.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM ferret.entity_external_id WHERE entity_id = $1',
        [stored.entity.id],
      );
      expect(rows.rows[0]?.count).toBe('1');
    });

    it('survives the server terminating every connection', async () => {
      const stored = await store.upsert(repository('durable-2'));
      await db.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      const read = await store.get(stored.entity.id);
      expect(read?.contentHash).toBe(stored.entity.contentHash);
    });

    it('stores a canonical id the database itself validates', async () => {
      // The id column is `uuid`, so a malformed id is rejected by PostgreSQL
      // rather than stored and discovered later.
      await expect(
        db.pool.query(
          `INSERT INTO ferret.entity (id, kind, canonical_key, schema_version, source_system, source_id, lifecycle, content_hash)
           VALUES ('not-a-uuid', 'repository', 'k', 1, 's', 'i', 'active', 'h')`,
        ),
      ).rejects.toThrow();
    });

    it('refuses two entities claiming the same canonical identity', async () => {
      const stored = await store.upsert(repository('unique-1'));
      await expect(
        db.pool.query(
          `INSERT INTO ferret.entity (id, kind, canonical_key, schema_version, source_system, source_id, lifecycle, content_hash)
           VALUES (gen_random_uuid(), 'repository', $1, 1, 's', 'i', 'active', 'h')`,
          [stored.entity.canonicalKey],
        ),
      ).rejects.toThrow();
    });
  });

  describe('every kind round-trips', () => {
    it('stores and reads back an entity of each of the sixteen kinds', async () => {
      // EPIC-006 AC-1: every supported source object must map to a canonical
      // entity. Exercised against the real column types, not just the schemas.
      const samples: EntityInput[] = [
        { kind: EntityKind.REPOSITORY, source: { system: 'git', id: 'k-repo' }, attributes: { name: 'r' } },
        { kind: EntityKind.BRANCH, source: { system: 'git', id: 'k-branch', scope: 'r' }, attributes: { ref: 'refs/heads/main' } },
        { kind: EntityKind.WORKTREE, source: { system: 'git', id: 'k-wt', scope: 'r' }, attributes: { path: '/tmp/wt' } },
        { kind: EntityKind.DEVELOPER, source: { system: 'git', id: 'k-dev' }, attributes: { name: 'Dev', emails: ['d@example.com'] } },
        { kind: EntityKind.AGENT, source: { system: 'ferret', id: 'k-agent' }, attributes: { name: 'claude-code', agentType: 'ai-client' } },
        { kind: EntityKind.SESSION, source: { system: 'ferret', id: 'k-session' }, attributes: { objective: 'do a thing' } },
        { kind: EntityKind.FILE, source: { system: 'git', id: 'k-file', scope: 'r' }, attributes: { path: 'a.ts' } },
        { kind: EntityKind.FILE_VERSION, source: { system: 'git', id: 'k-fv', scope: 'r' }, attributes: { contentHash: 'abc' } },
        { kind: EntityKind.COMMIT, source: { system: 'git', id: 'k-commit', scope: 'r' }, attributes: { sha: 'abc' } },
        { kind: EntityKind.PULL_REQUEST, source: { system: 'github', id: 'k-pr' }, attributes: { number: '1', state: 'open' } },
        { kind: EntityKind.REVIEW, source: { system: 'github', id: 'k-review' }, attributes: { state: 'approved' } },
        { kind: EntityKind.ISSUE, source: { system: 'jira', id: 'k-issue' }, attributes: { key: 'FER-1' } },
        { kind: EntityKind.RELEASE, source: { system: 'github', id: 'k-release' }, attributes: { version: '1.0.0' } },
        { kind: EntityKind.DEPLOYMENT, source: { system: 'github', id: 'k-deploy' }, attributes: { environment: 'prod' } },
        { kind: EntityKind.DOCUMENT, source: { system: 'file', id: 'k-doc' }, attributes: { title: 'Doc' } },
        { kind: EntityKind.EVIDENCE, source: { system: 'ferret', id: 'k-evidence' }, attributes: { statement: 'x', method: 'observed' } },
      ];

      for (const sample of samples) {
        const result = await store.upsert(sample);
        expect(result.outcome).toBe(UpsertOutcome.CREATED);

        const read = await store.get(result.entity.id);
        expect(read, `${sample.kind} did not round-trip`).toBeDefined();
        expect(read?.kind).toBe(sample.kind);
        expect(read?.contentHash).toBe(result.entity.contentHash);
      }
    }, 60_000);
  });
});
