import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActorClass, type DiscoveredRepository, type ProviderOperationContext } from '../../../src/index.js';
import {
  GitSourceProvider,
  MAX_SAMPLED_PATHS,
  describeEngineeringContext,
  parseStatus,
} from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * EPIC-037 and EPIC-038 — where the work is happening.
 *
 * Against real Git throughout. The state of a working tree is not a thing to
 * mock: the whole value of this Epic is that it reports what `git status`
 * reports, and a mock would prove only that the parser agrees with itself.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

async function repository(name: string): Promise<{ path: string }> {
  const path = await createRepository(workspace.path, name);
  await git(path, ['config', 'user.email', 'ada@example.invalid']);
  await git(path, ['config', 'user.name', 'Ada Lovelace']);
  return { path };
}

function options(): Parameters<typeof describeEngineeringContext>[1] {
  return {
    describeRepository: async (root: string): Promise<DiscoveredRepository> =>
      provider.describeRepository(root, context),
  };
}

/**
 * Compares two paths as the filesystem sees them.
 *
 * Not a string comparison. On Windows the CI runner's temp directory is reached
 * through its 8.3 short name — `C:\Users\RUNNER~1\...` — while
 * `git rev-parse --show-toplevel` correctly returns the long form. Both name the
 * same directory, and asserting on the spelling made a green suite fail on CI
 * for a difference that is not a defect. `realpath` resolves both to the
 * canonical form; case is folded because Windows paths are case-insensitive.
 */
async function expectSamePath(actual: string | undefined, expected: string): Promise<void> {
  expect(actual).toBeDefined();
  const canonical = async (path: string): Promise<string> => {
    const resolved = await realpath(path);
    const forward = resolved.replace(/\\/g, '/');
    return process.platform === 'win32' ? forward.toLowerCase() : forward;
  };
  expect(await canonical(actual ?? '')).toBe(await canonical(expected));
}

/** Every ref and HEAD, so a mutation of any kind would be visible. */
async function snapshot(path: string): Promise<string> {
  const refs = await git(path, ['show-ref', '--head']).catch(() => '');
  const head = await git(path, ['rev-parse', '--symbolic-full-name', 'HEAD']).catch(() => '');
  const status = await git(path, ['status', '--porcelain=v2', '--branch']);
  return `${String(refs)}|${String(head)}|${String(status)}`;
}

beforeAll(async () => {
  workspace = await createWorkspace('engineering-context');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
}, 120_000);

afterAll(async () => {
  await provider?.shutdown();
  await workspace?.cleanup();
});

withGit('resolving where we are', () => {
  it('resolves a nested directory to its repository — AC-1', async () => {
    const fixture = await repository('nested');
    await mkdir(join(fixture.path, 'src', 'deep'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'deep', 'a.txt'), 'a\n');

    const result = await describeEngineeringContext(join(fixture.path, 'src', 'deep'), options());

    expect(result).toBeDefined();
    expect(result?.repository.identityKey.length).toBeGreaterThan(0);
    await expectSamePath(result?.repository.root, fixture.path);
    // The worktree is the checkout root, not the directory that was asked about.
    await expectSamePath(result?.worktree.path, fixture.path);
  });

  it('answers with nothing outside a repository, rather than failing — AC-2', async () => {
    const outside = join(workspace.path, 'not-a-repository');
    await mkdir(outside, { recursive: true });

    await expect(describeEngineeringContext(outside, options())).resolves.toBeUndefined();
  });

  it('refuses a relative directory', async () => {
    await expect(describeEngineeringContext('relative/path', options())).rejects.toThrow();
  });

  it('reports the branch and the HEAD commit — AC-3', async () => {
    const fixture = await repository('on-a-branch');
    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.worktree.branch).toMatch(/^(main|master)$/);
    expect(result?.worktree.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(result?.worktree.detached).toBe(false);
  });

  it('reports a detached HEAD as detached, with no fabricated branch — AC-4', async () => {
    const fixture = await repository('detached');
    const head = String(await git(fixture.path, ['rev-parse', 'HEAD'])).trim();
    await git(fixture.path, ['checkout', '--detach', head]);

    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.worktree.detached).toBe(true);
    expect(result?.worktree.branch).toBeUndefined();
    expect(result?.worktree.headCommit).toBe(head);
  });
});

withGit('working-tree state', () => {
  it('reports a clean tree as clean — AC-5', async () => {
    const fixture = await repository('clean');
    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.worktree.state).toMatchObject({
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
    });
  });

  it('counts staged, unstaged and untracked separately — AC-6', async () => {
    const fixture = await repository('all-three');
    await writeFile(join(fixture.path, 'tracked.txt'), 'one\n');
    await git(fixture.path, ['add', 'tracked.txt']);
    await git(fixture.path, ['commit', '-m', 'add tracked']);

    await writeFile(join(fixture.path, 'staged.txt'), 'new\n');
    await git(fixture.path, ['add', 'staged.txt']);
    await writeFile(join(fixture.path, 'tracked.txt'), 'changed\n');
    await writeFile(join(fixture.path, 'untracked.txt'), 'loose\n');

    const state = (await describeEngineeringContext(fixture.path, options()))?.worktree.state;

    expect(state).toMatchObject({
      clean: false,
      stagedCount: 1,
      unstagedCount: 1,
      untrackedCount: 1,
    });
  });

  it('counts a file staged and then modified again in both — AC-6', async () => {
    // What `git status` itself shows, and the honest answer: the file has a
    // staged version and a different working copy.
    const fixture = await repository('staged-then-modified');
    await writeFile(join(fixture.path, 'both.txt'), 'staged\n');
    await git(fixture.path, ['add', 'both.txt']);
    await writeFile(join(fixture.path, 'both.txt'), 'and modified again\n');

    const state = (await describeEngineeringContext(fixture.path, options()))?.worktree.state;

    expect(state?.stagedCount).toBe(1);
    expect(state?.unstagedCount).toBe(1);
  });

  it('reports a rename as staged, with the new path — AC-8', async () => {
    const fixture = await repository('renamed');
    await writeFile(join(fixture.path, 'before.txt'), 'content that is long enough to match\n');
    await git(fixture.path, ['add', '-A']);
    await git(fixture.path, ['commit', '-m', 'add before']);

    await rename(join(fixture.path, 'before.txt'), join(fixture.path, 'after.txt'));
    await git(fixture.path, ['add', '-A']);

    const state = (await describeEngineeringContext(fixture.path, options()))?.worktree.state;

    expect(state?.stagedCount).toBe(1);
    expect(state?.sample).toContain('after.txt');
    // The original path is a second NUL-separated field of the same record, not
    // a second change.
    expect(state?.sample).not.toContain('before.txt');
  });

  it('bounds the sample and says it was truncated — AC-7', async () => {
    const fixture = await repository('many-changes');
    for (let index = 0; index < MAX_SAMPLED_PATHS + 10; index += 1) {
      await writeFile(join(fixture.path, `f${String(index)}.txt`), `${String(index)}\n`);
    }

    const state = (await describeEngineeringContext(fixture.path, options()))?.worktree.state;

    expect(state?.untrackedCount).toBe(MAX_SAMPLED_PATHS + 10);
    expect(state?.sample).toHaveLength(MAX_SAMPLED_PATHS);
    expect(state?.sampleTruncated).toBe(true);
  });

  it('reports awkward paths intact — AC-12', async () => {
    const fixture = await repository('awkward-paths');
    const names = ['with space.txt', "with'quote.txt", 'wíth-ñon-ascii.txt'];
    for (const name of names) await writeFile(join(fixture.path, name), 'x\n');

    const state = (await describeEngineeringContext(fixture.path, options()))?.worktree.state;

    for (const name of names) expect(state?.sample).toContain(name);
  });
});

withGit('upstream', () => {
  it('is absent when a branch tracks nothing — AC-9', async () => {
    const fixture = await repository('no-upstream');
    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.worktree.upstream).toBeUndefined();
  });

  it('reports ahead and behind against a tracked ref — AC-9', async () => {
    const origin = await repository('upstream-origin');
    await writeFile(join(origin.path, 'base.txt'), 'base\n');
    await git(origin.path, ['add', '-A']);
    await git(origin.path, ['commit', '-m', 'base']);

    const clonePath = join(workspace.path, 'upstream-clone');
    await git(workspace.path, ['clone', origin.path, clonePath]);
    await git(clonePath, ['config', 'user.email', 'ada@example.invalid']);
    await git(clonePath, ['config', 'user.name', 'Ada Lovelace']);

    await writeFile(join(clonePath, 'ahead.txt'), 'ahead\n');
    await git(clonePath, ['add', '-A']);
    await git(clonePath, ['commit', '-m', 'one ahead']);

    const result = await describeEngineeringContext(clonePath, options());

    expect(result?.worktree.upstream?.ref).toContain('origin/');
    expect(result?.worktree.upstream?.ahead).toBe(1);
    expect(result?.worktree.upstream?.behind).toBe(0);
  });
});

withGit('the local identity', () => {
  it('is normalized and classified — AC-10', async () => {
    const fixture = await repository('local-person');
    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.localIdentity?.identity.comparable).toBe('ada@example.invalid');
    expect(result?.localIdentity?.actorClass).toBe(ActorClass.DEVELOPER);
  });

  it('reports a machine account as an agent — AC-10', async () => {
    // `user.email` is whatever the user set, so it is classified like any other
    // identity rather than assumed to be the person at the keyboard.
    const fixture = await repository('local-bot');
    await git(fixture.path, ['config', 'user.email', 'actions@github.com']);
    await git(fixture.path, ['config', 'user.name', 'GitHub Actions']);

    const result = await describeEngineeringContext(fixture.path, options());

    expect(result?.localIdentity?.actorClass).toBe(ActorClass.AGENT);
    expect(result?.localIdentity?.reason).toContain('actions@github.com');
  });

  it('is absent when Git has no address to give', async () => {
    // Set to empty rather than unset: `--unset` clears only the local scope, so
    // on a machine with a global identity Git still has an answer — and
    // reporting it would be correct, since that is who a commit here would be
    // attributed to. An empty value is the deterministic form of "no address",
    // and it is the branch that matters: no address means no identity.
    const fixture = await repository('no-identity');
    await git(fixture.path, ['config', 'user.email', '']);

    const result = await describeEngineeringContext(fixture.path, options());
    expect(result?.localIdentity).toBeUndefined();
  });
});

withGit('reading state never changes it', () => {
  it('leaves every ref and HEAD exactly as they were — AC-11', async () => {
    const fixture = await repository('read-only');
    await writeFile(join(fixture.path, 'dirty.txt'), 'dirty\n');
    await git(fixture.path, ['add', 'dirty.txt']);
    await writeFile(join(fixture.path, 'loose.txt'), 'loose\n');

    const before = await snapshot(fixture.path);
    await describeEngineeringContext(fixture.path, options());
    await describeEngineeringContext(fixture.path, options());
    const after = await snapshot(fixture.path);

    expect(after).toBe(before);
  });

  it('does not run a program the repository nominates', async () => {
    // The hardened runner's guarantee, asserted here too because this Epic
    // adds new Git invocations and each one is a new opportunity to lose it.
    const fixture = await repository('hostile-config');
    const marker = join(fixture.path, 'pwned.txt');
    await git(fixture.path, ['config', 'core.fsmonitor', `sh -c 'echo x > ${marker}'`]);

    await describeEngineeringContext(fixture.path, options());

    await expect(rm(marker)).rejects.toThrow();
  });
});

describe('the status parser', () => {
  it('reads an initial commit with no HEAD', () => {
    const result = parseStatus('# branch.oid (initial)\0# branch.head main\0');

    expect(result.headCommit).toBeUndefined();
    expect(result.branch).toBe('main');
    expect(result.state.clean).toBe(true);
  });

  it('counts an unmerged path on its own', () => {
    // A conflicted path is neither staged nor simply modified, and reporting it
    // as either would make "is this tree ready to commit" answer wrongly.
    const record = 'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.txt';
    const result = parseStatus(`# branch.oid abc\0# branch.head main\0${record}\0`);

    expect(result.state.conflictedCount).toBe(1);
    expect(result.state.stagedCount).toBe(0);
    expect(result.state.unstagedCount).toBe(0);
    expect(result.state.clean).toBe(false);
    expect(result.state.sample).toStrictEqual(['conflicted.txt']);
  });

  it('keeps a path containing spaces whole', () => {
    const record = '1 M. N... 100644 100644 100644 aaa bbb a file with spaces.txt';
    const result = parseStatus(`# branch.oid abc\0# branch.head main\0${record}\0`);

    expect(result.state.sample).toStrictEqual(['a file with spaces.txt']);
  });

  it('reads ahead and behind', () => {
    const result = parseStatus(
      '# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -2\0',
    );

    expect(result.upstream).toStrictEqual({ ref: 'origin/main', ahead: 3, behind: 2 });
  });
});
