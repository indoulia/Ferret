import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';

import {
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
 * EPIC-082 end to end.
 *
 * Credentials below are AWS's documented examples and syntactically valid but
 * never-issued tokens. No real credential is in this tree.
 */

const version = await gitVersion();
const runnable = version !== undefined && databaseAvailable();
const describeSecrets = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(
    `\n[EPIC-082] SKIPPING secret exclusion: ${
      version === undefined ? 'the `git` executable was not found on PATH' : SKIP_REASON
    }.\n\n`,
  );
}

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GH_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

let database: TestDatabase;
let handle: FerretDatabase;
let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;
let fixture: { path: string; discovered: DiscoveredRepository };

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic082');
  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });

  workspace = await createWorkspace('ferret-secrets-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();

  const root = join(workspace.path, 'leaky');
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, 'leaky', {
    origin: 'https://github.com/indoulia/leaky.git',
  });

  await writeFile(join(path, '.env'), `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY\n`);
  await writeFile(join(path, '.env.example'), 'AWS_SECRET_ACCESS_KEY=\n');
  await mkdir(join(path, 'certs'), { recursive: true });
  await writeFile(join(path, 'certs', 'server.pem'), 'not a real key\n');
  await writeFile(join(path, 'app.js'), 'export const x = 1;\n');
  await git(path, ['add', '-A']);
  await git(path, ['commit', '-m', `rotate ${AWS_KEY}; new token ${GH_TOKEN}`]);

  fixture = { path, discovered: await provider.describeRepository(path, context) };

  await new RepositoryIndexer({
    source: provider,
    entities: new EntityStore(handle),
    relationships: new RelationshipStore(handle),
    evidence: new EvidenceStore(handle),
    watermarks: new CompatibilityService(handle, database.pool),
    lifecycle: new IndexLifecycleStore(handle),
  }).index(fixture.discovered, {}, context);
}, 180_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
  await database.drop();
});

/** Every text column that could carry an indexed credential. */
async function scanDatabase(needle: string): Promise<number> {
  const { rows } = await database.pool.query<{ n: string }>(
    `SELECT (
       (SELECT count(*) FROM ferret.entity WHERE attributes::text LIKE $1 OR source_id LIKE $1)
     + (SELECT count(*) FROM ferret.evidence WHERE statement::text LIKE $1)
     + (SELECT count(*) FROM ferret.relationship WHERE metadata::text LIKE $1)
     )::text AS n`,
    [`%${needle}%`],
  );
  return Number(rows[0]?.n ?? '0');
}

describeSecrets('a repository carrying credentials', () => {
  it('stores none of them, anywhere', async () => {
    // The check that matters: not "the commit message is redacted" but "the
    // value is absent from the database", which is the property a leak breaks.
    expect(await scanDatabase(AWS_KEY)).toBe(0);
    expect(await scanDatabase(GH_TOKEN)).toBe(0);
    expect(await scanDatabase('wJalrXUtnFEMIK7MDENGbPxRfiCY')).toBe(0);
  });

  it('keeps the commit message readable around the redaction', async () => {
    const { rows } = await database.pool.query<{ message: string }>(
      `SELECT attributes->>'message' AS message FROM ferret.entity
        WHERE kind = 'commit' AND attributes->>'message' LIKE 'rotate%'`,
    );
    const message = rows[0]?.message ?? '';
    expect(message).toContain('[redacted: aws-access-key-id]');
    expect(message).toContain('[redacted: github-token]');
    expect(message).toContain('rotate');
  });

  it('does not index a secret-bearing file', async () => {
    const { rows } = await database.pool.query<{ path: string }>(
      `SELECT attributes->>'path' AS path FROM ferret.entity WHERE kind = 'file'`,
    );
    const paths = rows.map((row) => row.path);

    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('certs/server.pem');
    // ...while everything else is still there, including the example file that
    // documents what the project needs.
    expect(paths).toContain('app.js');
    expect(paths).toContain('.env.example');
  });

  it('reports what it skipped, rather than leaving it to be inferred', async () => {
    const report = await new RepositoryIndexer({
      source: provider,
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      watermarks: new CompatibilityService(handle, database.pool),
      lifecycle: new IndexLifecycleStore(handle),
    }).index(fixture.discovered, { full: true }, context);

    const secretSkips = report.skipped.filter((skip) => skip.reason === 'secret-bearing path');
    expect(secretSkips.map((skip) => skip.path).sort()).toStrictEqual(['.env', 'certs/server.pem']);
  }, 120_000);
});
