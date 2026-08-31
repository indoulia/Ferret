import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CodeSymbolKind,
  buildCodeSymbols,
  createNullLogger,
  type CodeSymbol,
  type ContentSpan,
  type OutlineNode,
} from '../../../src/index.js';
import { SymbolStore, escapeLikePrefix, migrate, type FerretDatabase } from '../../../src/storage/index.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * EPIC-034 — the symbols a file declares, made findable.
 *
 * Against a real PostgreSQL, because the two things this Epic claims cannot be
 * shown against a mock: that reconciliation retires exactly what a file stopped
 * declaring and nothing else, and that every lookup uses an index rather than
 * scanning the entity table.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const SCOPE = 'repo-alpha';

let db: TestDatabase;
let handle: FerretDatabase;
let store: SymbolStore;

function span(startLine: number): ContentSpan {
  return { startByte: startLine * 100, endByte: startLine * 100 + 40, startLine, endLine: startLine + 2 };
}

function outline(title: string, kind: string, at: ContentSpan, children: readonly OutlineNode[] = []): OutlineNode {
  return { title, kind, span: at, children };
}

function symbolsFor(path: string, nodes: readonly OutlineNode[]): readonly CodeSymbol[] {
  return buildCodeSymbols({ segments: [], outline: nodes }, { path, scope: SCOPE });
}

/** Whether a query plan reads the entity table sequentially. */
async function scansSequentially(query: ReturnType<typeof sql>): Promise<boolean> {
  const plan = await handle.execute<{ 'QUERY PLAN': string }>(sql`EXPLAIN ${query}`);
  const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
  return /Seq Scan on entity/i.test(text);
}

describeDb(`symbol index (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('symbols');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    store = new SymbolStore(handle);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('stores a file’s symbols and reads them back — AC-1', async () => {
    const path = 'src/shapes.ts';
    const symbols = symbolsFor(path, [
      outline('add', 'function', span(1)),
      outline('Box', 'class', span(10), [outline('width', 'method', span(11))]),
    ]);

    const report = await store.indexFileSymbols({ scope: SCOPE, path }, symbols);
    expect(report).toMatchObject({ path, created: 3, updated: 0, unchanged: 0, tombstoned: 0, reinstated: 0 });

    const found = await store.findSymbols({ scope: SCOPE, path });
    expect(found.map((symbol) => symbol.qualifiedName)).toStrictEqual(['add', 'Box', 'Box.width']);
    expect(found[1]).toMatchObject({ kind: CodeSymbolKind.CLASS, path, lifecycle: 'active' });
  });

  it('changes nothing when the file is re-indexed unchanged — AC-2', async () => {
    const path = 'src/stable.ts';
    const symbols = symbolsFor(path, [outline('same', 'function', span(3))]);

    await store.indexFileSymbols({ scope: SCOPE, path }, symbols);
    const second = await store.indexFileSymbols({ scope: SCOPE, path }, symbols);

    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1, tombstoned: 0, reinstated: 0 });
  });

  it('tombstones a symbol the file no longer declares — AC-3', async () => {
    const path = 'src/shrinking.ts';
    await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(path, [outline('kept', 'function', span(1)), outline('removed', 'function', span(5))]),
    );

    const report = await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(path, [outline('kept', 'function', span(1))]),
    );

    expect(report.tombstoned).toBe(1);
    expect((await store.findSymbols({ scope: SCOPE, path })).map((s) => s.name)).toStrictEqual(['kept']);

    // Retained, not deleted: "when did this disappear, and what did it look
    // like" is a question EPIC-032 exists to keep answerable.
    const withDeleted = await store.findSymbols({ scope: SCOPE, path, includeDeleted: true });
    expect(withDeleted.find((symbol) => symbol.name === 'removed')?.lifecycle).toBe('deleted');
  });

  it('reinstates a symbol that comes back — AC-4', async () => {
    const path = 'src/returning.ts';
    const both = symbolsFor(path, [outline('a', 'function', span(1)), outline('b', 'function', span(5))]);
    const onlyA = symbolsFor(path, [outline('a', 'function', span(1))]);

    await store.indexFileSymbols({ scope: SCOPE, path }, both);
    await store.indexFileSymbols({ scope: SCOPE, path }, onlyA);
    const back = await store.indexFileSymbols({ scope: SCOPE, path }, both);

    // The restored symbol is byte-identical, so the upsert reports it
    // unchanged; reconciliation is what lifts the tombstone.
    expect(back).toMatchObject({ tombstoned: 0, reinstated: 1, unchanged: 2 });
    expect((await store.findSymbols({ scope: SCOPE, path })).map((s) => s.name)).toStrictEqual(['a', 'b']);
  });

  it('confines reconciliation to the file it indexed — AC-5', async () => {
    const first = 'src/one.ts';
    const second = 'src/two.ts';
    await store.indexFileSymbols({ scope: SCOPE, path: first }, symbolsFor(first, [outline('alpha', 'function', span(1))]));
    await store.indexFileSymbols({ scope: SCOPE, path: second }, symbolsFor(second, [outline('beta', 'function', span(1))]));

    // The second file is re-indexed as empty. The first must be untouched:
    // reconciling wider would retire symbols in files this run never read.
    const report = await store.indexFileSymbols({ scope: SCOPE, path: second }, []);

    expect(report.tombstoned).toBe(1);
    expect((await store.findSymbols({ scope: SCOPE, path: first })).map((s) => s.name)).toStrictEqual(['alpha']);
  });

  it('finds every declaration of a name across files, in a stable order — AC-6', async () => {
    for (const path of ['src/zeta.ts', 'src/alpha.ts']) {
      await store.indexFileSymbols({ scope: SCOPE, path }, symbolsFor(path, [outline('shared', 'function', span(7))]));
    }

    const first = await store.findSymbols({ name: 'shared' });
    const again = await store.findSymbols({ name: 'shared' });

    expect(first.map((symbol) => symbol.path)).toStrictEqual(['src/alpha.ts', 'src/zeta.ts']);
    expect(again).toStrictEqual(first);
  });

  it('filters by qualified name, by kind and by file, and combines them — AC-7', async () => {
    const path = 'src/filtering.ts';
    await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(path, [
        outline('Widget', 'class', span(1), [outline('render', 'method', span(2))]),
        outline('render', 'function', span(20)),
      ]),
    );

    expect((await store.findSymbols({ qualifiedName: 'Widget.render' })).map((s) => s.name)).toStrictEqual([
      'render',
    ]);
    expect((await store.findSymbols({ path, kind: CodeSymbolKind.CLASS })).map((s) => s.name)).toStrictEqual([
      'Widget',
    ]);
    // The same name, two kinds, one file: only the combination separates them.
    expect(
      (await store.findSymbols({ path, name: 'render', kind: CodeSymbolKind.FUNCTION })).map(
        (s) => s.qualifiedName,
      ),
    ).toStrictEqual(['render']);
  });

  it('matches a prefix at the start of a name and nowhere else — AC-8', async () => {
    const path = 'src/prefixes.ts';
    await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(path, [
        outline('resolveConfig', 'function', span(1)),
        outline('resolveSecrets', 'function', span(5)),
        outline('doResolve', 'function', span(9)),
      ]),
    );

    const found = await store.findSymbols({ path, namePrefix: 'resolve' });
    expect(found.map((symbol) => symbol.name).sort()).toStrictEqual(['resolveConfig', 'resolveSecrets']);
  });

  it('honours and bounds a limit — AC-9', async () => {
    const path = 'src/many.ts';
    await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(
        path,
        Array.from({ length: 10 }, (_, index) => outline(`f${String(index)}`, 'function', span(index + 1))),
      ),
    );

    expect(await store.findSymbols({ path, limit: 3 })).toHaveLength(3);
    // Above MAX_LIMIT the bound applies rather than the request.
    expect((await store.findSymbols({ path, limit: 100_000 })).length).toBeLessThanOrEqual(500);
  });

  it('treats SQL and LIKE metacharacters as literal text — AC-11', async () => {
    const path = "src/awkward'names.ts";
    const awkward = "weird'; DROP TABLE entity; --";
    const percent = 'pre%fix';
    await store.indexFileSymbols(
      { scope: SCOPE, path },
      symbolsFor(path, [
        outline(awkward, 'function', span(1)),
        outline(percent, 'function', span(5)),
        outline('preXfix', 'function', span(9)),
      ]),
    );

    expect((await store.findSymbols({ name: awkward })).map((s) => s.name)).toStrictEqual([awkward]);
    // `%` must match itself, not act as a wildcard — which would both return
    // the wrong rows and turn one lookup into a scan of the whole index.
    const prefixed = await store.findSymbols({ path, namePrefix: percent });
    expect(prefixed.map((symbol) => symbol.name)).toStrictEqual([percent]);

    // And the table is still there.
    const still = await handle.execute<{ n: string }>(sql`SELECT count(*) AS n FROM "ferret"."entity"`);
    expect(Number(still.rows[0]?.n ?? 0)).toBeGreaterThan(0);
  });

  it('escapes LIKE metacharacters', () => {
    expect(escapeLikePrefix('pre%fix_a\\b')).toBe('pre\\%fix\\_a\\\\b');
  });

  it.each([
    [
      'exact name',
      sql`SELECT id FROM "ferret"."entity" WHERE kind = 'code_symbol' AND attributes->>'name' = 'shared'`,
    ],
    [
      'qualified name',
      sql`SELECT id FROM "ferret"."entity" WHERE kind = 'code_symbol' AND attributes->>'qualifiedName' = 'Widget.render'`,
    ],
    [
      'file path',
      sql`SELECT id FROM "ferret"."entity" WHERE kind = 'code_symbol' AND attributes->>'path' = 'src/filtering.ts'`,
    ],
    [
      'name prefix',
      sql`SELECT id FROM "ferret"."entity" WHERE kind = 'code_symbol' AND attributes->>'name' LIKE 'resolve%'`,
    ],
  ])('uses an index for %s rather than scanning — AC-10', async (_label, query) => {
    // Asserted rather than assumed. A missing index is invisible on a fixture
    // of two hundred rows and unusable on a real repository, so the plan is
    // what is checked.
    await handle.execute(sql`SET LOCAL enable_seqscan = off`);
    expect(await scansSequentially(query)).toBe(false);
  });
});
