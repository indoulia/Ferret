import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ParserFramework,
  RepositoryIndexer,
  createNullLogger,
  loadGoldenDataset,
  measureRetrievalQuality,
  resolveIdentity,
  type GoldenDataset,
} from '../../../src/index.js';
import { PUBLIC_ACCESS } from '../../../src/retrieval/index.js';
import { CORPUS_SCOPE } from '../../../src/evaluation/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import {
  CompatibilityService,
  ContentStore,
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  RetrievalStore,
  SymbolStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { ProviderRegistry, discoverProviders } from '../../../src/providers/index.js';
import { FERRET_PARSERS_MODULE, loadFerretParsers } from '../../../src/cli/commands/parser-composition.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * The golden dataset and the indexer agree about identity — EPIC-096 AC-4.
 *
 * The unit tests prove the dataset is internally consistent, which is a claim
 * about the dataset alone. This is the claim that matters to a harness: that a
 * label written against source identity resolves to an entity Ferret actually
 * wrote. It cannot be proved without indexing, and it is the difference between
 * a dataset that measures Ferret and one that measures itself.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeGolden = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-096] SKIPPING the golden dataset index: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let dataset: GoldenDataset;
let repositoryId: string;
let retrieval: RetrievalStore;

/**
 * Builds the corpus into a real repository, one commit per history entry.
 *
 * Author, email and timestamps come from the dataset rather than from the clock,
 * so two runs on two machines produce the same history. A golden dataset whose
 * corpus differs per run is not golden.
 */
async function buildCorpusRepository(root: string): Promise<string> {
  const path = await createRepository(root, 'ledger', {
    origin: 'https://github.com/indoulia/ledger.git',
  });

  const started = Date.parse(dataset.history.startedAt);
  for (const [index, commit] of dataset.history.commits.entries()) {
    for (const file of commit.files) {
      const target = join(path, ...file.split(posix.sep));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        readFileSync(join(dataset.root, 'corpus', ...file.split(posix.sep)), 'utf8'),
      );
    }
    await git(path, ['add', ...commit.files]);
    // One minute apart, from a fixed start, so ordering is deterministic and the
    // commits do not all share a timestamp.
    const when = new Date(started + index * 60_000).toISOString();
    await git(
      path,
      [
        '-c',
        `user.name=${dataset.history.author.name}`,
        '-c',
        `user.email=${dataset.history.author.email}`,
        'commit',
        '--date',
        when,
        '-m',
        commit.subject,
      ],
      { GIT_COMMITTER_DATE: when },
    );
  }
  return path;
}

beforeAll(async () => {
  if (!runnable) return;
  dataset = loadGoldenDataset();

  database = await createTestDatabase('epic096');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-golden-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  const context = createTestOperationContext();

  const path = await buildCorpusRepository(workspace.path);
  const discovered = await provider.describeRepository(path, context);

  // Content indexing is on — EPIC-087 AC-11.
  //
  // Before EPIC-087 the harness measured an index that had never opened a file,
  // and `text-authentication` scored 0.00 because `authenticate` appears in
  // `login.ts`'s body and in no path. Measuring the same corpus without content
  // now would measure a capability the product no longer lacks.
  //
  // Composed through discovery, exactly as `ferret index --content` does.
  const registry = new ProviderRegistry();
  await discoverProviders(registry, [FERRET_PARSERS_MODULE], loadFerretParsers);
  const compatibility = new CompatibilityService(handle, database.pool);

  const indexer = new RepositoryIndexer({
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: compatibility,
    content: provider,
    symbols: new SymbolStore(handle),
    parser: new ParserFramework({ registry }),
    artifacts: compatibility,
    blobs: new ContentStore(handle),
  });
  await indexer.index(discovered, { withHistory: true, withFiles: true, withContent: true }, context);

  const found = await database.pool.query(
    `SELECT id FROM ferret.entity WHERE kind = 'repository' LIMIT 1`,
  );
  repositoryId = (found.rows[0] as { id: string }).id;
  retrieval = new RetrievalStore(handle);
}, 120_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

describeGolden(`the golden dataset against a real index (${runnable ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  it('indexed the corpus, so the assertions below are not vacuous', async () => {
    const files = await database.pool.query(
      `SELECT count(*)::int AS n FROM ferret.entity WHERE kind = 'file'`,
    );
    expect((files.rows[0] as { n: number }).n).toBe(dataset.corpus.length);
    expect(repositoryId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('resolves every expected result to an entity Ferret wrote — AC-4', async () => {
    // The criterion the whole dataset rests on. A label that resolves to nothing
    // scores zero in a harness, and zero is indistinguishable from "retrieval
    // returned the wrong thing" — so it must fail here instead, loudly.
    for (const query of dataset.queries) {
      for (const expected of query.expected) {
        const id = resolveIdentity(expected, { [CORPUS_SCOPE]: repositoryId });
        const row = await database.pool.query(`SELECT id FROM ferret.entity WHERE id = $1`, [id]);

        expect(row.rowCount, `${query.id} → ${expected.sourceId}`).toBe(1);
      }
    }
  });

  it('holds the evidence each expectation requires — AC-7', async () => {
    for (const expectation of dataset.evidence) {
      const id = resolveIdentity(expectation.subject, { [CORPUS_SCOPE]: repositoryId });
      const held = await database.pool.query(
        `SELECT count(*)::int AS n FROM ferret.evidence WHERE subject_id = $1`,
        [id],
      );

      expect(
        (held.rows[0] as { n: number }).n,
        `${expectation.id} → ${expectation.subject.sourceId}`,
      ).toBeGreaterThanOrEqual(expectation.atLeast);
    }
  });

  it('records every commit subject the history declares, exactly once', async () => {
    // By subject rather than by count. The fixture's own initialising commit
    // exists too, so a total would assert a fact about `createRepository` rather
    // than about the dataset — and "exactly once" is the property a label
    // actually needs, since a duplicated subject would make a text query
    // ambiguous.
    const rows = await database.pool.query(
      `SELECT attributes->>'message' AS message FROM ferret.entity WHERE kind = 'commit'`,
    );
    const messages = rows.rows.map((row) => (row as { message: string | null }).message ?? '');

    for (const commit of dataset.history.commits) {
      const matching = messages.filter((message) => message.startsWith(commit.subject));
      expect(matching.length, commit.subject).toBe(1);
    }
  });

  it('contains nothing matching an absence label', async () => {
    // Proved against the stored text rather than through retrieval, deliberately.
    // Whether *search* returns nothing is EPIC-098's measurement; whether the
    // corpus contains the term at all is this Epic's, and if it does the label is
    // simply wrong.
    for (const absent of dataset.queries.filter((query) => query.expected.length === 0)) {
      const hit = await database.pool.query(
        `SELECT count(*)::int AS n FROM ferret.entity WHERE attributes::text ILIKE $1`,
        [`%${absent.query}%`],
      );

      expect((hit.rows[0] as { n: number }).n, absent.id).toBe(0);
    }
  });
});

/**
 * The first measured retrieval figures Ferret has — EPIC-098.
 *
 * Shares this file's indexed corpus rather than building a second one: the
 * measurement needs exactly what EPIC-096's fixture already produces, and
 * indexing it twice would double the slowest part of the suite to keep two Epics
 * in separate files.
 *
 * **The assertions are about the report's shape, never its figures.** A test that
 * asserted `meanNdcg > 0.8` would make improving retrieval a build failure and
 * would freeze whatever the first run happened to produce into a requirement
 * nobody argued for. EPIC-096 §4 deferred the threshold decision here precisely
 * so it could be argued from data; the data is printed below and the decision is
 * recorded in the Epic's §16.
 */
describeGolden(`measuring retrieval against the golden dataset (${runnable ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  it('produces a well-formed report over every labelled query — AC-4, AC-6', async () => {
    const report = await measureRetrievalQuality(
      dataset,
      retrieval,
      { corpus: repositoryId },
      { access: PUBLIC_ACCESS },
    );

    // Printed, not asserted. This is the number the Epic exists to produce, and
    // it belongs in the validation record rather than in an expectation.
    process.stderr.write(`
[EPIC-098] ${JSON.stringify(report.aggregate)}
`);
    for (const one of report.queries) {
      process.stderr.write(
        `[EPIC-098] ${one.id.padEnd(22)} returned=${String(one.returned)} ` +
          `p@k=${String(one.precisionAtK)} recall=${String(one.recall)} ` +
          `rr=${String(one.reciprocalRank)} ndcg=${String(one.ndcg)} ` +
          `fp=${String(one.falsePositives)}
`,
      );
    }

    expect(report.queries).toHaveLength(dataset.queries.length);
    expect(report.aggregate.measured).toBeGreaterThan(0);
    expect(report.dataset.checksum).toBe(dataset.checksum);

    // The one threshold this Epic gates on, and the only one the data supports —
    // EPIC-098 §16. A result returned for a term that appears nowhere in the
    // corpus is a defect under any floor anyone would later choose, so it is safe
    // to fail a build on. The four scored means are deliberately NOT asserted:
    // 8 labels over 11 files is too small to turn into a requirement, and
    // freezing today's 0.32 precision as a floor would enshrine a number nobody
    // argued for.
    expect(report.aggregate.falsePositives).toBe(0);
  });

  it('reports which entity kinds a text query actually reaches', async () => {
    // Not a diagnostic left behind by accident. The first measurement scored
    // `text-authentication` at zero, and the reason is a property of the product
    // rather than of the label: a term that appears only in a commit message
    // reaches the commit, never the file that commit touched. Recording the kinds
    // here is what makes that claim checkable rather than asserted, and it is the
    // measured form of the EPIC-087 gap the validation record cites.
    const kinds = new Map<string, readonly string[]>();
    for (const label of dataset.queries.filter((query) => query.shape === 'text')) {
      const result = await retrieval.search({ text: label.query }, PUBLIC_ACCESS);
      kinds.set(label.id, result.hits.map((hit) => hit.entity.kind));
      process.stderr.write(
        `[EPIC-098] ${label.id} "${label.query}" reached: ${result.hits.map((hit) => hit.entity.kind).join(', ') || '(nothing)'}\n`,
      );
    }

    // A text query reaches something for at least one label, so the zero above
    // is a ranking/coverage result and not a broken query path.
    expect([...kinds.values()].some((found) => found.length > 0)).toBe(true);
  });

  it('never reports NaN — AC-11', async () => {
    const report = await measureRetrievalQuality(dataset, retrieval, { corpus: repositoryId });

    for (const value of Object.values(report.aggregate)) {
      if (typeof value === 'number') expect(Number.isNaN(value)).toBe(false);
    }
    for (const one of report.queries) {
      for (const value of [one.precisionAtK, one.recall, one.reciprocalRank, one.ndcg]) {
        if (value !== undefined) expect(Number.isNaN(value)).toBe(false);
      }
    }
  });
});
