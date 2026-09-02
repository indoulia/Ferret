import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import {
  Confidence,
  ContentUnavailable,
  createMetricsRegistry,
  Direction,
  ErrorCode,
  FerretError,
  EvidenceMethod,
  FILE_DECLARES_SYMBOL,
  PUBLIC_ACCESS,
  ParserFramework,
  ProviderRegistry,
  RepositoryIndexer,
  ResolutionRule,
  SYMBOL_REFERENCES_SYMBOL,
  SourceAuthority,
  UnresolvedReason,
  createNullLogger,
  type ContentReader,
  type DiscoveredRepository,
  type IndexReport,
  type IndexableSource,
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
  IndexRunStore,
  MigrationPolicy,
  RelationshipStore,
  RetrievalStore,
  SymbolStore,
  UNRESTRICTED_READ,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import {
  FERRET_PARSERS_MODULE,
  loadFerretParsers,
} from '../../../src/cli/commands/parser-composition.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * EPIC-108 Phases 3 and 4, against a real PostgreSQL, a real `git` and the real
 * tree-sitter grammars.
 *
 * The criteria under test are properties of all three at once, which is why
 * they are proved here rather than against fakes: AC-5 is "symbols reach the
 * database and can be read back", AC-6 is "a second run writes no rows", and
 * AC-15 is the EPIC-034 defect — every symbol retired on every run because two
 * derivations of one id disagreed. A fake at any boundary would have agreed with
 * the code rather than with the database, which is exactly how that defect
 * survived its unit tests.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeContent = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-108] SKIPPING content indexing: ${
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
  database = await createTestDatabase('epic108');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-content-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();

  // Through discovery, exactly as `ferret index --content` composes it. Naming
  // the parser here instead would prove the pipeline and not the composition.
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
  const path = await createRepository(root, name, {
    origin: `https://github.com/indoulia/${name}.git`,
  });
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

/**
 * Indexes the way `ferret index` does: incremental, which is the default and the
 * mode AC-6 and EPIC-031 AC-2 are written about.
 *
 * Deliberately not `full: true`. A full run re-reads all history, and EPIC-020
 * emits a `file` entity per path it sees in a commit carrying only
 * `{ path, extension }` — which rewrites the richer attributes the content stage
 * puts on that same entity. The churn is confined to `--full --content` and is
 * recorded in EPIC-108 §18.4 rather than papered over here.
 */
async function index(fixture: Fixture, withContent = true): Promise<IndexReport> {
  return new RepositoryIndexer(dependencies()).index(fixture.discovered, { withContent }, context);
}

async function symbolsOf(repositoryId: string, path: string): Promise<readonly { name: string; lifecycle: string }[]> {
  const rows = await handle.execute<{ name: string; lifecycle: string }>(sql`
    SELECT attributes->>'name' AS name, lifecycle
      FROM "ferret"."entity"
     WHERE kind = 'code_symbol'
       AND source_scope = ${`${repositoryId}:${path}`}
     ORDER BY attributes->>'qualifiedName'
  `);
  return rows.rows.map((row) => ({ name: row.name, lifecycle: row.lifecycle }));
}

/**
 * The same rows with their ids — EPIC-035 needs the entity an edge points at.
 *
 * A second helper rather than widening `symbolsOf`, whose callers compare its
 * rows with `toStrictEqual` and would fail on an extra key. A test helper that
 * breaks its siblings to suit a new test is the wrong shape.
 */
async function symbolIdsOf(
  repositoryId: string,
  path: string,
): Promise<readonly { id: string; name: string }[]> {
  const rows = await handle.execute<{ id: string; name: string }>(sql`
    SELECT id, attributes->>'name' AS name
      FROM "ferret"."entity"
     WHERE kind = 'code_symbol'
       AND source_scope = ${`${repositoryId}:${path}`}
     ORDER BY attributes->>'qualifiedName'
  `);
  return rows.rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * Every content-derived row, as a comparable snapshot.
 *
 * The direct way to prove "a second run writes no rows" for the rows this Epic
 * owns. `IndexReport.entities.updated` cannot be used for it: an incremental
 * second run rewrites the *parent* commit entity as a stub, which happens with
 * content indexing off too and predates this Epic entirely — see §18.5. A
 * counter that includes that would fail for a reason AC-6 is not about.
 */
async function contentRows(repositoryId: string): Promise<string> {
  const rows = await handle.execute<{ id: string; kind: string; content_hash: string; lifecycle: string }>(sql`
    SELECT id, kind, content_hash, lifecycle
      FROM "ferret"."entity"
     WHERE kind IN ('file', 'file_version', 'code_symbol')
       AND (source_scope = ${repositoryId} OR source_scope LIKE ${`${repositoryId}:%`})
     ORDER BY kind, id
  `);
  return rows.rows.map((row) => `${row.kind} ${row.id} ${row.content_hash} ${row.lifecycle}`).join('|');
}

async function fileAttributes(repositoryId: string, path: string): Promise<Record<string, unknown>> {
  const rows = await handle.execute<{ attributes: Record<string, unknown> }>(sql`
    SELECT attributes FROM "ferret"."entity"
     WHERE kind = 'file' AND source_scope = ${repositoryId} AND attributes->>'path' = ${path}
     LIMIT 1
  `);
  return rows.rows[0]?.attributes ?? {};
}

const SOURCE = `export class Box {
  width = 1;
  resize(next: number): void {
    this.width = next;
  }
}

export function makeBox(): Box {
  return new Box();
}
`;

describeContent('the content stage end to end', () => {
  it('records structure on the file and its version — AC-4', async () => {
    const fixture = await repository('structure');
    await commit(fixture, 'src/box.ts', SOURCE);

    const report = await index(fixture);

    const attributes = await fileAttributes(report.repositoryId, 'src/box.ts');
    // Produced by `describeFileStructure` and carried through the `structure`
    // option `emitFiles` has accepted since EPIC-030 and no caller ever filled.
    expect(attributes['mediaType']).toBe('text/x-typescript');
    expect(attributes['classification']).toBeDefined();
    expect(attributes['isBinary']).toBe(false);
    expect(attributes['isGenerated']).toBe(false);
  });

  it('produces code symbols readable back by file — AC-5', async () => {
    const fixture = await repository('symbols');
    await commit(fixture, 'src/box.ts', SOURCE);

    const report = await index(fixture);

    const names = (await symbolsOf(report.repositoryId, 'src/box.ts')).map((row) => row.name);
    expect(names).toContain('Box');
    expect(names).toContain('makeBox');
    expect(names).toContain('resize');
    expect(report.content?.symbols.created).toBeGreaterThan(0);
  });

  it('finds symbols by name and by qualified name through the port — AC-5', async () => {
    const fixture = await repository('symbol-lookup');
    await commit(fixture, 'src/box.ts', SOURCE);
    const report = await index(fixture);

    const store = new SymbolStore(handle);
    const byName = await store.findSymbols({ scope: report.repositoryId, name: 'makeBox' });
    const byQualified = await store.findSymbols({
      scope: report.repositoryId,
      qualifiedName: 'Box.resize',
    });

    expect(byName).toHaveLength(1);
    expect(byQualified).toHaveLength(1);
    expect(byQualified[0]?.path).toBe('src/box.ts');
  });

  it('counts what it did, and the counts add up — AC-11', async () => {
    const fixture = await repository('counts');
    await commit(fixture, 'src/box.ts', SOURCE);
    await commit(fixture, 'notes.md', '# notes\n');

    const report = await index(fixture);
    const counts = report.content;

    expect(counts).toBeDefined();
    if (counts === undefined) return;
    expect(counts.filesRead).toBe(counts.filesParsed + counts.filesUnparsed);
    expect(counts.filesConsidered).toBeGreaterThanOrEqual(counts.filesRead);
    expect(counts.filesFailed).toBe(0);
  });
});

describeContent('the re-parse gate', () => {
  it('reads nothing and writes nothing on an unchanged second run — AC-6', async () => {
    const fixture = await repository('idempotent');
    await commit(fixture, 'src/box.ts', SOURCE);

    const first = await index(fixture);
    const before = await contentRows(first.repositoryId);
    const second = await index(fixture);
    const after = await contentRows(first.repositoryId);

    expect(first.content?.filesRead).toBeGreaterThan(0);
    expect(second.content?.filesRead).toBe(0);
    expect(second.content?.filesParsed).toBe(0);
    expect(second.content?.filesSkippedUnchanged).toBe(first.content?.filesConsidered);

    // The half that is easy to get wrong: not merely "no content was read", but
    // "no row moved". A gate that skipped the read and then emitted the file
    // without the structure the first run derived would change every one of
    // these content hashes.
    expect(second.entities.created).toBe(0);
    expect(after).toBe(before);
    expect(after.length).toBeGreaterThan(0);
  });

  it('stays quiet on a third and fourth run', async () => {
    const fixture = await repository('idempotent-again');
    await commit(fixture, 'src/box.ts', SOURCE);

    const first = await index(fixture);
    await index(fixture);
    const settled = await contentRows(first.repositoryId);
    const third = await index(fixture);
    const fourth = await index(fixture);

    for (const report of [third, fourth]) {
      expect(report.content?.filesRead).toBe(0);
      expect(report.entities.created).toBe(0);
      expect(report.content?.symbols.tombstoned).toBe(0);
      expect(report.content?.symbols.created).toBe(0);
    }
    expect(await contentRows(first.repositoryId)).toBe(settled);
  });

  it('re-reads a file whose content changed', async () => {
    const fixture = await repository('changed');
    await commit(fixture, 'src/box.ts', SOURCE);
    await index(fixture);

    await commit(fixture, 'src/box.ts', `${SOURCE}\nexport function extra(): void {}\n`);
    const second = await index(fixture);

    expect(second.content?.filesRead).toBe(1);
    const names = (await symbolsOf(second.repositoryId, 'src/box.ts')).map((row) => row.name);
    expect(names).toContain('extra');
  });
});

describeContent('symbol reconciliation — AC-8, AC-15', () => {
  it('tombstones zero symbols on a second run over unchanged content — AC-15', async () => {
    // The EPIC-034 defect, protected at the integration level rather than only
    // at the unit level where it was fixed: the id `codeSymbolId` hashed and the
    // id `createEntity` hashed were derived three files apart, reconciliation
    // compared stored ids against freshly derived ones that disagreed, and every
    // symbol was retired on every run. Nothing failed; the index simply emptied.
    const fixture = await repository('no-mass-tombstone');
    await commit(fixture, 'src/box.ts', SOURCE);

    const first = await index(fixture);
    expect(first.content?.symbols.created).toBeGreaterThan(0);

    const second = await index(fixture);
    expect(second.content?.symbols.tombstoned).toBe(0);

    const alive = await symbolsOf(second.repositoryId, 'src/box.ts');
    expect(alive.every((row) => row.lifecycle === 'active')).toBe(true);
    expect(alive.length).toBe(first.content?.symbols.created);
  });

  it('tombstones a symbol the file stopped declaring, and reinstates it — AC-8', async () => {
    const fixture = await repository('tombstone-restore');
    await commit(fixture, 'src/box.ts', SOURCE);
    await index(fixture);

    await commit(fixture, 'src/box.ts', 'export class Box {\n  width = 1;\n}\n');
    const removed = await index(fixture);
    expect(removed.content?.symbols.tombstoned).toBeGreaterThan(0);

    const afterRemoval = await symbolsOf(removed.repositoryId, 'src/box.ts');
    expect(afterRemoval.find((row) => row.name === 'makeBox')?.lifecycle).toBe('deleted');

    // Restored byte-for-byte, so the upsert reports it unchanged and only
    // reconciliation can bring it back. That asymmetry is why `reinstated` is
    // counted separately from `updated`.
    await commit(fixture, 'src/box.ts', SOURCE);
    const restored = await index(fixture);
    expect(restored.content?.symbols.reinstated).toBeGreaterThan(0);

    const afterRestore = await symbolsOf(restored.repositoryId, 'src/box.ts');
    expect(afterRestore.find((row) => row.name === 'makeBox')?.lifecycle).toBe('active');
  });

  it('leaves symbols alone in files the run did not parse — AC-8', async () => {
    const fixture = await repository('isolated');
    await commit(fixture, 'src/one.ts', 'export function one(): void {}\n');
    await commit(fixture, 'src/two.ts', 'export function two(): void {}\n');
    const first = await index(fixture);

    await commit(fixture, 'src/one.ts', 'export function oneRenamed(): void {}\n');
    const second = await index(fixture);

    // One file changed, so one file was re-read; the other was gate-skipped and
    // its symbols must be exactly as they were. A file skipped by the gate is
    // not a file whose symbols were withdrawn.
    expect(second.content?.filesRead).toBe(1);
    const two = await symbolsOf(first.repositoryId, 'src/two.ts');
    expect(two).toStrictEqual([{ name: 'two', lifecycle: 'active' }]);
  });
});

describeContent('with content indexing off — AC-1', () => {
  it('writes no symbols and reports no content section', async () => {
    const fixture = await repository('metadata-only');
    await commit(fixture, 'src/box.ts', SOURCE);

    const report = await index(fixture, false);

    expect(report.content).toBeUndefined();
    expect(await symbolsOf(report.repositoryId, 'src/box.ts')).toStrictEqual([]);
    const attributes = await fileAttributes(report.repositoryId, 'src/box.ts');
    // The path and extension a tree listing gives, and nothing content-derived.
    expect(attributes['path']).toBe('src/box.ts');
    expect(attributes['mediaType']).toBeUndefined();
  });
});

describeContent('failure, cancellation and the guarantees they must not break — AC-10', () => {
  it('leaves the watermark where it was when the content stage was cancelled', async () => {
    // EPIC-031 AC-6, unchanged and now covering one more stage. A run that
    // failed halfway must be repeated, not resumed from a position it never
    // reached: the watermark moves only after every stage succeeded.
    const fixture = await repository('cancelled');
    await commit(fixture, 'src/box.ts', SOURCE);

    const before = await index(fixture, false);
    expect(before.watermark).toBeDefined();

    const controller = new AbortController();
    controller.abort();
    await expect(
      new RepositoryIndexer(dependencies()).index(
        fixture.discovered,
        { withContent: true },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED });

    // Re-read through a successful metadata run: the recorded position is the
    // one the earlier run left, not one the cancelled run claimed.
    const after = await index(fixture, false);
    expect(after.watermark).toBe(before.watermark);
  });

  it('retires nothing and reinstates nothing when a content run is cancelled', async () => {
    const fixture = await repository('cancelled-lifecycle');
    await commit(fixture, 'src/box.ts', SOURCE);
    const seeded = await index(fixture);
    const before = await contentRows(seeded.repositoryId);

    const controller = new AbortController();
    controller.abort();
    await expect(
      new RepositoryIndexer(dependencies()).index(
        fixture.discovered,
        { withContent: true },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED });

    expect(await contentRows(seeded.repositoryId)).toBe(before);
  });

  it('retires nothing when the tree listing was truncated, with content enabled', async () => {
    // EPIC-032's rule, unchanged and now exercised with a content stage
    // present. A partial view of a tree cannot be allowed to condemn the files
    // it did not reach, and content is not evidence of presence or absence.
    const fixture = await repository('truncated');
    await commit(fixture, 'src/one.ts', 'export function one(): void {}\n');
    await commit(fixture, 'src/two.ts', 'export function two(): void {}\n');
    await index(fixture);

    const truncating: IndexableSource = {
      listWorktrees: (repo, ctx) => provider.listWorktrees(repo, ctx),
      listBranches: (repo, request, ctx) => provider.listBranches(repo, request, ctx),
      readHistory: (repo, request, ctx) => provider.readHistory(repo, request, ctx),
      listFiles: async (repo, request, ctx) => {
        const listing = await provider.listFiles(repo, { ...request, limit: 1 }, ctx);
        return { entries: listing.entries, cursor: 'more' };
      },
      emit: (repo) => provider.emit(repo),
      emitGraph: (repo, parts) => provider.emitGraph(repo, parts),
      emitHistory: (repo, commits, options) => provider.emitHistory(repo, commits, options),
      emitFiles: (repo, entries, options) => provider.emitFiles(repo, entries, options),
    };

    const report = await new RepositoryIndexer({ ...dependencies(), source: truncating }).index(
      fixture.discovered,
      { withContent: true },
      context,
    );

    expect(report.lifecycle.retired).toBe(0);
    expect(report.lifecycle.skippedReason).toContain('truncated');
  });

  it('leaves the other file\'s symbols untouched when only one is parsed', async () => {
    // §8.9: symbol reconciliation is per file and only for files parsed on this
    // run. A file the content stage did not reach has its symbols left exactly
    // as they are.
    const fixture = await repository('per-file-isolation');
    await commit(fixture, 'src/one.ts', 'export function one(): void {}\n');
    await commit(fixture, 'src/two.ts', 'export function two(): void {}\n');
    const first = await index(fixture);

    await commit(fixture, 'src/one.ts', 'export function oneChanged(): void {}\n');
    const second = await index(fixture);

    expect(second.content?.filesRead).toBe(1);
    expect(await symbolsOf(first.repositoryId, 'src/two.ts')).toStrictEqual([
      { name: 'two', lifecycle: 'active' },
    ]);
  });

  it('completes the run when a file cannot be read, counting it on its own', async () => {
    // One unreadable file costs exactly itself. The run is a success with a
    // hole in it that the report names, rather than a failure.
    const fixture = await repository('unreadable-file');
    await commit(fixture, 'src/box.ts', SOURCE);

    const failing: ContentReader = {
      readFileContent: (repo, request, ctx) =>
        request.path === 'src/box.ts'
          ? Promise.resolve({
              read: false,
              reason: ContentUnavailable.UNREADABLE,
              detail: 'forced failure',
            })
          : provider.readFileContent(repo, request, ctx),
    };

    const report = await new RepositoryIndexer({ ...dependencies(), content: failing }).index(
      fixture.discovered,
      { withContent: true },
      context,
    );

    expect(report.content?.filesFailed).toBe(1);
    // The invariant still holds around the hole: the file that could not be
    // read is in neither `filesParsed` nor `filesUnparsed`, because Ferret
    // never had its bytes.
    expect(report.content?.filesRead).toBe(
      (report.content?.filesParsed ?? 0) + (report.content?.filesUnparsed ?? 0),
    );
    expect(await symbolsOf(report.repositoryId, 'src/box.ts')).toStrictEqual([]);
    // The run succeeded: the watermark moved and the report is a report.
    expect(report.watermark).toBeDefined();
  });
});

/**
 * References, edges and symbol evidence end to end — EPIC-035.
 *
 * Shares this file's fixture machinery because the capability needs exactly what
 * it already builds: a real repository, real `git`, the real parser and a real
 * database. The resolver's rules are unit-tested on paper; what needs a live run
 * is that the edges reach storage and that "where is this used" is answerable by
 * traversal.
 */
describeContent('the reference index end to end — EPIC-035', () => {
  const CALLER = [
    'export function applyTax(total: number): number {',
    '  return total * 1.2;',
    '}',
    '',
    'export function refundInvoice(total: number): number {',
    '  return applyTax(total);',
    '}',
    '',
  ].join('\n');

  it('writes a same-file reference edge and records the rule — AC-1, AC-3', async () => {
    const fixture = await repository('references');
    await commit(fixture, 'src/refund.ts', CALLER);

    const report = await index(fixture);

    const symbols = await symbolIdsOf(report.repositoryId, 'src/refund.ts');
    const applyTax = symbols.find((row) => row.name === 'applyTax');
    const refundInvoice = symbols.find((row) => row.name === 'refundInvoice');
    expect(applyTax).toBeDefined();
    expect(refundInvoice).toBeDefined();
    if (applyTax === undefined || refundInvoice === undefined) return;

    // "Where is this used", by inbound traversal — AC-14. No new read surface:
    // the port that already traverses relationships answers it.
    const retrieval = new RetrievalStore(handle);
    const inbound = await retrieval.neighbours(
      { from: applyTax.id, direction: Direction.IN, types: [SYMBOL_REFERENCES_SYMBOL] },
      PUBLIC_ACCESS,
    );

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.entity.id).toBe(refundInvoice.id);
    expect(inbound[0]?.metadata['rule']).toBe(ResolutionRule.SAME_FILE);
    expect(inbound[0]?.metadata['name']).toBe('applyTax');
  });

  it('writes a file_declares_symbol edge for every symbol', async () => {
    const fixture = await repository('declares');
    await commit(fixture, 'src/refund.ts', CALLER);
    const report = await index(fixture);

    const files = await handle.execute<{ id: string }>(sql`
      SELECT id FROM "ferret"."entity"
       WHERE kind = 'file' AND attributes->>'path' = 'src/refund.ts'
         AND source_scope = ${report.repositoryId}
       LIMIT 1
    `);
    const file = files.rows[0];
    expect(file).toBeDefined();
    if (file === undefined) return;

    const retrieval = new RetrievalStore(handle);
    const declared = await retrieval.neighbours(
      { from: file.id, direction: Direction.OUT, types: [FILE_DECLARES_SYMBOL] },
      PUBLIC_ACCESS,
    );

    expect(declared.length).toBeGreaterThanOrEqual(2);
    expect(declared.map((one) => one.entity.kind)).toStrictEqual(
      declared.map(() => 'code_symbol'),
    );
    expect(report.content?.references?.edges).toBeGreaterThan(0);
  });

  it('gives every symbol parsed evidence — AC-8, issue #49', async () => {
    const fixture = await repository('symbol-evidence');
    await commit(fixture, 'src/refund.ts', CALLER);
    const report = await index(fixture);

    const symbols = await symbolIdsOf(report.repositoryId, 'src/refund.ts');
    const applyTax = symbols.find((row) => row.name === 'applyTax');
    expect(applyTax).toBeDefined();
    if (applyTax === undefined) return;

    const store = new EvidenceStore(handle);
    const held = await store.forSubject(applyTax.id, UNRESTRICTED_READ);

    // The gap issue #49 recorded: a symbol had identity, attributes and
    // lifecycle and no evidence row stating how Ferret came to believe it.
    const parsed = held.filter((one) => one.method === EvidenceMethod.PARSED);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.statement).toBe('applyTax');
    // And the authority ranking issue #49 called inert now has something to
    // apply: `parsed` is 60 through EPIC-045.
    expect(parsed[0]?.authority).toBe(SourceAuthority.PARSED);
  });

  it('gives a resolution inferred evidence, derived from the declaration — AC-9', async () => {
    const fixture = await repository('resolution-evidence');
    await commit(fixture, 'src/refund.ts', CALLER);
    const report = await index(fixture);

    const symbols = await symbolIdsOf(report.repositoryId, 'src/refund.ts');
    const applyTax = symbols.find((row) => row.name === 'applyTax');
    expect(applyTax).toBeDefined();
    if (applyTax === undefined) return;

    const store = new EvidenceStore(handle);
    const held = await store.forSubject(applyTax.id, UNRESTRICTED_READ);
    const inferred = held.find((one) => one.method === EvidenceMethod.INFERRED);

    expect(inferred).toBeDefined();
    // The first shipping producer of `inferred` evidence, which is what makes
    // EPIC-046's chain live rather than latent.
    expect(inferred?.derivedFrom).toHaveLength(1);
    expect(inferred?.confidence).toBe(Confidence.STRONG);
  });

  it('resolves across files by unique name, at a lower confidence — AC-4', async () => {
    const fixture = await repository('cross-file');
    await commit(fixture, 'src/tax.ts', 'export function applyTax(n: number): number {\n  return n;\n}\n');
    await commit(
      fixture,
      'src/refund.ts',
      'export function refundInvoice(n: number): number {\n  return applyTax(n);\n}\n',
    );

    const report = await index(fixture);

    const tax = (await symbolIdsOf(report.repositoryId, 'src/tax.ts')).find(
      (row) => row.name === 'applyTax',
    );
    expect(tax).toBeDefined();
    if (tax === undefined) return;

    const retrieval = new RetrievalStore(handle);
    const inbound = await retrieval.neighbours(
      { from: tax.id, direction: Direction.IN, types: [SYMBOL_REFERENCES_SYMBOL] },
      PUBLIC_ACCESS,
    );

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.metadata['rule']).toBe(ResolutionRule.UNIQUE_IN_REPOSITORY);
    expect(report.content?.references?.byRule[ResolutionRule.UNIQUE_IN_REPOSITORY]).toBeGreaterThan(0);
  });

  it('writes no edge for an ambiguous name, and reports it — AC-5', async () => {
    // Two declarations of one name in two files. An edge asserting one of them
    // is manufacturing certainty, and a wrong call graph reads as knowledge.
    const fixture = await repository('ambiguous');
    await commit(fixture, 'src/a.ts', 'export function save(): void {}\n');
    await commit(fixture, 'src/b.ts', 'export function save(): void {}\n');
    await commit(fixture, 'src/use.ts', 'export function run(): void {\n  save();\n}\n');

    const report = await index(fixture);

    const a = (await symbolIdsOf(report.repositoryId, 'src/a.ts')).find((row) => row.name === 'save');
    const b = (await symbolIdsOf(report.repositoryId, 'src/b.ts')).find((row) => row.name === 'save');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;

    const retrieval = new RetrievalStore(handle);
    for (const target of [a, b]) {
      const inbound = await retrieval.neighbours(
        { from: target.id, direction: Direction.IN, types: [SYMBOL_REFERENCES_SYMBOL] },
        PUBLIC_ACCESS,
      );
      expect(inbound).toStrictEqual([]);
    }

    // Reported rather than silent — §12's number that matters.
    expect(report.content?.references?.unresolved[UnresolvedReason.AMBIGUOUS]).toBeGreaterThan(0);
  });

  it('reports an unknown name unresolved rather than inventing an edge — AC-6', async () => {
    const fixture = await repository('unknown-name');
    // A *bare* unknown name. `console.log(1)` is a member call and would be
    // `receiver-unknown` instead — the other refusal, with its own test.
    await commit(
      fixture,
      'src/use.ts',
      ['export function run(): void {', '  structuredClone(1);', '}', ''].join('\n'),
    );

    const report = await index(fixture);

    expect(report.content?.references?.unresolved[UnresolvedReason.NOT_FOUND]).toBeGreaterThan(0);
    expect(report.content?.references?.resolved).toBe(0);
  });

  it('writes nothing new when the file is unchanged — AC-13', async () => {
    const fixture = await repository('unchanged-references');
    await commit(fixture, 'src/refund.ts', CALLER);

    const first = await index(fixture);
    const second = await index(fixture);

    expect(first.content?.references?.edges).toBeGreaterThan(0);
    // The gate skips an unchanged file before the stage is reached, which is
    // what makes this structural rather than a deduplication that happens to
    // work: no parse, no symbols, no references, no writes.
    expect(second.content?.references?.extracted ?? 0).toBe(0);
    expect(second.content?.references?.edges ?? 0).toBe(0);
  });

  it('reports references as undefined when content indexing does not run', async () => {
    const fixture = await repository('no-content-references');
    await commit(fixture, 'src/refund.ts', CALLER);

    const report = await index(fixture, false);

    expect(report.content).toBeUndefined();
  });

  it('refuses a member call the repository rule may not answer — AC-6a', async () => {
    // The dogfooding finding, as a test: one `has` declared in the repository
    // and a `map.has(...)` call that must not resolve to it.
    const fixture = await repository('member-call');
    await commit(
      fixture,
      'src/registry.ts',
      ['export class Registry {', '  has(): boolean {', '    return true;', '  }', '}', ''].join('\n'),
    );
    await commit(
      fixture,
      'src/use.ts',
      [
        'export function run(seen: Map<string, number>): boolean {',
        '  return seen.has("x");',
        '}',
        '',
      ].join('\n'),
    );

    const report = await index(fixture);

    const declared = (await symbolIdsOf(report.repositoryId, 'src/registry.ts')).find(
      (row) => row.name === 'has',
    );
    expect(declared).toBeDefined();
    if (declared === undefined) return;

    const retrieval = new RetrievalStore(handle);
    const inbound = await retrieval.neighbours(
      { from: declared.id, direction: Direction.IN, types: [SYMBOL_REFERENCES_SYMBOL] },
      PUBLIC_ACCESS,
    );

    expect(inbound).toStrictEqual([]);
    expect(report.content?.references?.unresolved['receiver-unknown']).toBeGreaterThan(0);
  });

  it('resolves a recursive call and writes no self-edge — AC-6b', async () => {
    // EPIC-007 forbids a relationship connecting an entity to itself, and it is
    // right to: a symbol calling itself is a property of the symbol. Found on
    // Ferret's own code, where `connect` calls `connect`.
    const fixture = await repository('recursive');
    await commit(
      fixture,
      'src/walk.ts',
      [
        'export function walk(n: number): number {',
        '  if (n <= 0) return 0;',
        '  return walk(n - 1);',
        '}',
        '',
      ].join('\n'),
    );

    const report = await index(fixture);

    const walk = (await symbolIdsOf(report.repositoryId, 'src/walk.ts')).find(
      (row) => row.name === 'walk',
    );
    expect(walk).toBeDefined();
    if (walk === undefined) return;

    const retrieval = new RetrievalStore(handle);
    const inbound = await retrieval.neighbours(
      { from: walk.id, direction: Direction.IN, types: [SYMBOL_REFERENCES_SYMBOL] },
      PUBLIC_ACCESS,
    );

    expect(inbound).toStrictEqual([]);
    // Counted, so it does not look like a resolution that went missing.
    expect(report.content?.references?.recursive).toBeGreaterThan(0);
  });
});

/**
 * Documents through the indexer — EPIC-029.
 *
 * The two claims that need a real run: a Markdown file gains structure, and it
 * gains **no `code_symbol`**. The second is the defect §8.4 exists to prevent —
 * `codeSymbolKindOf` maps an unrecognised outline kind to `UNKNOWN` rather than
 * refusing, so without the contract a heading would be indexed as a
 * declaration, 206 files' worth on Ferret's own repository.
 */
describeContent('documents — EPIC-029', () => {
  const DOCUMENT = [
    '---',
    'title: Onboarding',
    '---',
    '',
    '# Onboarding',
    '',
    'How to start work on this project.',
    '',
    '## Prerequisites',
    '',
    '```sh',
    '# not a heading',
    'npm install',
    '```',
    '',
    '| tool | version |',
    '| --- | --- |',
    '| node | 22 |',
    '',
  ].join('\n');

  it('parses a Markdown file rather than reporting no-parser — AC-17', async () => {
    const fixture = await repository('markdown');
    await commit(fixture, 'docs/onboarding.md', DOCUMENT);

    const report = await index(fixture);

    expect(report.content?.filesParsed).toBeGreaterThan(0);
    expect(report.content?.unparsedReasons['no-parser'] ?? 0).toBe(0);
  });

  it('creates no code symbol for a document — AC-12', async () => {
    // §8.4's whole purpose. A heading is a section, not a declaration.
    const fixture = await repository('markdown-symbols');
    await commit(fixture, 'docs/onboarding.md', DOCUMENT);

    const report = await index(fixture);

    expect(await symbolsOf(report.repositoryId, 'docs/onboarding.md')).toStrictEqual([]);
    expect(report.content?.symbols.created).toBe(0);
  });

  it('still creates code symbols for code in the same run', async () => {
    // The assertion that keeps the one above from passing because symbols broke.
    const fixture = await repository('markdown-and-code');
    await commit(fixture, 'docs/onboarding.md', DOCUMENT);
    await commit(fixture, 'src/box.ts', SOURCE);

    const report = await index(fixture);

    expect(await symbolsOf(report.repositoryId, 'docs/onboarding.md')).toStrictEqual([]);
    expect((await symbolsOf(report.repositoryId, 'src/box.ts')).length).toBeGreaterThan(0);
  });

  it('classifies the document and records what the parse found', async () => {
    // Not a content search: this fixture wires no blob writer, so there is
    // nothing full-text to match — EPIC-087's port is optional and absent here.
    // What is assertable is that the document went through the parse path and
    // is classified as one.
    const fixture = await repository('markdown-structure');
    await commit(fixture, 'docs/onboarding.md', DOCUMENT);

    const report = await index(fixture);

    const files = await handle.execute<{ attributes: Record<string, unknown> }>(sql`
      SELECT attributes FROM "ferret"."entity"
       WHERE kind = 'file' AND attributes->>'path' = 'docs/onboarding.md'
         AND source_scope = ${report.repositoryId}
       LIMIT 1
    `);

    expect(files.rows[0]?.attributes['mediaType']).toBe('text/markdown');
    expect(files.rows[0]?.attributes['classification']).toBe('documentation');
    expect(report.content?.filesParsed).toBeGreaterThan(0);
    expect(report.content?.filesUnparsed).toBe(0);
  });
});

/**
 * Metrics through a real run — EPIC-092.
 *
 * EPIC-004's validation parked "was it healthy an hour ago" here, and §8.4's
 * answer is that history comes from EPIC-094's run journal rather than a new
 * table: migration 0012 made `summary` free-shaped on purpose, and it already
 * carries `started_at`, `ferret_version` and `invocation`.
 */
describeContent('metrics and tracing — EPIC-092', () => {
  it('records a snapshot into the run journal — AC-12', async () => {
    const fixture = await repository('metrics-journal');
    await commit(fixture, 'src/box.ts', SOURCE);

    const metrics = createMetricsRegistry();
    const report = await new RepositoryIndexer({
      ...dependencies(),
      metrics,
      runs: new IndexRunStore(handle),
    }).index(fixture.discovered, { withContent: true }, context);

    const runs = await handle.execute<{ summary: Record<string, unknown>; ferretVersion: string }>(sql`
      SELECT summary, ferret_version AS "ferretVersion"
        FROM "ferret"."index_run"
       WHERE repository_key = ${report.repositoryKey}
       ORDER BY started_at DESC LIMIT 1
    `);

    const summary = runs.rows[0]?.summary;
    expect(summary).toBeDefined();
    const recorded = summary?.['metrics'] as
      | { histograms: Record<string, { count: number }>; counters: Record<string, { total: number }> }
      | undefined;

    expect(recorded).toBeDefined();
    // A stage was timed and a file was parsed, so both instruments have seen
    // something — which is what makes the snapshot worth storing.
    expect(recorded?.histograms['ferret.index.stage_ms']?.count).toBeGreaterThan(0);
    expect(recorded?.counters['ferret.content.parsed']?.total).toBeGreaterThan(0);
  });

  it('keeps the version beside the number, so two runs are comparable — AC-13', async () => {
    const fixture = await repository('metrics-comparable');
    await commit(fixture, 'src/box.ts', SOURCE);
    const deps = { ...dependencies(), runs: new IndexRunStore(handle) };

    const first = await new RepositoryIndexer({ ...deps, metrics: createMetricsRegistry() }).index(
      fixture.discovered,
      { withContent: true },
      context,
    );
    await commit(fixture, 'src/second.ts', 'export function second(): void {}\n');
    await new RepositoryIndexer({ ...deps, metrics: createMetricsRegistry() }).index(
      fixture.discovered,
      { withContent: true },
      context,
    );

    const runs = await handle.execute<{ summary: Record<string, unknown>; ferretVersion: string }>(sql`
      SELECT summary, ferret_version AS "ferretVersion"
        FROM "ferret"."index_run"
       WHERE repository_key = ${first.repositoryKey}
       ORDER BY started_at
    `);

    expect(runs.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of runs.rows) {
      // The version is what makes a comparison across two runs meaningful
      // rather than misleading — a slower run on a newer build is a different
      // fact from a slower run on the same one.
      expect(row.ferretVersion).toBeDefined();
      expect(row.summary['metrics']).toBeDefined();
    }
  });

  it('reports a duration per stage over a real run — AC-16', async () => {
    const fixture = await repository('metrics-stage');
    await commit(fixture, 'src/box.ts', SOURCE);

    const metrics = createMetricsRegistry();
    await new RepositoryIndexer({ ...dependencies(), metrics }).index(
      fixture.discovered,
      { withContent: true },
      context,
    );

    const stage = metrics.snapshot().histograms['ferret.index.stage_ms'];
    expect(stage?.count).toBeGreaterThan(0);
    expect(stage?.sum).toBeGreaterThan(0);
    expect(stage?.unit).toBe('ms');

    // And per file, which is the question a 300-second run raises.
    const perFile = metrics.snapshot().histograms['ferret.content.file_ms'];
    expect(perFile?.count).toBeGreaterThan(0);
  });

  it('records what it measured even when the run fails — EPIC-092 §10', async () => {
    // "Which stage was slow before it died" is exactly the question a failure
    // raises, so a failed run's summary must still carry its numbers.
    const fixture = await repository('metrics-failed');
    await commit(fixture, 'src/box.ts', SOURCE);

    const metrics = createMetricsRegistry();
    const failing: IndexableSource = {
      ...provider,
      readHistory: () => {
        throw new FerretError(ErrorCode.PROVIDER_INIT_FAILED, 'the source went away', { details: {} });
      },
    } as unknown as IndexableSource;

    await expect(
      new RepositoryIndexer({
        ...dependencies(),
        source: failing,
        metrics,
        runs: new IndexRunStore(handle),
      }).index(fixture.discovered, { withContent: true }, context),
    ).rejects.toThrow();

    const runs = await handle.execute<{ summary: Record<string, unknown>; outcome: string }>(sql`
      SELECT summary, outcome FROM "ferret"."index_run"
       WHERE outcome = 'failed' ORDER BY started_at DESC LIMIT 1
    `);

    expect(runs.rows[0]?.outcome).toBe('failed');
    expect(runs.rows[0]?.summary['metrics']).toBeDefined();
  });
});
