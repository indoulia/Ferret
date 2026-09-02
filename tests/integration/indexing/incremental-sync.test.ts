import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  RelationshipType,
  RepositoryIndexer,
  createNullLogger,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  IndexRunStore,
  MigrationPolicy,
  RelationshipStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-076 — a second run reads less and writes nothing, proved end to end.
 *
 * EPIC-080 proved every write path idempotent individually; this proves the
 * property for a whole run, by counting rows across every table rather than by
 * reading a report that says `unchanged`.
 *
 * It also settles the two limitations parked on this Epic. Both look already
 * fixed from reading the code, and **looking is not evidence** — a limitation
 * record that outlived its defect is a false claim about the product, and
 * correcting one because it *seems* stale would be the same error in the other
 * direction.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeSync = runnable ? describe : describe.skip;
const logger = createNullLogger();

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

async function count(table: string): Promise<number> {
  const rows = await handle.execute<{ [column: string]: unknown; n: string }>(
    sql.raw(`SELECT count(*)::text AS n FROM ferret.${table}`),
  );
  return Number(rows.rows[0]?.n ?? '0');
}

function indexer(): RepositoryIndexer {
  const compatibility = new CompatibilityService(handle, database.pool);
  return new RepositoryIndexer({
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: compatibility,
    lifecycle: new IndexLifecycleStore(handle),
    runs: new IndexRunStore(handle),
    cursors: new SyncCursorStore(handle, database.pool),
    logger,
  });
}

async function fixture(name: string): Promise<DiscoveredRepository> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, name, { origin: `https://github.com/indoulia/${name}.git` });
  return provider.describeRepository(path, context);
}

/**
 * `at` pins the commit date, and AC-2 needs it.
 *
 * A cursor position is a commit *timestamp*, and Git's resolution is one
 * second. A fixture whose whole history lands inside a single second cannot
 * read less on a second run, because the boundary is inclusive — deliberately,
 * since an exclusive one would silently drop a commit sharing the boundary
 * second. Left to the wall clock this assertion passes on a slow machine and
 * fails on a fast one; CI failed it with `expected 2 to be less than 2`.
 */
async function commit(
  repository: DiscoveredRepository,
  path: string,
  body: string,
  at?: string,
): Promise<void> {
  const root = repository.root;
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body, 'utf8');
  await git(root, ['add', path]);
  const when = at === undefined ? {} : { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  await git(root, ['commit', '-m', `write ${path}`], when);
}

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic076');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger, policy: MigrationPolicy.AUTO });
  workspace = await createWorkspace('ferret-sync-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
}, 180_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

describeSync(`incremental synchronization (${runnable ? 'real PostgreSQL and git' : SKIP_REASON})`, () => {
  it('writes no new row on a second run over an unchanged repository — AC-1', async () => {
    const repository = await fixture('unchanged');
    await commit(repository, 'src/a.ts', 'export const a = 1;\n');

    await indexer().index(repository, { withHistory: true, withFiles: true }, context);
    const before = {
      entity: await count('entity'),
      relationship: await count('relationship'),
      evidence: await count('evidence'),
    };
    const second = await indexer().index(repository, { withHistory: true, withFiles: true }, context);

    // Counted, not read from the report: the report saying `unchanged` is the
    // thing under test and cannot also be the evidence for it.
    expect(await count('entity')).toBe(before.entity);
    expect(await count('relationship')).toBe(before.relationship);
    expect(await count('evidence')).toBe(before.evidence);
    expect(second.entities.created).toBe(0);
    expect(before.entity).toBeGreaterThan(0);
  }, 180_000);

  it('reads fewer commits on the second run — AC-2', async () => {
    const repository = await fixture('incremental');
    // Distinct pinned seconds, so exactly one commit sits at the newest one and
    // the second run has something to skip. See `commit` for why that matters.
    await commit(repository, 'src/b.ts', 'export const b = 1;\n', '2027-01-01T00:00:00Z');
    await commit(repository, 'src/e.ts', 'export const e = 1;\n', '2027-01-01T00:00:05Z');

    const first = await indexer().index(repository, { withHistory: true, withFiles: true }, context);
    const second = await indexer().index(repository, { withHistory: true, withFiles: true }, context);

    // Two claims, and both matter. Writing nothing is idempotence; reading less
    // is incrementality, and a run that re-read everything and then wrote
    // nothing would satisfy the first while failing the second.
    expect(first.commitsRead).toBeGreaterThan(1);
    expect(second.commitsRead).toBeLessThan(first.commitsRead);
    expect(second.incremental).toBe(true);
  }, 180_000);

  it('keeps one cursor per revision, so neither skips the other — AC-4', async () => {
    const repository = await fixture('two-revisions');
    await commit(repository, 'src/c.ts', 'export const c = 1;\n');
    await git(repository.root, ['checkout', '-b', 'feature']);
    await commit(repository, 'src/d.ts', 'export const d = 1;\n');

    const cursors = new SyncCursorStore(handle, database.pool);
    const before = (await cursors.list()).length;

    await indexer().index(repository, { revision: 'HEAD', withHistory: true, withFiles: true }, context);
    await indexer().index(repository, { revision: 'feature', withHistory: true, withFiles: true }, context);

    // Issue #19: one watermark per repository let a `HEAD` run skip commits a
    // feature-branch run had already passed — recorded in EPIC-031's table as a
    // real correctness gap, and closed by scoping the cursor to the revision.
    // This is the assertion that keeps it closed.
    expect((await cursors.list()).length).toBeGreaterThan(before + 1);
  }, 240_000);

  it('moves an interval start backwards for an earlier observation — AC-3', async () => {
    // Against the store directly. Constructing an out-of-order observation
    // through a Git fixture would test `git`'s ordering rather than the
    // property, and the property is the one EPIC-031's table parked here.
    const entities = new EntityStore(handle);
    const relationships = new RelationshipStore(handle);
    const repositoryId = (
      await entities.upsert({
        kind: EntityKind.REPOSITORY,
        source: { system: 'git', id: '/ooo-repo' },
        attributes: { name: 'ooo' },
      })
    ).entity.id;
    const fileId = (
      await entities.upsert({
        kind: EntityKind.FILE,
        source: { system: 'git', id: 'src/ooo.ts', scope: repositoryId },
        attributes: { path: 'src/ooo.ts' },
      })
    ).entity.id;

    const edge = {
      fromId: repositoryId,
      type: RelationshipType.REPOSITORY_CONTAINS_FILE,
      toId: fileId,
      fromKind: EntityKind.REPOSITORY,
      toKind: EntityKind.FILE,
      sourceSystem: 'git',
    } as const;

    // Newest first, which is the order history arrives in.
    await relationships.assert({ ...edge, validFrom: '2026-06-01T00:00:00.000Z' });
    await relationships.assert({ ...edge, validFrom: '2026-01-01T00:00:00.000Z' });

    const rows = await handle.execute<{ [column: string]: unknown; valid_from: string | Date; valid_to: string | Date | null }>(
      sql`SELECT valid_from, valid_to FROM ferret.relationship WHERE to_id = ${fileId}`,
    );

    // One open interval, starting at the *earlier* observation. EPIC-031's
    // table says the start does not move; the code deletes and replaces the row
    // — `relationships.ts:204` — and this is which of the two is true.
    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0]?.valid_from as string | Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(rows.rows[0]?.valid_to).toBeNull();
  }, 120_000);
});
