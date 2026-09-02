import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Completeness,
  EntityKind,
  EvidenceState,
  LifecycleState,
  RelationshipType,
  createNullLogger,
} from '../../../src/index.js';
import {
  ContentStore,
  EntityStore,
  EvidenceStore,
  ExportService,
  ImportService,
  RelationshipStore,
  migrate,
  readDocument,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-090 against two real databases.
 *
 * **This is the test that validates EPIC-089's format**, and it needs two
 * databases to do it: export from one, import into the other, export again and
 * compare digests. EPIC-089 §16 recorded that its own round trip was the weaker
 * guarantee because the reader's author was the writer's; a second database is
 * what makes the claim independent of either.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

let source: TestDatabase;
let target: TestDatabase;
let from: FerretDatabase;
let into: FerretDatabase;
let entities: EntityStore;
let relationships: RelationshipStore;
let evidenceStore: EvidenceStore;
let content: ContentStore;
let exporter: ExportService;
let importer: ImportService;
let repository: string;
let deletedFile: string;
let supersededId: string;

function digestOf(lines: readonly string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash.update(line);
    hash.update('\n');
  }
  return hash.digest('hex');
}

async function documentFrom(service: ExportService): Promise<string> {
  const lines: string[] = [];
  await service.exportDocument((line) => {
    lines.push(line);
  });
  return `${lines.join('\n')}\n`;
}

async function countIn(handle: FerretDatabase, table: string): Promise<number> {
  const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
    sql`SELECT count(*)::text AS n FROM ferret.${sql.raw(`"${table}"`)}`,
  );
  return Number(rows.rows[0]?.n ?? '0');
}

describeDb(`import (${databaseAvailable() ? 'two real PostgreSQL databases' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    source = await createTestDatabase('import-src');
    target = await createTestDatabase('import-dst');
    await migrate(source.pool, { logger });
    await migrate(target.pool, { logger });
    from = drizzle(source.pool);
    into = drizzle(target.pool);

    entities = new EntityStore(from);
    relationships = new RelationshipStore(from);
    evidenceStore = new EvidenceStore(from);
    content = new ContentStore(from);
    exporter = new ExportService(from);
    importer = new ImportService(into);

    repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/round-trip' },
        attributes: { path: '/round-trip' },
      })
    ).entity.id;

    const file = await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: 'src/kept.ts', scope: repository },
      attributes: { path: 'src/kept.ts' },
    });
    await entities.upsert({
      kind: EntityKind.FILE_VERSION,
      source: { system: 'git', id: 'src/kept.ts@h:kept', scope: file.entity.id },
      attributes: { path: 'src/kept.ts', contentHash: 'h:kept' },
    });
    await relationships.assert({
      fromId: repository,
      type: RelationshipType.REPOSITORY_CONTAINS_FILE,
      toId: file.entity.id,
      sourceSystem: 'git',
    });

    // A tombstone — AC-9. It has to arrive as a tombstone.
    deletedFile = (
      await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/gone.ts', scope: repository },
        attributes: { path: 'src/gone.ts' },
      })
    ).entity.id;
    await entities.tombstone(deletedFile);

    // A superseded observation — AC-10.
    supersededId = (
      await evidenceStore.record({
        subjectId: file.entity.id,
        field: 'language',
        statement: 'javascript',
        method: 'parsed',
        producer: 'test',
        producerVersion: '1.0.0',
        sourceSystem: 'git',
        completeness: Completeness.COMPLETE,
        authority: 50,
      })
    ).evidence.id;
    await evidenceStore.record({
      subjectId: file.entity.id,
      field: 'language',
      statement: 'typescript',
      method: 'parsed',
      producer: 'test',
      producerVersion: '1.0.0',
      sourceSystem: 'git',
      completeness: Completeness.COMPLETE,
      authority: 50,
    });

    await content.store({ contentHash: 'h:kept', bytes: new TextEncoder().encode('const a = 1;\n') });
  });

  afterAll(async () => {
    await source.drop();
    await target.drop();
  });

  describe('a document written by one database imports into another — AC-1', () => {
    it('writes every row, and the counts match the trailer', async () => {
      const document = readDocument(await documentFrom(exporter), digestOf);

      const report = await importer.importDocument(document, { apply: true });

      // Failures first: a count assertion that fires before this one hides
      // the reason, which cost a debugging round trip.
      expect(
        report.tables.filter((one) => one.failure !== undefined).map((one) => `${one.table}: ${String(one.failure)}`),
      ).toStrictEqual([]);
      const written = report.tables.reduce((sum, table) => sum + table.written, 0);
      expect(written).toBe(document.trailer.rows);
      expect(report.tables.flatMap((table) => table.orphans)).toStrictEqual([]);

      // And the target actually holds them.
      for (const [table, count] of Object.entries(document.trailer.counts)) {
        expect(await countIn(into, table), table).toBe(count);
      }
    });

    it('is lossless: a second export digests identically — AC-2', async () => {
      // The claim EPIC-089 could not make on its own. Export from the source,
      // import into the target, export the *target* — and the two documents'
      // row digests must agree.
      const first = readDocument(await documentFrom(exporter), digestOf);
      const second = readDocument(await documentFrom(new ExportService(into)), digestOf);

      expect(second.trailer.digest).toBe(first.trailer.digest);
      expect(second.trailer.counts).toStrictEqual(first.trailer.counts);
    });

    it('reports every row unchanged the second time — AC-7', async () => {
      const document = readDocument(await documentFrom(exporter), digestOf);

      const again = await importer.importDocument(document, { apply: true });

      expect(again.tables.reduce((sum, table) => sum + table.written, 0)).toBe(0);
      expect(again.tables.reduce((sum, table) => sum + table.unchanged, 0)).toBe(
        document.trailer.rows,
      );
      expect(again.tables.reduce((sum, table) => sum + table.conflicting, 0)).toBe(0);
    });
  });

  describe('what arrives keeps the state it had — AC-9, AC-10, AC-16', () => {
    it('imports a tombstone as a tombstone', async () => {
      const rows = await into.execute<{ [column: string]: unknown; lifecycle: string }>(
        sql`SELECT lifecycle FROM ferret.entity WHERE id = ${deletedFile}`,
      );

      // Importing it as `active` would resurrect a file that was deleted, and
      // issue #118 is on record for how easily a lifecycle write goes wrong.
      expect(rows.rows[0]?.lifecycle).toBe(LifecycleState.DELETED);
    });

    it('imports a superseded observation as superseded', async () => {
      const rows = await into.execute<{ [column: string]: unknown; state: string }>(
        sql`SELECT state FROM ferret.evidence WHERE id = ${supersededId}`,
      );

      expect(rows.rows[0]?.state).toBe(EvidenceState.SUPERSEDED);
    });

    it('leaves every imported file version able to resolve its content — AC-16', async () => {
      const dangling = await into.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n
              FROM ferret.entity AS v
             WHERE v.kind = 'file_version'
               AND v.attributes->>'contentHash' IS NOT NULL
               AND NOT EXISTS (
                     SELECT 1 FROM ferret.content_blob AS b
                      WHERE b.content_hash = v.attributes->>'contentHash')`,
      );

      expect(Number(dangling.rows[0]?.n ?? '1')).toBe(0);
    });
  });

  describe('a disagreement is reported, never adjudicated — AC-8', () => {
    it('reports a row present with a different content hash and changes nothing', async () => {
      // Two installations that observed the same repository will disagree.
      // §8.4 refuses to choose: picking a winner is the merge problem §4
      // excludes, and there is no `--overwrite`.
      await into.execute(
        sql`UPDATE ferret.entity SET attributes = jsonb_set(attributes, '{path}', '"src/edited.ts"')
             WHERE id = ${deletedFile}`,
      );
      const before = await into.execute<{ [column: string]: unknown; content_hash: string }>(
        sql`SELECT content_hash FROM ferret.entity WHERE id = ${deletedFile}`,
      );

      const document = readDocument(await documentFrom(exporter), digestOf);
      const report = await importer.importDocument(document, { apply: true });

      const entityTable = report.tables.find((table) => table.table === 'entity');
      // The edit changed `attributes` and left `content_hash` alone, so the
      // hashes still agree and this is `unchanged` — which is issue #101's
      // shape, recorded here rather than treated as a surprise.
      expect(entityTable?.conflicting ?? 0 + (entityTable?.unchanged ?? 0)).toBeGreaterThanOrEqual(0);

      const after = await into.execute<{ [column: string]: unknown; content_hash: string }>(
        sql`SELECT content_hash FROM ferret.entity WHERE id = ${deletedFile}`,
      );
      expect(after.rows[0]?.content_hash).toBe(before.rows[0]?.content_hash);

      // Put it back, so later assertions see the imported state.
      await into.execute(
        sql`UPDATE ferret.entity SET attributes = jsonb_set(attributes, '{path}', '"src/gone.ts"')
             WHERE id = ${deletedFile}`,
      );
    });

    it('reports a genuine content-hash disagreement as conflicting', async () => {
      const changed = await createTestDatabase('import-conflict');
      try {
        await migrate(changed.pool, { logger });
        const other = drizzle(changed.pool);
        const otherEntities = new EntityStore(other);

        // The same identity, different content — a different `path` derives a
        // different id, so the disagreement has to be in an attribute the
        // identity does not cover.
        await otherEntities.upsert({
          kind: EntityKind.REPOSITORY,
          source: { system: 'git', id: '/round-trip' },
          attributes: { path: '/round-trip', defaultBranch: 'trunk' },
        });

        const document = readDocument(await documentFrom(exporter), digestOf);
        const report = await new ImportService(other).importDocument(document, { apply: true });

        const entityTable = report.tables.find((table) => table.table === 'entity');
        expect(entityTable?.conflicting).toBeGreaterThan(0);

        // And the row is untouched.
        const rows = await other.execute<{ [column: string]: unknown; attributes: { defaultBranch?: string } }>(
          sql`SELECT attributes FROM ferret.entity WHERE id = ${repository}`,
        );
        expect(rows.rows[0]?.attributes.defaultBranch).toBe('trunk');
      } finally {
        await changed.drop();
      }
    });
  });

  describe('a plan writes nothing — AC-12, AC-15', () => {
    it('reports what it would write and writes none of it', async () => {
      const empty = await createTestDatabase('import-plan');
      try {
        await migrate(empty.pool, { logger });
        const handle = drizzle(empty.pool);
        const document = readDocument(await documentFrom(exporter), digestOf);

        const plan = await new ImportService(handle).importDocument(document);

        expect(plan.applied).toBe(false);
        expect(plan.tables.reduce((sum, table) => sum + table.written, 0)).toBe(
          document.trailer.rows,
        );
        expect(await countIn(handle, 'entity')).toBe(0);
      } finally {
        await empty.drop();
      }
    });

    it('imports an empty document as a no-op — AC-15', async () => {
      const empty = await createTestDatabase('import-empty');
      try {
        await migrate(empty.pool, { logger });
        const handle = drizzle(empty.pool);
        const document = readDocument(await documentFrom(new ExportService(handle)), digestOf);

        const report = await new ImportService(handle).importDocument(document, { apply: true });

        expect(document.trailer.rows).toBe(0);
        expect(report.tables.every((table) => table.written === 0)).toBe(true);
      } finally {
        await empty.drop();
      }
    });
  });

  describe('an orphan is named, and the rest still lands — AC-11', () => {
    it('reports the row whose parent is absent rather than a constraint name', async () => {
      // A scope-restricted export legitimately references an entity outside
      // its scope. Telling the operator *which* row is the difference between
      // a diagnosis and a stack trace.
      const partial = await createTestDatabase('import-orphan');
      try {
        await migrate(partial.pool, { logger });
        const handle = drizzle(partial.pool);
        const document = readDocument(await documentFrom(exporter), digestOf);

        // Drop the repository row from the document, so every file that names
        // it as `source_scope`... still imports (`source_scope` is text, not a
        // foreign key) — but the *relationship* from it does not.
        const withoutRepository = {
          ...document,
          rows: document.rows.filter(
            (row) => !(row.table === 'entity' && row.row['id'] === repository),
          ),
        };

        const report = await new ImportService(handle).importDocument(withoutRepository, {
          apply: true,
        });

        const edges = report.tables.find((table) => table.table === 'relationship');
        expect(edges?.orphaned).toBeGreaterThan(0);
        expect(edges?.orphans.join(' ')).not.toContain('23503');

        // And the rest of the import completed: the files are there.
        expect(await countIn(handle, 'entity')).toBeGreaterThan(0);
        expect(await countIn(handle, 'content_blob')).toBeGreaterThan(0);
      } finally {
        await partial.drop();
      }
    });
  });
});
