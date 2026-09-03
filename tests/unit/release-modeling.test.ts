import { describe, expect, it } from 'vitest';

import { EntityKind, RelationshipType, canonicalId, canonicalKey } from '../../src/domain/index.js';
import { MAX_RELEASE_COMMITS, commitsInRelease } from '../../src/project/ancestry.js';
import { modelReleases } from '../../src/project/releases.js';
import { Emitter } from '../../src/providers/sdk/emit.js';
import { DeploymentState } from '../../src/providers/contracts/source-project.js';
import type {
  ProjectDeployment,
  ProjectDeploymentStatus,
  ProjectRelease,
} from '../../src/providers/contracts/source-project.js';

/**
 * EPIC-073. What shipped, and where it went.
 *
 * The ancestry walk is the part worth testing hardest: no release API answers
 * "which commits does this contain", so the answer is derived, and a derivation
 * nobody checks is a claim nobody can defend.
 */

const REPOSITORY = canonicalId(
  canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'github', sourceId: 'o/r' }),
);

function emitter(): Emitter {
  return new Emitter({
    sourceSystem: 'github',
    producer: 'ferret.source.github',
    producerVersion: '1.0.0',
    systemOfRecord: true,
  });
}

/**
 * A small history.
 *
 *   c1 ← c2 ← c3 ← c5 (merge, also from c4)
 *          ↖ c4
 */
const PARENTS = new Map<string, readonly string[]>([
  ['c1', []],
  ['c2', ['c1']],
  ['c3', ['c2']],
  ['c4', ['c2']],
  ['c5', ['c3', 'c4']],
]);

const V1: ProjectRelease = { id: 'RE_1', tag: 'v1.0.0', publishedAt: '2026-01-01T00:00:00.000Z' };
const V2: ProjectRelease = { id: 'RE_2', tag: 'v2.0.0', publishedAt: '2026-02-01T00:00:00.000Z' };
const TAGS = new Map([
  ['v1.0.0', 'c2'],
  ['v2.0.0', 'c5'],
]);

function model(input: Parameters<typeof modelReleases>[0]) {
  return modelReleases(input, emitter());
}

describe('the ancestry walk', () => {
  it('reports what is new since the previous release — AC-2', () => {
    // `git log v1.0.0..v2.0.0`: c5, c4 and c3, and not c2 or c1.
    const walk = commitsInRelease(PARENTS, 'c5', 'c2');
    expect([...walk.commits].sort()).toStrictEqual(['c3', 'c4', 'c5']);
    expect(walk.truncated).toBe(false);
  });

  it('crosses a merge and reaches both sides', () => {
    const walk = commitsInRelease(PARENTS, 'c5', 'c2');
    expect(walk.commits).toContain('c3');
    expect(walk.commits).toContain('c4');
  });

  it('returns the whole ancestry with no predecessor — AC-3', () => {
    const walk = commitsInRelease(PARENTS, 'c5', undefined);
    expect([...walk.commits].sort()).toStrictEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('stops at the bound and says it stopped — AC-3', () => {
    const walk = commitsInRelease(PARENTS, 'c5', undefined, { limit: 2 });
    expect(walk.commits).toHaveLength(2);
    expect(walk.truncated).toBe(true);
  });

  it('reports a parent it was not given, rather than calling it a root — AC-6', () => {
    // "We do not have this commit" and "this commit has no parents" are
    // different facts, and only the second is a claim about history.
    const partial = new Map<string, readonly string[]>([['c9', ['c8']]]);
    const walk = commitsInRelease(partial, 'c9', undefined);
    expect(walk.commits).toStrictEqual(['c9']);
    expect(walk.unresolved).toStrictEqual(['c8']);
  });

  it('declares a bound a reader can reason about', () => {
    expect(MAX_RELEASE_COMMITS).toBe(5_000);
  });
});

describe('release modelling', () => {
  it('makes a release entity with its tag as the version — AC-1', () => {
    const result = model({ repositoryId: REPOSITORY, releases: [V1] });
    const entity = result.entities.find((one) => one.kind === EntityKind.RELEASE);
    expect(entity?.source.scope).toBe(REPOSITORY);
    expect(entity?.attributes['version']).toBe('v1.0.0');
    expect(entity?.attributes['tag']).toBe('v1.0.0');
  });

  it('gives the second release only what is new — AC-2', () => {
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V2, V1],
      tagCommits: TAGS,
      commitParents: PARENTS,
    });
    const second = result.entities.find(
      (one) => one.kind === EntityKind.RELEASE && one.attributes['tag'] === 'v2.0.0',
    );
    const included = result.relationships
      .filter(
        (edge) =>
          edge.type === RelationshipType.RELEASE_INCLUDES_COMMIT && edge.fromId === second?.id,
      )
      .map((edge) => edge.toId);
    expect(included).toHaveLength(3);
    // Recorded on the edge: a reader asking why a commit is in a release gets
    // the derivation rather than a bare assertion.
    const edge = result.relationships.find(
      (one) => one.type === RelationshipType.RELEASE_INCLUDES_COMMIT && one.fromId === second?.id,
    );
    expect(edge?.metadata['basis']).toBe('ancestry');
    expect(edge?.metadata['since']).toBe('v1.0.0');
  });

  it('orders releases by publication, whatever order they arrive in — AC-2', () => {
    // Passed newest-first above; v1 must still be v2's predecessor.
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V2, V1],
      tagCommits: TAGS,
      commitParents: PARENTS,
    });
    const first = result.entities.find(
      (one) => one.kind === EntityKind.RELEASE && one.attributes['tag'] === 'v1.0.0',
    );
    const firstIncludes = result.relationships.filter(
      (edge) => edge.type === RelationshipType.RELEASE_INCLUDES_COMMIT && edge.fromId === first?.id,
    );
    // v1 is the first release, so it contains its whole ancestry: c1 and c2.
    expect(firstIncludes).toHaveLength(2);
  });

  it('gives a draft an entity, no commits, and no successorship — AC-4', () => {
    const draft: ProjectRelease = { ...V2, id: 'RE_draft', tag: 'v3.0.0', draft: true };
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V1, draft],
      tagCommits: new Map([...TAGS, ['v3.0.0', 'c5']]),
      commitParents: PARENTS,
    });
    const entity = result.entities.find(
      (one) => one.kind === EntityKind.RELEASE && one.attributes['tag'] === 'v3.0.0',
    );
    expect(entity).toBeDefined();
    expect(
      result.relationships.filter(
        (edge) => edge.type === RelationshipType.RELEASE_INCLUDES_COMMIT && edge.fromId === entity?.id,
      ),
    ).toStrictEqual([]);
  });

  it('reports an unresolvable tag rather than an empty release — AC-5', () => {
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V1],
      tagCommits: new Map(),
      commitParents: PARENTS,
    });
    expect(result.unresolvedTags).toStrictEqual(['v1.0.0']);
    expect(result.entities.some((one) => one.kind === EntityKind.RELEASE)).toBe(true);
  });

  it('reports a truncated release — AC-3', () => {
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V1],
      tagCommits: TAGS,
      commitParents: PARENTS,
      maxCommitsPerRelease: 1,
    });
    expect(result.truncatedReleases).toStrictEqual(['v1.0.0']);
  });

  it('emits every commit endpoint as a placeholder — AC-11', () => {
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V1],
      tagCommits: TAGS,
      commitParents: PARENTS,
    });
    const placeholders = new Set(result.placeholderEntityIds);
    const commits = result.entities.filter((one) => one.kind === EntityKind.COMMIT);
    expect(commits.length).toBeGreaterThan(0);
    // EPIC-072 §8.10 learned this from a 23503. An edge whose endpoint has
    // never been written is not a graph.
    for (const commit of commits) expect(placeholders.has(commit.id)).toBe(true);
  });

  it('redacts a credential pasted into release notes', () => {
    const leaky: ProjectRelease = { ...V1, body: 'deploy with ghp_0123456789abcdefghijklmnopqrstuvwxyzA' };
    const result = model({ repositoryId: REPOSITORY, releases: [leaky] });
    expect(String(result.entities[0]?.attributes['notes'])).not.toContain('ghp_0123456789');
  });
});

describe('deployment modelling', () => {
  const DEPLOY: ProjectDeployment = {
    id: 'DE_1',
    ref: 'v2.0.0',
    revision: 'c5',
    environment: 'production',
    production: true,
    createdAt: '2026-02-02T00:00:00.000Z',
  };

  const SUCCEEDED: ProjectDeploymentStatus = {
    id: 'DS_2',
    deploymentId: 'DE_1',
    state: 'success',
    lifecycle: DeploymentState.SUCCEEDED,
    createdAt: '2026-02-02T00:10:00.000Z',
  };

  it('makes a deployment entity with its environment — AC-7', () => {
    const result = model({ repositoryId: REPOSITORY, deployments: [DEPLOY] });
    const entity = result.entities.find((one) => one.kind === EntityKind.DEPLOYMENT);
    expect(entity?.attributes['environment']).toBe('production');
    expect(entity?.attributes['revision']).toBe('c5');
  });

  it('leaves the state absent when nothing reported one — AC-8', () => {
    // Calling it `pending` would be Ferret's guess presented as the system's
    // answer.
    const result = model({ repositoryId: REPOSITORY, deployments: [DEPLOY] });
    const entity = result.entities.find((one) => one.kind === EntityKind.DEPLOYMENT);
    expect(entity?.attributes['state']).toBeUndefined();
  });

  it('takes the latest status, and inactive is not a failure — AC-9', () => {
    const earlier: ProjectDeploymentStatus = {
      id: 'DS_1',
      deploymentId: 'DE_1',
      state: 'in_progress',
      lifecycle: DeploymentState.IN_PROGRESS,
      createdAt: '2026-02-02T00:05:00.000Z',
    };
    const superseded: ProjectDeploymentStatus = {
      id: 'DS_3',
      deploymentId: 'DE_1',
      state: 'inactive',
      lifecycle: DeploymentState.INACTIVE,
      createdAt: '2026-02-03T00:00:00.000Z',
    };

    const latest = model({
      repositoryId: REPOSITORY,
      deployments: [DEPLOY],
      deploymentStatuses: [earlier, SUCCEEDED],
    });
    expect(
      latest.entities.find((one) => one.kind === EntityKind.DEPLOYMENT)?.attributes['state'],
    ).toBe(DeploymentState.SUCCEEDED);

    const later = model({
      repositoryId: REPOSITORY,
      deployments: [DEPLOY],
      deploymentStatuses: [SUCCEEDED, superseded],
    });
    // Superseded by a later deployment. Not a failure, and it must never be
    // counted as one.
    expect(
      later.entities.find((one) => one.kind === EntityKind.DEPLOYMENT)?.attributes['state'],
    ).toBe(DeploymentState.INACTIVE);
  });

  it('joins a deployment to the release whose tag it deployed — AC-10', () => {
    const result = model({
      repositoryId: REPOSITORY,
      releases: [V1, V2],
      deployments: [DEPLOY],
      tagCommits: TAGS,
      commitParents: PARENTS,
    });
    const edge = result.relationships.find(
      (one) => one.type === RelationshipType.DEPLOYMENT_DEPLOYS_RELEASE,
    );
    expect(edge).toBeDefined();
    expect(edge?.metadata['ref']).toBe('v2.0.0');
  });

  it('does not call a branch a release — AC-10', () => {
    // GitHub deploys a ref. A branch is not a release however often it is
    // deployed, and an edge that pretended otherwise would make "what is in
    // production" answer with the wrong thing on every repository deploying
    // `main`.
    const branch: ProjectDeployment = { ...DEPLOY, ref: 'main' };
    const result = model({ repositoryId: REPOSITORY, releases: [V1, V2], deployments: [branch] });
    expect(
      result.relationships.filter(
        (one) => one.type === RelationshipType.DEPLOYMENT_DEPLOYS_RELEASE,
      ),
    ).toStrictEqual([]);
  });

  it('carries evidence for the state it did report', () => {
    const result = model({
      repositoryId: REPOSITORY,
      deployments: [DEPLOY],
      deploymentStatuses: [SUCCEEDED],
    });
    const evidence = result.evidence.find((one) => one.field === 'attributes.state');
    expect(evidence?.locator?.kind).toBe('deployment');
    expect(evidence?.locator?.detail).toBe('production');
  });
});

describe('release modelling — failure', () => {
  it('skips one malformed record and models the rest — AC-16', () => {
    const malformed = { id: 'RE_bad', tag: 42 as unknown as string };
    const result = model({ repositoryId: REPOSITORY, releases: [malformed, V1] });
    expect(result.skipped.map((one) => one.id)).toStrictEqual(['RE_bad']);
    expect(result.entities.some((one) => one.attributes['tag'] === 'v1.0.0')).toBe(true);
  });

  it('models nothing from nothing', () => {
    const result = model({ repositoryId: REPOSITORY });
    expect(result.entities).toStrictEqual([]);
    expect(result.skipped).toStrictEqual([]);
  });
});
