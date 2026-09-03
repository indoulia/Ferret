import { EntityKind, RelationshipType } from '../domain/index.js';
import { entityKindForActor } from '../domain/actor.js';
import { classifyIdentity, normalizeGitIdentity, type NormalizedIdentity } from '../identity/index.js';
import { redactSecrets } from '../security/index.js';
import {
  ProjectItemState,
  type ProjectActor,
  type ProjectIssue,
  type ProjectPullRequest,
  type ProjectReview,
} from '../providers/contracts/source-project.js';
import type { Emitter } from '../providers/sdk/emit.js';
import type { CanonicalEntity, CanonicalEvidence, CanonicalRelationship } from '../domain/index.js';

import { CANONICAL_SOURCE_SYSTEM } from '../resolution/global.js';

import { findClosingReferences } from './references.js';

/**
 * Records into canonical knowledge — EPIC-072.
 *
 * A pure function. No transport, no database, no clock beyond what the records
 * carry: EPIC-021 reads GitHub and EPIC-071 will read Jira, and both hand their
 * records here. That this module cannot make a request is the property that
 * lets it be tested exhaustively without one.
 *
 * Everything it uses already existed. `kinds.ts` declared `pull_request`,
 * `review` and `issue`; `relationship.ts` declared six edge types between them;
 * `attributes.ts` had the schemas; `Emitter` attaches attribution;
 * `classifyIdentity` tells a person from a bot. This Epic adds no primitive —
 * it is the join nothing had performed.
 */

export interface ProjectModelInput {
  /** The repository these belong to. Identity is scoped to it — §8.1. */
  readonly repositoryId: string;
  /** `owner/repo`, for resolving a same-repository issue reference. */
  readonly project: string;
  readonly pullRequests?: readonly ProjectPullRequest[];
  /** Keyed by the pull request id the reviews belong to. */
  readonly reviews?: readonly ProjectReview[];
  readonly issues?: readonly ProjectIssue[];
}

export interface SkippedRecord {
  readonly id: string;
  readonly reason: string;
}

export interface ProjectModelResult {
  readonly entities: readonly CanonicalEntity[];
  readonly relationships: readonly CanonicalRelationship[];
  readonly evidence: readonly CanonicalEvidence[];
  /**
   * Identities worth linking, for a caller that also holds Git's — §8.6.
   *
   * Not proposals: `proposeIdentityLinks` compares a *set*, and this module sees
   * only one system's. Handing back the normalized identity lets a caller that
   * has both run the comparison EPIC-036 already implements, rather than having
   * a second, weaker one written here.
   */
  readonly identities: readonly NormalizedIdentity[];
  /**
   * Entities emitted only so an edge has an endpoint — EPIC-072 §8.10.
   *
   * A merge commit, a target branch, a referenced issue in another repository:
   * each is an entity Git or another pass owns, and each has to *exist* before
   * the edge to it can be stored — the `relationship` table has a foreign key,
   * and a modelling pass that emitted the edge without the endpoint produced a
   * `23503` rather than a graph. Found by the integration test, and fixed the
   * way the Git provider already does it: the ids are named here, and the
   * writer upserts them with `ifAbsent` so a stub never overwrites a record an
   * earlier run read in full.
   */
  readonly placeholderEntityIds: readonly string[];
  /** §8.9. One malformed record must not fail a repository. */
  readonly skipped: readonly SkippedRecord[];
  /** How much of the graph rests on text parsing — §12. */
  readonly inferredResolutions: number;
}

interface Accumulator {
  readonly entities: CanonicalEntity[];
  readonly relationships: CanonicalRelationship[];
  readonly evidence: CanonicalEvidence[];
  readonly identities: NormalizedIdentity[];
  readonly skipped: SkippedRecord[];
  readonly actors: Map<string, CanonicalEntity>;
  readonly placeholders: Set<string>;
  readonly seen: Set<string>;
  inferredResolutions: number;
}

/** Model a repository's project records. */
export function modelProject(input: ProjectModelInput, emitter: Emitter): ProjectModelResult {
  const state: Accumulator = {
    entities: [],
    relationships: [],
    evidence: [],
    identities: [],
    skipped: [],
    actors: new Map(),
    placeholders: new Set(),
    seen: new Set(),
    inferredResolutions: 0,
  };

  const pullRequestsById = new Map<string, CanonicalEntity>();

  for (const issue of input.issues ?? []) {
    modelOne(state, issue.id, () => {
      addIssue(state, issue, input, emitter);
    });
  }

  for (const pull of input.pullRequests ?? []) {
    modelOne(state, pull.id, () => {
      pullRequestsById.set(pull.id, addPullRequest(state, pull, input, emitter));
    });
  }

  for (const review of input.reviews ?? []) {
    modelOne(state, review.id, () => {
      addReview(state, review, pullRequestsById, input, emitter);
    });
  }

  return {
    entities: state.entities,
    relationships: state.relationships,
    evidence: state.evidence,
    identities: state.identities,
    placeholderEntityIds: [...state.placeholders],
    skipped: state.skipped,
    inferredResolutions: state.inferredResolutions,
  };
}

/**
 * Records an entity once, remembering whether it was a placeholder.
 *
 * A record modelled in full outranks a stub for the same id, whichever order
 * they arrive in: an issue that appears both as a record and as the target of
 * "Fixes #7" is one entity, and the full version must win.
 */
function addEntity(state: Accumulator, entity: CanonicalEntity, placeholder: boolean): CanonicalEntity {
  if (!state.seen.has(entity.id)) {
    state.seen.add(entity.id);
    state.entities.push(entity);
    if (placeholder) state.placeholders.add(entity.id);
    return entity;
  }
  if (!placeholder) state.placeholders.delete(entity.id);
  return entity;
}

/**
 * One record, and a failure that costs one record.
 *
 * §8.9. A repository with four hundred pull requests and one that violates an
 * attribute schema should produce three hundred and ninety-nine modelled
 * records and a count — not an exception that loses all of them.
 */
function modelOne(state: Accumulator, id: string, model: () => void): void {
  try {
    model();
  } catch (error) {
    state.skipped.push({ id, reason: error instanceof Error ? error.message : String(error) });
  }
}

function addIssue(
  state: Accumulator,
  issue: ProjectIssue,
  input: ProjectModelInput,
  emitter: Emitter,
): CanonicalEntity {
  const entity = emitter.entity({
    kind: EntityKind.ISSUE,
    source: {
      id: issue.id,
      scope: input.repositoryId,
      ...(issue.url === undefined ? {} : { url: issue.url }),
    },
    attributes: {
      ...(issue.number === undefined ? {} : { key: String(issue.number) }),
      // A title can carry a token: somebody pastes a failing curl command into
      // an issue and the token travels with it.
      title: redactSecrets(issue.title).text,
      state: issue.lifecycle,
      // The source's own word, beside the comparable reading — EPIC-021 §8.1.
      sourceState: issue.state,
      labels: [...(issue.labels ?? [])],
      ...(issue.createdAt === undefined ? {} : { createdAt: issue.createdAt }),
      ...(issue.closedAt === undefined ? {} : { closedAt: issue.closedAt }),
    },
    ...(issue.updatedAt === undefined ? {} : { sourceObservedAt: issue.updatedAt }),
  });
  addEntity(state, entity, false);

  // §8.8. State is the attribute a person will ask Ferret to justify.
  state.evidence.push(
    emitter.about(entity, 'attributes.state', issue.lifecycle, {
      ...(issue.number === undefined
        ? {}
        : { locator: { kind: 'issue', start: issue.number, detail: input.project } }),
    }),
  );

  if (issue.author !== undefined) actorEntity(state, issue.author, emitter);
  return entity;
}

function addPullRequest(
  state: Accumulator,
  pull: ProjectPullRequest,
  input: ProjectModelInput,
  emitter: Emitter,
): CanonicalEntity {
  const entity = emitter.entity({
    kind: EntityKind.PULL_REQUEST,
    source: {
      id: pull.id,
      scope: input.repositoryId,
      ...(pull.url === undefined ? {} : { url: pull.url }),
    },
    attributes: {
      ...(pull.number === undefined ? {} : { number: String(pull.number) }),
      title: redactSecrets(pull.title).text,
      // `draft` is a state a person asks about, and GitHub reports it beside
      // `open` rather than instead of it.
      state: pull.draft === true && pull.lifecycle === ProjectItemState.OPEN ? 'draft' : pull.lifecycle,
      // A branch name can carry a token — `fix/ghp_…` is a legal ref.
      ...(pull.sourceBranch === undefined
        ? {}
        : { sourceRef: redactSecrets(pull.sourceBranch).text }),
      ...(pull.targetBranch === undefined
        ? {}
        : { targetRef: redactSecrets(pull.targetBranch).text }),
      ...(pull.createdAt === undefined ? {} : { createdAt: pull.createdAt }),
      ...(pull.mergedAt === undefined ? {} : { mergedAt: pull.mergedAt }),
      ...(pull.closedAt === undefined ? {} : { closedAt: pull.closedAt }),
      ...(pull.mergeCommit === undefined ? {} : { mergeCommit: pull.mergeCommit }),
    },
    ...(pull.updatedAt === undefined ? {} : { sourceObservedAt: pull.updatedAt }),
  });
  addEntity(state, entity, false);

  const locator =
    pull.number === undefined
      ? {}
      : { locator: { kind: 'pull-request' as const, start: pull.number, detail: input.project } };
  state.evidence.push(emitter.about(entity, 'attributes.state', pull.lifecycle, locator));

  if (pull.author !== undefined) actorEntity(state, pull.author, emitter);

  // §8.2. Only a merged pull request proposes a commit Ferret can resolve: an
  // open one proposes commits on a branch that may never have been fetched, and
  // an edge into emptiness is worse than an absent edge.
  if (pull.mergeCommit !== undefined) {
    const commit = addEntity(state, commitEntity(pull.mergeCommit, emitter), true);
    state.relationships.push(
      emitter.relationship({
        fromId: entity.id,
        type: RelationshipType.PULL_REQUEST_PROPOSES_COMMIT,
        toId: commit.id,
        metadata: { role: 'merge-commit' },
      }),
    );
    state.evidence.push(emitter.about(entity, 'attributes.mergeCommit', pull.mergeCommit, locator));
  }

  // §8.3. The *target* is an edge because it outlives the pull request; the
  // source branch is an attribute because it usually does not.
  if (pull.targetBranch !== undefined) {
    const branch = addEntity(state, branchEntity(pull.targetBranch, input.repositoryId, emitter), true);
    state.relationships.push(
      emitter.relationship({
        fromId: entity.id,
        type: RelationshipType.PULL_REQUEST_TARGETS_BRANCH,
        toId: branch.id,
      }),
    );
  }

  addResolutions(state, entity, pull, input, emitter);
  return entity;
}

/**
 * `Fixes #12` — an inference, labelled as one.
 *
 * §8.4. The evidence is `inferred` and names the pull request's own evidence as
 * its basis, so "why do you believe this pull request resolved that issue" has
 * an answer that ends at a quotation from a body somebody wrote.
 */
function addResolutions(
  state: Accumulator,
  entity: CanonicalEntity,
  pull: ProjectPullRequest,
  input: ProjectModelInput,
  emitter: Emitter,
): void {
  for (const reference of findClosingReferences(pull.body)) {
    // A cross-repository reference is scoped to *that* repository, which is the
    // only reading that can be right. Ferret may not have indexed it, and an
    // entity id that resolves to nothing yet is still the correct id.
    const issueScope =
      reference.project === undefined || reference.project === input.project
        ? input.repositoryId
        : foreignRepositoryScope(reference.project, emitter);

    const issue = emitter.entity({
      kind: EntityKind.ISSUE,
      // The provider's stable id is not knowable from a body: what a reference
      // gives is a number in a project, so that is the source id, and EPIC-051
      // is what reconciles it with the record when both are present.
      source: { id: `${reference.project ?? input.project}#${String(reference.number)}`, scope: issueScope },
      attributes: { key: String(reference.number) },
    });
    addEntity(state, issue, true);

    // The basis is *observed*: the body said this. `derivedFrom` names an
    // evidence row and not an entity — `evidence_derivation` has a foreign key
    // to `evidence`, and passing an entity id was a `23503` the integration
    // test caught. Recording the quotation is also what makes the inference
    // answerable: "why do you believe this" ends at a sentence somebody wrote.
    const observed = emitter.about(entity, 'body.reference', reference.text, {
      ...(pull.number === undefined
        ? {}
        : { locator: { kind: 'pull-request', start: pull.number, detail: input.project } }),
    });
    state.evidence.push(observed);

    const inferred = emitter.inferred({
      subjectId: entity.id,
      field: 'resolves',
      statement: { issue: issue.id, keyword: reference.keyword, quoted: reference.text },
      derivedFrom: [observed.id],
      sourceContentHash: entity.contentHash,
      sourceId: entity.source.id,
      ...(entity.source.url === undefined ? {} : { sourceUrl: entity.source.url }),
    });
    state.evidence.push(inferred);

    state.relationships.push(
      emitter.relationship({
        fromId: entity.id,
        type: RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
        toId: issue.id,
        metadata: { keyword: reference.keyword, basis: 'body-reference' },
      }),
    );
    state.inferredResolutions += 1;
  }
}

function addReview(
  state: Accumulator,
  review: ProjectReview,
  pullRequests: ReadonlyMap<string, CanonicalEntity>,
  input: ProjectModelInput,
  emitter: Emitter,
): void {
  const pull = pullRequests.get(review.pullRequestId);
  if (pull === undefined) {
    // Not an error: a caller may model reviews for a pull request it fetched in
    // an earlier pass. Recorded so the count is honest rather than silent.
    state.skipped.push({
      id: review.id,
      reason: `review names pull request "${review.pullRequestId}", which is not in this batch`,
    });
    return;
  }

  const entity = emitter.entity({
    kind: EntityKind.REVIEW,
    source: { id: review.id, scope: input.repositoryId },
    attributes: {
      // §8.5. The verdict lives here, so "was this approved" is a query rather
      // than an inference over which edges exist.
      state: review.approved ? 'approved' : review.state.toLowerCase(),
      ...(review.body === undefined ? {} : { body: redactSecrets(review.body).text }),
      ...(review.submittedAt === undefined ? {} : { submittedAt: review.submittedAt }),
    },
    ...(review.submittedAt === undefined ? {} : { sourceObservedAt: review.submittedAt }),
  });
  addEntity(state, entity, false);

  state.relationships.push(
    emitter.relationship({
      fromId: entity.id,
      type: RelationshipType.REVIEW_REVIEWS_PULL_REQUEST,
      toId: pull.id,
    }),
  );

  if (review.reviewer !== undefined) {
    const reviewer = actorEntity(state, review.reviewer, emitter);
    // §8.5. Emitted whatever the verdict: a person who requested changes did
    // review it, and collapsing this into approval would make "was this
    // approved" and "did anyone look at this" the same question.
    if (reviewer.kind === EntityKind.DEVELOPER) {
      state.relationships.push(
        emitter.relationship({
          fromId: reviewer.id,
          type: RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST,
          toId: pull.id,
          metadata: { verdict: review.approved ? 'approved' : review.state.toLowerCase() },
        }),
      );
    }
  }
}

/**
 * An actor, as a developer or an agent — §8.6, §8.7.
 *
 * Keyed on the provider's stable identity, and **not** merged with anything.
 * The normalized identity is collected so a caller holding Git's identities can
 * run EPIC-036's comparison over the union; a second, weaker comparison written
 * here would be the thing EPIC-036 exists to prevent.
 */
function actorEntity(state: Accumulator, actor: ProjectActor, emitter: Emitter): CanonicalEntity {
  const existing = state.actors.get(actor.identity);
  if (existing !== undefined) return existing;

  const name = actor.displayName ?? actor.login ?? actor.identity;
  // A login with no address is presented as GitHub's own noreply form: EPIC-036
  // recovers a login from exactly that shape, so this is the one spelling that
  // lets `LinkRule.GITHUB_NOREPLY_LOGIN` join a web-UI commit to this actor.
  const address =
    actor.email ??
    (actor.login === undefined ? undefined : `${actor.login}@users.noreply.github.com`);
  const normalized = address === undefined ? undefined : normalizeGitIdentity(name, address);
  // `classifyIdentity` is EPIC-036's, and it is what keeps `dependabot[bot]`
  // out of a report about who is contributing. A second heuristic here would
  // disagree with it eventually. An actor with no address at all is classified
  // on its name, which is all there is.
  const classification = classifyIdentity(
    normalized ?? { name, email: '', comparable: '', localPart: '', domain: '', login: undefined },
  );

  const entity = emitter.entity({
    kind: entityKindForActor(classification.actorClass),
    source: { id: actor.identity },
    // `emails` and `usernames` are *lists* — EPIC-036's schema, and its comment
    // gives the reason: one person commits as several addresses, and collapsing
    // them would throw away the evidence resolution depends on. An agent has
    // neither, so it carries what `agentAttributes` declares instead.
    attributes:
      entityKindForActor(classification.actorClass) === EntityKind.DEVELOPER
        ? {
            name,
            emails: actor.email === undefined ? [] : [actor.email],
            usernames: actor.login === undefined ? [] : [actor.login],
          }
        : {
            name,
            agentType: 'bot',
          },
  });
  addEntity(state, entity, false);
  state.actors.set(actor.identity, entity);

  if (normalized !== undefined) state.identities.push(normalized);

  return entity;
}

/**
 * The commit entity Git derives — EPIC-051 §8.2.
 *
 * `system: CANONICAL_SOURCE_SYSTEM` is the whole point and was the defect: a
 * SHA is a hash of the commit, so there is exactly one commit with it whoever
 * mentions it. Emitting into the reporting system produced `github`'s copy of
 * `abc123` beside `git`'s — two entities for one object, and every
 * `PULL_REQUEST_PROPOSES_COMMIT` edge pointing at the one nothing else knew
 * about.
 */
function commitEntity(sha: string, emitter: Emitter): CanonicalEntity {
  return emitter.entity({
    kind: EntityKind.COMMIT,
    source: { id: sha, system: CANONICAL_SOURCE_SYSTEM },
    attributes: { sha },
  });
}

/**
 * The branch entity EPIC-017 derives — scoped to the repository, keyed on the ref.
 *
 * The system is the canonical one for the same reason as a commit: the scope
 * already makes the name unique, and deriving it in `github` would split `main`
 * from the `main` the Git provider indexed. EPIC-051 §8.2.
 */
function branchEntity(ref: string, repositoryId: string, emitter: Emitter): CanonicalEntity {
  return emitter.entity({
    kind: EntityKind.BRANCH,
    source: { id: ref, scope: repositoryId, system: CANONICAL_SOURCE_SYSTEM },
    attributes: { ref: redactSecrets(ref).text },
  });
}

/**
 * The scope for an issue in a repository Ferret may not have indexed.
 *
 * Derived the way EPIC-017 derives a repository entity, so if that repository is
 * indexed later the ids agree rather than needing reconciliation.
 */
function foreignRepositoryScope(project: string, emitter: Emitter): string {
  return emitter.entity({
    kind: EntityKind.REPOSITORY,
    source: { id: project },
    attributes: { name: project },
  }).id;
}
