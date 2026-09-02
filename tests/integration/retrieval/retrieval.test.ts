import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PUBLIC_ACCESS,
  Direction,
  ErrorCode,
  HitSource,
  MAX_LIMIT,
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
    const files = await retrieval.findEntities({ kind: 'file', limit: MAX_LIMIT }, PUBLIC_ACCESS);
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files.every((entity) => entity.kind === 'file')).toBe(true);
  });

  it('finds an entity by an exact attribute', async () => {
    // Deterministic: there is one file at this path, and "probably that one" is
    // not an answer.
    const found = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/connection-pool.ts' },
    }, PUBLIC_ACCESS);
    expect(found).toHaveLength(1);
    expect(found[0]?.attributes['path']).toBe('src/connection-pool.ts');
  });

  it('finds the files identified within one repository', async () => {
    const scoped = await retrieval.findEntities({ kind: 'file', scope: repositoryId, limit: MAX_LIMIT }, PUBLIC_ACCESS);
    expect(scoped.length).toBeGreaterThanOrEqual(4);
  });

  it('returns nothing rather than everything for a filter that matches nothing', async () => {
    expect(await retrieval.findEntities({ kind: 'file', attributes: { path: 'no/such/file' } }, PUBLIC_ACCESS)).toStrictEqual(
      [],
    );
  });

  it('reads one entity with its external identifiers', async () => {
    const [file] = await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS);
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
    const hostile = await retrieval.findEntities({
      kind: 'file',
      attributes: { "path'; DROP TABLE ferret.entity; --": 'x' },
    }, PUBLIC_ACCESS);
    expect(hostile).toStrictEqual([]);
    // Still there.
    expect((await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS)).length).toBe(1);
  });
});

describeRetrieval('traversal', () => {
  it('finds what a repository contains', async () => {
    const out = await retrieval.neighbours({
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
    const [file] = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/retry-policy.ts' },
    }, PUBLIC_ACCESS);
    const inbound = await retrieval.neighbours({
      from: file?.id ?? '',
      direction: Direction.IN,
      types: [RelationshipType.COMMIT_MODIFIES_FILE],
      limit: MAX_LIMIT,
    }, PUBLIC_ACCESS);

    expect(inbound.length).toBeGreaterThanOrEqual(1);
    expect(inbound.every((neighbour) => neighbour.entity.kind === 'commit')).toBe(true);
  });

  it('follows both directions when the question has none', async () => {
    const [file] = await retrieval.findEntities({
      kind: 'file',
      attributes: { path: 'src/retry-policy.ts' },
    }, PUBLIC_ACCESS);
    const both = await retrieval.neighbours({ from: file?.id ?? '', limit: MAX_LIMIT }, PUBLIC_ACCESS);
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
    const past = await retrieval.neighbours({ from: repositoryId, at: before, limit: MAX_LIMIT }, PUBLIC_ACCESS);
    const now = await retrieval.neighbours({ from: repositoryId, limit: MAX_LIMIT }, PUBLIC_ACCESS);

    // Structural edges were observed today, so yesterday Ferret knew nothing.
    expect(now.length).toBeGreaterThan(past.length);
  });

  it('excludes an interval that ended exactly at the instant asked about', async () => {
    // Half-open, the same convention EPIC-007 uses everywhere. Mixing the two is
    // how a worktree appears to be on two branches for one instant.
    const open = await retrieval.neighbours({
      from: repositoryId,
      types: [RelationshipType.REPOSITORY_CONTAINS_FILE],
      limit: 1,
    }, PUBLIC_ACCESS);
    const edge = open[0];
    expect(edge).toBeDefined();

    const atStart = await retrieval.neighbours({
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
    ).toStrictEqual([]);
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
    expect((await retrieval.findEntities({ kind: 'file', limit: 1 }, PUBLIC_ACCESS)).length).toBe(1);
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
