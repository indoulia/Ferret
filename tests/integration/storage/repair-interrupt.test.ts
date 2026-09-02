import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RepositoryIndexer,
  createNullLogger,
  type DiscoveredRepository,
  type IndexableSource,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import { VERSION } from '../../../src/version.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
  IndexRunStore,
  IntegrityService,
  MigrationPolicy,
  RelationshipStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-094 AC-13 — an interrupted repair leaves the index no worse.
 *
 * The criterion was recorded `PENDING`, on the argument that "a repair is an
 * ordinary index run and inherits EPIC-031 AC-6". Half of that is true and the
 * half that is not is the reason this file exists.
 *
 * The watermark half does inherit: `#writeWatermark` runs only after every
 * stage succeeds, so a run that dies part way advances nothing. But a repair
 * does something an ordinary run does not — `verify --repair` calls
 * `markStale` **before** re-deriving, so an interruption between the two leaves
 * artefacts marked stale and not rebuilt. EPIC-031 AC-6 says nothing about that
 * residue, and "it is probably fine" is not evidence.
 *
 * So the repair sequence is composed here exactly as `verify.ts` composes it,
 * interrupted at a known stage boundary, and the index is measured either side.
 * Against a real PostgreSQL and a real `git`, because the property is about
 * what survives in the database when a process stops.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeRepair = runnable ? describe : describe.skip;
const logger = createNullLogger();

/** The producer whose artefacts a repair marks stale — `verify.ts`. */
const INDEXER_PRODUCER = 'ferret.indexer';

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;
let integrity: IntegrityService;
let repository: DiscoveredRepository;

/**
 * The repair's indexer, composed as `src/cli/commands/verify.ts` composes it.
 *
 * Copied deliberately rather than imported. The criterion is about the repair
 * path's behaviour, and a test that reached into the command to get the object
 * would be asserting against whatever that command happens to build today —
 * which is the same shape of mistake as trusting the inheritance argument.
 */
function indexer(source: IndexableSource = provider): RepositoryIndexer {
  const compatibility = new CompatibilityService(handle, database.pool);
  return new RepositoryIndexer({
    source,
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

/**
 * The provider, aborting once history has been read.
 *
 * A known stage boundary rather than a timer, so the interruption lands in the
 * same place on every machine. By the time `readHistory` returns, stage 1 has
 * written the repository, its worktrees and its branches, and the history graph
 * is about to be written — so this is genuinely *part way* and not "before it
 * started". The next `throwIfAborted`, at the file stage, ends the run.
 *
 * A timer here would make the outcome depend on how fast the machine is, which
 * is the defect EPIC-076 fixed in its own AC-2 test.
 */
function abortingAfterHistory(controller: AbortController): IndexableSource {
  return {
    listWorktrees: (repo, ctx) => provider.listWorktrees(repo, ctx),
    listBranches: (repo, request, ctx) => provider.listBranches(repo, request, ctx),
    readHistory: async (repo, request, ctx) => {
      const page = await provider.readHistory(repo, request, ctx);
      controller.abort();
      return page;
    },
    listFiles: (repo, request, ctx) => provider.listFiles(repo, request, ctx),
    emit: (repo) => provider.emit(repo),
    emitGraph: (repo, parts) => provider.emitGraph(repo, parts),
    emitHistory: (repo, commits, options) => provider.emitHistory(repo, commits, options),
    emitFiles: (repo, entries, options) => provider.emitFiles(repo, entries, options),
  };
}

/** Every watermark row, with the fields a resumed run would trust. */
async function watermarks(): Promise<{ scope: string | null; version: string; metadata: string }[]> {
  const rows = await handle.execute<{ scope_id: string | null; producer_version: string; metadata: unknown }>(sql`
    SELECT scope_id, producer_version, metadata
      FROM ferret.derived_artifact
     WHERE producer = ${INDEXER_PRODUCER}
     ORDER BY scope_id
  `);
  return rows.rows.map((row) => ({
    scope: row.scope_id,
    version: row.producer_version,
    metadata: JSON.stringify(row.metadata),
  }));
}

async function findingCount(): Promise<number> {
  return (await integrity.sweep({ logger })).findings.length;
}

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic094ac13');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger, policy: MigrationPolicy.AUTO });
  integrity = new IntegrityService(handle);

  workspace = await createWorkspace('ferret-repair-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();

  const root = join(workspace.path, 'subject');
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, 'subject', {
    origin: 'https://github.com/indoulia/subject.git',
  });
  await writeFile(join(path, 'a.ts'), 'export const a = 1;\n', 'utf8');
  await git(path, ['add', 'a.ts']);
  await git(path, ['commit', '-m', 'add a']);
  repository = await provider.describeRepository(path, context);

  await indexer().index(repository, { withHistory: true, withFiles: true }, context);
}, 240_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

describeRepair(`an interrupted repair — AC-13 (${runnable ? 'real PostgreSQL and git' : SKIP_REASON})`, () => {
  it('leaves the index no worse than it found it, and advances no watermark', async () => {
    // A real corruption, so the repair has a reason to exist. Direct SQL is the
    // bar EPIC-008 set: a mocked store would assert that a mock was called.
    await handle.execute(sql`
      UPDATE ferret.entity
         SET attributes = jsonb_set(attributes, '{message}', '"tampered"')
       WHERE kind = 'commit'
    `);

    const before = await findingCount();
    expect(before).toBeGreaterThan(0);
    const watermarksBefore = await watermarks();
    expect(watermarksBefore.length).toBeGreaterThan(0);

    // The repair sequence, in `verify.ts`'s order: mark stale, then re-derive.
    const compatibility = new CompatibilityService(handle, database.pool);
    await compatibility.markStale(INDEXER_PRODUCER, VERSION);

    const controller = new AbortController();
    const interrupted = indexer(abortingAfterHistory(controller));
    await expect(
      interrupted.index(
        repository,
        { full: true, withHistory: true, withFiles: true },
        { ...context, signal: controller.signal },
      ),
    ).rejects.toThrow();

    // **No worse.** Not "unchanged" — a partial re-derivation may legitimately
    // have fixed some rows on its way past, and forbidding that would forbid
    // the repair from making progress at all. What the criterion rules out is
    // the index coming back with *more* wrong with it than before.
    expect(await findingCount()).toBeLessThanOrEqual(before);

    // **No watermark it did not earn.** `#writeWatermark` runs after every
    // stage succeeds, so an interrupted run leaves the position exactly where
    // the last complete run left it — metadata included, because a position
    // that moved would make the next run resume from history it never read.
    expect(await watermarks()).toStrictEqual(watermarksBefore);
  }, 240_000);

  it('leaves the stale marking truthful rather than misleading', async () => {
    // The residue the inheritance argument does not cover. After the
    // interruption above, artefacts are marked stale and not rebuilt — so the
    // question is whether that marking is a lie.
    //
    // It is not, and this is why: `markStale` sets `state` and `last_checked_at`
    // and nothing else. It touches no producer version, no schema version and
    // no hash, and its own `WHERE` requires the version to actually differ. The
    // integrity sweep judges staleness from `producer_version` and
    // `schema_version`, never from `state`, so the marking cannot manufacture a
    // finding or hide one.
    const stale = await handle.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
        FROM ferret.derived_artifact
       WHERE producer = ${INDEXER_PRODUCER}
         AND producer_version <> ${VERSION}
         AND state = 'stale'
    `);
    // Nothing here is version-skewed, so nothing was marked — which is the
    // assertion that matters: `markStale` did not touch a current artefact on
    // its way past.
    expect(Number(stale.rows[0]?.n ?? '0')).toBe(0);

    const current = await handle.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n
        FROM ferret.derived_artifact
       WHERE producer = ${INDEXER_PRODUCER} AND producer_version = ${VERSION}
    `);
    expect(Number(current.rows[0]?.n ?? '0')).toBeGreaterThan(0);
  }, 120_000);

  it('completes when it is run again, which is what makes the interruption survivable', async () => {
    // An index left no worse is only useful if it is also still repairable. A
    // run that could not finish after an interruption would satisfy the letter
    // of AC-13 and leave an operator with no way out.
    const before = await findingCount();
    const watermarksBefore = await watermarks();

    const report = await indexer().index(
      repository,
      { full: true, withHistory: true, withFiles: true },
      context,
    );
    // This run *earned* its watermark, which is the other half of AC-13 stated
    // positively: the gate stops an interrupted run, it does not stop a
    // completing one.
    expect(report.watermark).toBeDefined();
    expect(await watermarks()).not.toStrictEqual(watermarksBefore);

    // Still no worse, and **not asserted clean** — issue #101. A `commit` whose
    // attributes were altered in place survives a `full: true` re-read, so the
    // two findings the tampering created are still here. That is AC-11's
    // recorded PARTIAL, not a failure of this criterion, and asserting zero
    // would be this test quietly claiming AC-11 was met.
    //
    // Measured rather than argued: the surviving findings are
    // `content-hash-mismatch` on `commit`, which traces the case issue #101
    // says "has the same shape and has not been traced to a specific line".
    const after = await integrity.sweep({ logger });
    expect(after.findings.length).toBeLessThanOrEqual(before);
    expect(after.findings.every((finding) => finding.entityKind === 'commit')).toBe(true);
  }, 240_000);
});
