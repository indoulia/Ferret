import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ErrorCode,
  RelationshipType,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { GitSourceProvider, sanitizeRefText } from '../../../src/git/index.js';
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
 * EPIC-018 — branches and worktrees, against real repositories.
 *
 * The property under test throughout is Governance §9: a repository, a worktree
 * and a branch are three different entities. It sounds pedantic until you try to
 * answer *"what was I working on last Tuesday"* for a developer with four
 * worktrees of one clone — a model that stores "the current branch" against the
 * repository can represent one of them, and will be wrong about the other three.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-018] SKIPPING every branch/worktree test: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-refs-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
});

afterAll(async () => {
  if (version === undefined) return;
  await provider.shutdown();
  await workspace.cleanup();
});

async function scope(name: string): Promise<string> {
  const path = join(workspace.path, name);
  await mkdir(path, { recursive: true });
  return path;
}

/** Creates a repository and returns both its path and how Ferret sees it. */
async function repository(
  name: string,
  options: Parameters<typeof createRepository>[2] = {},
): Promise<{ path: string; discovered: DiscoveredRepository }> {
  const root = await scope(name);
  const path = await createRepository(root, name, {
    origin: `https://github.com/indoulia/${name}.git`,
    ...options,
  });
  return { path, discovered: await provider.describeRepository(path, context) };
}

withGit('worktrees', () => {
  it('reports the primary worktree of an ordinary repository', async () => {
    const { discovered } = await repository('primary-only');
    const worktrees = await provider.listWorktrees(discovered, context);

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.primary).toBe(true);
    expect(worktrees[0]?.ref).toBe('refs/heads/main');
    expect(worktrees[0]?.detached).toBe(false);
  });

  it('reports every linked worktree, primary first', async () => {
    const { path, discovered } = await repository('linked');
    const parent = await scope('linked-checkouts');
    await addWorktree(path, parent, 'feature-a');
    await addWorktree(path, parent, 'feature-b');

    const worktrees = await provider.listWorktrees(discovered, context);

    expect(worktrees).toHaveLength(3);
    // A linked worktree can be removed and the primary cannot, so "which
    // checkout is the real one" is answerable only because Git orders these.
    expect(worktrees[0]?.primary).toBe(true);
    expect(worktrees.slice(1).every((worktree) => !worktree.primary)).toBe(true);
    expect(worktrees.map((worktree) => worktree.ref).sort()).toStrictEqual([
      'refs/heads/main',
      'refs/heads/wt-feature-a',
      'refs/heads/wt-feature-b',
    ]);
  });

  it('gives the same answer whichever checkout it is asked about', async () => {
    // The reason `listWorktrees` takes a repository rather than a path. A linked
    // worktree and its primary share one repository; if the answer depended on
    // which directory a walk happened to reach first, the graph would disagree
    // with itself.
    const { path, discovered } = await repository('either-way');
    const parent = await scope('either-way-checkouts');
    const linked = await addWorktree(path, parent, 'other');

    const fromPrimary = await provider.listWorktrees(discovered, context);
    const fromLinked = await provider.listWorktrees(
      await provider.describeRepository(linked, context),
      context,
    );

    expect(fromLinked.map((worktree) => worktree.path).sort()).toStrictEqual(
      fromPrimary.map((worktree) => worktree.path).sort(),
    );
  });

  it('reports a detached HEAD as detached rather than inventing a branch', async () => {
    const { path, discovered } = await repository('detached');
    const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    await git(path, ['checkout', '--detach', head]);

    const worktrees = await provider.listWorktrees(discovered, context);
    expect(worktrees[0]?.detached).toBe(true);
    // Governance §6: not knowing which branch is a representable state.
    expect(worktrees[0]?.ref).toBeUndefined();
  });

  it('reports a locked worktree with its reason', async () => {
    const { path, discovered } = await repository('lockable');
    const parent = await scope('lockable-checkouts');
    const linked = await addWorktree(path, parent, 'onusb');
    await git(path, ['worktree', 'lock', '--reason', 'on removable media', linked]);

    const worktrees = await provider.listWorktrees(discovered, context);
    const locked = worktrees.find((worktree) => worktree.locked);
    expect(locked).toBeDefined();
    expect(locked?.lockReason).toBe('on removable media');
  });

  it('reports a worktree whose directory has gone as prunable, not as missing', async () => {
    // A developer deletes a worktree directory without telling Git. The checkout
    // is still recorded, and saying "prunable" is more useful than either
    // pretending it exists or silently dropping it.
    const { path, discovered } = await repository('prunable');
    const parent = await scope('prunable-checkouts');
    const linked = await addWorktree(path, parent, 'gone');
    await rm(linked, { recursive: true, force: true, maxRetries: 3 });

    const worktrees = await provider.listWorktrees(discovered, context);
    expect(worktrees.some((worktree) => worktree.prunable)).toBe(true);
  });

  it('reports a bare repository as having one bare worktree', async () => {
    const root = await scope('bare-worktree');
    const path = await createBareRepository(root, 'mirror.git');
    const discovered = await provider.describeRepository(path, context);

    const worktrees = await provider.listWorktrees(discovered, context);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.bare).toBe(true);
  });
});

withGit('branches', () => {
  it('lists local branches with their head commits', async () => {
    const { path, discovered } = await repository('branches');
    await git(path, ['branch', 'feature']);
    await git(path, ['branch', 'release/1.0']);

    const page = await provider.listBranches(discovered, {}, context);

    expect(page.items.map((branch) => branch.shortName)).toStrictEqual([
      'feature',
      'main',
      'release/1.0',
    ]);
    for (const branch of page.items) {
      expect(branch.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
      expect(branch.ref).toBe(`refs/heads/${branch.shortName}`);
    }
  });

  it('marks the branch this checkout is on', async () => {
    const { path, discovered } = await repository('head-marker');
    await git(path, ['branch', 'other']);

    const page = await provider.listBranches(discovered, {}, context);
    expect(page.items.filter((branch) => branch.isHead).map((b) => b.shortName)).toStrictEqual(['main']);
  });

  it('reports the default branch as unknown when the repository records none', async () => {
    // `refs/remotes/origin/HEAD` is only written by `git clone` and
    // `git remote set-head`. Guessing `main` is wrong for every repository that
    // predates 2020, so absent is reported as absent.
    const { discovered } = await repository('no-default');
    const page = await provider.listBranches(discovered, {}, context);

    expect(page.defaultRef).toBeUndefined();
    expect(page.items.every((branch) => !branch.isDefault)).toBe(true);
  });

  it('reports the default branch when the repository does record one', async () => {
    const { path, discovered } = await repository('with-default');
    await git(path, ['branch', 'develop']);
    // What a clone writes.
    await git(path, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop']);

    const page = await provider.listBranches(discovered, {}, context);
    expect(page.defaultRef).toBe('refs/heads/develop');
    expect(page.items.filter((branch) => branch.isDefault).map((b) => b.shortName)).toStrictEqual([
      'develop',
    ]);
  });

  it('reports an upstream when one is configured', async () => {
    const { path, discovered } = await repository('upstream');
    await git(path, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await git(path, ['branch', '--set-upstream-to=origin/main', 'main']);

    const page = await provider.listBranches(discovered, {}, context);
    expect(page.items.find((branch) => branch.shortName === 'main')?.upstream).toBe(
      'refs/remotes/origin/main',
    );
  });

  it('parses a branch with no upstream, where a field is empty', async () => {
    // The genuine hazard in the ref format, and the reason for the
    // NUL-separated `for-each-ref` rather than anything whitespace-delimited:
    // `%(upstream)` is *empty* for a branch that tracks nothing, and `%(HEAD)`
    // is a single space for one that is not checked out. A whitespace-delimited
    // parse silently shifts every field along.
    //
    // (Ref names themselves cannot contain spaces — Git forbids it — so that is
    // not the hazard, despite being the obvious guess.)
    const { path, discovered } = await repository('empty-fields');
    await git(path, ['branch', 'no-upstream']);
    await git(path, ['branch', 'unicode-ünïcode']);

    const page = await provider.listBranches(discovered, {}, context);
    const tracked = page.items.find((branch) => branch.shortName === 'no-upstream');

    expect(tracked?.upstream).toBeUndefined();
    expect(tracked?.isHead).toBe(false);
    expect(tracked?.headCommit).toMatch(/^[0-9a-f]{40,64}$/);
    expect(page.items.map((branch) => branch.shortName)).toContain('unicode-ünïcode');
  });

  it('pages through branches deterministically', async () => {
    const { path, discovered } = await repository('paged-branches');
    for (let i = 0; i < 9; i += 1) await git(path, ['branch', `b${String(i)}`]);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await provider.listBranches(
        discovered,
        { limit: 3, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      seen.push(...result.items.map((branch) => branch.shortName));
      cursor = result.cursor;
      if (cursor === undefined) break;
    }

    expect(seen).toStrictEqual([...seen].sort());
    expect(new Set(seen).size).toBe(10);
  });

  it('refuses a branch cursor from a different provider', async () => {
    const { discovered } = await repository('foreign-branch-cursor');
    const { encodeCursor, Capability } = await import('../../../src/index.js');
    const foreign = encodeCursor('ferret.source.github', Capability.SOURCE_REPOSITORY, { offset: 1 });

    await expect(
      provider.listBranches(discovered, { cursor: foreign }, context),
    ).rejects.toMatchObject({ code: ErrorCode.CURSOR_INVALID });
  });
});

withGit('the graph', () => {
  it('connects a repository to its branches and its checkouts', async () => {
    const { path, discovered } = await repository('graph');
    const parent = await scope('graph-checkouts');
    await addWorktree(path, parent, 'side');

    const worktrees = await provider.listWorktrees(discovered, context);
    const branches = (await provider.listBranches(discovered, {}, context)).items;
    const graph = provider.emitGraph(discovered, { worktrees, branches });

    const kinds = graph.entities.map((entity) => entity.kind).sort();
    expect(kinds).toStrictEqual(['branch', 'branch', 'repository', 'worktree', 'worktree']);

    const types = graph.relationships.map((relationship) => relationship.type).sort();
    expect(types).toStrictEqual([
      RelationshipType.REPOSITORY_CONTAINS_BRANCH,
      RelationshipType.REPOSITORY_CONTAINS_BRANCH,
      RelationshipType.REPOSITORY_CONTAINS_WORKTREE,
      RelationshipType.REPOSITORY_CONTAINS_WORKTREE,
      RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
      RelationshipType.WORKTREE_CHECKS_OUT_BRANCH,
    ]);
  });

  it('gives two worktrees of one repository two different identities', async () => {
    // The property the whole Epic exists for. Two checkouts are two entities;
    // collapsing them is how "what was I working on" becomes unanswerable.
    const { path, discovered } = await repository('two-checkouts');
    const parent = await scope('two-checkouts-parent');
    await addWorktree(path, parent, 'second');

    const worktrees = await provider.listWorktrees(discovered, context);
    const graph = provider.emitGraph(discovered, { worktrees });
    const worktreeEntities = graph.entities.filter((entity) => entity.kind === 'worktree');

    expect(worktreeEntities).toHaveLength(2);
    expect(new Set(worktreeEntities.map((entity) => entity.id)).size).toBe(2);
  });

  it('scopes a branch to its repository, so two `main`s are two branches', async () => {
    const a = await repository('scope-a');
    const b = await repository('scope-b');

    const branchOf = async (repo: typeof a): Promise<string> => {
      const branches = (await provider.listBranches(repo.discovered, {}, context)).items;
      const graph = provider.emitGraph(repo.discovered, { branches });
      const branch = graph.entities.find((entity) => entity.kind === 'branch');
      if (branch === undefined) throw new Error('no branch emitted');
      return branch.id;
    };

    expect(await branchOf(a)).not.toBe(await branchOf(b));
  });

  it('does not connect a detached worktree to a branch it is not on', async () => {
    // Governance §6: manufacturing an endpoint would make a false statement
    // about what the developer is working on.
    const { path, discovered } = await repository('detached-graph');
    const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
    await git(path, ['checkout', '--detach', head]);

    const worktrees = await provider.listWorktrees(discovered, context);
    const branches = (await provider.listBranches(discovered, {}, context)).items;
    const graph = provider.emitGraph(discovered, { worktrees, branches });

    expect(
      graph.relationships.filter((r) => r.type === RelationshipType.WORKTREE_CHECKS_OUT_BRANCH),
    ).toStrictEqual([]);
  });

  it('emits identical entity ids for an unchanged repository read twice', async () => {
    // Governance §10 for the half this Epic can guarantee on its own. Entity
    // identity is content-derived, so re-reading unchanged state is genuinely a
    // no-op however much later it happens.
    const { discovered } = await repository('idempotent-graph');
    const worktrees = await provider.listWorktrees(discovered, context);
    const branches = (await provider.listBranches(discovered, {}, context)).items;

    const first = provider.emitGraph(discovered, { worktrees, branches });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = provider.emitGraph(discovered, { worktrees, branches });

    expect(second.entities.map((e) => e.id)).toStrictEqual(first.entities.map((e) => e.id));
  });

  it('emits identical relationship ids for one observation instant', async () => {
    // Relationship identity includes `validFrom` (EPIC-007), so a graph emitted
    // without a shared instant would not be internally consistent — every edge
    // would carry a slightly different moment. `observedAt` makes one emission
    // one observation.
    const { discovered } = await repository('one-instant');
    const worktrees = await provider.listWorktrees(discovered, context);
    const branches = (await provider.listBranches(discovered, {}, context)).items;
    const observedAt = new Date('2026-08-30T12:00:00.000Z');

    const first = provider.emitGraph(discovered, { worktrees, branches, observedAt });
    const second = provider.emitGraph(discovered, { worktrees, branches, observedAt });

    expect(second.relationships.map((r) => r.id)).toStrictEqual(first.relationships.map((r) => r.id));
    expect(new Set(first.relationships.map((r) => r.validFrom)).size).toBe(1);
  });

  it('reports its observation time rather than pretending to know a valid time', async () => {
    // Git cannot say when a branch came to be contained by its repository. What
    // Ferret records is when it *looked*, and Governance §6 wants that
    // distinction visible rather than smoothed into a confident-looking date.
    const { discovered } = await repository('observation-time');
    const branches = (await provider.listBranches(discovered, {}, context)).items;
    const observedAt = new Date('2026-01-02T03:04:05.000Z');

    const graph = provider.emitGraph(discovered, { branches, observedAt });
    expect(graph.relationships[0]?.validFrom).toBe(observedAt.toISOString());
    // Still open: nothing has ended it.
    expect(graph.relationships[0]?.validTo).toBeNull();
  });

  it('produces a different checkout relationship after a branch switch', async () => {
    // What EPIC-007's exclusivity constraint exists to reconcile: a worktree is
    // on one branch at a time, so switching is a *new* relationship that
    // supersedes the old one rather than a contradiction.
    const { path, discovered } = await repository('switching');
    await git(path, ['branch', 'next']);

    const before = provider.emitGraph(discovered, {
      worktrees: await provider.listWorktrees(discovered, context),
      branches: (await provider.listBranches(discovered, {}, context)).items,
    });

    await git(path, ['checkout', 'next']);

    const after = provider.emitGraph(discovered, {
      worktrees: await provider.listWorktrees(discovered, context),
      branches: (await provider.listBranches(discovered, {}, context)).items,
    });

    const checkout = (graph: typeof before): string | undefined =>
      graph.relationships.find((r) => r.type === RelationshipType.WORKTREE_CHECKS_OUT_BRANCH)?.toId;

    expect(checkout(after)).toBeDefined();
    expect(checkout(after)).not.toBe(checkout(before));
    // The worktree itself is the same entity; only what it has checked out moved.
    const worktreeId = (graph: typeof before): string | undefined =>
      graph.entities.find((entity) => entity.kind === 'worktree')?.id;
    expect(worktreeId(after)).toBe(worktreeId(before));
  });
});

withGit('untrusted ref content', () => {
  it('strips control characters from repository-controlled text', () => {
    // A lock reason and an upstream name are free-form, they reach a terminal,
    // and an ANSI escape in a branch listing can rewrite what an operator
    // believes they are looking at. Governance §12.
    const hostile = `main[2K[1Grm -rf / `;
    const cleaned = sanitizeRefText(hostile);
    expect(cleaned).not.toContain('');
    expect(cleaned).not.toContain(' ');
    expect(cleaned).toContain('main');
  });

  it('bounds the length of anything it takes from a repository', () => {
    expect(sanitizeRefText('x'.repeat(10_000)).length).toBeLessThanOrEqual(512);
  });

  it('does not emit a branch whose head is not a commit id', async () => {
    // Defensive: `objectname` comes from the repository. A value that is not a
    // hash means Ferret misparsed or the repository is malformed, and emitting
    // it would put nonsense into the graph as though it were observed.
    const { discovered } = await repository('sane-heads');
    const page = await provider.listBranches(discovered, {}, context);
    expect(page.items.every((branch) => /^[0-9a-f]{40,64}$/.test(branch.headCommit))).toBe(true);
  });
});
