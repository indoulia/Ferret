import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Capability,
  ErrorCode,
  FerretError,
  ProviderRegistry,
  RepositoryIdentityKind,
  RepositoryOperation,
  SkipReason,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GIT_PROVIDER_ID, GitSourceProvider, runGit } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import {
  addWorktree,
  createBareRepository,
  createRepository,
  createWorkspace,
  git,
  gitVersion,
} from '../../support/git-fixtures.js';

/**
 * EPIC-017 against real repositories created by real `git`.
 *
 * Everything here that matters is a fact about Git rather than about Ferret: a
 * linked worktree's `.git` is a file, a bare repository has no top level,
 * `rev-parse` prints its answers in a fixed order. Asserting those against a
 * stub would only confirm what the test author already believed.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  // Loudly, not silently. A suite that quietly skips its only real coverage
  // reports success for a build nobody verified.
  process.stderr.write(
    '\n[EPIC-017] SKIPPING every Git integration test: the `git` executable was not found on PATH.\n' +
      '           These tests are the only coverage of repository discovery against real repositories.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace();
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

afterAll(async () => {
  if (version === undefined) return;
  await provider.shutdown();
  await workspace.cleanup();
});

/** A directory nothing else uses, so tests do not see each other's fixtures. */
async function scope(name: string): Promise<string> {
  const path = join(workspace.path, name);
  await mkdir(path, { recursive: true });
  return path;
}

function byName(repositories: readonly DiscoveredRepository[], name: string): DiscoveredRepository {
  const found = repositories.find((repository) => repository.root.replace(/\\/g, '/').endsWith(`/${name}`));
  if (found === undefined) {
    throw new Error(`${name} not found among ${repositories.map((r) => r.root).join(', ')}`);
  }
  return found;
}

withGit('discovering repositories', () => {
  it('finds a repository under a root', async () => {
    const root = await scope('basic');
    await createRepository(root, 'alpha', { origin: 'https://github.com/indoulia/alpha.git' });

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items).toHaveLength(1);
    expect(byName(result.items, 'alpha').identityKey).toBe('github.com/indoulia/alpha');
  });

  it('finds several, and does not descend into one it has found', async () => {
    const root = await scope('several');
    await createRepository(root, 'a', { origin: 'https://github.com/indoulia/a.git' });
    await createRepository(root, 'b', { origin: 'https://github.com/indoulia/b.git' });
    const nested = join(root, 'a', 'vendor');
    await mkdir(nested, { recursive: true });
    await createRepository(nested, 'inner', { origin: 'https://github.com/indoulia/inner.git' });

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    // A submodule is reachable from its parent. Descending through every
    // repository looking for a stray nested one is how a walk that should take
    // a second takes a minute.
    expect(result.items.map((r) => r.identityKey).sort()).toStrictEqual([
      'github.com/indoulia/a',
      'github.com/indoulia/b',
    ]);
  });

  it('descends into a found repository when asked', async () => {
    const root = await scope('nested');
    await createRepository(root, 'outer', { origin: 'https://github.com/indoulia/outer.git' });
    const inner = join(root, 'outer', 'packages');
    await mkdir(inner, { recursive: true });
    await createRepository(inner, 'inner', { origin: 'https://github.com/indoulia/inner2.git' });

    const result = await provider.discoverRepositories({ roots: [root], includeNested: true }, context);
    expect(result.items).toHaveLength(2);
  });

  it('finds a bare repository, which has no working tree', async () => {
    const root = await scope('bare');
    await createBareRepository(root, 'mirror.git');

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.bare).toBe(true);
  });

  it('treats five worktrees of one clone as one repository with five checkouts', async () => {
    // Governance §9: a branch is not a worktree, and a worktree is not a
    // repository. A linked worktree keeps its own `.git` and shares the common
    // one, which is exactly what makes them the same repository.
    const root = await scope('worktrees');
    const main = await createRepository(root, 'main', { origin: 'https://github.com/indoulia/wt.git' });
    for (let i = 0; i < 4; i += 1) await addWorktree(main, root, `wt-${String(i)}`);

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items).toHaveLength(5);
    expect(new Set(result.items.map((r) => r.identityKey)).size).toBe(1);
    expect(result.items.filter((r) => r.linkedWorktree)).toHaveLength(4);

    const linked = result.items.find((r) => r.linkedWorktree);
    expect(linked?.gitDir).not.toBe(linked?.commonGitDir);
  });

  it('gives two clones of one remote the same identity, at different paths', async () => {
    const root = await scope('clones');
    await createRepository(root, 'clone-a', { origin: 'git@github.com:indoulia/same.git' });
    await createRepository(root, 'clone-b', { origin: 'https://github.com/indoulia/same' });

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items).toHaveLength(2);
    expect(new Set(result.items.map((r) => r.identityKey)).size).toBe(1);
    expect(result.items.every((r) => r.identityKind === RepositoryIdentityKind.REMOTE)).toBe(true);
  });

  it('identifies a repository with no remote by its path, and says so', async () => {
    const root = await scope('no-remote');
    await createRepository(root, 'local');

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items[0]?.identityKind).toBe(RepositoryIdentityKind.PATH);
    expect(result.items[0]?.remotes).toStrictEqual([]);
  });

  it('prefers origin when a repository has several remotes', async () => {
    const root = await scope('multi-remote');
    await createRepository(root, 'forked', {
      origin: 'https://github.com/me/forked.git',
      remotes: { upstream: 'https://github.com/them/forked.git' },
    });

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items[0]?.identityKey).toBe('github.com/me/forked');
    // Config order must not decide identity.
    expect(result.items[0]?.remotes.map((r) => r.name)).toStrictEqual(['origin', 'upstream']);
  });

  it('describes a repository it is pointed at directly', async () => {
    const root = await scope('describe');
    const path = await createRepository(root, 'target', { origin: 'https://github.com/indoulia/t.git' });

    const described = await provider.describeRepository(path, context);
    expect(described.identityKey).toBe('github.com/indoulia/t');
    expect(described.bare).toBe(false);
  });

  it('emits the same canonical id however the repository was reached', async () => {
    // Governance §10: re-ingesting unchanged content is a no-op. Two discoveries
    // of one repository must produce one entity, not two.
    const root = await scope('idempotent');
    const path = await createRepository(root, 'stable', { origin: 'https://github.com/indoulia/s.git' });

    const walked = (await provider.discoverRepositories({ roots: [root] }, context)).items[0];
    const described = await provider.describeRepository(path, context);
    if (walked === undefined) throw new Error('nothing discovered');

    expect(provider.emit(walked).entity.id).toBe(provider.emit(described).entity.id);
  });
});

withGit('emission', () => {
  it('produces a repository entity with attributed evidence', async () => {
    const root = await scope('emit');
    await createRepository(root, 'emitted', { origin: 'https://github.com/indoulia/emitted.git' });
    const repository = (await provider.discoverRepositories({ roots: [root] }, context)).items[0];
    if (repository === undefined) throw new Error('nothing discovered');

    const { entity, evidence } = provider.emit(repository);

    expect(entity.kind).toBe('repository');
    expect(entity.attributes['name']).toBe('emitted');
    expect(evidence.length).toBeGreaterThan(0);
    for (const record of evidence) {
      // Governance §21: without the producer version, "re-read everything the
      // old discovery emitted" is unanswerable.
      expect(record.producer).toBe(GIT_PROVIDER_ID);
      expect(record.producerVersion.length).toBeGreaterThan(0);
      expect(record.sourceSystem).toBe('git');
      expect(record.method).toBe('observed');
    }
  });

  it('keeps machine-local detail out of canonical attributes', async () => {
    // Where a checkout lives is a fact about this machine, not the repository.
    // Two machines sharing one Ferret database would otherwise overwrite each
    // other's copy of the same row for ever — and Governance §9 has a better
    // home for it anyway: a checkout is a worktree, which EPIC-018 models.
    const root = await scope('local-detail');
    await createRepository(root, 'paths', { origin: 'https://github.com/indoulia/paths.git' });
    const repository = (await provider.discoverRepositories({ roots: [root] }, context)).items[0];
    if (repository === undefined) throw new Error('nothing discovered');

    const { entity } = provider.emit(repository);
    expect(JSON.stringify(entity.attributes)).not.toContain(workspace.path.replace(/\\/g, '\\\\'));
    expect(entity.unknownFields['localRoot']).toBe(repository.root);
  });

  it('refuses to emit before the provider is initialized', () => {
    const fresh = new GitSourceProvider();
    expect(() =>
      fresh.emit({
        identityKey: 'x',
        identityKind: RepositoryIdentityKind.PATH,
        root: '/x',
        gitDir: '/x/.git',
        commonGitDir: '/x/.git',
        bare: false,
        linkedWorktree: false,
        remotes: [],
        originUrl: undefined,
      }),
    ).toThrow(FerretError);
  });
});

withGit('security', () => {
  const TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwx';

  it('never emits a token that was sitting in .git/config', async () => {
    // `git clone https://user:TOKEN@host/repo` writes the token into the
    // repository's config, where it stays. Ferret reads that config.
    const root = await scope('secret-remote');
    await createRepository(root, 'tokened', {
      origin: `https://x-access-token:${TOKEN}@github.com/indoulia/private.git`,
    });

    const result = await provider.discoverRepositories({ roots: [root] }, context);
    const repository = result.items[0];
    if (repository === undefined) throw new Error('nothing discovered');
    const { entity, evidence } = provider.emit(repository);

    const everything = JSON.stringify({ repository, entity, evidence });
    expect(everything).not.toContain(TOKEN);
    // And the identity still unifies with the clean form, because a token is
    // not part of what a repository *is*.
    expect(repository.identityKey).toBe('github.com/indoulia/private');
  });

  it('does not run a program a repository nominates in its own configuration', async () => {
    // The vector: `core.hooksPath`, `core.fsmonitor`, `core.pager`,
    // `credential.helper` and `core.sshCommand` each name a program, and a
    // repository sets them in its own `.git/config`. A repository Ferret clones
    // for indexing can therefore execute code by being looked at.
    //
    // The test has a **control**, because the version without one was worthless:
    // it passed on Windows purely because a `#!/bin/sh` script will not run
    // there, and would have passed just as happily if Ferret had no protection
    // at all. The control proves the fixture is genuinely hostile *before*
    // anything is concluded from Ferret's behaviour.
    const root = await scope('hostile-config');
    const marker = join(root, 'program-ran.txt');
    const script = join(root, 'evil.sh');
    const hooks = join(root, 'evil-hooks');
    await mkdir(hooks, { recursive: true });
    await writeFile(script, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    await writeFile(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });

    const repository = await createRepository(root, 'hostile', {
      origin: 'https://github.com/indoulia/hostile.git',
      config: [
        `core.fsmonitor=${script}`,
        `core.pager=${script}`,
        `core.hooksPath=${hooks}`,
        `credential.helper=!${script}`,
      ],
    });

    const { readFile, rm } = await import('node:fs/promises');

    // Control: an ordinary Git invocation, with none of Ferret's overrides.
    await git(repository, ['status', '--porcelain']).catch(() => '');
    const vectorWorks = await readFile(marker, 'utf8').then(
      () => true,
      () => false,
    );
    await rm(marker, { force: true });

    if (!vectorWorks) {
      // Not a pass. This platform cannot run the fixture's program at all, so
      // the test demonstrates nothing about Ferret and says so rather than
      // reporting a protection it did not observe.
      process.stderr.write(
        '[EPIC-017] this platform did not execute the hostile fixture even without Ferret’s overrides;\n' +
          '           the configuration-execution vector is NOT demonstrated here (it is on Linux CI).\n',
      );
    }

    const result = await provider.discoverRepositories({ roots: [root] }, context);
    expect(result.items).toHaveLength(1);

    // The assertion that matters: with Ferret's `-c` overrides in place, the
    // same repository executes nothing.
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });

  it('treats a directory named like a shell command as a directory', async () => {
    // If any part of this Epic built a command string, this fixture would run
    // its contents. It does not, because there is no string to build.
    const root = await scope('shell-metachars');
    const hostile = process.platform === 'win32' ? 'weird & name' : 'weird; touch pwned & name';
    await mkdir(join(root, hostile), { recursive: true });
    await createRepository(join(root, hostile), 'inside', {
      origin: 'https://github.com/indoulia/inside.git',
    });

    const result = await provider.discoverRepositories({ roots: [root] }, context);
    expect(result.items).toHaveLength(1);

    const { access } = await import('node:fs/promises');
    await expect(access(join(root, 'pwned'))).rejects.toThrow();
  });

  it('treats a directory named like an option as a directory', async () => {
    // Not a shell problem — a *Git* problem. `--upload-pack=…` in argument
    // position is read as an option, and paths are made absolute so they never
    // land there.
    const root = await scope('option-like');
    const hostile = join(root, '--upload-pack=evil');
    await mkdir(hostile, { recursive: true });
    await createRepository(hostile, 'inner', { origin: 'https://github.com/indoulia/opt.git' });

    const result = await provider.discoverRepositories({ roots: [root] }, context);
    expect(result.items).toHaveLength(1);
  });

  it('ignores an environment variable trying to redirect Git', async () => {
    const root = await scope('env-redirect');
    const real = await createRepository(root, 'real', { origin: 'https://github.com/indoulia/real.git' });
    const decoy = await createRepository(root, 'decoy', { origin: 'https://github.com/indoulia/decoy.git' });

    const previous = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = join(decoy, '.git');
    try {
      const described = await provider.describeRepository(real, context);
      // Without scrubbing, Git would have answered about the decoy, and every
      // fact Ferret recorded would have attached to the wrong entity.
      expect(described.identityKey).toBe('github.com/indoulia/real');
    } finally {
      if (previous === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previous;
    }
  });

  it('does not follow a symbolic link out of its root', async () => {
    const outside = await scope('outside-target');
    await createRepository(outside, 'secret', { origin: 'https://github.com/indoulia/secret.git' });

    const root = await scope('symlink-escape');
    try {
      await symlink(outside, join(root, 'escape'), 'dir');
    } catch {
      // Windows without Developer Mode refuses to create a link without
      // elevation. Reported rather than passed over in silence.
      process.stderr.write('[EPIC-017] symlink creation unavailable; escape test not exercised\n');
      return;
    }

    const notFollowed = await provider.discoverRepositories({ roots: [root] }, context);
    expect(notFollowed.items).toHaveLength(0);
    expect(notFollowed.skipped.some((skip) => skip.reason === SkipReason.SYMLINK)).toBe(true);

    // Even when following is enabled, a link out of the root is refused: a link
    // to `/` would turn "index my projects" into "index this machine".
    const following = await provider.discoverRepositories(
      { roots: [root], followSymlinks: true },
      context,
    );
    expect(following.items).toHaveLength(0);
    expect(following.skipped.some((skip) => skip.reason === SkipReason.OUTSIDE_ROOT)).toBe(true);
  });

  it('does not loop on a symbolic link back up its own tree', async () => {
    const root = await scope('symlink-loop');
    const inner = join(root, 'inner');
    await mkdir(inner, { recursive: true });
    try {
      await symlink(root, join(inner, 'up'), 'dir');
    } catch {
      process.stderr.write('[EPIC-017] symlink creation unavailable; loop test not exercised\n');
      return;
    }
    await createRepository(inner, 'repo', { origin: 'https://github.com/indoulia/loop.git' });

    // Without the visited set this never returns.
    const result = await provider.discoverRepositories(
      { roots: [root], followSymlinks: true },
      context,
    );
    expect(result.items).toHaveLength(1);
  });

  it('refuses a Git argument carrying a null byte', async () => {
    const root = await scope('null-byte');
    await expect(
      runGit(['status', 'a b'], { cwd: root, signal: context.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE });
  });

  it('refuses to run Git in a relative directory', async () => {
    await expect(runGit(['status'], { cwd: 'relative', signal: context.signal })).rejects.toMatchObject({
      code: ErrorCode.USAGE,
    });
  });
});

withGit('degrading rather than breaking', () => {
  it('reports a directory that is not a repository, and keeps walking', async () => {
    const root = await scope('mixed');
    await createRepository(root, 'good', { origin: 'https://github.com/indoulia/good.git' });
    // A `.git` file that points nowhere: Git will refuse it.
    const broken = join(root, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, '.git'), 'gitdir: /nonexistent/elsewhere\n', 'utf8');

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items).toHaveLength(1);
    expect(result.skipped.some((skip) => skip.reason === SkipReason.NOT_A_REPOSITORY)).toBe(true);
  });

  it('reports a root that does not exist rather than failing the walk', async () => {
    const root = await scope('missing-root');
    await createRepository(root, 'present', { origin: 'https://github.com/indoulia/p.git' });

    const result = await provider.discoverRepositories(
      { roots: [root, join(root, 'does-not-exist')] },
      context,
    );

    expect(result.items).toHaveLength(1);
    expect(result.skipped.some((skip) => skip.reason === SkipReason.UNREADABLE)).toBe(true);
  });

  it('stops at its depth bound and says that it did', async () => {
    const root = await scope('deep');
    let path = root;
    for (let i = 0; i < 6; i += 1) {
      path = join(path, `level-${String(i)}`);
      await mkdir(path, { recursive: true });
    }
    await createRepository(path, 'buried', { origin: 'https://github.com/indoulia/buried.git' });

    const shallow = await provider.discoverRepositories({ roots: [root], maxDepth: 2 }, context);
    expect(shallow.items).toHaveLength(0);
    // Silence here would be the worst outcome: Ferret would answer questions
    // about a codebase it had only half seen, confidently.
    expect(shallow.skipped.some((skip) => skip.reason === SkipReason.DEPTH_LIMIT)).toBe(true);

    const deep = await provider.discoverRepositories({ roots: [root], maxDepth: 10 }, context);
    expect(deep.items).toHaveLength(1);
  });

  it('honours exclusion rules', async () => {
    const root = await scope('excluded');
    const modules = join(root, 'node_modules');
    await mkdir(modules, { recursive: true });
    await createRepository(modules, 'dependency', { origin: 'https://github.com/x/dep.git' });
    await createRepository(root, 'mine', { origin: 'https://github.com/indoulia/mine.git' });

    const result = await provider.discoverRepositories({ roots: [root] }, context);

    expect(result.items.map((r) => r.identityKey)).toStrictEqual(['github.com/indoulia/mine']);
    expect(result.skipped.some((skip) => skip.reason === SkipReason.EXCLUDED)).toBe(true);
  });

  it('refuses a relative root rather than resolving it against the process', async () => {
    await expect(provider.discoverRepositories({ roots: ['relative/path'] }, context)).rejects.toMatchObject(
      { code: ErrorCode.USAGE },
    );
  });

  it('refuses a request with no roots', async () => {
    await expect(provider.discoverRepositories({ roots: [] }, context)).rejects.toMatchObject({
      code: ErrorCode.USAGE,
    });
  });
});

withGit('paging and cancellation', () => {
  it('pages through repositories and stops when the enumeration ends', async () => {
    const root = await scope('paging');
    for (let i = 0; i < 5; i += 1) {
      await createRepository(root, `p${String(i)}`, {
        origin: `https://github.com/indoulia/p${String(i)}.git`,
      });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await provider.discoverRepositories(
        { roots: [root], limit: 2, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      seen.push(...result.items.map((r) => r.identityKey));
      cursor = result.cursor;
      if (cursor === undefined) break;
    }

    expect(seen.sort()).toStrictEqual([
      'github.com/indoulia/p0',
      'github.com/indoulia/p1',
      'github.com/indoulia/p2',
      'github.com/indoulia/p3',
      'github.com/indoulia/p4',
    ]);
  });

  it('refuses a cursor issued for a different set of roots', async () => {
    const first = await scope('cursor-roots-a');
    const second = await scope('cursor-roots-b');
    await createRepository(first, 'a1', { origin: 'https://github.com/indoulia/a1.git' });
    await createRepository(first, 'a2', { origin: 'https://github.com/indoulia/a2.git' });

    const page = await provider.discoverRepositories({ roots: [first], limit: 1 }, context);
    expect(page.cursor).toBeDefined();

    // Resuming a walk that never happened would silently return the wrong
    // repositories, which is worse than an error.
    await expect(
      provider.discoverRepositories({ roots: [second], cursor: page.cursor ?? '' }, context),
    ).rejects.toMatchObject({ code: ErrorCode.CURSOR_INVALID });
  });

  it('refuses a cursor issued by a different provider', async () => {
    const root = await scope('cursor-foreign');
    await createRepository(root, 'only', { origin: 'https://github.com/indoulia/only.git' });
    const { encodeCursor } = await import('../../../src/index.js');
    const foreign = encodeCursor('ferret.source.github', Capability.SOURCE_REPOSITORY, { after: root });

    await expect(
      provider.discoverRepositories({ roots: [root], cursor: foreign }, context),
    ).rejects.toMatchObject({ code: ErrorCode.CURSOR_INVALID });
  });

  it('stops a walk when it is cancelled', async () => {
    const root = await scope('cancel');
    for (let i = 0; i < 3; i += 1) {
      await createRepository(root, `c${String(i)}`, {
        origin: `https://github.com/indoulia/c${String(i)}.git`,
      });
    }

    const cancellable = createTestOperationContext();
    cancellable.abort();

    await expect(provider.discoverRepositories({ roots: [root] }, cancellable)).rejects.toMatchObject({
      code: ErrorCode.INTERRUPTED,
    });
  });

  it('runs many discoveries concurrently without interfering', async () => {
    const root = await scope('concurrent');
    for (let i = 0; i < 6; i += 1) {
      await createRepository(root, `k${String(i)}`, {
        origin: `https://github.com/indoulia/k${String(i)}.git`,
      });
    }

    const results = await Promise.all(
      Array.from({ length: 8 }, () => provider.discoverRepositories({ roots: [root] }, context)),
    );

    // Every walk is independent state; a shared cache or a shared cursor would
    // show here as results that disagree.
    for (const result of results) expect(result.items).toHaveLength(6);
    expect(new Set(results.map((r) => r.items.map((i) => i.identityKey).sort().join(',')))).toHaveLength(1);
  });
});

withGit('through the provider registry', () => {
  it('is selected by capability, never by name', async () => {
    // EPIC-011's claim, tested for the first time against a real provider.
    const registry = new ProviderRegistry();
    registry.register(new GitSourceProvider());

    const selected = registry.forCapability(Capability.SOURCE_REPOSITORY);
    expect(selected?.id).toBe(GIT_PROVIDER_ID);

    const declaration = registry.declarationFor(Capability.SOURCE_REPOSITORY);
    expect(declaration?.operations).toContain(RepositoryOperation.DISCOVER);
    expect(declaration?.limits?.supportsServerSideFilter).toBe(false);
    await Promise.resolve();
  });

  it('reports Git as a dependency it needs', async () => {
    const checks = await provider.checkDependencies(createTestProviderContext());
    expect(checks.map((check) => check.name)).toContain('git');
  });
});

withGit('performance', () => {
  it('walks a wide tree within budget', async () => {
    const root = await scope('perf');
    // 500 directories, one repository. The cost being measured is the walk, not
    // Git: a walk that degrades will show here long before a user notices.
    for (let i = 0; i < 500; i += 1) {
      await mkdir(join(root, `dir-${String(i)}`), { recursive: true });
    }
    await createRepository(root, 'needle', { origin: 'https://github.com/indoulia/needle.git' });

    const started = performance.now();
    const result = await provider.discoverRepositories({ roots: [root] }, context);
    const elapsed = performance.now() - started;

    expect(result.items).toHaveLength(1);
    expect(result.directoriesVisited).toBeGreaterThanOrEqual(500);
    // A regression ceiling, not a target: this walks a filesystem Ferret does
    // not control, on CI hardware that varies.
    expect(elapsed).toBeLessThan(30_000);
  });

  it('identifies repositories at a bounded cost per repository', async () => {
    const root = await scope('perf-identify');
    for (let i = 0; i < 25; i += 1) {
      await createRepository(root, `r${String(i)}`, {
        origin: `https://github.com/indoulia/r${String(i)}.git`,
        commit: false,
      });
    }

    const started = performance.now();
    const result = await provider.discoverRepositories({ roots: [root] }, context);
    const elapsed = performance.now() - started;

    expect(result.items).toHaveLength(25);
    // Two Git invocations per repository. Process creation dominates, and on
    // Windows it dominates heavily, so the ceiling is generous by design.
    expect(elapsed).toBeLessThan(60_000);
  });
});

withGit('the fixtures themselves', () => {
  it('creates repositories real Git recognises', async () => {
    // A fixture nobody checks is a fixture that can silently stop creating what
    // the tests believe it creates.
    const root = await scope('fixture-check');
    const path = await createRepository(root, 'checked', { origin: 'https://example.com/a/b.git' });
    const inside = await git(path, ['rev-parse', '--is-inside-work-tree']);
    expect(inside.trim()).toBe('true');
  });
});
