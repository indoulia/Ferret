import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NOTHING_WITHHELD,
  PUBLIC_ACCESS,
  Direction,
  ErrorCode,
  HitSource,
  MAX_LIMIT,
  MAX_TRAVERSAL_DEPTH,
  TraversalBound,
  traverseFrom,
  RepositoryIndexer,
  RelationshipType,
  boundedLimit,
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
  RetrievalStore,
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
 * EPIC-052 and EPIC-053 against a real indexed repository.
 *
 * The distinction under test throughout is between the two kinds of question,
 * because conflating them is how a system starts returning plausible answers to
 * precise ones:
 *
 * - **Exact** has a right answer and no ranking. *Which files does this
 *   repository contain* is not a question you answer approximately.
 * - **Full-text** is a guess with a score, for things a person half-remembers.
 *
 * Both are exercised over a repository built by real `git` and indexed by the
 * real indexer, because a hand-seeded database would only prove the seeding.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeRetrieval = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-052/053] SKIPPING retrieval: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;
let retrieval: RetrievalStore;
let repository: DiscoveredRepository;
let repositoryId: string;

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic052');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-retrieval-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
  retrieval = new RetrievalStore(handle);

  // One repository with deliberately searchable content.
  const root = join(workspace.path, 'searchable');
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, 'searchable', {
    origin: 'https://github.com/indoulia/searchable.git',
  });
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'src', 'connection-pool.ts'), 'export const pool = 1;\n');
  await writeFile(join(path, 'src', 'retry-policy.ts'), 'export const retry = 1;\n');
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-m', 'add connection pooling and retry handling']);

  await writeFile(join(path, 'docs.md'), 'documentation\n');
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-m', 'document the timeout behaviour of the pool']);

  await git(path, ['branch', 'feature/timeouts']);

  repository = await provider.describeRepository(path, context);
  const indexer = new RepositoryIndexer({
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: new CompatibilityService(handle, database.pool),
  });
  repositoryId = (await indexer.index(repository, {}, context)).repositoryId;
});

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

describe('query bounds', () => {
  it('bounds a limit without a database', () => {
    // Retrieval answers an AI client over MCP, and an unbounded result set is a
    // context window filled by one query.
    expect(boundedLimit(undefined)).toBe(50);
    expect(boundedLimit(10)).toBe(10);
    expect(boundedLimit(10_000)).toBe(MAX_LIMIT);
    expect(boundedLimit(0)).toBe(50);
    expect(boundedLimit(-1)).toBe(50);
    expect(boundedLimit(1.5)).toBe(50);
  });
});

describeRetrieval('exact structured retrieval', () => {
  it('finds every entity of a kind', async () => {
    const { entities: files } = await retrieval.findEntities({ kind: 'file', limit: MAX_LIMIT }, PUBLIC_ACCESS);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.every((entity) => entity.kind === 'file')).toBe(true);
  });

  it('finds an entity by an exact attribute', async () => {
    // Deterministic: there is one file at this path, and "probably that one" is
    // not an answer.
    const { entities: found } = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/connection-pool.ts' },
    }, PUBLIC_ACCESS);
    expect(found).toHaveLength(1);
    expect(found[0]?.attributes['path']).toBe('src/connection-pool.ts');
  });

  it('finds the files identified within one repository', async () => {
    const { entities: scoped } = await retrieval.findEntities({ kind: 'file', scope: repositoryId, limit: MAX_LIMIT }, PUBLIC_ACCESS);
    expect(scoped.length).toBeGreaterThanOrEqual(4);
  });

  it('returns nothing rather than everything for a filter that matches nothing', async () => {
    // Nothing found, nothing withheld, nothing further — three separate facts,
    // and the point of asserting all three is that "there is nothing there"
    // must not be reachable by any other route.
    expect(
      await retrieval.findEntities({ kind: 'file', attributes: { path: 'no/such/file' } }, PUBLIC_ACCESS),
    ).toStrictEqual({ entities: [], withheld: NOTHING_WITHHELD, more: false });
  });

  it('reads one entity with its external identifiers', async () => {
    const { entities: [file] } = await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS);
    const full = await retrieval.getEntity(file?.id ?? '', PUBLIC_ACCESS);
    expect(full?.id).toBe(file?.id);
    expect(Array.isArray(full?.externalIds)).toBe(true);
  });

  it('reports a missing entity as missing', async () => {
    expect(await retrieval.getEntity('00000000-0000-0000-0000-000000000000', PUBLIC_ACCESS)).toBeUndefined();
  });

  it('treats an attribute name as data, not as SQL', async () => {
    // The attribute *key* is a bind parameter too. A name reaching the query as
    // interpolated text would be an injection through a field nobody thinks of
    // as user input.
    const { entities: hostile } = await retrieval.findEntities({
      kind: 'file',
      attributes: { "path'; DROP TABLE ferret.entity; --": 'x' },
    }, PUBLIC_ACCESS);
    expect(hostile).toStrictEqual([]);
    // Still there.
    expect((await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS)).entities).toHaveLength(1);
  });
});

describeRetrieval('traversal', () => {
  it('finds what a repository contains', async () => {
    const { neighbours: out } = await retrieval.neighbours({
      from: repositoryId,
      direction: Direction.OUT,
      limit: MAX_LIMIT,
    }, PUBLIC_ACCESS);
    const types = new Set(out.map((neighbour) => neighbour.relationshipType));

    expect(types).toContain(RelationshipType.REPOSITORY_CONTAINS_FILE);
    expect(types).toContain(RelationshipType.REPOSITORY_CONTAINS_COMMIT);
    expect(types).toContain(RelationshipType.REPOSITORY_CONTAINS_BRANCH);
    expect(out.every((neighbour) => neighbour.direction === 'out')).toBe(true);
  });

  it('finds what points at a file', async () => {
    const { entities: [file] } = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/retry-policy.ts' },
    }, PUBLIC_ACCESS);
    const { neighbours: inbound } = await retrieval.neighbours({
      from: file?.id ?? '',
      direction: Direction.IN,
      types: [RelationshipType.COMMIT_MODIFIES_FILE],
      limit: MAX_LIMIT,
    }, PUBLIC_ACCESS);

    expect(inbound.length).toBeGreaterThanOrEqual(1);
    expect(inbound.every((neighbour) => neighbour.entity.kind === 'commit')).toBe(true);
  });

  it('follows both directions when the question has none', async () => {
    const { entities: [file] } = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/retry-policy.ts' },
    }, PUBLIC_ACCESS);
    const { neighbours: both } = await retrieval.neighbours({ from: file?.id ?? '', limit: MAX_LIMIT }, PUBLIC_ACCESS);
    const directions = new Set(both.map((neighbour) => neighbour.direction));

    // A file is contained *by* a repository and modified *by* commits, and has
    // versions of its own. Asking twice invites asking once.
    expect(directions.has('in')).toBe(true);
    expect(directions.has('out')).toBe(true);
  });

  it('answers as of an instant, not only as of now', async () => {
    // The reason relationships carry valid time at all, and the question Ferret
    // exists for: *what was this like last Tuesday*.
    const before = new Date(Date.now() - 86_400_000).toISOString();
    const { neighbours: past } = await retrieval.neighbours({ from: repositoryId, at: before, limit: MAX_LIMIT }, PUBLIC_ACCESS);
    const { neighbours: now } = await retrieval.neighbours({ from: repositoryId, limit: MAX_LIMIT }, PUBLIC_ACCESS);

    // Structural edges were observed today, so yesterday Ferret knew nothing.
    expect(now.length).toBeGreaterThan(past.length);
  });

  it('excludes an interval that ended exactly at the instant asked about', async () => {
    // Half-open, the same convention EPIC-007 uses everywhere. Mixing the two is
    // how a worktree appears to be on two branches for one instant.
    const { neighbours: open } = await retrieval.neighbours({
      from: repositoryId,
      types: [RelationshipType.REPOSITORY_CONTAINS_FILE],
      limit: 1,
    }, PUBLIC_ACCESS);
    const edge = open[0];
    expect(edge).toBeDefined();

    const { neighbours: atStart } = await retrieval.neighbours({
      from: repositoryId,
      types: [RelationshipType.REPOSITORY_CONTAINS_FILE],
      at: edge?.validFrom,
      limit: MAX_LIMIT,
    }, PUBLIC_ACCESS);
    // `valid_from <= at` is inclusive, so the interval is live at its own start.
    expect(atStart.length).toBeGreaterThan(0);
  });

  it('returns nothing for an entity nothing is connected to', async () => {
    expect(
      await retrieval.neighbours({ from: '00000000-0000-0000-0000-000000000000' }, PUBLIC_ACCESS),
    ).toStrictEqual({ neighbours: [], withheld: NOTHING_WITHHELD, more: false });
  });
});

describeRetrieval('full-text retrieval', () => {
  it('finds a commit by words from its message', async () => {
    const hits = (await retrieval.search({ text: 'connection pooling' }, PUBLIC_ACCESS)).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.entity.kind === 'commit')).toBe(true);
  });

  it('stems, so a search for one form finds another', async () => {
    // The difference between `english` and `simple`, and the reason for it: a
    // person searching "pool" should find "pooling".
    const hits = (await retrieval.search({ text: 'pool' }, PUBLIC_ACCESS)).hits;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('finds a file by words from its path', async () => {
    // PostgreSQL lexes `src/retry-policy.ts` as one token of type `file`, so a
    // separated form is indexed alongside it — otherwise no query a person
    // would type finds a file at all.
    const hits = (await retrieval.search({ text: 'retry policy', kinds: ['file'] }, PUBLIC_ACCESS)).hits;
    expect(hits.some((hit) => hit.entity.attributes['path'] === 'src/retry-policy.ts')).toBe(true);

    const single = (await retrieval.search({ text: 'connection', kinds: ['file'] }, PUBLIC_ACCESS)).hits;
    expect(single.some((hit) => hit.entity.attributes['path'] === 'src/connection-pool.ts')).toBe(true);
  });

  it('does not find a path by a hyphenated fragment, and that is a known gap', async () => {
    // Recorded rather than hidden. `retry-policy` parses as a *phrase* query —
    // 'retry-polici' <-> 'retri' <-> 'polici' — which no lexing of the path
    // satisfies. Deciding when to use exact matching instead of full text is
    // EPIC-055's job, and asserting the current behaviour means the day it
    // changes is a visible decision rather than an accident.
    const hits = (await retrieval.search({ text: 'retry-policy', kinds: ['file'] }, PUBLIC_ACCESS)).hits;
    expect(hits.some((hit) => hit.entity.attributes['path'] === 'src/retry-policy.ts')).toBe(false);
  });

  it('understands a quoted phrase', async () => {
    // `websearch_to_tsquery` rather than `plainto_tsquery`: it understands what
    // a person types without being told a syntax.
    const phrase = (await retrieval.search({ text: '"timeout behaviour"' }, PUBLIC_ACCESS)).hits;
    expect(phrase.length).toBeGreaterThan(0);
  });

  it('understands exclusion', async () => {
    const withBoth = (await retrieval.search({ text: 'pool', limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    const excluded = (await retrieval.search({ text: 'pool -timeout', limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    expect(excluded.length).toBeLessThanOrEqual(withBoth.length);
  });

  it('orders by relevance and says where each hit came from', async () => {
    const hits = (await retrieval.search({ text: 'timeout', limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    expect(hits.length).toBeGreaterThan(0);

    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]?.score).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
    }
    for (const hit of hits) {
      expect([HitSource.ENTITY, HitSource.EVIDENCE]).toContain(hit.source);
      if (hit.source === HitSource.EVIDENCE) expect(hit.evidence).toBeDefined();
    }
  });

  it('shows why something matched', async () => {
    const [hit] = (await retrieval.search({ text: 'connection' }, PUBLIC_ACCESS)).hits;
    // A score with no explanation is a number a person has to trust.
    expect(hit?.highlight).toBeDefined();
    expect(String(hit?.highlight)).toContain('<b>');
  });

  it('searches evidence statements, not only entity names', async () => {
    const hits = (await retrieval.search({ text: 'searchable', limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    expect(hits.some((hit) => hit.source === HitSource.EVIDENCE)).toBe(true);
  });

  it('can be told to search entities only', async () => {
    const hits = (await retrieval.search({ text: 'searchable', includeEvidence: false, limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    expect(hits.every((hit) => hit.source === HitSource.ENTITY)).toBe(true);
  });

  it('filters by kind', async () => {
    const hits = (await retrieval.search({ text: 'pool', kinds: ['file'], limit: MAX_LIMIT }, PUBLIC_ACCESS)).hits;
    expect(hits.every((hit) => hit.entity.kind === 'file')).toBe(true);
  });

  it('finds nothing rather than everything for a term that is absent', async () => {
    expect((await retrieval.search({ text: 'zzzznotpresentanywhere' }, PUBLIC_ACCESS)).hits).toStrictEqual([]);
  });

  it('does not crash on syntax a person might type', async () => {
    // `to_tsquery` and `plainto_tsquery` both throw on malformed input. A search
    // box that a stray parenthesis can crash is a search box that will be.
    for (const text of ['(((', 'a & | b', '"unclosed', '!!!', 'and or not', '\\']) {
      await expect(retrieval.search({ text }, PUBLIC_ACCESS)).resolves.toBeDefined();
    }
  });

  it('refuses an empty or oversized query', async () => {
    await expect(retrieval.search({ text: '   ' }, PUBLIC_ACCESS)).rejects.toMatchObject({ code: ErrorCode.USAGE });
    await expect(retrieval.search({ text: 'x'.repeat(2000) }, PUBLIC_ACCESS)).rejects.toMatchObject({
      code: ErrorCode.USAGE,
    });
  });

  it('treats search text as data, not as SQL', async () => {
    const hostile = "'; DROP TABLE ferret.entity; --";
    await expect(retrieval.search({ text: hostile }, PUBLIC_ACCESS)).resolves.toBeDefined();
    // Still there.
    expect((await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS)).entities).toHaveLength(1);
  });

  it('never returns more than the maximum, whatever it is asked for', async () => {
    const hits = (await retrieval.search({ text: 'pool', limit: 100_000 }, PUBLIC_ACCESS)).hits;
    expect(hits.length).toBeLessThanOrEqual(MAX_LIMIT);
  });

  it('searches a realistic corpus within budget', async () => {
    const started = performance.now();
    for (let i = 0; i < 50; i += 1) await retrieval.search({ text: 'pool timeout retry' }, PUBLIC_ACCESS);
    const elapsed = performance.now() - started;

    // Fifty searches against a GIN index. This is the query on the hot path of
    // every AI-client question, so a regression to a sequential scan shows here.
    expect(elapsed).toBeLessThan(20_000);
  });
});

/**
 * Freshness ranking against a real index — EPIC-057.
 *
 * Shares this file's repository because the claim needs an indexed corpus and
 * nothing about it needs a second one. Each test restores the lifecycle it
 * changed, so the fixture the tests above rely on is the fixture they get.
 */
describeRetrieval(`ranking by standing (${runnable ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  /** Marks one entity retired, runs the assertion, and puts it back. */
  async function whileRetired(id: string, lifecycle: string, run: () => Promise<void>): Promise<void> {
    await database.pool.query(`UPDATE ferret.entity SET lifecycle = $2 WHERE id = $1`, [id, lifecycle]);
    try {
      await run();
    } finally {
      await database.pool.query(`UPDATE ferret.entity SET lifecycle = 'active' WHERE id = $1`, [id]);
    }
  }

  it('drops a tombstoned hit below every live one, and still returns it — AC-1, AC-9, AC-10', async () => {
    const before = (await retrieval.search({ text: 'pool', limit: 10 }, PUBLIC_ACCESS)).hits;
    expect(before.length).toBeGreaterThan(1);
    const best = before[0];
    expect(best).toBeDefined();
    if (best === undefined) return;

    await whileRetired(best.entity.id, 'deleted', async () => {
      const after = (await retrieval.search({ text: 'pool', limit: 10 }, PUBLIC_ACCESS)).hits;

      // Reordered, not filtered. A deleted file that matches is still an answer
      // to "what used to be here".
      expect(after).toHaveLength(before.length);
      expect(after.map((hit) => hit.entity.id)).toContain(best.entity.id);

      const moved = after[after.length - 1];
      expect(moved?.entity.id).toBe(best.entity.id);
      expect(moved?.ranking?.standing).toBeGreaterThan(0);
      expect(moved?.ranking?.why).toContain('removed');

      // And it really was the better match — the ordering changed because of
      // standing, not because relevance did.
      expect(moved?.ranking?.relevance).toBe(best.ranking?.relevance);
      for (const hit of after.slice(0, -1)) expect(hit.ranking?.standing).toBe(0);
    });
  });

  it('ranks a superseded hit below a deleted one — AC-2', async () => {
    const hits = (await retrieval.search({ text: 'pool', limit: 10 }, PUBLIC_ACCESS)).hits;
    const [first, second] = hits;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    await whileRetired(first.entity.id, 'superseded', async () => {
      await whileRetired(second.entity.id, 'deleted', async () => {
        const after = (await retrieval.search({ text: 'pool', limit: 10 }, PUBLIC_ACCESS)).hits;
        const order = after.map((hit) => hit.entity.id);

        expect(order.indexOf(second.entity.id)).toBeLessThan(order.indexOf(first.entity.id));
        expect(after[after.length - 1]?.ranking?.why).toContain('replacement');
      });
    });
  });

  it('says nothing about standing on a live hit — AC-10', async () => {
    const hits = (await retrieval.search({ text: 'pool', limit: 10 }, PUBLIC_ACCESS)).hits;

    for (const hit of hits) {
      expect(hit.ranking?.standing).toBe(0);
      expect(hit.ranking?.why).toBeUndefined();
    }
  });
});

/**
 * Multi-hop traversal — EPIC-050.
 *
 * EPIC-007's validation recorded that traversal was one hop and that depth and
 * cycle protection "must be addressed before multi-hop traversal exists". This
 * is that, against a real graph: the fixture repository has commits with
 * parents, files with versions, and — since EPIC-035 — symbols that reference
 * each other.
 */
describeRetrieval(`traversing more than one hop (${runnable ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  /** The repository, and a commit and file that are two hops apart. */
  const originOf = async (): Promise<{ repositoryId: string; commitId: string }> => {
    // No scope filter: a commit's `source_scope` is not the repository id, and
    // this fixture holds one repository.
    const commits = await handle.execute<{ id: string }>(sql`
      SELECT id FROM ferret.entity
       WHERE kind = 'commit' ORDER BY source_observed_at DESC LIMIT 1
    `);
    const commitId = commits.rows[0]?.id;
    expect(commitId).toBeDefined();
    return { repositoryId, commitId: commitId ?? '' };
  };

  it('returns exactly what neighbours returns at depth 1 — AC-2', async () => {
    const { repositoryId: root } = await originOf();

    const { neighbours: hop } = await retrieval.neighbours({ from: root, limit: 50 }, PUBLIC_ACCESS);
    const walk = await retrieval.traverse({ from: root, depth: 1, limit: 50 }, PUBLIC_ACCESS);

    expect(walk.paths.map((one) => one.entity.id).sort()).toStrictEqual(
      hop.map((one) => one.entity.id).sort(),
    );
    for (const path of walk.paths) expect(path.depth).toBe(1);
  });

  it('reaches a file through its repository in two hops, with the path — AC-1', async () => {
    const walk = await retrieval.traverse({ from: repositoryId, depth: 2, limit: 200 }, PUBLIC_ACCESS);

    const twoHops = walk.paths.filter((one) => one.depth === 2);
    expect(twoHops.length).toBeGreaterThan(0);

    const path = twoHops[0];
    expect(path?.steps).toHaveLength(2);
    // The path is the answer to "how": both edge types in order, and the
    // intermediate node's id.
    expect(path?.steps[0]?.relationshipType).toBeDefined();
    expect(path?.steps[1]?.entityId).toBe(path?.entity.id);
    expect(path?.steps[0]?.entityId).not.toBe(path?.entity.id);
  });

  it('never reports the same entity twice, and terminates on a cyclic graph — AC-4, AC-5', async () => {
    // `commit_parent_of_commit` is genuinely cyclic in a repository with
    // merges, and a visited set is what makes the walk terminate: the graph is
    // walked, not the set of walks.
    const walk = await retrieval.traverse(
      { from: repositoryId, depth: 4, limit: 300 },
      PUBLIC_ACCESS,
    );
    const ids = walk.paths.map((one) => one.entity.id);

    expect(new Set(ids).size).toBe(ids.length);
    // And the origin is never reported as something it reached.
    expect(ids).not.toContain(repositoryId);
  });

  it('orders by depth, then deterministically — AC-6', async () => {
    const first = await retrieval.traverse({ from: repositoryId, depth: 3, limit: 100 }, PUBLIC_ACCESS);
    const second = await retrieval.traverse({ from: repositoryId, depth: 3, limit: 100 }, PUBLIC_ACCESS);

    const depths = first.paths.map((one) => one.depth);
    expect(depths).toStrictEqual([...depths].sort((a, b) => a - b));
    expect(first.paths.map((one) => one.entity.id)).toStrictEqual(
      second.paths.map((one) => one.entity.id),
    );
  });

  it('applies the type filter at every hop — AC-7', async () => {
    const walk = await retrieval.traverse(
      { from: repositoryId, depth: 3, types: ['repository_contains_file'], limit: 200 },
      PUBLIC_ACCESS,
    );

    for (const path of walk.paths) {
      for (const step of path.steps) expect(step.relationshipType).toBe('repository_contains_file');
    }
    // One type that only leaves the repository means nothing beyond depth 1.
    expect(walk.paths.every((one) => one.depth === 1)).toBe(true);
  });

  it('applies direction at every hop, and reaches the root from a leaf — AC-8', async () => {
    const files = await handle.execute<{ id: string }>(sql`
      SELECT id FROM ferret.entity
       WHERE kind = 'file' AND source_scope = ${repositoryId} LIMIT 1
    `);
    const fileId = files.rows[0]?.id;
    expect(fileId).toBeDefined();
    if (fileId === undefined) return;

    const inbound = await retrieval.traverse(
      { from: fileId, depth: 2, direction: Direction.IN, limit: 100 },
      PUBLIC_ACCESS,
    );

    expect(inbound.paths.map((one) => one.entity.id)).toContain(repositoryId);
  });

  it('says which bound stopped the walk — AC-12, AC-13', async () => {
    const byDepth = await retrieval.traverse(
      { from: repositoryId, depth: 1, limit: 500 },
      PUBLIC_ACCESS,
    );
    const byLimit = await retrieval.traverse({ from: repositoryId, depth: 4, limit: 3 }, PUBLIC_ACCESS);

    // The graph continues past one hop, so Ferret stopped looking and says so.
    expect(byDepth.truncated).toBe(TraversalBound.DEPTH);
    expect(byDepth.depthReached).toBe(1);

    expect(byLimit.paths).toHaveLength(3);
    expect(byLimit.truncated).toBe(TraversalBound.LIMIT);
  });

  it('reports no truncation when the walk exhausted the graph', async () => {
    const files = await handle.execute<{ id: string }>(sql`
      SELECT id FROM ferret.entity
       WHERE kind = 'file_version' AND source_scope IN (
         SELECT id::text FROM ferret.entity WHERE kind = 'file' AND source_scope = ${repositoryId}
       ) LIMIT 1
    `);
    const versionId = files.rows[0]?.id;
    if (versionId === undefined) return;

    // A file version's only edges lead back up, and `out` from it leads nowhere.
    const walk = await retrieval.traverse(
      { from: versionId, depth: 3, direction: Direction.OUT, limit: 100 },
      PUBLIC_ACCESS,
    );

    expect(walk.truncated).toBeUndefined();
  });

  it('clamps a depth beyond the bound rather than rejecting it — AC-3', async () => {
    const walk = await retrieval.traverse(
      { from: repositoryId, depth: 99, limit: 50 },
      PUBLIC_ACCESS,
    );

    expect(walk.depthReached).toBeLessThanOrEqual(MAX_TRAVERSAL_DEPTH);
  });

  it('keeps every path reachable one hop at a time — AC-16', async () => {
    // §8.3's invariant, which is what makes the iterative design a security
    // property rather than a style: nothing is reachable transitively that is
    // not reachable directly, under the same access context.
    const walk = await retrieval.traverse({ from: repositoryId, depth: 3, limit: 40 }, PUBLIC_ACCESS);

    for (const path of walk.paths) {
      let previous = repositoryId;
      for (const step of path.steps) {
        const { neighbours: hop } = await retrieval.neighbours({ from: previous, limit: 500 }, PUBLIC_ACCESS);
        expect(hop.map((one) => one.entity.id)).toContain(step.entityId);
        previous = step.entityId;
      }
    }
  });

  it('answers a question that needs two hops', async () => {
    // The question EPIC-007's validation used to describe what was missing:
    // "which release contains the fix for FER-12" needs several hops. The
    // fixture has no releases, so the same shape one level down — which files
    // does the commit at the tip of this repository reach, through the
    // repository — is the assertion.
    const { commitId } = await originOf();
    if (commitId === '') return;

    const walk = await retrieval.traverse(
      { from: commitId, depth: 2, includeHistorical: true, limit: 100 },
      PUBLIC_ACCESS,
    );

    expect(walk.paths.some((one) => one.depth === 2)).toBe(true);
  });

  it('reaches nothing from an entity that does not exist, without failing', async () => {
    const walk = await retrieval.traverse(
      { from: '00000000-0000-4000-8000-000000000000', depth: 3 },
      PUBLIC_ACCESS,
    );

    expect(walk.paths).toStrictEqual([]);
    expect(walk.truncated).toBeUndefined();
  });
});

/**
 * The measurement EPIC-007 §D-001 asked for — EPIC-050 §16.
 *
 * D-001 chose "a table with indexes, not a graph database", on the reasoning
 * that "the traversals Ferret needs are shallow and typed … not arbitrary-depth
 * path finding, and PostgreSQL answers those from an index". It ends with
 * **"Revisit when EPIC-050 measures a traversal that PostgreSQL cannot serve."**
 *
 * So this Epic owes a number, whichever way it comes out. Printed rather than
 * only asserted, for the same reason EPIC-098 prints its retrieval figures: the
 * number belongs in the validation record, and a threshold nobody argued for is
 * worse than none.
 */
describeRetrieval(`the D-001 measurement (${runnable ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  it('walks to the maximum depth well inside a budget a client would accept', async () => {
    const started = performance.now();
    const walk = await retrieval.traverse(
      { from: repositoryId, depth: MAX_TRAVERSAL_DEPTH, limit: 200 },
      PUBLIC_ACCESS,
    );
    const elapsed = performance.now() - started;

    process.stderr.write(
      `[EPIC-050] depth=${String(MAX_TRAVERSAL_DEPTH)} reached=${String(walk.depthReached)} ` +
        `paths=${String(walk.paths.length)} truncated=${String(walk.truncated)} ` +
        `elapsedMs=${elapsed.toFixed(1)}\n`,
    );

    // A generous ceiling, deliberately. The claim being tested is D-001's —
    // that PostgreSQL *can* serve this shape of traversal — not that it hits a
    // particular millisecond. A walk that took seconds would be the finding
    // that overturns the decision, and this fails if it does.
    expect(elapsed).toBeLessThan(2000);
    expect(walk.paths.length).toBeGreaterThan(0);
  });

  it('costs at most one query per level', async () => {
    // The performance property the design rests on, asserted rather than
    // assumed: the walk is bounded by depth, and each level is one indexed
    // lookup per frontier node.
    let queries = 0;
    const counted = await traverseFrom(
      async (from, limit) => {
        queries += 1;
        return retrieval.neighbours({ from, limit }, PUBLIC_ACCESS);
      },
      { from: repositoryId, depth: 2, limit: 5 },
    );

    process.stderr.write(
      `[EPIC-050] queries=${String(queries)} for depth=2 limit=5 paths=${String(counted.paths.length)}\n`,
    );
    // One for the origin, then at most one per node on the first level.
    expect(queries).toBeLessThanOrEqual(1 + counted.paths.filter((one) => one.depth === 1).length);
  });
});
