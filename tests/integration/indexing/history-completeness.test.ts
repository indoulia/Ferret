import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RepositoryIndexer, createNullLogger, type DiscoveredRepository, type ProviderOperationContext } from '../../../src/index.js';
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
 * History completeness — the forensic fixture.
 *
 * One question, asked four ways: **after Ferret says it indexed a repository,
 * is every commit in that repository in the graph?**
 *
 * Each case here reproduces one finding of the post-roadmap forensic pass
 * (`docs/evidence/FERRET-POST-ROADMAP-FORENSIC.md`), and all four share a root:
 * history was resumed by *commit date* from a *bounded* page. A date is not a
 * position — it is a value the repository chooses, it does not order the commit
 * graph, and the newest commit of a page is not the newest commit of a
 * repository when the page was cut short.
 *
 * These assert the requirement, not the mechanism. None of them names a cursor,
 * a watermark or a page size: they count commits in a repository, count commits
 * in the graph, and compare. An implementation that resumes some other correct
 * way passes them unchanged.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeHistory = runnable ? describe : describe.skip;
const logger = createNullLogger();

/** 2020-01-01T00:00:00Z, in seconds. Every fixture date is an offset from it. */
const EPOCH = Math.floor(Date.parse('2020-01-01T00:00:00Z') / 1000);

/** More than `MAX_COMMITS_PER_READ`, so one page cannot hold the history. */
const DEEP_COMMITS = 1005;

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

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

/** Every commit reachable from `rev`, newest first. */
async function commitsIn(root: string, rev = 'HEAD'): Promise<readonly string[]> {
  const out = await git(root, ['log', '--format=%H', rev]);
  return out.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Which of `shas` reached the graph as a commit Ferret actually read.
 *
 * A commit entity written as a *placeholder* — the gap-filler for a parent the
 * run did not read — carries a sha and nothing else. It is not history; it is a
 * promise that something exists. `message IS NOT NULL` is what separates the
 * two, and it is why this asks for read commits rather than for rows.
 */
async function readCommits(shas: readonly string[]): Promise<Set<string>> {
  if (shas.length === 0) return new Set();
  const rows = await handle.execute<{ [column: string]: unknown; source_id: string }>(
    sql`SELECT source_id FROM ferret.entity
         WHERE kind = 'commit'
           AND attributes ? 'message'
           AND source_id = ANY(${sql.raw(`ARRAY[${shas.map((sha) => `'${sha}'`).join(',')}]::text[]`)})`,
  );
  return new Set(rows.rows.map((row) => row.source_id));
}

/** The commits of `rev` that are missing from the graph, oldest first. */
async function missingFrom(root: string, rev = 'HEAD'): Promise<readonly string[]> {
  const all = await commitsIn(root, rev);
  const held = await readCommits(all);
  return [...all].reverse().filter((sha) => !held.has(sha));
}

/**
 * Writes a linear history of `count` commits with `git fast-import`.
 *
 * One commit per second from `EPOCH`, oldest first. Plain `git commit` would be
 * a thousand subprocesses — a minute of the suite's time to build a fixture
 * whose only interesting property is that it is longer than one page.
 *
 * Imported onto its own ref and then `reset --hard`, because the fixture
 * repository already has a seed commit this history does not descend from, and
 * `fast-import` refuses to move a branch to an unrelated tip.
 */
function importLinearHistory(root: string, count: number): void {
  const lines: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const when = EPOCH + index;
    const message = `commit ${String(index)}\n`;
    lines.push('commit refs/heads/imported');
    lines.push(`mark :${String(index)}`);
    lines.push(`author Ada <ada@example.com> ${String(when)} +0000`);
    lines.push(`committer Ada <ada@example.com> ${String(when)} +0000`);
    lines.push(`data ${String(Buffer.byteLength(message, 'utf8'))}`);
    lines.push(message.trimEnd());
    if (index > 1) lines.push(`from :${String(index - 1)}`);
    if (index === 1) {
      const body = 'seed\n';
      lines.push(`M 100644 inline history.txt`);
      lines.push(`data ${String(Buffer.byteLength(body, 'utf8'))}`);
      lines.push(body.trimEnd());
    }
    lines.push('');
  }
  lines.push('done');
  execFileSync('git', ['fast-import', '--done', '--quiet'], {
    cwd: root,
    input: `${lines.join('\n')}\n`,
    windowsHide: true,
    shell: false,
  });
}

/** A commit on the current branch, at a pinned instant. */
async function commitAt(root: string, path: string, at: number): Promise<void> {
  await writeFile(join(root, path), `${path}@${String(at)}\n`, 'utf8');
  await git(root, ['add', path]);
  const when = new Date(at * 1000).toISOString();
  await git(root, ['commit', '-m', `write ${path}`], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('history_completeness');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger, policy: MigrationPolicy.AUTO });
  workspace = await createWorkspace('ferret-history-');
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

describeHistory(`history completeness (${runnable ? 'real PostgreSQL and git' : SKIP_REASON})`, () => {
  it('reads a repository deeper than one page — F-01', async () => {
    const repository = await fixture('deep');
    importLinearHistory(repository.root, DEEP_COMMITS);
    await git(repository.root, ['reset', '--hard', 'imported']);

    const report = await indexer().index(
      repository,
      { withHistory: true, withFiles: false, withChanges: false },
      context,
    );

    const all = await commitsIn(repository.root);
    expect(all).toHaveLength(DEEP_COMMITS);
    expect({
      missing: (await missingFrom(repository.root)).length,
      commitsRead: report.commitsRead,
    }).toStrictEqual({ missing: 0, commitsRead: DEEP_COMMITS });
  }, 600_000);

  it('cannot be repaired by a later run, and --full is not a way back — F-01', async () => {
    const repository = await fixture('deep-full');
    importLinearHistory(repository.root, DEEP_COMMITS);
    await git(repository.root, ['reset', '--hard', 'imported']);
    const index = indexer();

    await index.index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);
    await index.index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);
    await index.index(repository, { withHistory: true, withFiles: false, withChanges: false, full: true }, context);

    expect(await missingFrom(repository.root)).toStrictEqual([]);
  }, 900_000);

  it('pages a resumed read without leaving the walk it resumed — F-01', async () => {
    const repository = await fixture('paged-resume');
    const root = repository.root;
    await commitAt(root, 'm1.txt', EPOCH + 1);
    const indexed = (await commitsIn(root))[0] as string;

    // A back-dated branch, merged after `indexed`. What is new is therefore not
    // a prefix of the full history: the two walks interleave, which is the only
    // arrangement in which paging out of the filtered walk is visible.
    await git(root, ['checkout', '-b', 'wide', indexed]);
    for (let index = 0; index < 6; index += 1) {
      await commitAt(root, `w${String(index)}.txt`, EPOCH + 5 + index);
    }
    await git(root, ['checkout', 'main']);
    await commitAt(root, 'm2.txt', EPOCH + 40);
    const mergeAt = new Date((EPOCH + 50) * 1000).toISOString();
    await git(root, ['merge', '--no-ff', 'wide', '-m', 'merge wide'], {
      GIT_AUTHOR_DATE: mergeAt,
      GIT_COMMITTER_DATE: mergeAt,
    });

    // What `git log HEAD ^indexed` holds is the answer the provider must give,
    // however many pages it takes to give it.
    const expected = (await git(root, ['log', '--format=%H', 'HEAD', `^${indexed}`]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort();

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: { commits: readonly { sha: string }[]; cursor: string | undefined } =
        await provider.readHistory(
          repository,
          { limit: 2, exclude: [indexed], ...(cursor === undefined ? {} : { cursor }) },
          context,
        );
      collected.push(...page.commits.map((commit) => commit.sha));
      cursor = page.cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 20);

    expect({ commits: [...collected].sort(), pages: pages > 1 }).toStrictEqual({
      commits: expected,
      pages: true,
    });
  }, 180_000);

  it('keeps a second branch whose commits predate the first branch tip — F-02', async () => {
    const repository = await fixture('branches');
    const root = repository.root;
    await commitAt(root, 'm1.txt', EPOCH + 1);
    const base = (await commitsIn(root))[0] as string;
    await commitAt(root, 'm2.txt', EPOCH + 20);

    await indexer().index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);

    // Forked from the first commit, and finished before `main`'s tip was made.
    await git(root, ['checkout', '-b', 'feature', base]);
    await commitAt(root, 'f1.txt', EPOCH + 5);
    await commitAt(root, 'f2.txt', EPOCH + 6);

    await indexer().index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);

    expect(await missingFrom(root, 'feature')).toStrictEqual([]);
  }, 180_000);

  it('keeps ingesting after a commit dated in the future — F-03', async () => {
    const repository = await fixture('skew');
    const root = repository.root;
    await commitAt(root, 'a.txt', EPOCH + 1);
    // One wrong clock, or one `git commit --date`.
    await commitAt(root, 'b.txt', Math.floor(Date.parse('2035-06-01T00:00:00Z') / 1000));

    await indexer().index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);

    await commitAt(root, 'c.txt', EPOCH + 10);
    await commitAt(root, 'd.txt', EPOCH + 11);

    const second = await indexer().index(
      repository,
      { withHistory: true, withFiles: false, withChanges: false },
      context,
    );

    expect({ missing: await missingFrom(root), read: second.commitsRead > 0 }).toStrictEqual({
      missing: [],
      read: true,
    });
  }, 180_000);

  it('reads a back-dated branch merged after the last run — F-04', async () => {
    const repository = await fixture('backdate');
    const root = repository.root;
    await commitAt(root, 'm1.txt', EPOCH + 1);
    const base = (await commitsIn(root))[0] as string;
    await commitAt(root, 'm2.txt', EPOCH + 10);

    await indexer().index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);

    // A branch older than the watermark, merged after it.
    await git(root, ['checkout', '-b', 'topic', base]);
    await commitAt(root, 't1.txt', EPOCH + 5);
    await commitAt(root, 't2.txt', EPOCH + 6);
    const merged = await commitsIn(root, 'topic');
    await git(root, ['checkout', 'main']);
    const mergeAt = new Date((EPOCH + 30) * 1000).toISOString();
    await git(root, ['merge', '--no-ff', 'topic', '-m', 'merge topic'], {
      GIT_AUTHOR_DATE: mergeAt,
      GIT_COMMITTER_DATE: mergeAt,
    });

    await indexer().index(repository, { withHistory: true, withFiles: false, withChanges: false }, context);

    // Not "an entity exists" — a placeholder satisfies that. These commits must
    // be present as history, with the message the repository actually holds.
    const held = await readCommits(merged);
    expect([...merged].filter((sha) => !held.has(sha))).toStrictEqual([]);
  }, 180_000);
});
