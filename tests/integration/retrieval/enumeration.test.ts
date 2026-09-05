import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PUBLIC_ACCESS,
  RepositoryIndexer,
  boundedOffset,
  createNullLogger,
  type CanonicalEntity,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { CODE_SYMBOL_KIND, registerCodeSymbolKind } from '../../../src/code/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import {
  CompatibilityService,
  EntityStore,
  EvidenceStore,
  IndexLifecycleStore,
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
 * Enumerating a repository larger than one page — EPIC-118.
 *
 * Ferret indexes its own repository, and that is the case this suite exists
 * for: 830 tracked files against a `MAX_LIMIT` of 500. Until the store's
 * `offset` was reachable, the tool whose stated purpose is "every file in this
 * repository" could answer that question about a small repository only, and its
 * failure on a large one was **not** a short answer — the 343 files past the
 * page read to Ferret's own dogfood oracle as tracked files missing from the
 * index. A wrong answer wearing a right one's clothes.
 *
 * So every case here is about the whole set rather than the first page: reached
 * exactly once, in a stable order, confined to one repository, and carrying the
 * same provenance on page three as on page one.
 *
 * A real repository built by real `git` and read by the real indexer. A
 * hand-seeded table would page perfectly and prove only that `OFFSET` works.
 */

/**
 * More files than the page sizes below, so paging is exercised rather than
 * merely available. Small enough that `git` stays fast.
 */
const FILE_COUNT = 24;
const PAGE = 10;

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeEnumeration = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-118] SKIPPING enumeration: ${
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
let indexer: RepositoryIndexer;

/** The repository under test, and a second one that must never bleed into it. */
let subject: DiscoveredRepository;
let subjectPath: string;
let subjectId: string;
let neighbourId: string;

async function indexSubject(options: Record<string, unknown> = {}): Promise<void> {
  await indexer.index(subject, options, context);
}

/**
 * Every entity of a kind in a scope, read the way a client must read it.
 *
 * Pages until the store says there is no more, and returns what each page
 * returned rather than a set — a duplicate across a page boundary is exactly
 * what this must be able to see.
 */
async function pageAll(
  scope: string | undefined,
  kind: string,
  limit = PAGE,
): Promise<{ entities: CanonicalEntity[]; pages: number }> {
  const entities: CanonicalEntity[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = await retrieval.findEntities(
      { kind, ...(scope === undefined ? {} : { scope }), limit, offset },
      PUBLIC_ACCESS,
    );
    pages += 1;
    entities.push(...page.entities);
    if (!page.more) break;
    offset += limit;
    // A store that always says "more" would spin for ever; failing beats hanging.
    expect(pages).toBeLessThan(FILE_COUNT);
  }
  return { entities, pages };
}

function paths(entities: readonly CanonicalEntity[]): string[] {
  return entities.map((entity) => String(entity.attributes['path']));
}

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic118');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-enumeration-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
  retrieval = new RetrievalStore(handle);
  indexer = new RepositoryIndexer({
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: new CompatibilityService(handle, database.pool),
    // Without it the indexer reports the sweep as *not run* rather than
    // tombstoning a vanished file, and the delete case below would assert
    // against a repository whose deletions were never modelled.
    lifecycle: new IndexLifecycleStore(handle),
  });

  const root = join(workspace.path, 'repositories');
  await mkdir(root, { recursive: true });

  subjectPath = await createRepository(root, 'subject', {
    origin: 'https://github.com/indoulia/subject.git',
  });
  await mkdir(join(subjectPath, 'src'), { recursive: true });
  for (let i = 0; i < FILE_COUNT; i += 1) {
    await writeFile(join(subjectPath, 'src', `unit-${String(i).padStart(3, '0')}.ts`), `export const n = ${String(i)};\n`);
  }
  await git(subjectPath, ['add', '-A']);
  await git(subjectPath, ['commit', '-m', 'add the units']);

  // A second repository, so a scope that stopped applying after page one is
  // visible as another repository's rows arriving in this one's answer.
  const neighbourPath = await createRepository(root, 'neighbour', {
    origin: 'https://github.com/indoulia/neighbour.git',
  });
  await mkdir(join(neighbourPath, 'src'), { recursive: true });
  for (let i = 0; i < FILE_COUNT; i += 1) {
    await writeFile(join(neighbourPath, 'src', `unit-${String(i).padStart(3, '0')}.ts`), `export const n = ${String(i)};\n`);
  }
  await git(neighbourPath, ['add', '-A']);
  await git(neighbourPath, ['commit', '-m', 'add the units']);

  subject = await provider.describeRepository(subjectPath, context);
  subjectId = (await indexer.index(subject, {}, context)).repositoryId;
  const neighbour = await provider.describeRepository(neighbourPath, context);
  neighbourId = (await indexer.index(neighbour, {}, context)).repositoryId;
});

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

describe('where a page starts', () => {
  it('is bounded without a database', () => {
    // `MAX_LIMIT` bounds what one query returns and so protects a context
    // window. Bounding the offset too would cap how much of a repository could
    // ever be enumerated, which is the failure this exists to fix — so it is
    // deliberately unbounded above.
    expect(boundedOffset(undefined)).toBe(0);
    expect(boundedOffset(0)).toBe(0);
    expect(boundedOffset(10)).toBe(10);
    expect(boundedOffset(1_000_000)).toBe(1_000_000);
    // Rejected values fail towards the first page rather than towards a
    // database error, matching `boundedLimit`.
    expect(boundedOffset(-1)).toBe(0);
    expect(boundedOffset(1.5)).toBe(0);
    expect(boundedOffset(Number.NaN)).toBe(0);
  });
});

describeEnumeration('reading a repository larger than one page', () => {
  it('reaches every file exactly once, and knows when it is finished', async () => {
    const { entities, pages } = await pageAll(subjectId, 'file');
    const found = paths(entities);

    // README.md from the fixture's initial commit, plus the units.
    expect(found).toHaveLength(FILE_COUNT + 1);
    expect(pages).toBeGreaterThan(1);
    // No duplicate and no gap: a set the same size as the list means nothing
    // was returned twice, and the count means nothing was skipped.
    expect(new Set(found).size).toBe(found.length);
    expect(found).toContain('README.md');
    expect(found).toContain('src/unit-000.ts');
    expect(found).toContain(`src/unit-${String(FILE_COUNT - 1).padStart(3, '0')}.ts`);
  });

  it('says there is no more only when there is no more', async () => {
    const short = await retrieval.findEntities({ kind: 'file', scope: subjectId, limit: PAGE }, PUBLIC_ACCESS);
    expect(short.more).toBe(true);

    const whole = await retrieval.findEntities(
      { kind: 'file', scope: subjectId, limit: FILE_COUNT + 1 },
      PUBLIC_ACCESS,
    );
    expect(whole.more).toBe(false);
    expect(whole.entities).toHaveLength(FILE_COUNT + 1);
  });

  it('returns an empty page past the end rather than wrapping to the start', async () => {
    // A store that ignored a large offset would return page one, and a client
    // paging on `more` would loop for ever over the same rows.
    const past = await retrieval.findEntities(
      { kind: 'file', scope: subjectId, limit: PAGE, offset: 10_000 },
      PUBLIC_ACCESS,
    );
    expect(past.entities).toHaveLength(0);
    expect(past.more).toBe(false);
  });

  it('orders totally, so the same question pages the same way twice', async () => {
    const first = paths((await pageAll(undefined, 'file')).entities);
    const again = paths((await pageAll(undefined, 'file')).entities);
    expect(again).toEqual(first);

    // And the paged read agrees with the unpaged one, rather than merely being
    // stable while wrong.
    const unpaged = await retrieval.findEntities({ kind: 'file', limit: 500 }, PUBLIC_ACCESS);
    expect(paths(unpaged.entities)).toEqual(first);
  });
});

describeEnumeration('paging a kind whose sort key repeats', () => {
  /**
   * The ordering has to be **total**, and `(kind, source_id)` is not.
   *
   * No constraint says it is unique, and one kind ties in practice: a
   * `code_symbol`'s source id is the symbol's name, so every name declared in
   * two files is a tie. Ferret's own index holds 178 such groups. PostgreSQL is
   * free to order tied rows differently between two executions of the same
   * query — invisible within a single page, and corrupting to every paged
   * enumeration, because a row that moves across a page boundary is returned
   * twice or skipped entirely.
   *
   * Seeded directly rather than parsed out of source: the tie is a property of
   * the identity rule, and running the content stage to obtain one would test
   * the parser instead.
   */
  const NAME = 'Accumulator';
  let tied: string[];

  beforeAll(async () => {
    // `code_symbol` is a registered kind rather than one the core ships, so a
    // composition that wants symbols has to say so. Idempotent.
    registerCodeSymbolKind();
    const entities = new EntityStore(handle);
    tied = [];
    for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']) {
      const written = await entities.upsert({
        kind: CODE_SYMBOL_KIND,
        // Same `source.id` every time, a different scope each time — which is
        // exactly how two files declaring one name are identified.
        source: { system: 'git', id: NAME, scope: `${subjectId}:${file}` },
        attributes: {
          name: NAME,
          path: file,
          qualifiedName: `${file}#${NAME}`,
          symbolKind: 'class',
          startLine: 1,
          endLine: 2,
          startByte: 0,
          endByte: 32,
        },
      });
      tied.push(written.entity.id);
    }
  });

  it('reaches every tied row exactly once, and in the same order twice', async () => {
    const read = async (): Promise<string[]> => {
      const ids: string[] = [];
      // One at a time, so every tie sits on a page boundary — the only place
      // an unstable order can do damage.
      for (let offset = 0; offset < tied.length; offset += 1) {
        const page = await retrieval.findEntities(
          { kind: CODE_SYMBOL_KIND, limit: 1, offset },
          PUBLIC_ACCESS,
        );
        ids.push(...page.entities.map((entity) => entity.id));
      }
      return ids;
    };

    const first = await read();
    expect(first).toHaveLength(tied.length);
    expect(new Set(first).size).toBe(tied.length);
    expect([...first].sort()).toEqual([...tied].sort());
    expect(await read()).toEqual(first);
  });
});

describeEnumeration('the boundary between two sources', () => {
  it('never returns another repository the whole way through', async () => {
    // Both repositories hold `src/unit-000.ts`. A scope applied to the first
    // page and forgotten on the rest would be invisible in a small fixture and
    // catastrophic in a real one: the answer stays plausible and stops being
    // this repository's.
    const { entities } = await pageAll(subjectId, 'file');
    expect(entities.length).toBeGreaterThan(PAGE);
    expect(entities.every((entity) => entity.source.scope === subjectId)).toBe(true);
  });

  it('gives each repository its own files, not their union', async () => {
    const mine = paths((await pageAll(subjectId, 'file')).entities);
    const theirs = paths((await pageAll(neighbourId, 'file')).entities);
    const everything = paths((await pageAll(undefined, 'file')).entities);

    expect(mine).toEqual(theirs);
    expect(everything).toHaveLength(mine.length + theirs.length);
  });
});

describeEnumeration('what survives being read a page at a time', () => {
  it('carries source and path on the last page as on the first', async () => {
    // Provenance is not a property of the first page. A projection that
    // differed by page would make a citation depend on where a row happened to
    // land.
    const { entities } = await pageAll(subjectId, 'file');
    for (const entity of entities) {
      expect(entity.source.system).toBe('git');
      expect(entity.source.scope).toBe(subjectId);
      expect(entity.source.id.length).toBeGreaterThan(0);
      expect(String(entity.attributes['path']).length).toBeGreaterThan(0);
      expect(entity.contentHash.length).toBeGreaterThan(0);
    }
  });

  it('re-indexing changes neither the membership nor the order', async () => {
    // Idempotence, asserted through the enumeration rather than beside it:
    // Governance §10 says indexing twice changes nothing, and "nothing" has to
    // include the order rows come back in, or the second run silently repages.
    const before = paths((await pageAll(subjectId, 'file')).entities);
    await indexSubject();
    const after = paths((await pageAll(subjectId, 'file')).entities);

    expect(after).toEqual(before);
  });

  it('shows a file added, changed and deleted after the first page', async () => {
    // Placed past the first page by name, deliberately. A change visible only
    // within the first page would pass this suite and fail every real
    // repository — which is the whole class of defect EPIC-118 is about.
    const added = 'src/unit-900-late.ts';
    const changed = 'src/unit-000.ts';

    await writeFile(join(subjectPath, added), 'export const late = 1;\n');
    await writeFile(join(subjectPath, changed), 'export const n = 0; // edited\n');
    await git(subjectPath, ['add', '-A']);
    await git(subjectPath, ['commit', '-m', 'add one late file and edit an early one']);
    await indexSubject();

    const withAdded = await pageAll(subjectId, 'file');
    expect(paths(withAdded.entities)).toContain(added);
    expect(withAdded.pages).toBeGreaterThan(1);

    await rm(join(subjectPath, added));
    await git(subjectPath, ['add', '-A']);
    await git(subjectPath, ['commit', '-m', 'remove the late file']);
    await indexSubject();

    // A tombstone, not a disappearance: the row is retained and its lifecycle
    // says what happened, and both facts must survive paging.
    const after = await pageAll(subjectId, 'file');
    const tombstone = after.entities.find((entity) => entity.attributes['path'] === added);
    expect(tombstone?.lifecycle).toBe('deleted');

    const active = await retrieval.findEntities(
      { kind: 'file', scope: subjectId, lifecycle: 'active', limit: 500 },
      PUBLIC_ACCESS,
    );
    expect(paths(active.entities)).not.toContain(added);
    expect(paths(active.entities)).toContain(changed);
  });
});
