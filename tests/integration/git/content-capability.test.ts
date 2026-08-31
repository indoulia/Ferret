import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CAPABILITY_VERSIONS,
  Capability,
  CapabilitySupport,
  ContentUnavailable,
  ErrorCode,
  ProviderRegistry,
  RepositoryOperation,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * EPIC-108 AC-2 — the content read as a *capability operation*.
 *
 * The Git-layer test next door proves the bytes are right. This one proves the
 * route to them is the contract: the operation is declared, the declaration is
 * at a version that contains it, and a caller reaches it by asking the registry
 * for `source.repository` rather than by naming Git.
 *
 * The distinction matters because the indexer is forbidden from acquiring
 * content itself (EPIC-031 §11). If this route did not work, the only remaining
 * one would be the filesystem.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-108] SKIPPING every content-capability test: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-content-cap-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

afterAll(async () => {
  if (version === undefined) return;
  await provider.shutdown();
  await workspace.cleanup();
});

interface Fixture {
  path: string;
  discovered: DiscoveredRepository;
}

async function repository(name: string): Promise<Fixture> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, name);
  return { path, discovered: await provider.describeRepository(path, context) };
}

async function entry(fixture: Fixture, file: string): Promise<{ path: string; oid: string }> {
  const listing = await provider.listFiles(fixture.discovered, {}, context);
  const found = listing.entries.find((candidate) => candidate.path === file);
  if (found === undefined) throw new Error(`${file} is not in the tree`);
  return { path: found.path, oid: found.oid };
}

withGit('the declaration', () => {
  it('declares source.repository at version 2, naming the content operation', () => {
    const declaration = provider.capabilities.find(
      (candidate) => candidate.capability === Capability.SOURCE_REPOSITORY,
    );
    expect(declaration?.version).toBe(2);
    expect(declaration?.version).toBe(CAPABILITY_VERSIONS[Capability.SOURCE_REPOSITORY]);
    expect(declaration?.operations).toContain(RepositoryOperation.READ_CONTENT);
  });

  it('is selectable for the content operation through the registry, by capability', () => {
    // The property EPIC-031 §11 depends on. A caller that had to import the Git
    // provider to read content would have made the indexer's security contract
    // unsatisfiable.
    const registry = new ProviderRegistry();
    registry.register(new GitSourceProvider());

    const verdict = registry.supports(Capability.SOURCE_REPOSITORY, RepositoryOperation.READ_CONTENT);
    expect(verdict.support).toBe(CapabilitySupport.SUPPORTED);
    expect(verdict.declaredVersion).toBe(2);
  });

  it('still declares every operation it had at version 1', () => {
    // Raising a version must not quietly drop anything. A consumer of the older
    // contract keeps working, which is what the unchanged minimum promises.
    const declaration = provider.capabilities.find(
      (candidate) => candidate.capability === Capability.SOURCE_REPOSITORY,
    );
    expect(declaration?.operations).toStrictEqual([
      RepositoryOperation.DISCOVER,
      RepositoryOperation.DESCRIBE,
      RepositoryOperation.LIST_WORKTREES,
      RepositoryOperation.LIST_BRANCHES,
      RepositoryOperation.READ_HISTORY,
      RepositoryOperation.LIST_FILES,
      RepositoryOperation.READ_CONTENT,
    ]);
  });
});

withGit('the operation', () => {
  it('returns the bytes a tree entry addresses', async () => {
    const fixture = await repository('capability-read');
    await writeFile(join(fixture.path, 'app.ts'), 'export const x = 1;\n', 'utf8');
    await git(fixture.path, ['add', 'app.ts']);
    await git(fixture.path, ['commit', '-m', 'app']);

    const target = await entry(fixture, 'app.ts');
    const result = await provider.readFileContent(fixture.discovered, target, context);

    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('export const x = 1;\n');
    expect(result.sizeBytes).toBe(20);
  });

  it('reads the revision, not the working tree', async () => {
    const fixture = await repository('capability-revision');
    await writeFile(join(fixture.path, 'mod.ts'), 'export const committed = true;\n', 'utf8');
    await git(fixture.path, ['add', 'mod.ts']);
    await git(fixture.path, ['commit', '-m', 'mod']);
    const target = await entry(fixture, 'mod.ts');

    await writeFile(join(fixture.path, 'mod.ts'), 'export const edited = true;\n', 'utf8');

    const result = await provider.readFileContent(fixture.discovered, target, context);
    expect(result.read).toBe(true);
    if (!result.read) return;
    expect(Buffer.from(result.bytes).toString('utf8')).toContain('committed');
  });

  it('answers the byte bound in the contract vocabulary', async () => {
    const fixture = await repository('capability-bound');
    await writeFile(join(fixture.path, 'wide.txt'), 'z'.repeat(40_000), 'utf8');
    await git(fixture.path, ['add', 'wide.txt']);
    await git(fixture.path, ['commit', '-m', 'wide']);

    const result = await provider.readFileContent(
      fixture.discovered,
      { ...(await entry(fixture, 'wide.txt')), maxBytes: 512 },
      context,
    );

    expect(result.read).toBe(false);
    if (result.read) return;
    expect(result.reason).toBe(ContentUnavailable.TOO_LARGE);
  });

  it('answers a missing object in the contract vocabulary', async () => {
    const fixture = await repository('capability-missing');
    const result = await provider.readFileContent(
      fixture.discovered,
      { path: 'gone.ts', oid: '0000000000000000000000000000000000000001' },
      context,
    );

    expect(result.read).toBe(false);
    if (result.read) return;
    expect(result.reason).toBe(ContentUnavailable.NOT_FOUND);
  });

  it('fails the operation when the run was cancelled', async () => {
    // AC-10 depends on this: a cancelled content stage must leave the run
    // unsuccessful, which it cannot do if a cancelled read comes back as a
    // reportable verdict alongside the ordinary ones.
    const fixture = await repository('capability-cancelled');
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.readFileContent(fixture.discovered, await entry(fixture, 'README.md'), {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPTED });
  });
});
