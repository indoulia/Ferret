import { createHash } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, createNullLogger } from '../../../src/index.js';
import {
  ContentStore,
  EntityStore,
  ExportService,
  ImportService,
  migrate,
  readDocument,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * A backup has to come back — F-17, F-29.
 *
 * EPIC-089 writes a document and EPIC-090 reads it, and between them sits the
 * only promise that matters: what was exported can be restored. Two ways that
 * promise was broken, both of which a passing round-trip test over ordinary
 * rows cannot see.
 *
 * **A document the writer calls successful and the reader calls damaged.**
 * Export ran a redactor over each assembled JSON *line*. That redactor fails
 * closed on size, replacing its whole input with a sentence — so a large enough
 * row stopped being JSON, the digest was computed over the replacement and
 * verified, and the restore failed on a document whose own trailer said it was
 * intact. Discovered during a restore, which is when the original is gone.
 *
 * **A document that writes SQL.** Column names arrived from the document and
 * were interpolated into the statement as quoted identifiers, with no escaping
 * and no check that the schema has such a column. EPIC-090 §11 says every row
 * is validated the way an observation is; it was not.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/**
 * U+0001 — a character with no short JSON escape.
 *
 * `JSON.stringify` writes it as `\\u0001`: six characters for one stored byte,
 * where a tab costs two. That ratio is what puts a serialized row past a scan
 * limit the stored value is nowhere near.
 */
const CONTROL = '\u0001';

let source: TestDatabase;
let target: TestDatabase;
let from: FerretDatabase;
let into: FerretDatabase;

/** The digest `readDocument` checks the trailer against, as `ferret import` computes it. */
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

describeDb(`backup fidelity (${databaseAvailable() ? 'two real PostgreSQL databases' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    source = await createTestDatabase('backup-src');
    target = await createTestDatabase('backup-dst');
    await migrate(source.pool, { logger });
    await migrate(target.pool, { logger });
    from = drizzle(source.pool);
    into = drizzle(target.pool);

    const entities = new EntityStore(from);
    const repository = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/backup' },
        attributes: { path: '/backup' },
      })
    ).entity.id;
    const file = await entities.upsert({
      kind: EntityKind.FILE,
      source: { system: 'git', id: 'src/big.txt', scope: repository },
      attributes: { path: 'src/big.txt' },
    });
    void file;

    // A text file of U+0001. It has no short JSON escape — unlike a tab, which
    // costs two characters — so each byte stored costs six characters
    // serialized, and a body well inside every storage bound produces a JSON
    // line past the redactor's one-million-character scan limit. Nothing here
    // is exotic: a vendored binary-ish data file classified as text does it.
    const body = Buffer.from(CONTROL.repeat(200_000), 'utf8');
    await new ContentStore(from).store({
      contentHash: 'sha256:tabs',
      bytes: body,
      mediaType: 'text/plain',
      encoding: 'utf-8',
    });
  }, 180_000);

  afterAll(async () => {
    await source.drop();
    await target.drop();
  });

  it('writes a document the reader accepts, however large a row serializes — F-17', async () => {
    const document = await documentFrom(new ExportService(from));

    // The failure this reproduces is not "the import rejected a row": it is that
    // export reported success on a document that is not readable at all. Read it
    // the way `ferret import` does.
    const checked = readDocument(document, digestOf);
    const report = await new ImportService(into).importDocument(checked, { apply: true });

    const blobs = report.tables.find((table) => table.table === 'content_blob');
    expect({
      failures: report.tables.filter((table) => table.failure !== undefined).map((table) => table.table),
      blobsWritten: blobs?.written,
      storedInTarget: await countIn(into, 'content_blob'),
    }).toStrictEqual({ failures: [], blobsWritten: 1, storedInTarget: 1 });
  }, 180_000);

  it('restores the bytes it exported, rather than a sentence about them — F-17', async () => {
    const rows = await into.execute<{ [column: string]: unknown; text_content: string | null }>(
      sql`SELECT text_content FROM ferret.content_blob WHERE content_hash = 'sha256:tabs'`,
    );

    expect(rows.rows[0]?.text_content).toBe(CONTROL.repeat(200_000));
  }, 180_000);

  it('refuses a document naming a column the schema does not have — F-29', async () => {
    // The identifier quoting is what a crafted column name breaks out of. The
    // requirement is not "escape it better": it is that a document may not name
    // a column the target's own catalogue does not know.
    const hostile = [
      JSON.stringify({
        kind: 'ferret-export',
        format: 1,
        ferretVersion: '0.1.0',
        entitySchemaVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: ['entity'],
      }),
      JSON.stringify({
        table: 'entity',
        row: {
          id: '00000000-0000-4000-8000-0000000000ff',
          kind: 'repository',
          'id") VALUES (\'x\'); CREATE TABLE ferret.pwned(x int); --': 'ignored',
        },
      }),
    ];
    const digest = digestOf(hostile.slice(1));
    const document = `${[
      ...hostile,
      JSON.stringify({ kind: 'ferret-export-trailer', counts: { entity: 1 }, rows: 1, digest }),
    ].join('\n')}\n`;

    const importer = new ImportService(into);
    const checked = readDocument(document, digestOf);
    const report = await importer.importDocument(checked, { apply: true });

    const injected = await into.execute<{ [column: string]: unknown; present: string | null }>(
      sql`SELECT to_regclass('ferret.pwned')::text AS present`,
    );
    const failure = report.tables.find((table) => table.table === 'entity')?.failure ?? '';
    // "Something failed" is not the requirement, and asserting it would pass
    // against the defect: interpolating the crafted name produced a PostgreSQL
    // syntax error, which the report carries as a failure too. What must be
    // true is that Ferret refused the column before building a statement from
    // it, and said which column.
    expect({
      refusedByFerret: /column/i.test(failure) && !/syntax error/i.test(failure),
      written: report.tables.find((table) => table.table === 'entity')?.written,
      injectedObject: injected.rows[0]?.present ?? null,
    }).toStrictEqual({ refusedByFerret: true, written: 0, injectedObject: null });
  }, 180_000);
});
