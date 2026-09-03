import { EntityKind, RelationshipType } from '../domain/index.js';
import { redactSecrets } from '../security/index.js';
import {
  DeploymentState,
  type ProjectDeployment,
  type ProjectDeploymentStatus,
  type ProjectRelease,
} from '../providers/contracts/source-project.js';
import type { Emitter } from '../providers/sdk/emit.js';
import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../domain/index.js';

import { commitsInRelease, MAX_RELEASE_COMMITS } from './ancestry.js';

/**
 * Releases and deployments — EPIC-073.
 *
 * `RELEASE_INCLUDES_COMMIT` and `DEPLOYMENT_DEPLOYS_RELEASE` have been declared
 * since EPIC-006 and never emitted. The first is the interesting one: no
 * release API answers it, because a release names a tag and a tag names one
 * commit. The answer is in the commit graph Ferret already has — §8.2.
 */

export interface ReleaseModelInput {
  readonly repositoryId: string;
  readonly releases?: readonly ProjectRelease[];
  readonly deployments?: readonly ProjectDeployment[];
  /** Statuses for the deployments above, in any order — §8.4. */
  readonly deploymentStatuses?: readonly ProjectDeploymentStatus[];
  /**
   * The commit each tag points at.
   *
   * Supplied by the caller because resolving a tag is Git's job, not a project
   * tracker's: `GET /releases` reports `tag_name` and nothing about ancestry.
   */
  readonly tagCommits?: ReadonlyMap<string, string>;
  /** Every commit's parents, for the ancestry walk — §8.2. */
  readonly commitParents?: ReadonlyMap<string, readonly string[]>;
  readonly maxCommitsPerRelease?: number;
}

export interface ReleaseModelResult {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
  readonly placeholderEntityIds: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Releases whose commit set hit the bound — §8.2. */
  readonly truncatedReleases: readonly string[];
  /** Releases whose tag Ferret could not resolve to a commit — §8.3. */
  readonly unresolvedTags: readonly string[];
}

interface Accumulator {
  readonly entities: CanonicalEntity[];
  readonly relationships: CanonicalRelationship[];
  readonly evidence: CanonicalEvidence[];
  readonly placeholders: Set<string>;
  readonly seen: Set<string>;
  readonly skipped: { id: string; reason: string }[];
  readonly truncated: string[];
  readonly unresolvedTags: string[];
}

/** Model a repository's releases and deployments. */
export function modelReleases(input: ReleaseModelInput, emitter: Emitter): ReleaseModelResult {
  const state: Accumulator = {
    entities: [],
    relationships: [],
    evidence: [],
    placeholders: new Set(),
    seen: new Set(),
    skipped: [],
    truncated: [],
    unresolvedTags: [],
  };

  // §8.2. Ordered oldest first, because a release's contents are what is new
  // since the one before it, and "before" is a date the source reported.
  const releases = [...(input.releases ?? [])].sort(byPublication);
  const byId = new Map<string, CanonicalEntity>();
  let previousTag: string | undefined;

  for (const release of releases) {
    try {
      const entity = addRelease(state, release, input, previousTag, emitter);
      byId.set(release.id, entity);
      // A draft is not published, so it does not become the predecessor: the
      // next real release's contents are measured from the last real one.
      if (release.draft !== true) previousTag = release.tag;
    } catch (error) {
      state.skipped.push({ id: release.id, reason: messageOf(error) });
    }
  }

  const latestStatus = latestByDeployment(input.deploymentStatuses ?? []);
  for (const deployment of input.deployments ?? []) {
    try {
      addDeployment(state, deployment, latestStatus.get(deployment.id), releases, byId, input, emitter);
    } catch (error) {
      state.skipped.push({ id: deployment.id, reason: messageOf(error) });
    }
  }

  return {
    entities: state.entities,
    relationships: state.relationships,
    evidence: state.evidence,
    placeholderEntityIds: [...state.placeholders],
    skipped: state.skipped,
    truncatedReleases: state.truncated,
    unresolvedTags: state.unresolvedTags,
  };
}

function addRelease(
  state: Accumulator,
  release: ProjectRelease,
  input: ReleaseModelInput,
  previousTag: string | undefined,
  emitter: Emitter,
): CanonicalEntity {
  const entity = emitter.entity({
    kind: EntityKind.RELEASE,
    source: {
      id: release.id,
      scope: input.repositoryId,
      ...(release.url === undefined ? {} : { url: release.url }),
    },
    attributes: {
      ...(release.name === undefined ? {} : { name: redactSecrets(release.name).text }),
      // The tag *is* the version for every project that tags its releases, and
      // where a name differs it is a title rather than a version.
      version: release.tag,
      tag: release.tag,
      ...(release.publishedAt === undefined ? {} : { releasedAt: release.publishedAt }),
      ...(release.prerelease === undefined ? {} : { isPrerelease: release.prerelease }),
      ...(release.body === undefined ? {} : { notes: redactSecrets(release.body).text }),
    },
    ...(release.publishedAt === undefined ? {} : { sourceObservedAt: release.publishedAt }),
  });
  addEntity(state, entity, false);

  state.evidence.push(
    emitter.about(entity, 'attributes.tag', release.tag, {
      locator: { kind: 'tag', start: release.tag },
    }),
  );

  // A draft release contains nothing: it has not been published, and its tag
  // may not exist yet. Emitting a commit set for one would be a claim about a
  // release that has not happened.
  if (release.draft === true) return entity;

  addReleaseCommits(state, entity, release, input, previousTag, emitter);
  return entity;
}

/**
 * The commits a release contains — §8.2.
 *
 * Everything reachable from this release's tag and not from the previous
 * release's. Without a tag-to-commit map there is nothing to walk, and that is
 * reported rather than guessed: a release whose tag Ferret cannot resolve gets
 * an entity and no commit edges, which is the honest half.
 */
function addReleaseCommits(
  state: Accumulator,
  entity: CanonicalEntity,
  release: ProjectRelease,
  input: ReleaseModelInput,
  previousTag: string | undefined,
  emitter: Emitter,
): void {
  const head = input.tagCommits?.get(release.tag);
  if (head === undefined) {
    state.unresolvedTags.push(release.tag);
    return;
  }
  const parents = input.commitParents;
  if (parents === undefined) return;

  const walk = commitsInRelease(
    parents,
    head,
    previousTag === undefined ? undefined : input.tagCommits?.get(previousTag),
    { limit: input.maxCommitsPerRelease ?? MAX_RELEASE_COMMITS },
  );
  if (walk.truncated) state.truncated.push(release.tag);

  for (const sha of walk.commits) {
    const commit = addEntity(
      state,
      emitter.entity({ kind: EntityKind.COMMIT, source: { id: sha }, attributes: { sha } }),
      true,
    );
    state.relationships.push(
      emitter.relationship({
        fromId: entity.id,
        type: RelationshipType.RELEASE_INCLUDES_COMMIT,
        toId: commit.id,
        metadata: {
          // How this was worked out, recorded on the edge: a reader asking why
          // a commit is in a release gets "reachable from its tag and not from
          // the previous release's" rather than a bare assertion.
          basis: 'ancestry',
          ...(previousTag === undefined ? {} : { since: previousTag }),
        },
      }),
    );
  }
}

function addDeployment(
  state: Accumulator,
  deployment: ProjectDeployment,
  status: ProjectDeploymentStatus | undefined,
  releases: readonly ProjectRelease[],
  releaseEntities: ReadonlyMap<string, CanonicalEntity>,
  input: ReleaseModelInput,
  emitter: Emitter,
): void {
  const entity = emitter.entity({
    kind: EntityKind.DEPLOYMENT,
    source: {
      id: deployment.id,
      scope: input.repositoryId,
      ...(deployment.url === undefined ? {} : { url: deployment.url }),
    },
    attributes: {
      ...(deployment.environment === undefined ? {} : { environment: deployment.environment }),
      // §8.4. Absent rather than assumed: a deployment with no status has not
      // reported one, and calling that `pending` would be Ferret's guess rather
      // than the system's answer.
      ...(status === undefined ? {} : { state: status.lifecycle }),
      ...(deployment.revision === undefined ? {} : { revision: deployment.revision }),
      ...(status?.createdAt === undefined
        ? deployment.createdAt === undefined
          ? {}
          : { deployedAt: deployment.createdAt }
        : { deployedAt: status.createdAt }),
      ...(deployment.description === undefined
        ? {}
        : { description: redactSecrets(deployment.description).text }),
    },
    ...(deployment.updatedAt === undefined ? {} : { sourceObservedAt: deployment.updatedAt }),
  });
  addEntity(state, entity, false);

  if (status !== undefined) {
    state.evidence.push(
      emitter.about(entity, 'attributes.state', status.lifecycle, {
        locator: {
          kind: 'deployment',
          start: deployment.id,
          ...(deployment.environment === undefined ? {} : { detail: deployment.environment }),
        },
      }),
    );
  }

  // §8.5. A deployment deploys a *release* only when its ref is one. GitHub
  // deploys a ref, which may be a tag, a branch or a raw SHA — and a branch is
  // not a release however often it is deployed.
  const release = deployment.ref === undefined ? undefined : releases.find((one) => one.tag === deployment.ref);
  const releaseEntity = release === undefined ? undefined : releaseEntities.get(release.id);
  if (releaseEntity !== undefined) {
    state.relationships.push(
      emitter.relationship({
        fromId: entity.id,
        type: RelationshipType.DEPLOYMENT_DEPLOYS_RELEASE,
        toId: releaseEntity.id,
        metadata: { ref: deployment.ref ?? '' },
      }),
    );
  }
}

/**
 * The last status a deployment reported.
 *
 * Last by `createdAt`, and ties broken by order of appearance — GitHub returns
 * statuses newest first, so the first of two with the same timestamp is the
 * later one.
 */
function latestByDeployment(
  statuses: readonly ProjectDeploymentStatus[],
): ReadonlyMap<string, ProjectDeploymentStatus> {
  const latest = new Map<string, ProjectDeploymentStatus>();
  for (const status of statuses) {
    const held = latest.get(status.deploymentId);
    if (held === undefined) {
      latest.set(status.deploymentId, status);
      continue;
    }
    if ((status.createdAt ?? '') > (held.createdAt ?? '')) latest.set(status.deploymentId, status);
  }
  return latest;
}

/** Oldest first. A release with no publication date sorts before one with. */
function byPublication(one: ProjectRelease, two: ProjectRelease): number {
  return (one.publishedAt ?? '').localeCompare(two.publishedAt ?? '');
}

function addEntity(
  state: Accumulator,
  entity: CanonicalEntity,
  placeholder: boolean,
): CanonicalEntity {
  if (!state.seen.has(entity.id)) {
    state.seen.add(entity.id);
    state.entities.push(entity);
    if (placeholder) state.placeholders.add(entity.id);
    return entity;
  }
  if (!placeholder) state.placeholders.delete(entity.id);
  return entity;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported so a caller can name the state it is filtering on. */
export { DeploymentState };
