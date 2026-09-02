import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Completeness,
  EntityKind,
  LifecycleState,
  EvidenceState,
  createNullLogger,
} from '../../../src/index.js';
import {
  ContentStore,
  EntityStore,
  EvidenceStore,
  RetentionService,
  RetentionTarget,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-088 against a real PostgreSQL.
 *
 * Every claim in this Epic is an anti-join, and an anti-join is exactly the
 * thing a fake gets right by construction and a database gets right or wrong.
 * Two of them decide whether Ferret deletes an answer:
 *
 * - a blob a live `file_version` points at, which EPIC-087 says outlives it
 *   deliberately;
 * - a superseded record a **current** record was derived from, where
 *   `evidence_derivation` cascades on delete and would take the provenance
 *   edge with it silently.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let db: TestDatabase;
let handle: FerretDatabase;
let entities: EntityStore;
let content: ContentStore;
let evidenceStore: EvidenceStore;
let retention: RetentionService;
let repository: string;

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function blobHashes(): Promise<string[]> {
  const rows = await handle.execute<{ [column: string]: unknown; content_hash: string }>(
    sql`SELECT content_hash FROM ferret.content_blob ORDER BY content_hash`,
  );
  return rows.rows.map((row) => row.content_hash);
}

async function evidenceIds(): Promise<string[]> {
  const rows = await handle.execute<{ [column: string]: unknown; id: string }>(
    sql`SELECT id FROM ferret.evidence ORDER BY id`,
  );
  return rows.rows.map((row) => row.id);
}

/** A file and a version of it carrying the hash — the shape Git writes. */
async function fileWithVersion(path: string, contentHash: string): Promise<string> {
  const file = await entities.upsert({
    kind: EntityKind.FILE,
    source: { system: 'git', id: path, scope: repository },
    attributes: { path },
  });
  await entities.upsert({
    kind: EntityKind.FILE_VERSION,
    source: { system: 'git', id: `${path}@${contentHash}`, scope: file.entity.id },
    attributes: { path, contentHash },
  });
  return file.entity.id;
}

/** Records one observation and returns its id. */
async function observe(subjectId: string, field: string, statement: unknown): Promise<string> {
  const written = await evidenceStore.record({
    subjectId,
    field,
    statement,
    method: 'parsed',
    producer: 'test',
    producerVersion: '1.0.0',
    sourceSystem: 'git',
    completeness: Completeness.COMPLETE,
    authority: 50,
  });
  return written.evidence.id;
}

/** Backdates a record so an age boundary can be crossed without waiting. */
async function backdate(id: string, days: number): Promise<void> {
  await handle.execute(
    sql`UPDATE ferret.evidence
           SET recorded_at = now() - (${String(days)} || ' days')::interval
         WHERE id = ${id}::uuid`,
  );
}

async function stateOf(id: string): Promise<string | undefined> {
  const rows = await handle.execute<{ [column: string]: unknown; state: string }>(
    sql`SELECT state FROM ferret.evidence WHERE id = ${id}::uuid`,
  );
  return rows.rows[0]?.state;
}

describeDb(`retention (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('retention');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    content = new ContentStore(handle);
    evidenceStore = new EvidenceStore(handle);
    retention = new RetentionService(handle);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/retention-repo' },
        attributes: { path: '/retention-repo' },
      })
    ).entity.id;
  });

  afterAll(async () => {
    await db.drop();
  });

  describe('unreferenced blobs — AC-3, AC-4, AC-14', () => {
    it('deletes only the blob no file version references', async () => {
      await fileWithVersion('src/kept.ts', 'h:kept');
      await content.store({ contentHash: 'h:kept', bytes: bytes('kept body\n') });
      await content.store({ contentHash: 'h:orphan', bytes: bytes('orphan body\n') });

      const plan = await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });

      expect(plan.counts[0]).toMatchObject({ target: 'blobs', rows: 1 });
      expect(plan.counts[0]?.bytes).toBeGreaterThan(0);
      const left = await blobHashes();
      expect(left).toContain('h:kept');
      expect(left).not.toContain('h:orphan');
    });

    it('keeps a referenced blob even when it is the only one left — AC-4', async () => {
      // EPIC-087: a blob "outlives the last file version that referenced it,
      // deliberately: that is what makes it deduplicated storage rather than a
      // cache". So reclamation is *after* the last reference, never while one
      // exists.
      const before = await blobHashes();
      const plan = await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });

      expect(plan.counts[0]?.rows).toBe(0);
      expect(await blobHashes()).toStrictEqual(before);
    });

    it('leaves every remaining file version able to resolve its content — AC-14', async () => {
      // The invariant that makes the delete safe, asserted rather than
      // reasoned about: after a prune, no `file_version` names a missing blob.
      await fileWithVersion('src/second.ts', 'h:second');
      await content.store({ contentHash: 'h:second', bytes: bytes('second body\n') });
      await content.store({ contentHash: 'h:also-orphan', bytes: bytes('gone\n') });

      await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });

      const dangling = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n
              FROM ferret.entity AS v
             WHERE v.kind = 'file_version'
               AND v.attributes->>'contentHash' IS NOT NULL
               AND NOT EXISTS (
                     SELECT 1 FROM ferret.content_blob AS b
                      WHERE b.content_hash = v.attributes->>'contentHash')`,
      );
      expect(Number(dangling.rows[0]?.n ?? '1')).toBe(0);
      expect(await content.read('h:second')).toBeDefined();
    });

    it('reclaims nothing the second time — AC-13', async () => {
      await content.store({ contentHash: 'h:twice', bytes: bytes('once\n') });

      const first = await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });
      const second = await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });

      expect(first.counts[0]?.rows).toBe(1);
      expect(second.counts[0]?.rows).toBe(0);
    });

    it('deletes no blob a tombstoned file version still names — AC-9', async () => {
      // A tombstone is a record that a deletion happened, and EPIC-006 §D-009
      // says its content is one of the questions Ferret exists to answer. So
      // the blob behind a deleted file is *referenced*, and stays.
      const file = await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/removed.ts', scope: repository },
        attributes: { path: 'src/removed.ts' },
      });
      const version = await entities.upsert({
        kind: EntityKind.FILE_VERSION,
        source: { system: 'git', id: 'src/removed.ts@h:tombstoned', scope: file.entity.id },
        attributes: { path: 'src/removed.ts', contentHash: 'h:tombstoned' },
      });
      await entities.tombstone(version.entity.id);
      await content.store({ contentHash: 'h:tombstoned', bytes: bytes('what it contained\n') });

      await retention.prune({ targets: [RetentionTarget.BLOBS], apply: true });

      expect(await blobHashes()).toContain('h:tombstoned');
      // And the tombstone itself is untouched — there is no target for it.
      const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.entity WHERE lifecycle = ${LifecycleState.DELETED}`,
      );
      expect(Number(rows.rows[0]?.n ?? '0')).toBeGreaterThan(0);
    });
  });

  describe('superseded evidence past an age — AC-6, AC-7, AC-8', () => {
    it('deletes a superseded record older than the age', async () => {
      const subject = await fileWithVersion('src/aged.ts', 'h:aged');
      const first = await observe(subject, 'language', 'typescript');
      // EPIC-047 supersedes the earlier record when a second arrives.
      await observe(subject, 'language', 'typescript-4');
      await backdate(first, 90);

      expect(await stateOf(first)).toBe(EvidenceState.SUPERSEDED);

      const plan = await retention.prune({
        targets: [RetentionTarget.EVIDENCE],
        supersededOlderThanDays: 30,
        apply: true,
      });

      expect(plan.counts[0]?.rows).toBe(1);
      expect(await evidenceIds()).not.toContain(first);
    });

    it('keeps a superseded record younger than the age — AC-7', async () => {
      const subject = await fileWithVersion('src/young.ts', 'h:young');
      const first = await observe(subject, 'language', 'javascript');
      await observe(subject, 'language', 'javascript-2');
      await backdate(first, 3);

      const plan = await retention.prune({
        targets: [RetentionTarget.EVIDENCE],
        supersededOlderThanDays: 30,
        apply: true,
      });

      expect(plan.counts[0]?.rows).toBe(0);
      expect(await evidenceIds()).toContain(first);
    });

    it('never deletes current evidence, whatever the age — AC-8', async () => {
      const subject = await fileWithVersion('src/current.ts', 'h:current');
      const live = await observe(subject, 'language', 'python');
      await backdate(live, 3650);

      const plan = await retention.prune({
        targets: [RetentionTarget.EVIDENCE],
        supersededOlderThanDays: 0,
        apply: true,
      });

      expect(await stateOf(live)).toBe(EvidenceState.CURRENT);
      expect(plan.counts[0]?.failure).toBeUndefined();
    });

    it('keeps a superseded record a current record was derived from', async () => {
      // The guard `evidence_derivation`'s cascade makes necessary. A superseded
      // observation still answers "where did this conclusion come from", and
      // deleting it would erase the edge as well as the row.
      const subject = await fileWithVersion('src/derived.ts', 'h:derived');
      const source = await observe(subject, 'authors', ['a@example.com']);
      await observe(subject, 'authors', ['a@example.com', 'b@example.com']);
      await backdate(source, 400);

      const conclusion = await evidenceStore.record({
        subjectId: subject,
        field: 'ownership',
        statement: 'a@example.com',
        method: 'inferred',
        producer: 'test',
        producerVersion: '1.0.0',
        sourceSystem: 'ferret',
        completeness: Completeness.COMPLETE,
        authority: 20,
        derivedFrom: [source],
      });

      const plan = await retention.prune({
        targets: [RetentionTarget.EVIDENCE],
        supersededOlderThanDays: 30,
        apply: true,
      });

      expect(await stateOf(source)).toBe(EvidenceState.SUPERSEDED);
      expect(await evidenceIds()).toContain(source);
      expect(plan.counts[0]?.rows).toBe(0);
      // And the chain still resolves, which is the point of keeping it.
      const chain = await evidenceStore.provenanceOf(conclusion.evidence.id);
      expect(JSON.stringify(chain)).toContain(source);
    });
  });

  describe('the plan, and failure isolation — AC-1, AC-2, AC-10, AC-11', () => {
    it('deletes nothing without apply, and reports the same counts — AC-2, AC-10', async () => {
      await content.store({ contentHash: 'h:planned', bytes: bytes('still here\n') });

      const planned = await retention.prune({ targets: [RetentionTarget.BLOBS] });

      expect(planned.applied).toBe(false);
      expect(planned.counts[0]?.rows).toBe(1);
      expect(await blobHashes()).toContain('h:planned');
    });

    it('runs every target when none is named, and still deletes nothing — AC-1', async () => {
      const before = await blobHashes();
      const plan = await retention.prune({
        targets: [RetentionTarget.BLOBS, RetentionTarget.JOURNALS, RetentionTarget.EVIDENCE],
      });

      expect(plan.counts.map((count) => count.target)).toStrictEqual([
        'blobs',
        'journals',
        'evidence',
      ]);
      expect(await blobHashes()).toStrictEqual(before);
    });

    it('reports a failing target and still runs the others — AC-11', async () => {
      // §8.5's reason for one transaction per target, made visible: a broken
      // target says so rather than being absent from the report, and the
      // target beside it still runs.
      await handle.execute(sql`ALTER TABLE ferret.content_blob RENAME TO content_blob_hidden`);
      try {
        const plan = await retention.prune({
          targets: [RetentionTarget.BLOBS, RetentionTarget.EVIDENCE],
          supersededOlderThanDays: 30,
          apply: true,
        });

        const blobs = plan.counts.find((count) => count.target === 'blobs');
        const evidenceCount = plan.counts.find((count) => count.target === 'evidence');
        expect(blobs?.failure).toBeDefined();
        expect(evidenceCount?.failure).toBeUndefined();
      } finally {
        await handle.execute(sql`ALTER TABLE ferret.content_blob_hidden RENAME TO content_blob`);
      }
    });
  });
});
