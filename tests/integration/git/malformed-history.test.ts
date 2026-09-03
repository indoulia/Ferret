import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitSourceProvider } from '../../../src/git/index.js';
import { parseLog, readHistory, type CommitRecord } from '../../../src/git/history.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import type { DiscoveredRepository, ProviderOperationContext } from '../../../src/index.js';

/**
 * History that Git itself will hand back malformed — F-95, F-96, F-97.
 *
 * Every field of a commit comes from a repository Ferret did not write, and two
 * of them are not even guaranteed to be the shape Git's own format promises: a
 * commit object with a date Git cannot parse makes `%aI` emit the *literal
 * specifier*, and one with an out-of-range timezone emits `+999:99`. Neither is
 * exotic — `git fast-import`, `cvs2git` and hand-written objects all produce
 * them, `git clone` copies them without complaint because `transfer.fsckObjects`
 * defaults to false, and `git fsck` calls the result `badDate` rather than
 * refusing to serve it.
 *
 * The requirement is the one EPIC-019 §12 and §13 state: a malformed region
 * reduces what Ferret knows without breaking what it knows. Specifically it must
 * not silently take the rest of the page with it, and it must never turn a
 * header field into a file that does not exist.
 */

const version = await gitVersion();
const runnable = version !== undefined;
const describeGit = runnable ? describe : describe.skip;

/** Every Git call takes one; the contract requires it. */
function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A repository record for the emitter, which needs no working tree. */
const REPOSITORY_FOR_EMIT: DiscoveredRepository = {
  identityKey: 'github.com/indoulia/emit',
  identityKind: 'remote',
  root: '/emit',
  gitDir: '/emit/.git',
  commonGitDir: '/emit/.git',
  bare: false,
  linkedWorktree: false,
  remotes: [],
  originUrl: 'https://github.com/indoulia/emit.git',
};

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

/** A commit object written byte for byte, so its header can be malformed. */
function writeCommit(root: string, body: string): string {
  return execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--literally', '--stdin'], {
    cwd: root,
    input: body,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  }).trim();
}

async function fixture(name: string): Promise<DiscoveredRepository> {
  const root = join(workspace.path, name);
  await git(workspace.path, ['init', '-q', '-b', 'main', name]);
  const path = await createRepository(root, name, { origin: `https://github.com/indoulia/${name}.git` });
  return provider.describeRepository(path, context);
}

beforeAll(async () => {
  if (!runnable) return;
  workspace = await createWorkspace('ferret-malformed-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
  context = createTestOperationContext();
}, 180_000);

afterAll(async () => {
  if (!runnable) return;
  await provider.shutdown();
  await workspace.cleanup();
});

describeGit(`malformed git history (${runnable ? 'real git' : 'git is unavailable'})`, () => {
  it('reads the commits either side of one Git cannot date — F-95', async () => {
    const repository = await fixture('bad-date');
    const root = repository.root;
    const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
    const first = (await git(root, ['rev-parse', 'HEAD'])).trim();

    // `notanumber` where the author timestamp belongs. Git stores it, serves it,
    // and prints the literal `%aI` when asked to format it as a date.
    const broken = writeCommit(
      root,
      `tree ${tree}\nparent ${first}\nauthor A <a@x.com> notanumber +0000\ncommitter C <c@x.com> notanumber +0000\n\nthe undatable commit\n`,
    );
    const tip = (await git(root, ['commit-tree', tree, '-p', broken, '-m', 'after the bad one'])).trim();
    await git(root, ['reset', '--hard', tip]);

    const page = await readHistory({ cwd: root, signal: signal(), withChanges: true });

    // Three commits exist and three must come back. The one in the middle may
    // arrive without dates — that is honest — but it must not take its
    // neighbours with it.
    expect(page.commits.map((commit) => commit.subject)).toStrictEqual([
      'after the bad one',
      'the undatable commit',
      'initial',
    ]);
  }, 120_000);

  it('never turns a header field into a file that does not exist — F-95', async () => {
    const repository = await fixture('bad-date-changes');
    const root = repository.root;
    const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
    const first = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const broken = writeCommit(
      root,
      `tree ${tree}\nparent ${first}\nauthor A <a@x.com> notanumber +0000\ncommitter C <c@x.com> notanumber +0000\n\nundatable\n`,
    );
    const tip = (await git(root, ['commit-tree', tree, '-p', broken, '-m', 'tip'])).trim();
    await git(root, ['reset', '--hard', tip]);

    const page = await readHistory({ cwd: root, signal: signal(), withChanges: true });
    const paths = page.commits.flatMap((commit) => commit.changes.map((change) => change.path));

    // `%aI`, an email address and a tree hash are all things the desynchronised
    // parser reported as changed files, and the indexer wrote every one of them
    // into the graph as a `file` entity.
    expect(paths.filter((path) => /^%|@|^[0-9a-f]{40}$/u.test(path))).toStrictEqual([]);
  }, 120_000);

  it('emits the commits it could read when one of them is malformed — F-96', async () => {
    const repository = await fixture('emit-isolation');
    const root = repository.root;
    const tree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
    const first = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const broken = writeCommit(
      root,
      `tree ${tree}\nparent ${first}\nauthor A <a@x.com> notanumber +0000\ncommitter C <c@x.com> notanumber +0000\n\nundatable\n`,
    );
    const tip = (await git(root, ['commit-tree', tree, '-p', broken, '-m', 'tip'])).trim();
    await git(root, ['reset', '--hard', tip]);

    const page = await readHistory({ cwd: root, signal: signal(), withChanges: false });
    const graph = provider.emitHistory(repository, page.commits, { observedAt: new Date() });

    // One commit Ferret cannot represent must cost that commit, not the page.
    // A thousand-commit read that returns zero entities because of one bad
    // header is the opposite of the isolation EPIC-019 AC-9 asks for.
    const shas = graph.entities
      .filter((entity) => entity.kind === 'commit')
      .map((entity) => entity.attributes['sha']);
    expect(shas).toContain(tip);
    expect(shas).toContain(first);
  }, 120_000);

  it('keeps the commits Git streamed before it failed, and says it was cut short — F-97', async () => {
    const repository = await fixture('corrupt-object');
    const root = repository.root;
    for (let index = 0; index < 10; index += 1) {
      await git(root, ['commit', '-q', '--allow-empty', '-m', `commit ${String(index)}`]);
    }
    const all = (await git(root, ['log', '--format=%H']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    // Delete one object in the middle. `git log` streams the newer commits to
    // stdout and *then* exits non-zero, which is the case that mattered: the
    // reader threw the streamed commits away and returned an empty page, which
    // is indistinguishable from a repository with no history at all.
    const missing = all[5] as string;
    rmSync(join(root, '.git', 'objects', missing.slice(0, 2), missing.slice(2)), { force: true });

    const page = await readHistory({ cwd: root, signal: signal() });

    // How many Git manages to stream before it gives up is Git's business, not
    // a contract — asserting an exact number would be asserting its buffering.
    // The contract is that what it did stream is kept, and that the page does
    // not present itself as complete.
    expect({
      keptSome: page.commits.length > 0,
      allReal: page.commits.every((commit) => all.includes(commit.sha)),
      incomplete: page.incomplete !== undefined,
    }).toStrictEqual({ keptSome: true, allReal: true, incomplete: true });
  }, 120_000);

  it('loses only the commit it cannot represent, not the page — F-96', () => {
    // Isolation asserted without a bad date, deliberately: F-95 removed that
    // trigger, and a test that relied on it would prove the trigger was gone
    // rather than that the boundary exists. Any commit the canonical model
    // refuses must cost itself alone.
    const good = (sha: string, subject: string): CommitRecord => ({
      sha,
      tree: undefined,
      parents: [],
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      authoredAt: '2026-01-01T00:00:00+00:00',
      committerName: 'Ada',
      committerEmail: 'ada@example.com',
      committedAt: '2026-01-01T00:00:00+00:00',
      subject,
      body: '',
      changes: [],
    });
    const unrepresentable: CommitRecord = { ...good('', 'no identity at all'), sha: '' };

    const graph = provider.emitHistory(
      REPOSITORY_FOR_EMIT,
      [good('a'.repeat(40), 'before'), unrepresentable, good('b'.repeat(40), 'after')],
      { observedAt: new Date() },
    );

    const subjects = graph.entities
      .filter((entity) => entity.kind === 'commit')
      .map((entity) => entity.attributes['message']);
    expect({
      kept: [subjects.includes('before'), subjects.includes('after')],
      skipped: graph.skippedRecords.length,
    }).toStrictEqual({ kept: [true, true], skipped: 1 });
  });

  it('reports an unreadable revision as a refusal rather than an empty history — F-97', async () => {
    const repository = await fixture('bad-since');
    const root = repository.root;

    // An unparseable `since` made `git log` exit non-zero, and the reader turned
    // that into "this repository has nothing", which a caller cannot tell from
    // the truth.
    await expect(readHistory({ cwd: root, signal: signal(), since: 'not-a-date' })).rejects.toThrow(/since/iu);
  }, 120_000);

  it('still reports a repository with no commits as empty, not as damaged', () => {
    // The case the old branch existed for, and it must keep working: an empty
    // repository is a question with the answer "nothing", not a failure.
    expect(parseLog('', false)).toStrictEqual([]);
  });
});
