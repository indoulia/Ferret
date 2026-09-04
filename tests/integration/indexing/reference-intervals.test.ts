import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import {
  Direction,
  PUBLIC_ACCESS,
  ParserFramework,
  ProviderRegistry,
  RepositoryIndexer,
  createNullLogger,
  type DiscoveredRepository,
  type IndexReport,
  type IndexerDependencies,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { discoverProviders } from '../../../src/providers/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  MigrationPolicy,
  RelationshipStore,
  RetrievalStore,
  SymbolStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  FERRET_PARSERS_MODULE,
  loadFerretParsers,
} from '../../../src/cli/commands/parser-composition.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * **One call site is one open interval, and a call that is gone is closed — F-25b.**
 * **What Ferret could not resolve survives the run that measured it — F-27.**
 *
 * F-25b: `#findOpenEquivalent` matches on byte-identical metadata, and the
 * reference edge carried `line`. So moving a call down a file opened a *second*
 * open interval for the same edge rather than recognising the first — measured
 * live as two rows for `checkAll` at lines 408 and 412, both `validTo: null`,
 * from two index runs. And nothing ever ended a content edge: the indexer only
 * asserts, and the sole `retire` caller in `src/` is the entity lifecycle sweep.
 * A call deleted from a file therefore stayed in the graph for ever.
 *
 * F-27: `UnresolvedReference[]` was aggregated into counters and a
 * `logger.debug` line and then dropped — nothing written against the symbol, the
 * file or the run. "Nothing references this" and "we refused to resolve most of
 * the references" were the same answer, which is what makes a dead-code or
 * impact answer dangerous rather than merely incomplete.
 *
 * Against a real PostgreSQL, real `git` and the real grammars, because both are
 * properties of what is *persisted across runs* — a fake store would agree with
 * the code rather than with the database, which is how the duplicate intervals
 * survived their unit tests.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeIndex = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[Batch 7] SKIPPING reference intervals: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let registry: ProviderRegistry;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('batch7ref');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-refint-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();

  registry = new ProviderRegistry();
  await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);
}, 120_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

interface Fixture {
  path: string;
  discovered: DiscoveredRepository;
}

async function repository(name: string): Promise<Fixture> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, name, { origin: `https://github.com/indoulia/${name}.git` });
  return { path, discovered: await provider.describeRepository(path, context) };
}

async function commit(fixture: Fixture, path: string, body: string): Promise<void> {
  await mkdir(dirname(join(fixture.path, path)), { recursive: true });
  await writeFile(join(fixture.path, path), body, 'utf8');
  await git(fixture.path, ['add', path]);
  await git(fixture.path, ['commit', '-m', `write ${path}`]);
}

function dependencies(): IndexerDependencies {
  const compatibility = new CompatibilityService(handle, database.pool);
  return {
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: compatibility,
    lifecycle: new IndexLifecycleStore(handle),
    content: provider,
    symbols: new SymbolStore(handle),
    parser: new ParserFramework({ registry }),
    artifacts: compatibility,
  };
}

async function index(fixture: Fixture): Promise<IndexReport> {
  return new RepositoryIndexer(dependencies()).index(fixture.discovered, { withContent: true }, context);
}

/** Reference edges, with their interval state — the rows F-25b is about. */
async function referenceEdges(
  repositoryId: string,
): Promise<readonly { type: string; open: boolean; metadata: Record<string, unknown> }[]> {
  const rows = await handle.execute<{ type: string; valid_to: string | null; metadata: Record<string, unknown> }>(sql`
    SELECT r.type, r.valid_to, r.metadata
      FROM "ferret"."relationship" r
      JOIN "ferret"."entity" e ON e.id = r.from_id
     WHERE r.type IN ('symbol_references_symbol', 'file_references_symbol')
       AND (e.source_scope = ${repositoryId} OR e.source_scope LIKE ${`${repositoryId}:%`})
     ORDER BY r.type, r.valid_from
  `);
  return rows.rows.map((row) => ({
    type: row.type,
    open: row.valid_to === null,
    metadata: row.metadata,
  }));
}

async function fileAttributes(repositoryId: string, path: string): Promise<Record<string, unknown>> {
  const rows = await handle.execute<{ attributes: Record<string, unknown> }>(sql`
    SELECT attributes FROM "ferret"."entity"
     WHERE kind = 'file' AND source_scope = ${repositoryId} AND attributes->>'path' = ${path}
     LIMIT 1
  `);
  return rows.rows[0]?.attributes ?? {};
}

/**
 * A file with one resolvable call and one that is not.
 *
 * `helper()` is a bare call to a declaration in the same file — the edge.
 * `values.map(...)` is a member call on a receiver whose type Ferret does not
 * know — the unresolved one. `blank` exists only to move `use` down the file.
 */
function source(blankLines: number, includeCall = true): string {
  return `export function helper(n: number): number {
  return n + 1;
}
${'\n'.repeat(blankLines)}export function use(values: readonly number[]): number {
  const doubled = values.map((v) => v * 2);
${includeCall ? '  return helper(doubled.length);' : '  return doubled.length;'}
}
`;
}

describeIndex('a reference edge across two runs — F-25b', () => {
  it('opens one interval when a call moves to a different line', async () => {
    const fixture = await repository('moved-call');
    await commit(fixture, 'src/mod.ts', source(0));
    const first = await index(fixture);
    const repositoryId = first.repositoryId;

    const afterFirst = await referenceEdges(repositoryId);
    expect(afterFirst.filter((edge) => edge.open), 'the first run wrote no reference edge').not.toStrictEqual([]);

    // The same call, four lines further down. Nothing about the *fact* changed:
    // `use` still references `helper`.
    await commit(fixture, 'src/mod.ts', source(4));
    await index(fixture);

    const afterSecond = await referenceEdges(repositoryId);
    const open = afterSecond.filter((edge) => edge.open);

    expect(open, 'moving a call opened a second interval for the same fact').toHaveLength(
      afterFirst.filter((edge) => edge.open).length,
    );
  }, 180_000);

  it('does not put a line number in the edge’s identity', async () => {
    // The mechanism, stated separately from its symptom. The call site's line
    // is evidence — one row per call site, with a `line` locator — and putting
    // it in edge metadata made an edge's identity depend on where in the file it
    // happened to be written.
    const fixture = await repository('edge-metadata');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);

    for (const edge of await referenceEdges(report.repositoryId)) {
      expect(Object.keys(edge.metadata), 'the call site line is part of the edge').not.toContain('line');
      // What the edge legitimately carries: which rule concluded it, and what
      // was named. A caller reading a call graph needs both.
      expect(Object.keys(edge.metadata)).toContain('rule');
      expect(Object.keys(edge.metadata)).toContain('name');
    }
  }, 180_000);

  it('closes the interval when the call is deleted', async () => {
    // Nothing ever ended a content edge, so a call removed from a file stayed
    // in the graph for ever and every impact answer kept asserting it.
    const fixture = await repository('deleted-call');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);
    expect((await referenceEdges(report.repositoryId)).filter((edge) => edge.open).length).toBeGreaterThan(0);

    await commit(fixture, 'src/mod.ts', source(0, false));
    await index(fixture);

    const edges = await referenceEdges(report.repositoryId);
    expect(edges.filter((edge) => edge.open), 'a deleted call is still asserted').toStrictEqual([]);
    // A tombstone, not a delete: "when did this stop being true" stays
    // answerable.
    expect(edges.length, 'the retired edge was deleted rather than closed').toBeGreaterThan(0);
  }, 180_000);

  it('leaves an unchanged file’s edges exactly as they were — the control', async () => {
    // A retire pass that closed edges it should not is the worse failure, and
    // it would be invisible in the two assertions above.
    const fixture = await repository('unchanged');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);
    const before = await referenceEdges(report.repositoryId);

    await index(fixture);

    expect(await referenceEdges(report.repositoryId)).toStrictEqual(before);
  }, 180_000);
});

describeIndex('what could not be resolved is written down — F-27', () => {
  it('records the file’s resolution counts, rather than logging and dropping them', async () => {
    const fixture = await repository('unresolved');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);

    const attributes = await fileAttributes(report.repositoryId, 'src/mod.ts');
    const resolution = attributes['referenceResolution'] as
      | { extracted?: number; resolved?: number; unresolved?: Record<string, number> }
      | undefined;

    expect(resolution, 'the unresolved count was computed and thrown away').toBeDefined();
    expect(resolution?.extracted ?? 0).toBeGreaterThan(0);
    // `values.map(...)` cannot resolve: the receiver's type is unknown. The
    // count of what Ferret refused is the number EPIC-035 §12 says matters.
    const unresolved = Object.values(resolution?.unresolved ?? {}).reduce((sum, n) => sum + n, 0);
    expect(unresolved, 'a file with an unresolvable member call reported none').toBeGreaterThan(0);
    expect((resolution?.resolved ?? 0) + unresolved).toBe(resolution?.extracted);
  }, 180_000);

  it('survives a gate skip, so a second run still writes no rows', async () => {
    // Found by re-auditing the fix rather than by the finding. The counts are
    // written onto the `file` entity, and a second run over unchanged content
    // *skips the parse at the gate* — so the entity is re-emitted with no
    // counts, the upsert reports `updated`, and EPIC-108 AC-6's "a second run
    // writes no rows" is false for exactly the files the gate exists to make
    // free. The same trap `structure` already documents, one attribute later.
    const fixture = await repository('gate-replay');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);
    const first = await fileAttributes(report.repositoryId, 'src/mod.ts');

    const second = await index(fixture);

    expect(second.filesRead).toBeGreaterThan(0);
    const after = await fileAttributes(report.repositoryId, 'src/mod.ts');
    expect(after['referenceResolution'], 'the gate skip stripped the counts').toStrictEqual(
      first['referenceResolution'],
    );
    expect(after).toStrictEqual(first);
  }, 180_000);

  it('names the reasons, so "refused" and "not there" stay apart', async () => {
    const fixture = await repository('reasons');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);

    const attributes = await fileAttributes(report.repositoryId, 'src/mod.ts');
    const resolution = attributes['referenceResolution'] as { unresolved?: Record<string, number> } | undefined;

    // `receiver-unknown` is a refusal Ferret can explain; `not-found` is an
    // absence. Collapsing them into one number is what made the answer
    // dangerous.
    expect(Object.keys(resolution?.unresolved ?? {})).toContain('receiver-unknown');
  }, 180_000);
});

/**
 * **And what was written down reaches the reader — F-27's read half.**
 *
 * Batch 7 persisted the counts and stopped. Nothing under `src/mcp/`,
 * `src/retrieval/` or `src/context/` mentioned `referenceResolution`, so the
 * tool surface answered a reference question with `truncated: false` and
 * `withheld: 0` — an affirmative claim to be whole — over a graph Ferret had
 * refused to finish resolving. Persisting a measurement nobody reads leaves the
 * dangerous answer exactly as dangerous.
 *
 * Against the real store rather than the fake, because the aggregate is a query:
 * the reasons live in a nested JSONB object across many `file` rows, and a fake
 * would agree with this code rather than with PostgreSQL.
 */
describeIndex('an incomplete reference answer says so — F-27, the read half', () => {
  /** The `file` entity for a path — an end of `file_references_symbol`. */
  async function fileId(repositoryId: string, path: string): Promise<string> {
    const rows = await handle.execute<{ id: string }>(sql`
      SELECT id FROM "ferret"."entity"
       WHERE kind = 'file' AND source_scope = ${repositoryId} AND attributes->>'path' = ${path}
       LIMIT 1
    `);
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error(`no file entity for ${path} was indexed`);
    return id;
  }

  /** The `code_symbol` a "who references this" question would be asked about. */
  async function symbolId(repositoryId: string, name: string): Promise<string> {
    const rows = await handle.execute<{ id: string }>(sql`
      SELECT id FROM "ferret"."entity"
       WHERE kind = 'code_symbol'
         AND attributes->>'name' = ${name}
         AND (source_scope = ${repositoryId} OR source_scope LIKE ${`${repositoryId}:%`})
       LIMIT 1
    `);
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error(`no code_symbol named ${name} was indexed`);
    return id;
  }

  it('does not report an inbound reference list as complete when references were refused', async () => {
    const fixture = await repository('read-half');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);

    const retrieval = new RetrievalStore(handle);
    const answer = await retrieval.neighbours(
      {
        from: await symbolId(report.repositoryId, 'helper'),
        direction: Direction.IN,
        types: ['symbol_references_symbol', 'file_references_symbol'],
        limit: 20,
      },
      PUBLIC_ACCESS,
    );

    // The three fields that used to be the whole answer still say what they
    // always said, and on their own they still read as "this is complete".
    expect(answer.more, 'the bound did not cut this hop').toBe(false);
    expect(answer.withheld.total, 'nothing was withheld from this caller').toBe(0);

    expect(answer.references, 'a reference answer carried no completeness at all').toBeDefined();
    expect(answer.references?.completeness).toBe('incomplete');
    // `values.map(...)` — a member call whose receiver's type Ferret does not
    // know. It is a refusal over candidates Ferret holds, so it could have been
    // an edge here, and that is what makes the answer short rather than empty.
    expect(answer.references?.unresolved.refused ?? 0).toBeGreaterThan(0);
    expect(Object.keys(answer.references?.unresolved.byReason ?? {})).toContain('receiver-unknown');
    expect(answer.references?.filesMeasured ?? 0).toBeGreaterThan(0);
  }, 180_000);

  it('leaves a question that is not about references unqualified — the control', async () => {
    // A commit's neighbours have no reference graph to be short of, and a
    // verdict attached to every traversal is one a reader stops seeing. F-66
    // was that lesson and it is not being re-learned.
    const fixture = await repository('not-references');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);

    const retrieval = new RetrievalStore(handle);
    const answer = await retrieval.neighbours(
      { from: report.repositoryId, types: ['repository_contains_file'], limit: 20 },
      PUBLIC_ACCESS,
    );

    expect(answer.references, 'a containment question was given a resolution verdict').toBeUndefined();
  }, 180_000);

  it('counts the same answer the same way twice — a second run adds nothing', async () => {
    // The counts are replayed through the gate on an unchanged second run
    // (AC-6), so an aggregate that double-counted a replayed file would drift
    // upwards on every index. Idempotency of the *read*, over the idempotency
    // Batch 7 established for the write.
    const fixture = await repository('read-idempotent');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await index(fixture);
    const retrieval = new RetrievalStore(handle);
    const query = {
      from: await symbolId(report.repositoryId, 'helper'),
      direction: Direction.IN,
      types: ['symbol_references_symbol', 'file_references_symbol'],
      limit: 20,
    };

    const first = await retrieval.neighbours(query, PUBLIC_ACCESS);
    await index(fixture);
    const second = await retrieval.neighbours(query, PUBLIC_ACCESS);

    expect(second.references).toStrictEqual(first.references);
  }, 180_000);

  it('reports unknown, not complete, when no file recorded a count', async () => {
    // An index whose content stage never ran has earned no verdict. Reporting
    // `complete` for it would be the same false assurance one layer along.
    const fixture = await repository('no-content');
    await commit(fixture, 'src/mod.ts', source(0));
    const report = await new RepositoryIndexer(dependencies()).index(
      fixture.discovered,
      { withContent: false },
      context,
    );

    // Asked of the `file` itself, because a file is an end of
    // `file_references_symbol` and a repository is an end of nothing — the
    // narrowing that keeps this verdict off traversals it has no bearing on.
    const retrieval = new RetrievalStore(handle);
    const answer = await retrieval.neighbours(
      { from: await fileId(report.repositoryId, 'src/mod.ts'), limit: 20 },
      PUBLIC_ACCESS,
    );

    expect(answer.references?.completeness).toBe('unknown');
    expect(answer.references?.filesMeasured).toBe(0);
  }, 180_000);
});
