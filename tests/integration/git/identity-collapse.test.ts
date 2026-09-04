import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GitSourceProvider } from '../../../src/git/index.js';
import { readHistory } from '../../../src/git/history.js';
import { normalizeGitIdentity, parseMailmap } from '../../../src/identity/index.js';
import { createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createRepository, createWorkspace, git, gitVersion } from '../../support/git-fixtures.js';
import type { DiscoveredRepository } from '../../../src/index.js';

/**
 * **Two people are not one person because Git could not name either — F-11.**
 *
 * `normalizeGitIdentity` refuses only the *empty* address. Any other non-address
 * string is kept as an opaque identity whose `comparable` is the raw string, and
 * the provider derives the developer entity id straight from it. So every commit
 * authored `unknown` — what `git filter-branch`, `cvs2git` and hand-written
 * commit objects emit — becomes **one developer**, and the merge happens at
 * derivation time where `IdentityStore.merge` cannot see it and no evidence
 * records it. It is not reversible by adjudication because nothing was
 * adjudicated.
 *
 * The comment two lines above the derivation already states the guarantee this
 * file asserts: *"No address means no identity. Inventing one from a display
 * name would merge every 'unknown' author in the repository into one person."*
 * That is exactly what happened; the guarantee was true of the empty string and
 * of nothing else.
 *
 * Real `git`, real commits, and the provider's own `emitHistory` — the identity
 * is derived there, so that is where it has to be observed.
 */

const version = await gitVersion();
const describeGit = version === undefined ? describe.skip : describe;

function signal(): AbortSignal {
  return new AbortController().signal;
}

let workspace: { path: string; cleanup: () => Promise<void> };
let provider: GitSourceProvider;

beforeAll(async () => {
  workspace = await createWorkspace('ferret-identity-');
  provider = new GitSourceProvider();
  await provider.initialize(createTestProviderContext());
}, 60_000);

afterAll(async () => {
  await provider?.shutdown();
  await workspace?.cleanup();
});

interface Graph {
  readonly developers: readonly { id: string; name: unknown; emails: unknown }[];
  readonly commits: readonly { id: string; sha: unknown; attributes: Record<string, unknown> }[];
  readonly authorEdges: readonly { fromId: string; toId: string }[];
}

/**
 * Builds a repository with the given authors and returns what the provider
 * emitted for it.
 *
 * Each author is `[displayName, email]` and produces one commit, so a collapse
 * shows up as fewer developer entities than authors.
 */
async function emitFor(
  name: string,
  authors: readonly (readonly [string, string])[],
  mailmap?: string,
): Promise<Graph> {
  const root = await createRepository(workspace.path, name, { commit: false });
  for (const [author, email] of authors) {
    await git(root, ['commit', '-q', '--allow-empty', '-m', `by ${author}`, `--author=${author} <${email}>`]);
  }
  const discovered: DiscoveredRepository = await provider.describeRepository(root, createTestProviderContext());
  const page = await readHistory({ cwd: root, signal: signal(), withChanges: false });

  const graph = provider.emitHistory(discovered, page.commits, {
    observedAt: new Date(),
    ...(mailmap === undefined ? {} : { mailmap: parseMailmap(mailmap) }),
  });

  const developers = graph.entities
    .filter((entity) => entity.kind === 'developer' || entity.kind === 'agent')
    .map((entity) => ({
      id: entity.id,
      name: entity.attributes['name'],
      emails: entity.attributes['emails'],
    }));
  const commits = graph.entities
    .filter((entity) => entity.kind === 'commit')
    .map((entity) => ({ id: entity.id, sha: entity.attributes['sha'], attributes: entity.attributes }));
  const authorEdges = graph.relationships
    .filter((edge) => edge.type === 'developer_authored_commit' || edge.type === 'agent_authored_commit')
    .map((edge) => ({ fromId: edge.fromId, toId: edge.toId }));

  // A commit the emitter could not represent is rolled back and recorded, and a
  // fix that quietly lost one would otherwise show up only as a count being
  // short — which is how the first attempt at F-11 failed.
  expect(graph.skippedRecords, `${name}: commits the emitter refused`).toStrictEqual([]);

  return { developers, commits, authorEdges };
}

describe('the one place the decision is made', () => {
  it('refuses an address that is not an address, not only an empty one', () => {
    // The unit statement of the same rule, so a change to the provider cannot
    // silently move the decision somewhere else.
    expect(normalizeGitIdentity('Real Person', 'real@example.com')).toBeDefined();
    expect(normalizeGitIdentity('Nobody', '')).toBeUndefined();

    // `?? false` would make this vacuous: a missing property would read as
    // "not addressed" and the assertion would pass against the defect. It has
    // to be the value itself.
    expect(normalizeGitIdentity('Real Person', 'real@example.com')?.addressed).toBe(true);
    for (const notAnAddress of ['unknown', '(no author)', 'none', 'root', '@', 'a@']) {
      const identity = normalizeGitIdentity('Someone', notAnAddress);
      expect(identity, notAnAddress).toBeDefined();
      expect(identity?.addressed, `${notAnAddress} was treated as an address`).toBe(false);
    }
  });
});

describeGit('a repository whose authors have no address', () => {
  it('does not merge two people into one developer — F-11', async () => {
    const graph = await emitFor('collapse', [
      ['Alice Ainsworth', 'unknown'],
      ['Bob Brookes', 'unknown'],
      ['Carol Chen', 'carol@example.com'],
    ]);

    expect(graph.commits).toHaveLength(3);

    // The whole finding, in one assertion: `unknown` must not become a person.
    const identified = graph.developers.map((developer) => String(developer.name));
    expect(identified, 'a non-address became a developer identity').toStrictEqual(['Carol Chen']);

    // And nothing points two different humans at one actor.
    expect(graph.authorEdges).toHaveLength(1);
    const targets = new Set(graph.authorEdges.map((edge) => edge.fromId));
    expect(targets.size).toBe(1);
  }, 60_000);

  it('records what Git said rather than discarding it', async () => {
    // Refusing to *identify* is not licence to lose the observation. The commit
    // keeps what the repository claimed, marked as unattributed, so "who wrote
    // this" answers "Git said Alice Ainsworth <unknown>, which is not an
    // identity" rather than answering nothing.
    const graph = await emitFor('unattributed', [['Alice Ainsworth', 'unknown']]);

    const commit = graph.commits[0];
    const unattributed = commit?.attributes['unattributedAuthor'] as
      | { name?: string; email?: string; reason?: string }
      | undefined;

    expect(unattributed, 'the author Git reported was dropped without a trace').toBeDefined();
    expect(unattributed?.name).toBe('Alice Ainsworth');
    expect(unattributed?.email).toBe('unknown');
    expect(String(unattributed?.reason)).toMatch(/address/iu);
  }, 60_000);

  it('still identifies an author a .mailmap gives an address to', async () => {
    // The refusal has to happen *after* the project's own mapping, or a mailmap
    // — which exists precisely to repair imported history — would stop working
    // on the histories that need it most.
    const graph = await emitFor(
      'mailmapped',
      [['Alice Ainsworth', 'unknown']],
      '<alice@example.com> <unknown>',
    );

    expect(graph.developers.map((developer) => String(developer.name))).toStrictEqual(['Alice Ainsworth']);
    expect(graph.authorEdges).toHaveLength(1);
  }, 60_000);

  it('keeps identifying ordinary authors, and keeps two of them apart', async () => {
    // The control. A fix that identified nobody would pass every assertion
    // above and destroy the feature.
    const graph = await emitFor('ordinary', [
      ['Dana Diaz', 'dana@example.com'],
      ['Erin Evans', 'erin@example.com'],
      ['Dana Diaz', 'dana+tag@example.com'],
    ]);

    const names = graph.developers.map((developer) => String(developer.name)).sort();
    // `dana+tag@` is the same person — subaddressing is stripped by
    // `normalizeGitIdentity`, and that behaviour must survive this change.
    expect(names).toStrictEqual(['Dana Diaz', 'Erin Evans']);
    expect(graph.authorEdges).toHaveLength(3);
  }, 60_000);
});
