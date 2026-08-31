import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ErrorCode,
  RelationshipType,
  parseMailmap,
  type DiscoveredRepository,
  type ProviderOperationContext,
} from '../../../src/index.js';
import { ChangeKind, GitSourceProvider } from '../../../src/git/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';

/**
 * EPIC-019 and EPIC-020 against real history.
 *
 * The parser has its own unit tests; what these add is everything the parser
 * cannot know on its own — that the format string actually produces the shape it
 * assumes, that renames survive a real `--find-renames`, and that the graph a
 * real repository implies is the graph Ferret emits.
 */

const version = await gitVersion();
const withGit = version === undefined ? describe.skip : describe;

if (version === undefined) {
  process.stderr.write(
    '\n[EPIC-019/020] SKIPPING every history test: the `git` executable was not found on PATH.\n\n',
  );
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;
let context: ProviderOperationContext;

beforeAll(async () => {
  if (version === undefined) return;
  workspace = await createWorkspace('ferret-history-');
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

/** A repository with a small, deliberately awkward history. */
async function history(name: string): Promise<Fixture> {
  const root = join(workspace.path, name);
  await mkdir(root, { recursive: true });
  const path = await createRepository(root, name, {
    origin: `https://github.com/indoulia/${name}.git`,
  });
  return { path, discovered: await provider.describeRepository(path, context) };
}

async function commit(path: string, message: string, author = 'Ada Lovelace <ada@example.invalid>'): Promise<void> {
  await git(path, ['commit', '--author', author, '-m', message]);
}

withGit('reading history', () => {
  it('reads commits newest first, with their metadata', async () => {
    const fixture = await history('basic');
    await writeFile(join(fixture.path, 'second.txt'), 'two\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add second');

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);

    expect(commits).toHaveLength(2);
    expect(commits[0]?.subject).toBe('add second');
    expect(commits[1]?.subject).toBe('initial');
    expect(commits[0]?.sha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(commits[0]?.authorEmail).toBe('ada@example.invalid');
    expect(commits[0]?.parents).toStrictEqual([commits[1]?.sha]);
    expect(commits[1]?.parents).toStrictEqual([]);
  });

  it('reads a multi-line commit message intact', async () => {
    const fixture = await history('message');
    await writeFile(join(fixture.path, 'x.txt'), 'x\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'subject line\n\nfirst body line\nsecond body line');

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);
    expect(commits[0]?.subject).toBe('subject line');
    expect(commits[0]?.body).toBe('first body line\nsecond body line');
  });

  it('reads the files a commit changed', async () => {
    const fixture = await history('changes');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'a.ts'), 'a\n');
    await writeFile(join(fixture.path, 'src', 'b.ts'), 'b\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add two files');

    const { commits } = await provider.readHistory(
      fixture.discovered,
      { withChanges: true },
      context,
    );

    expect(commits[0]?.changes.map((change) => change.path).sort()).toStrictEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
    expect(commits[0]?.changes.every((change) => change.kind === ChangeKind.ADDED)).toBe(true);
  });

  it('reads a rename as a rename, with both paths', async () => {
    // The entry the parser gets wrong if it treats every status as two tokens.
    const fixture = await history('rename');
    await writeFile(join(fixture.path, 'old.txt'), 'contents that stay the same\n'.repeat(10));
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add old');
    await git(fixture.path, ['mv', 'old.txt', 'new.txt']);
    await commit(fixture.path, 'rename it');

    const { commits } = await provider.readHistory(
      fixture.discovered,
      { withChanges: true },
      context,
    );
    const renamed = commits[0]?.changes[0];

    expect(renamed?.kind).toBe(ChangeKind.RENAMED);
    expect(renamed?.previousPath).toBe('old.txt');
    expect(renamed?.path).toBe('new.txt');
    expect(renamed?.similarity).toBe(100);
  });

  it('reads a deletion', async () => {
    const fixture = await history('delete');
    await writeFile(join(fixture.path, 'doomed.txt'), 'x\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add doomed');
    await git(fixture.path, ['rm', 'doomed.txt']);
    await commit(fixture.path, 'remove doomed');

    const { commits } = await provider.readHistory(
      fixture.discovered,
      { withChanges: true },
      context,
    );
    expect(commits[0]?.changes[0]).toMatchObject({ kind: ChangeKind.DELETED, path: 'doomed.txt' });
  });

  it('reads a merge commit’s parents, and reports no changes for it', async () => {
    const fixture = await history('merge');
    await git(fixture.path, ['checkout', '-b', 'side']);
    await writeFile(join(fixture.path, 'side.txt'), 's\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'side work');
    await git(fixture.path, ['checkout', 'main']);
    await git(fixture.path, ['merge', '--no-ff', 'side', '-m', 'merge side']);

    const { commits } = await provider.readHistory(
      fixture.discovered,
      { withChanges: true },
      context,
    );
    const merge = commits[0];

    expect(merge?.subject).toBe('merge side');
    expect(merge?.parents).toHaveLength(2);
    // Not an omission: "what did this merge change" depends which parent you
    // compare against, so Git prints nothing and Ferret invents nothing.
    expect(merge?.changes).toStrictEqual([]);
  });

  it('pages through history', async () => {
    const fixture = await history('paged');
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(fixture.path, `f${String(i)}.txt`), `${String(i)}\n`);
      await git(fixture.path, ['add', '-A']);
      await commit(fixture.path, `commit ${String(i)}`);
    }

    const seen: string[] = [];
    let skip = 0;
    for (let page = 0; page < 10; page += 1) {
      const result = await provider.readHistory(fixture.discovered, { limit: 2, skip }, context);
      seen.push(...result.commits.map((c) => c.subject));
      if (result.cursor === undefined) break;
      skip += result.commits.length;
    }

    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it('reads only what is new when given an instant', async () => {
    // The read that actually matters for a running Ferret. Offset paging is
    // O(offset) on a deep history; an incremental read walks only what changed.
    const fixture = await history('incremental');
    // An hour, not a second: creating a commit takes long enough on a busy
    // Windows runner that a one-second cutoff is a race, and a racy test in a
    // reliability suite is worse than no test.
    const cutoff = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(join(fixture.path, 'later.txt'), 'later\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'later commit');

    const all = await provider.readHistory(fixture.discovered, {}, context);
    expect(all.commits.length).toBeGreaterThanOrEqual(2);

    // Nothing was committed after a cutoff in the future.
    const none = await provider.readHistory(fixture.discovered, { since: cutoff }, context);
    expect(none.commits).toStrictEqual([]);
  });

  it('answers with nothing for a ref that does not exist', async () => {
    // A question with the answer "nothing", not a failure — Governance §13.
    const fixture = await history('missing-ref');
    const { commits } = await provider.readHistory(
      fixture.discovered,
      { revision: 'refs/heads/never-existed' },
      context,
    );
    expect(commits).toStrictEqual([]);
  });

  it('refuses a revision that would be read as an option', async () => {
    const fixture = await history('bad-revision');
    await expect(
      provider.readHistory(fixture.discovered, { revision: '--upload-pack=evil' }, context),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE });
  });

  it('does not execute a program a repository nominates, while reading history', async () => {
    // The same protection EPIC-017 established, exercised through a different
    // command: `git log` consults the same configuration.
    const fixture = await history('hostile-log');
    const marker = join(workspace.path, 'log-ran.txt');
    const script = join(workspace.path, 'evil-log.sh');
    await writeFile(script, `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
    await git(fixture.path, ['config', 'core.pager', script]);
    await git(fixture.path, ['config', 'core.fsmonitor', script]);

    await provider.readHistory(fixture.discovered, { withChanges: true }, context);

    const { readFile } = await import('node:fs/promises');
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  });
});

withGit('the commit graph', () => {
  it('emits commits, their authors and the files they touched', async () => {
    const fixture = await history('graph');
    await mkdir(join(fixture.path, 'src'), { recursive: true });
    await writeFile(join(fixture.path, 'src', 'main.ts'), 'x\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add main');

    const { commits } = await provider.readHistory(
      fixture.discovered,
      { withChanges: true },
      context,
    );
    const graph = provider.emitHistory(fixture.discovered, commits);

    const kinds = new Set(graph.entities.map((entity) => entity.kind));
    expect(kinds).toContain('commit');
    expect(kinds).toContain('developer');
    expect(kinds).toContain('file');

    const types = new Set(graph.relationships.map((relationship) => relationship.type));
    expect(types).toContain(RelationshipType.REPOSITORY_CONTAINS_COMMIT);
    expect(types).toContain(RelationshipType.DEVELOPER_AUTHORED_COMMIT);
    expect(types).toContain(RelationshipType.COMMIT_MODIFIES_FILE);
    expect(types).toContain(RelationshipType.COMMIT_PARENT_OF_COMMIT);
  });

  it('gives a commit the same identity in every repository that holds it', async () => {
    // A Git commit hash is a content hash of the commit object: the same commit
    // in a fork and in its upstream is the same commit, byte for byte. Scoping
    // it to a repository would make "which release contains this fix"
    // unanswerable across a fork.
    const upstream = await history('upstream');
    const forkRoot = join(workspace.path, 'fork');
    await mkdir(forkRoot, { recursive: true });
    await git(forkRoot, ['clone', '--quiet', upstream.path, 'fork']);
    const forkPath = join(forkRoot, 'fork');
    await git(forkPath, ['remote', 'set-url', 'origin', 'https://github.com/someone-else/fork.git']);
    const fork = await provider.describeRepository(forkPath, context);

    // Two different repositories by EPIC-017's rules…
    expect(fork.identityKey).not.toBe(upstream.discovered.identityKey);

    const upstreamGraph = provider.emitHistory(
      upstream.discovered,
      (await provider.readHistory(upstream.discovered, {}, context)).commits,
    );
    const forkGraph = provider.emitHistory(
      fork,
      (await provider.readHistory(fork, {}, context)).commits,
    );

    const commitIds = (graph: typeof upstreamGraph): string[] =>
      graph.entities.filter((entity) => entity.kind === 'commit').map((entity) => entity.id).sort();

    // …holding the same commit.
    expect(forkGraph.entities.length).toBeGreaterThan(0);
    expect(commitIds(forkGraph)).toStrictEqual(commitIds(upstreamGraph));
  });

  it('scopes a file to its repository, so two READMEs are two files', async () => {
    const a = await history('files-a');
    const b = await history('files-b');

    const fileIds = async (fixture: Fixture): Promise<string[]> => {
      const { commits } = await provider.readHistory(fixture.discovered, { withChanges: true }, context);
      return provider
        .emitHistory(fixture.discovered, commits)
        .entities.filter((entity) => entity.kind === 'file')
        .map((entity) => entity.id);
    };

    const [first] = await fileIds(a);
    const [second] = await fileIds(b);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('keeps both paths of a rename reachable', async () => {
    // The old path is a file Ferret may never otherwise hear about — deleted in
    // the same commit that created its successor. Recording it is what makes the
    // history traversable backwards.
    const fixture = await history('rename-graph');
    await writeFile(join(fixture.path, 'before.txt'), 'stable contents\n'.repeat(10));
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'add before');
    await git(fixture.path, ['mv', 'before.txt', 'after.txt']);
    await commit(fixture.path, 'rename');

    const { commits } = await provider.readHistory(fixture.discovered, { withChanges: true }, context);
    const graph = provider.emitHistory(fixture.discovered, commits);
    const paths = graph.entities
      .filter((entity) => entity.kind === 'file')
      .map((entity) => entity.attributes['path']);

    expect(paths).toContain('before.txt');
    expect(paths).toContain('after.txt');
  });

  it('does not invent a developer for a commit with no author address', async () => {
    // Inventing an identity from a display name would merge every anonymous
    // author in the repository into one person.
    const fixture = await history('anonymous');
    await writeFile(join(fixture.path, 'a.txt'), 'a\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'anonymous', 'Nobody <>');

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);
    const anonymous = commits.find((c) => c.subject === 'anonymous');
    expect(anonymous?.authorEmail).toBe('');

    const graph = provider.emitHistory(fixture.discovered, [anonymous!]);
    expect(graph.entities.filter((entity) => entity.kind === 'developer')).toStrictEqual([]);
    expect(
      graph.relationships.filter((r) => r.type === RelationshipType.DEVELOPER_AUTHORED_COMMIT),
    ).toStrictEqual([]);
  });

  it('emits an agent for a bot author, never a developer — EPIC-036 AC-11', async () => {
    // The failure this replaces: `dependabot[bot]` recorded as a human
    // contributor, so "who has worked on this file" answers with a machine.
    const fixture = await history('bot-author');
    await writeFile(join(fixture.path, 'deps.txt'), 'bump\n');
    await git(fixture.path, ['add', '-A']);
    await commit(
      fixture.path,
      'chore(deps): bump left-pad',
      'dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
    );

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);
    const bump = commits.find((c) => c.subject.startsWith('chore(deps)'));
    const graph = provider.emitHistory(fixture.discovered, [bump!]);

    const agents = graph.entities.filter((entity) => entity.kind === 'agent');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.attributes).toMatchObject({ agentType: 'bot' });
    // And it says why, so the classification is answerable without re-deriving.
    expect(String(agents[0]?.attributes['description'])).toContain('github-app-noreply-address');

    expect(graph.entities.filter((entity) => entity.kind === 'developer')).toStrictEqual([]);
    expect(
      graph.relationships.filter((r) => r.type === RelationshipType.DEVELOPER_AUTHORED_COMMIT),
    ).toStrictEqual([]);
    expect(
      graph.relationships.filter((r) => r.type === RelationshipType.AGENT_AUTHORED_COMMIT),
    ).toHaveLength(1);
  });

  it('applies a .mailmap the caller supplies, and nothing when it does not — EPIC-036 AC-7', async () => {
    const fixture = await history('mailmap-history');
    await writeFile(join(fixture.path, 'm.txt'), 'm\n');
    await git(fixture.path, ['add', '-A']);
    await commit(fixture.path, 'from an old address', 'A. L. <old@example.invalid>');

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);
    const old = commits.find((c) => c.subject === 'from an old address');

    const withoutMap = provider.emitHistory(fixture.discovered, [old!]);
    expect(
      withoutMap.entities
        .filter((entity) => entity.kind === 'developer')
        .flatMap((entity) => entity.attributes['emails'] as string[]),
    ).toContain('old@example.invalid');

    const mailmap = parseMailmap('Ada Lovelace <ada@example.invalid> <old@example.invalid>');
    const withMap = provider.emitHistory(fixture.discovered, [old!], { mailmap });
    const ada = withMap.entities.find(
      (entity) => entity.kind === 'developer' && entity.attributes['name'] === 'Ada Lovelace',
    );

    expect(ada).toBeDefined();
    expect(ada?.attributes['emails']).toContain('ada@example.invalid');
    expect(JSON.stringify(withMap.entities)).not.toContain('old@example.invalid');
  });

  it('collapses many commits by one address into one developer, and keeps two addresses apart', async () => {
    // Both halves matter. Failing to collapse would give a developer a new
    // identity per commit; collapsing two *addresses* would decide that they are
    // one person, which is EPIC-036's decision and not one to make by accident.
    const fixture = await history('one-developer');
    for (let i = 0; i < 4; i += 1) {
      await writeFile(join(fixture.path, `f${String(i)}.txt`), `${String(i)}\n`);
      await git(fixture.path, ['add', '-A']);
      await commit(fixture.path, `commit ${String(i)}`);
    }

    const { commits } = await provider.readHistory(fixture.discovered, {}, context);
    const graph = provider.emitHistory(fixture.discovered, commits);

    const developers = graph.entities.filter((entity) => entity.kind === 'developer');
    // Ada authored four; the fixture's own identity authored the initial commit.
    expect(developers).toHaveLength(2);

    const ada = developers.find((entity) =>
      (entity.attributes['emails'] as string[]).includes('ada@example.invalid'),
    );
    expect(ada).toBeDefined();

    const authored = graph.relationships.filter(
      (relationship) =>
        relationship.type === RelationshipType.DEVELOPER_AUTHORED_COMMIT &&
        relationship.fromId === ada?.id,
    );
    expect(authored).toHaveLength(4);
  });

  it('emits identical entity ids for the same history read twice', async () => {
    const fixture = await history('idempotent-history');
    const { commits } = await provider.readHistory(fixture.discovered, { withChanges: true }, context);

    const first = provider.emitHistory(fixture.discovered, commits);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = provider.emitHistory(fixture.discovered, commits);

    expect(second.entities.map((e) => e.id)).toStrictEqual(first.entities.map((e) => e.id));
    // A commit's valid time is a fact Git *does* know — unlike a branch's
    // containment — so the parent and authorship edges are stable too.
    const stable = (graph: typeof first): string[] =>
      graph.relationships
        .filter((r) => r.type !== RelationshipType.REPOSITORY_CONTAINS_COMMIT)
        .map((r) => r.id);
    expect(stable(second)).toStrictEqual(stable(first));
  });

  it('reads a large history within budget', { timeout: 120_000 }, async () => {
    const fixture = await history('bulk');
    // Twenty-five, not a thousand: the cost here is *creating* the fixture —
    // roughly 450 ms per `git commit` on Windows — and the property under test
    // is that reading them is one invocation rather than twenty-five.
    for (let i = 0; i < 25; i += 1) {
      await writeFile(join(fixture.path, 'churn.txt'), `${String(i)}\n`);
      await git(fixture.path, ['add', '-A']);
      await commit(fixture.path, `churn ${String(i)}`);
    }

    const started = performance.now();
    const { commits } = await provider.readHistory(fixture.discovered, { withChanges: true }, context);
    const graph = provider.emitHistory(fixture.discovered, commits);
    const elapsed = performance.now() - started;

    expect(commits).toHaveLength(26);
    expect(graph.entities.length).toBeGreaterThan(25);
    // One Git invocation for twenty-six commits, not twenty-six invocations.
    // At ~450 ms per process, per-commit reading would not fit in this budget.
    expect(elapsed).toBeLessThan(10_000);
  });
});
