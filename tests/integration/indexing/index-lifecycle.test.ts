import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  RepositoryIndexer,
  createNullLogger,
  watermarkScopeId,
  type DiscoveredRepository,
  type IndexableSource,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  MigrationPolicy,
  RelationshipStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * EPIC-032: Ferret learning that things stop existing.
 *
 * Measured against Ferret's own repository before any of this existed: thirteen
 * of three hundred and eighteen indexed files no longer existed, every one
 * recorded `active`, every one holding an **open** `repository_contains_file`
 * edge — and every one already carrying a `commit_modifies_file` record whose
 * metadata read `change: deleted`. The observation had been made, stored, and
 * never acted on.
 *
 * Every test here runs against a real PostgreSQL and a real `git`, because the
 * defect lived in the space between what Git reported, what the graph stored and
 * what a query returned. A fake at any of those boundaries would have agreed
 * with the code rather than with the repository.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeLifecycle = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-032] SKIPPING index lifecycle: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic032');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-lifecycle-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
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

function indexer(source: IndexableSource = provider): RepositoryIndexer {
  return new RepositoryIndexer({
    source,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: new CompatibilityService(handle, database.pool),
    lifecycle: new IndexLifecycleStore(handle),
  });
}

/** Adds a file and commits it. */
async function add(fixture: Fixture, path: string, body = 'x\n'): Promise<void> {
  const full = join(fixture.path, path);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body);
  await git(fixture.path, ['add', '-A']);
  await git(fixture.path, ['commit', '-m', `add ${path}`]);
}

async function remove(fixture: Fixture, path: string): Promise<void> {
  await rm(join(fixture.path, path));
  await git(fixture.path, ['add', '-A']);
  await git(fixture.path, ['commit', '-m', `remove ${path}`]);
}

/** What Ferret believes about one file: its lifecycle and its containment. */
async function believed(
  repositoryId: string,
  path: string,
): Promise<{ lifecycle: string; open: number; intervals: { from: Date; to: Date | null }[] }> {
  const entity = await database.pool.query(
    `SELECT id, lifecycle FROM ferret.entity
      WHERE kind = 'file' AND source_scope = $1 AND attributes->>'path' = $2`,
    [repositoryId, path],
  );
  const row = entity.rows[0] as { id: string; lifecycle: string } | undefined;
  if (row === undefined) return { lifecycle: 'absent', open: 0, intervals: [] };

  const edges = await database.pool.query(
    `SELECT valid_from, valid_to FROM ferret.relationship
      WHERE from_id = $1 AND to_id = $2 AND type = 'repository_contains_file'
      ORDER BY valid_from`,
    [repositoryId, row.id],
  );
  const intervals = (edges.rows as { valid_from: Date; valid_to: Date | null }[]).map((edge) => ({
    from: edge.valid_from,
    to: edge.valid_to,
  }));
  return {
    lifecycle: row.lifecycle,
    open: intervals.filter((interval) => interval.to === null).length,
    intervals,
  };
}

/**
 * Several cases below index the same repository two or three times, against a
 * real PostgreSQL and a real `git`. Each run spawns a good number of
 * subprocesses — heavily so on Windows — so they carry explicit timeouts. The
 * default thirty seconds measures how loaded the machine is, not whether the
 * reconciliation is idempotent.
 */
describeLifecycle('a file that stops existing', () => {
  it('is tombstoned, and its containment closed at the deleting commit', async () => {
    // AC-1 and AC-2. The whole Epic in one case.
    const fixture = await repository('deleted');
    await add(fixture, 'doomed.txt');
    await add(fixture, 'kept.txt');
    await remove(fixture, 'doomed.txt');

    const report = await indexer().index(fixture.discovered, {}, context);

    expect(report.lifecycle.retired).toBe(1);
    expect(report.lifecycle.skippedReason).toBeUndefined();

    const doomed = await believed(report.repositoryId, 'doomed.txt');
    expect(doomed.lifecycle).toBe('deleted');
    expect(doomed.open).toBe(0);

    // Not merely closed — closed at the instant the fact changed, which is
    // what makes "what did this repository contain in January" answerable.
    const deletedAt = new Date(
      (await git(fixture.path, ['log', '-1', '--format=%cI'])).trim(),
    );
    const closed = doomed.intervals.find((interval) => interval.to !== null);
    expect(closed?.to?.getTime()).toBe(deletedAt.getTime());

    // ...and the file beside it is untouched. A sweep that retires more than it
    // should would still satisfy every assertion above.
    const kept = await believed(report.repositoryId, 'kept.txt');
    expect(kept.lifecycle).toBe('active');
    expect(kept.open).toBe(1);
  });

  it('was contained from when it appeared, not from when it was last touched', async () => {
    // `git log` returns newest-first, so the first assertion of an edge won and
    // every earlier one was absorbed as "already open". Ferret claimed to have
    // started containing README.md at the instant of its most recent edit, and
    // asking what a repository held at a past instant returned nothing that had
    // been modified since — the one question the temporal model exists for.
    const fixture = await repository('first-seen');
    await add(fixture, 'early.txt', 'one\n');
    const appeared = new Date((await git(fixture.path, ['log', '-1', '--format=%cI'])).trim());

    await add(fixture, 'later.txt');
    await writeFile(join(fixture.path, 'early.txt'), 'two\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'edit early']);

    const report = await indexer().index(fixture.discovered, {}, context);
    const early = await believed(report.repositoryId, 'early.txt');

    expect(early.open).toBe(1);
    expect(early.intervals[0]?.from.getTime()).toBe(appeared.getTime());
  });

  it('comes back when it is added again', async () => {
    // AC-3. The newest statement wins, which is what makes this fall out rather
    // than needing a rule of its own.
    const fixture = await repository('revived');
    await add(fixture, 'phoenix.txt');
    await remove(fixture, 'phoenix.txt');

    const first = await indexer().index(fixture.discovered, {}, context);
    expect((await believed(first.repositoryId, 'phoenix.txt')).lifecycle).toBe('deleted');

    await add(fixture, 'phoenix.txt', 'again\n');
    const second = await indexer().index(fixture.discovered, {}, context);

    const revived = await believed(second.repositoryId, 'phoenix.txt');
    expect(revived.lifecycle).toBe('active');
    expect(revived.open).toBe(1);

    // The gap stays visible. Reopening the closed interval would have been
    // quicker and would have quietly asserted the file was there all along.
    expect(revived.intervals.length).toBeGreaterThan(1);
  }, 120_000);

  it('changes nothing on the runs after the first', async () => {
    // AC-9. A reconciliation that is not idempotent is a reconciliation that
    // rewrites history every hour.
    const fixture = await repository('idempotent');
    await add(fixture, 'gone.txt');
    await remove(fixture, 'gone.txt');

    await indexer().index(fixture.discovered, {}, context);
    const second = await indexer().index(fixture.discovered, {}, context);
    const third = await indexer().index(fixture.discovered, {}, context);

    expect(second.lifecycle).toStrictEqual({ retired: 0, reinstated: 0, skippedReason: undefined });
    expect(third.lifecycle).toStrictEqual({ retired: 0, reinstated: 0, skippedReason: undefined });
  }, 120_000);

  it('survives a full re-read, which re-observes the commit that added it', async () => {
    // Found by doing it. A full run re-reads the commit that *added* the file —
    // a perfectly good observation, simply not the newest — and reopened the
    // containment edge. The sweep saw nothing to do because it was keyed only
    // off the entity, leaving a tombstoned file the repository still claimed to
    // contain.
    const fixture = await repository('full-reread');
    await add(fixture, 'transient.txt');
    await remove(fixture, 'transient.txt');

    await indexer().index(fixture.discovered, {}, context);
    const full = await indexer().index(fixture.discovered, { full: true }, context);

    const after = await believed(full.repositoryId, 'transient.txt');
    expect(after.lifecycle).toBe('deleted');
    expect(after.open).toBe(0);
  }, 120_000);
});

describeLifecycle('a partial observation retires nothing', () => {
  /**
   * The property most worth testing, because its failure is silent and total: a
   * sweep run against a truncated listing would tombstone most of a large
   * repository, and the run would look exactly like every successful one.
   */
  it('does nothing when the file tree was not read at all', async () => {
    const fixture = await repository('no-files');
    await add(fixture, 'present.txt');
    await remove(fixture, 'present.txt');

    const report = await indexer().index(fixture.discovered, { withFiles: false }, context);

    expect(report.lifecycle.retired).toBe(0);
    expect(report.lifecycle.skippedReason).toContain('file tree was not read');
    expect((await believed(report.repositoryId, 'present.txt')).lifecycle).toBe('active');
  });

  it('does nothing when the file tree came back truncated', async () => {
    // Proved by violating the gate rather than by asserting the flag: the
    // provider is wrapped so its listing reports a cursor, which is the only
    // signal that a tree was cut short.
    const fixture = await repository('truncated');
    await add(fixture, 'a.txt');
    await add(fixture, 'b.txt');
    await remove(fixture, 'a.txt');

    // Delegates to the real provider rather than inheriting from it: the
    // provider holds private fields, and a prototype-derived object is not an
    // instance as far as those are concerned. Every method is forwarded on the
    // instance itself; only the listing is changed, and only to report that it
    // was cut short.
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

    const report = await indexer(truncating).index(fixture.discovered, {}, context);

    expect(report.lifecycle.retired).toBe(0);
    expect(report.lifecycle.skippedReason).toContain('truncated');
    // The deletion is real and Ferret still holds the evidence. It simply
    // refuses to act on a view it knows was partial.
    expect((await believed(report.repositoryId, 'a.txt')).lifecycle).toBe('active');
  });

  it('does nothing when no lifecycle store is configured', async () => {
    const fixture = await repository('no-store');
    await add(fixture, 'orphan.txt');
    await remove(fixture, 'orphan.txt');

    const bare = new RepositoryIndexer({
      source: provider,
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      watermarks: new CompatibilityService(handle, database.pool),
    });
    const report = await bare.index(fixture.discovered, {}, context);

    expect(report.lifecycle.skippedReason).toContain('no lifecycle store');
  });
});

describeLifecycle('the sweep stays inside the repository it was given', () => {
  it('never retires another repository’s files', async () => {
    // A repository must not be able to reach another's entities. `source_scope`
    // is set by Ferret from the repository being indexed and never from
    // repository content, which is what makes the boundary hold.
    const victim = await repository('bystander');
    await add(victim, 'safe.txt');
    const victimReport = await indexer().index(victim.discovered, {}, context);

    const attacker = await repository('sweeper');
    await add(attacker, 'safe.txt');
    await remove(attacker, 'safe.txt');
    await indexer().index(attacker.discovered, {}, context);

    // Same path, different repository, untouched.
    const safe = await believed(victimReport.repositoryId, 'safe.txt');
    expect(safe.lifecycle).toBe('active');
    expect(safe.open).toBe(1);
  }, 120_000);

  it('does not corrupt the graph when two indexers sweep at once', async () => {
    const fixture = await repository('concurrent-sweep');
    await add(fixture, 'contended.txt');
    await remove(fixture, 'contended.txt');

    const [a, b] = await Promise.all([
      indexer().index(fixture.discovered, {}, context),
      indexer().index(fixture.discovered, {}, context),
    ]);

    // Exactly one of them did the work. Both reporting it would mean the
    // tombstone was applied twice; neither would mean it was lost.
    expect(a.lifecycle.retired + b.lifecycle.retired).toBe(1);

    const after = await believed(a.repositoryId, 'contended.txt');
    expect(after.lifecycle).toBe('deleted');
    expect(after.open).toBe(0);
  }, 120_000);
});

describeLifecycle('the watermark belongs to the revision that was read', () => {
  it('does not skip commits when revisions are indexed in turn', async () => {
    // Issue #19. One watermark per repository silently loses history: index
    // HEAD, then a branch, then HEAD again, and every HEAD commit older than the
    // branch tip is never read. Nothing fails and no later run goes back for it.
    const fixture = await repository('issue-19');
    await add(fixture, 'base.txt');

    await git(fixture.path, ['checkout', '-b', 'feature']);
    await add(fixture, 'feature-only.txt');

    await git(fixture.path, ['checkout', '-']);
    await add(fixture, 'main-after.txt');

    const engine = indexer();
    await engine.index(fixture.discovered, { revision: 'feature' }, context);
    await engine.index(fixture.discovered, {}, context);

    // `main-after.txt` is older than the feature branch's tip. With one shared
    // watermark its commit is skipped and the file never reaches the graph.
    const found = await database.pool.query(
      `SELECT 1 FROM ferret.entity
        WHERE kind = 'file' AND attributes->>'path' = 'main-after.txt'
          AND source_scope = (SELECT id::text FROM ferret.entity WHERE kind = 'repository'
                               AND source_id = $1)`,
      [fixture.discovered.identityKey],
    );
    expect(found.rowCount).toBe(1);
  }, 120_000);

  it('keeps the bare repository id for the default revision', () => {
    // Watermarks written before this existed must still be found, or the change
    // would cost every installation a full re-read of every repository.
    const id = '00000000-0000-4000-8000-000000000000';
    expect(watermarkScopeId(id, undefined)).toBe(id);
    expect(watermarkScopeId(id, 'HEAD')).toBe(id);
    expect(watermarkScopeId(id, 'feature')).not.toBe(id);
    expect(watermarkScopeId(id, 'feature')).toBe(watermarkScopeId(id, 'feature'));
    expect(watermarkScopeId(id, 'feature')).not.toBe(watermarkScopeId(id, 'other'));
  });
});
