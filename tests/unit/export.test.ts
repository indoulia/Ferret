import { describe, expect, it } from 'vitest';

import {
  EXPORT_TABLES,
  ExportService,
  backupCommandFor,
  isExportManifest,
  isExportTrailer,
  readExportDocument,
  type FerretDatabase,
} from '../../src/storage/index.js';

/**
 * EPIC-089's format, without a database.
 *
 * The manifest, the trailer, the digest and the reader are decided by the
 * writer alone. The anti-joins and the scope closure are
 * `tests/integration/storage/export.test.ts`.
 */

interface FakeRow {
  readonly [column: string]: unknown;
}

/**
 * A database that answers one page per table, in `EXPORT_TABLES` order.
 *
 * Positional rather than matching on the SQL: a fake that inspected the
 * statement would be asserting how the query is *spelled*, and the property
 * under test is the document. The service issues one query per table and stops
 * when a page comes back shorter than the batch, so the Nth call is the Nth
 * table — which is exactly the pagination contract worth pinning.
 *
 * Only valid for an unscoped export; a scope issues closure queries first, and
 * those are integration-tested against a real graph.
 */
function fakeDatabase(tables: Readonly<Record<string, readonly FakeRow[]>>): FerretDatabase {
  let call = 0;
  const reader = {
    execute: () => {
      const spec = EXPORT_TABLES[call];
      call += 1;
      return Promise.resolve({ rows: spec === undefined ? [] : (tables[spec.table] ?? []) });
    },
  };
  // §8.6a reads the whole document inside one transaction, so the fake has to
  // hand out a reader — which also pins the requested isolation, since
  // `read committed` would defeat the point.
  return {
    ...reader,
    transaction: (run: (tx: unknown) => Promise<unknown>, options?: { isolationLevel?: string }) => {
      expect(options?.isolationLevel).toBe('repeatable read');
      return run(reader);
    },
  } as unknown as FerretDatabase;
}

async function collect(service: ExportService, scope?: string): Promise<string[]> {
  const lines: string[] = [];
  await service.exportDocument((line) => {
    lines.push(line);
  }, scope === undefined ? {} : { scope });
  return lines;
}

describe('the document is a manifest, rows and a trailer — AC-1, AC-2, AC-11', () => {
  it('writes the manifest first and the trailer last', async () => {
    const service = new ExportService(
      fakeDatabase({ entity: [{ id: 'e1', kind: 'file' }], relationship: [{ id: 'r1' }] }),
    );

    const lines = await collect(service);

    expect(isExportManifest(JSON.parse(lines[0] ?? '{}'))).toBe(true);
    expect(isExportTrailer(JSON.parse(lines[lines.length - 1] ?? '{}'))).toBe(true);
  });

  it('names the versions in the manifest and the counts in the trailer — AC-2', async () => {
    const service = new ExportService(fakeDatabase({ entity: [{ id: 'e1' }, { id: 'e2' }] }));

    const document = readExportDocument((await collect(service)).join('\n'));

    expect(document.manifest?.ferretVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(document.manifest?.entitySchemaVersion).toBeGreaterThan(0);
    expect(document.manifest?.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(document.trailer?.counts['entity']).toBe(2);
    expect(document.trailer?.rows).toBe(2);
    expect(document.trailer?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exports an empty index as a valid document — AC-11', async () => {
    const service = new ExportService(fakeDatabase({}));

    const lines = await collect(service);
    const document = readExportDocument(lines.join('\n'));

    // Manifest and trailer, and nothing between them.
    expect(lines).toHaveLength(2);
    expect(document.rows).toStrictEqual([]);
    expect(document.trailer?.rows).toBe(0);
    // Every table is named with a zero rather than omitted: "this table was
    // exported and was empty" is a different fact from "this table was not
    // exported", and only the first is safe for an importer to assume.
    expect(Object.keys(document.trailer?.counts ?? {}).sort()).toStrictEqual(
      EXPORT_TABLES.map((spec) => spec.table).sort(),
    );
  });

  it('names the tables in dependency order, so an importer can stream', () => {
    const order = EXPORT_TABLES.map((spec) => spec.table);

    expect(order.indexOf('entity')).toBeLessThan(order.indexOf('relationship'));
    expect(order.indexOf('entity')).toBeLessThan(order.indexOf('evidence'));
    expect(order.indexOf('evidence')).toBeLessThan(order.indexOf('evidence_derivation'));
  });

  it('gives every table a unique ordering key, or pagination would loop', () => {
    // The keyset predicate is `(key) > (last)`. A non-unique key would return
    // the same page for ever, so this is the invariant the loop depends on.
    for (const spec of EXPORT_TABLES) {
      expect(spec.key.length, `${spec.table} has no ordering key`).toBeGreaterThan(0);
    }
  });
});

describe('the digest, and what it is sensitive to — AC-10, AC-16', () => {
  it('recomputes to the trailer value over the rows alone', async () => {
    const service = new ExportService(fakeDatabase({ entity: [{ id: 'e1', kind: 'file' }] }));

    const document = readExportDocument((await collect(service)).join('\n'));

    expect(document.digest).toBe(document.trailer?.digest);
  });

  it('changes when a row changes', async () => {
    const first = readExportDocument(
      (await collect(new ExportService(fakeDatabase({ entity: [{ id: 'e1', kind: 'file' }] })))).join('\n'),
    );
    const second = readExportDocument(
      (await collect(new ExportService(fakeDatabase({ entity: [{ id: 'e1', kind: 'commit' }] })))).join('\n'),
    );

    expect(second.digest).not.toBe(first.digest);
  });

  it('does not change when only the manifest does', async () => {
    // The manifest carries an instant, so two exports of identical rows have
    // different first lines. The digest covers the rows, which is what makes it
    // comparable across two exports of the same index.
    const rows = { entity: [{ id: 'e1', kind: 'file' }] };
    const first = readExportDocument((await collect(new ExportService(fakeDatabase(rows)))).join('\n'));
    const second = readExportDocument((await collect(new ExportService(fakeDatabase(rows)))).join('\n'));

    expect(second.manifest?.exportedAt).toBeDefined();
    expect(second.digest).toBe(first.digest);
  });

  it('reads a truncated document as having no trailer — AC-16', async () => {
    const lines = await collect(new ExportService(fakeDatabase({ entity: [{ id: 'e1' }] })));

    const truncated = readExportDocument(lines.slice(0, -1).join('\n'));

    expect(truncated.manifest).toBeDefined();
    expect(truncated.trailer).toBeUndefined();
    // And the rows that did arrive are still readable, which is what makes the
    // absence diagnosable rather than fatal.
    expect(truncated.rows).toHaveLength(1);
  });

  it('reads a document that is only a manifest as having no trailer', () => {
    const document = readExportDocument('{"kind":"ferret-export","format":1}');

    expect(document.manifest).toBeDefined();
    expect(document.trailer).toBeUndefined();
    expect(document.rows).toStrictEqual([]);
  });
});

describe('the export is streamed, not assembled — AC-12', () => {
  it('writes each row before reading the next page', async () => {
    // §8.6. The property is interleaving: a row reaches the sink before the
    // query for the page after it is issued. An implementation that collected
    // every row and wrote at the end would pass every other test in this file
    // and fail on an index larger than memory, which is the case this Epic
    // exists for.
    const order: string[] = [];
    let served = 0;

    const reader = {
      execute: () => {
        order.push('query');
        served += 1;
        // Two single-row pages of `entity`, then nothing.
        return Promise.resolve({ rows: served <= 2 ? [{ id: `e${String(served)}` }] : [] });
      },
    };
    const paged = {
      ...reader,
      transaction: (run: (tx: unknown) => Promise<unknown>) => run(reader),
    } as unknown as FerretDatabase;

    await new ExportService(paged).exportDocument(
      (line) => {
        order.push(line.includes('"table":"entity"') ? 'row' : 'boundary');
      },
      { batch: 1 },
    );

    // manifest, then query/row alternating — never query, query, row, row.
    expect(order.slice(0, 5)).toStrictEqual(['boundary', 'query', 'row', 'query', 'row']);
  });

  it('holds no row array across pages', async () => {
    // The generator yields; nothing accumulates. Asserted through the source
    // because a memory measurement in a unit test is a flake waiting to happen.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/storage/export.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain('AsyncGenerator');
    expect(source).toContain('yield');
  });
});

describe('a backup is pg_dump, and Ferret does not wrap it — AC-14, AC-15', () => {
  it('names the command with the schema Ferret owns', () => {
    const command = backupCommandFor('postgres://localhost/ferret');

    expect(command).toContain('pg_dump');
    expect(command).toContain('--schema=ferret');
    expect(command).toContain('postgres://localhost/ferret');
  });

  it('names the environment variable when no URL is configured', () => {
    expect(backupCommandFor(undefined)).toContain('$FERRET_DATABASE_URL');
  });

  it('spawns no process — the command is printed, not run', async () => {
    // §8.1 and Governance §5: the right amount of backup code to write is none.
    // A wrapper would add a version-matching failure mode and subtract nothing.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/storage/export.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn');
    expect(source).not.toContain('pg_restore');
  });
});

describe('a manifest from another build is refusable — AC-2', () => {
  it('rejects a document that is not a Ferret export', () => {
    expect(isExportManifest({ kind: 'something-else', format: 1 })).toBe(false);
    expect(isExportManifest({ kind: 'ferret-export', format: 2 })).toBe(false);
    expect(isExportManifest(null)).toBe(false);
    expect(isExportManifest('ferret-export')).toBe(false);
  });

  it('rejects a trailer that is not one', () => {
    expect(isExportTrailer({ kind: 'ferret-export' })).toBe(false);
    expect(isExportTrailer(undefined)).toBe(false);
  });
});
