import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

import {
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
