import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
  ErrorCode,
  RepositoryIndexer,
  createNullLogger,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
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
 * EPIC-031 end to end: a real Git repository, indexed into a real PostgreSQL.
 *
 * This is the first test in the project that exercises the whole chain — provider
 * selected by capability, canonical entities, relationships, evidence, storage,
 * schema — and it is the only place several of the invariants the earlier Epics
 * *recorded* can actually be checked.
 *
 * The one that matters most: **indexing an unchanged repository twice must not
 * grow the database.** EPIC-018 recorded that it would, because relationship
 * identity includes `validFrom`. Here it is measured by counting rows.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeEndToEnd = runnable ? describe : describe.skip;

if (!runnable) {
  // Loudly. This is the only suite that exercises the whole chain, so a silent
  // skip would report success for a build in which nothing was joined up.
  process.stderr.write(
    `\n[EPIC-031] SKIPPING the end-to-end index: ${
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
  database = await createTestDatabase('epic031');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-index-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

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

function indexer(): RepositoryIndexer {
  return new RepositoryIndexer({
    // No cast. The Git provider satisfies `IndexableSource` structurally, which
    // is exactly the claim the ports design makes: the indexer names the narrow
    // interface it needs, and a provider that happens to fit is accepted without
    // either side importing the other.
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: new CompatibilityService(handle, database.pool),
  });
}

async function counts(): Promise<{ entities: number; relationships: number; evidence: number }> {
  const read = async (table: string): Promise<number> => {
    const result = await database.pool.query(`SELECT count(*)::int AS n FROM ferret.${table}`);
    return (result.rows[0] as { n: number }).n;
  };
  return {
    entities: await read('entity'),
    relationships: await read('relationship'),
    evidence: await read('evidence'),
  };
}

describeEndToEnd('indexing a repository', () => {
  it('writes a connected graph on the first run', async () => {
    const fixture = await repository('first-run');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'main.ts'), 'export const x = 1;\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add source']);

    const report = await indexer().index(fixture.discovered, {}, context);

    expect(report.incremental).toBe(false);
    expect(report.entities.created).toBeGreaterThan(0);
    expect(report.relationships.created).toBeGreaterThan(0);
    expect(report.commitsRead).toBe(2);
    expect(report.filesRead).toBe(2);
    expect(report.watermark).toBeDefined();

    const kinds = await database.pool.query(
      "SELECT DISTINCT kind FROM ferret.entity WHERE kind IN ('repository','branch','worktree','commit','developer','file','file_version') ORDER BY kind",
    );
    expect(kinds.rows.map((row) => (row as { kind: string }).kind)).toStrictEqual([
      'branch',
      'commit',
      'developer',
      'file',
      'file_version',
      'repository',
      'worktree',
    ]);
  });

  it('stores every commit in full, not just the newest one', async () => {
    // Found by dogfooding, not by testing: 60 of 61 commits in Ferret's own
    // index held nothing but a SHA.
    //
    // `git log` returns commits newest first, so each one emits its parent as a
    // placeholder before the loop reaches that parent properly — and the
    // placeholder won. The graph had exactly the right shape and was almost
    // entirely empty, which is the worst way for it to be wrong, because every
    // structural assertion still passed.
    const fixture = await repository('full-commits');
    for (let i = 0; i < 3; i += 1) {
      await writeFile(join(fixture.path, `c${String(i)}.txt`), `${String(i)}\n`);
      await git(fixture.path, ['add', '-A']);
      await git(fixture.path, ['commit', '-m', `message number ${String(i)}`]);
    }

    const report = await indexer().index(fixture.discovered, {}, context);

    const rows = await database.pool.query(
      `SELECT count(*) FILTER (WHERE attributes ? 'message') AS with_message,
              count(*) AS total
         FROM ferret.entity e
        WHERE e.kind = 'commit'
          AND e.id IN (SELECT to_id FROM ferret.relationship
                        WHERE type = 'repository_contains_commit' AND from_id = $1)`,
      [report.repositoryId],
    );
    const counts = rows.rows[0] as { with_message: string; total: string };

    expect(Number(counts.total)).toBe(4);
    // Every one of them, not just the newest.
    expect(Number(counts.with_message)).toBe(4);
  });

  it('does not grow the database when nothing changed', async () => {
    // The invariant EPIC-018 recorded as its most important limitation, and the
    // reason EPIC-007's store now treats an open interval with identical
    // endpoints as a no-op. Without that fix this test would add a row per edge
    // per run, for ever, for a repository nobody had touched.
    const fixture = await repository('idempotent');
    const engine = indexer();

    await engine.index(fixture.discovered, {}, context);
    const first = await counts();

    const second = await engine.index(fixture.discovered, {}, context);
    const afterSecond = await counts();

    expect(afterSecond).toStrictEqual(first);
    expect(second.entities.created).toBe(0);
    expect(second.relationships.created).toBe(0);
    expect(second.evidence.recorded).toBe(0);
  });

  it('reads only what is new on the second run', async () => {
    const fixture = await repository('incremental');
    const engine = indexer();

    const first = await engine.index(fixture.discovered, {}, context);
    expect(first.incremental).toBe(false);
    expect(first.commitsRead).toBe(1);

    const second = await engine.index(fixture.discovered, {}, context);
    // A watermark now exists, so the provider was asked only for what is newer.
    //
    // At most the boundary commit comes back: `git log --since` has second
    // granularity and an inclusive boundary. Moving the boundary forward to
    // avoid it would risk skipping a sibling commit made in the same second, and
    // silently losing history is far worse than re-reading one whose write is
    // idempotent — which the second assertion checks.
    expect(second.incremental).toBe(true);
    expect(second.commitsRead).toBeLessThanOrEqual(1);
    expect(second.entities.created).toBe(0);

    await writeFile(join(fixture.path, 'new.txt'), 'new\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'something new']);

    const third = await engine.index(fixture.discovered, {}, context);
    expect(third.incremental).toBe(true);
    expect(third.commitsRead).toBeGreaterThanOrEqual(1);
    expect(third.entities.created).toBeGreaterThan(0);
  });

  it('re-reads everything when asked for a full run', async () => {
    // The escape hatch for "Ferret's model of this repository is wrong". It is
    // explicit because it is expensive, and because a run that silently decided
    // to be full would be indistinguishable from one that lost its place.
    const fixture = await repository('full-run');
    const engine = indexer();

    await engine.index(fixture.discovered, {}, context);
    const incremental = await engine.index(fixture.discovered, {}, context);
    expect(incremental.incremental).toBe(true);

    const full = await engine.index(fixture.discovered, { full: true }, context);
    expect(full.incremental).toBe(false);
    expect(full.commitsRead).toBe(1);
    // Re-reading is not re-writing: everything was already known.
    expect(full.entities.created).toBe(0);
  });

  it('records a branch switch as history rather than as a contradiction', async () => {
    // The exclusive relationship, end to end. A worktree is on one branch at a
    // time, so switching closes the old interval and opens a new one — which is
    // what makes "what was I working on last Tuesday" answerable.
    const fixture = await repository('switching');
    const engine = indexer();
    await git(fixture.path, ['branch', 'next']);
    const report = await engine.index(fixture.discovered, {}, context);

    await git(fixture.path, ['checkout', 'next']);
    const rediscovered = await provider.describeRepository(fixture.path, context);
    await engine.index(rediscovered, {}, context);

    // Scoped to *this* repository's worktrees, reached through the graph.
    //
    // The first version counted open intervals across the whole database and
    // found five — one per repository the earlier tests had indexed, each
    // correctly on a branch. A global count cannot answer a question about one
    // worktree. Matching by path was the next attempt and was brittle: Git
    // reports a path in its own form, which differs from the fixture's on
    // Windows. Traversing the containment edge is what the graph is *for*.
    const rows = await database.pool.query(
      `SELECT r.valid_from, r.valid_to
         FROM ferret.relationship r
        WHERE r.type = 'worktree_checks_out_branch'
          AND r.from_id IN (
            SELECT c.to_id FROM ferret.relationship c
             WHERE c.type = 'repository_contains_worktree' AND c.from_id = $1
          )
        ORDER BY r.valid_from`,
      [report.repositoryId],
    );
    const intervals = rows.rows as { valid_from: Date; valid_to: Date | null }[];

    expect(intervals.length).toBeGreaterThanOrEqual(2);
    // Exactly one open interval: the worktree is on exactly one branch now.
    expect(intervals.filter((interval) => interval.valid_to === null)).toHaveLength(1);
  });

  it('stops when cancelled, without leaving a watermark it did not earn', async () => {
    // Governance §13: an interrupted index should leave Ferret knowing less,
    // never knowing something wrong. A watermark written by a run that failed
    // halfway would leave a permanent gap nothing would ever fill.
    const fixture = await repository('cancelled');
    const cancellable = createTestOperationContext();
    cancellable.abort();

    await expect(indexer().index(fixture.discovered, {}, cancellable)).rejects.toMatchObject({
      code: ErrorCode.INTERRUPTED,
    });

    const artifacts = await database.pool.query(
      `SELECT count(*)::int AS n FROM ferret.derived_artifact WHERE kind = 'index'`,
    );
    const before = (artifacts.rows[0] as { n: number }).n;

    await indexer().index(fixture.discovered, {}, context);
    const after = await database.pool.query(
      `SELECT count(*)::int AS n FROM ferret.derived_artifact WHERE kind = 'index'`,
    );
    expect((after.rows[0] as { n: number }).n).toBe(before + 1);
  });

  it('runs two indexers over one repository without corrupting the graph', async () => {
    // Not a scenario anyone designs; it is what a scheduled index racing a
    // manual one actually looks like.
    const fixture = await repository('concurrent');
    const engines = [indexer(), indexer(), indexer()];

    const reports = await Promise.all(
      engines.map((engine) => engine.index(fixture.discovered, {}, context)),
    );

    for (const report of reports) expect(report.entities.created + report.entities.unchanged).toBeGreaterThan(0);

    const duplicates = await database.pool.query(
      `SELECT from_id, type, to_id, count(*) FILTER (WHERE valid_to IS NULL) AS open
       FROM ferret.relationship
       GROUP BY from_id, type, to_id
       HAVING count(*) FILTER (WHERE valid_to IS NULL) > 1`,
    );
    // One open interval per edge, whatever order three concurrent writers
    // happened to interleave in.
    expect(duplicates.rows).toStrictEqual([]);
  });

  it('indexes a repository with real history within budget', async () => {
    const fixture = await repository('bulk-index');
    for (let i = 0; i < 15; i += 1) {
      await writeFile(join(fixture.path, `f${String(i)}.txt`), `${String(i)}\n`);
      await git(fixture.path, ['add', '-A']);
      await git(fixture.path, ['commit', '-m', `commit ${String(i)}`]);
    }

    const engine = indexer();
    const started = performance.now();
    const report = await engine.index(fixture.discovered, {}, context);
    const firstRun = performance.now() - started;

    expect(report.commitsRead).toBe(16);
    expect(report.filesRead).toBe(16);

    const resumed = performance.now();
    const second = await engine.index(fixture.discovered, {}, context);
    const secondRun = performance.now() - resumed;

    // Deliberately **not** an assertion about how many commits came back.
    // `--since` has second granularity, and on a fast runner an entire fixture
    // history is created inside one second — so the boundary legitimately
    // returns all of it. That is the documented behaviour at its extreme, and
    // the alternative (moving the boundary forward) risks losing a sibling
    // commit, which is far worse than re-reading one.
    //
    // What the watermark actually promises is that the second run *writes*
    // nothing, which is what is checked.
    expect(second.incremental).toBe(true);
    expect(second.entities.created).toBe(0);
    expect(second.relationships.created).toBe(0);
    expect(second.evidence.recorded).toBe(0);
    // `expect(secondRun).toBeLessThan(firstRun)` used to stand here and was
    // flaky: it failed on a shared runner at 1685ms against 1618ms, a 4%
    // spread, having passed on the two runs before it. It cannot detect what
    // it claims to either — the file tree is still read in full on the second
    // run, so losing the incremental path would land near 1.0x, inside the
    // same noise band it was tripping on. What actually proves the watermark
    // is the four assertions above: the run reports itself incremental and
    // writes nothing. Wall clock keeps only its absolute ceiling.
    expect(firstRun).toBeLessThan(60_000);
    expect(secondRun).toBeLessThan(60_000);
  }, 180_000);
});
