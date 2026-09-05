import { EntityKind, RelationshipType } from '../domain/index.js';
import { entityKindForActor } from '../domain/actor.js';
import { classifyIdentity, normalizeGitIdentity, type NormalizedIdentity } from '../identity/index.js';
import { redactSecrets } from '../security/index.js';
import {
  ProjectItemState,
  type ProjectActor,
  type ProjectComment,
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
  /**
   * Comments on the issues and pull requests above — EPIC-121.
   *
   * Every project provider Ferret ships has implemented `listComments` since
   * EPIC-021, and until now nothing called it: the synchronizer stages issues,
   * pull requests and reviews and stops. A comment is where the reasoning
   * behind a change actually lives — the objection that moved a design, the
   * "this is why we did not do X" that no commit message carries — so a context
   * layer that indexes the issue and drops the discussion has indexed the
   * agenda rather than the meeting.
   *
   * A comment whose parent is not in this batch is skipped and counted, exactly
   * as a review whose pull request is absent is.
   */
  readonly comments?: readonly ProjectComment[];
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
  // Comments hang off either kind, so both are remembered by the id their
  // `parentId` will name. One map rather than two lookups: a tracker where an
  // issue and a pull request are the same object — Jira, GitLab — would
  // otherwise need the caller to know which it was.
  const parentsById = new Map<string, CanonicalEntity>();

  for (const issue of input.issues ?? []) {
    modelOne(state, issue.id, () => {
      parentsById.set(issue.id, addIssue(state, issue, input, emitter));
    });
  }

  // Same-project issues by the number a body would cite them as. Built from
  // what this batch actually read, so a closing reference can resolve to the
  // record rather than to a stub standing in for it.
  const issuesByNumber = new Map<number, CanonicalEntity>();
  for (const issue of input.issues ?? []) {
    const entity = parentsById.get(issue.id);
    if (entity !== undefined && typeof issue.number === 'number') {
      issuesByNumber.set(issue.number, entity);
    }
  }

  for (const pull of input.pullRequests ?? []) {
    modelOne(state, pull.id, () => {
      const entity = addPullRequest(state, pull, input, emitter, issuesByNumber);
      pullRequestsById.set(pull.id, entity);
      parentsById.set(pull.id, entity);
    });
  }

  for (const review of input.reviews ?? []) {
    modelOne(state, review.id, () => {
      addReview(state, review, pullRequestsById, input, emitter);
    });
  }

  for (const comment of input.comments ?? []) {
    modelOne(state, comment.id, () => {
      addComment(state, comment, parentsById, input, emitter);
    });
  }

  // Links last, when every issue this batch read is already an entity, so a
  // link between two of them joins the records rather than two stubs.
  for (const issue of input.issues ?? []) {
    if (issue.links === undefined || issue.links.length === 0) continue;
    modelOne(state, issue.id, () => {
      addIssueLinks(state, issue, parentsById, input, emitter);
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
      // The number where the tracker numbers, the key where it keys — EPIC-122.
      // `ProjectRecord.key` was added by EPIC-071 with the reason stated on the
      // field: "a contract with only `number` would have made every Jira issue
      // arrive without the identifier its users actually say out loud". This
      // module then read only `number`, so that is exactly what happened —
      // every Jira issue reached the graph with no `FER-12` on it.
      ...(issue.number !== undefined
        ? { key: String(issue.number) }
        : issue.key === undefined
          ? {}
          : { key: issue.key }),
      // A title can carry a token: somebody pastes a failing curl command into
      // an issue and the token travels with it.
      title: redactSecrets(issue.title).text,
      state: issue.lifecycle,
      // The source's own word, beside the comparable reading — EPIC-021 §8.1.
      sourceState: issue.state,
      labels: [...(issue.labels ?? [])],
      // Declared by `issueAttributes` since EPIC-006 and never populated: the
      // Jira provider requested both fields on every search and discarded them
      // for want of a contract field to carry them. EPIC-122.
      ...(issue.issueType === undefined ? {} : { issueType: issue.issueType }),
      ...(issue.priority === undefined ? {} : { priority: issue.priority }),
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
  issuesByNumber: ReadonlyMap<number, CanonicalEntity>,
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

  addResolutions(state, entity, pull, input, emitter, issuesByNumber);
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
  issuesByNumber: ReadonlyMap<number, CanonicalEntity>,
): void {
  for (const reference of findClosingReferences(pull.body)) {
    // A cross-repository reference is scoped to *that* repository, which is the
    // only reading that can be right. Ferret may not have indexed it, and an
    // entity id that resolves to nothing yet is still the correct id.
    const issueScope =
      reference.project === undefined || reference.project === input.project
        ? input.repositoryId
        : foreignRepositoryScope(reference.project, emitter);

    // The issue this batch actually read, when it read it — EPIC-121.
    //
    // A body gives a *number*, and a provider's stable id is not knowable from
    // one: GitHub identifies an issue by its `node_id`, so `owner/repo#7` is a
    // guess at a name rather than the name. The original reading minted that
    // guess as a placeholder and left EPIC-051 to reconcile it, which is right
    // for an issue Ferret has never seen — and wrong for one sitting in the
    // same batch, where it produces *two* entities for one issue and hangs the
    // `resolves` edge off the stub. Found by giving the fixtures the `node_id`
    // the live API always sends, having found the same mismatch in comments.
    const known =
      reference.project === undefined || reference.project === input.project
        ? issuesByNumber.get(reference.number)
        : undefined;

    const issue =
      known ??
      emitter.entity({
        kind: EntityKind.ISSUE,
        source: { id: `${reference.project ?? input.project}#${String(reference.number)}`, scope: issueScope },
        attributes: { key: String(reference.number) },
      });
    // A record read in full is never re-registered as a placeholder.
    addEntity(state, issue, known === undefined);

    // The basis is *observed*: the body said this. `derivedFrom` names an
    // evidence row and not an entity — `evidence_derivation` has a foreign key
    // to `evidence`, and passing an entity id was a `23503` the integration
    // test caught. Recording the quotation is also what makes the inference
    // answerable: "why do you believe this" ends at a sentence somebody wrote.
    const observed = emitter.about(entity, 'body.reference', reference.text, {
      // A set: one row per reference found in the body — F-06.
      cardinality: 'collection',
      ...(pull.number === undefined
        ? {}
        : { locator: { kind: 'pull-request', start: pull.number, detail: input.project } }),
    });
    state.evidence.push(observed);

    const inferred = emitter.inferred({
      subjectId: entity.id,
      field: 'resolves',
      // A set: one row per closing reference in the body — F-06.
      cardinality: 'collection',
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
 * One comment, as a document about the thing it was written on — EPIC-121.
 *
 * **No new entity kind, deliberately.** A comment is text with an author, a
 * parent and two instants, which is what `document` already models, and
 * `DOCUMENT_DESCRIBES_ENTITY` is already the edge from a document to the thing
 * it is about. Adding a `comment` kind would have made every existing query
 * that asks for the documents about an issue miss the discussion on it — the
 * same reason EPIC-119 scoped its sources to `repository` rather than minting a
 * `source` kind.
 *
 * The body goes in `description`, which `attributes.ts` defines as "free-text
 * description or body, as the source provides it". It is **redacted first**:
 * a comment is the single most likely place in a tracker for somebody to paste
 * a failing request with a token in it.
 *
 * There is no author *edge*. `document` has no authorship relationship in
 * EPIC-007's set, and inventing one here would be this module deciding a
 * canonical model question on behalf of one connector. The author is modelled
 * as an actor — so the person exists, is resolvable, and is joined to their
 * commits by EPIC-036 — and the comment records which actor wrote it as
 * evidence rather than as an edge nothing else would produce.
 */
function addComment(
  state: Accumulator,
  comment: ProjectComment,
  parents: ReadonlyMap<string, CanonicalEntity>,
  input: ProjectModelInput,
  emitter: Emitter,
): void {
  const parent = parents.get(comment.parentId);
  if (parent === undefined) {
    // Not an error, and the same rule `addReview` states: a caller may model
    // comments for an issue it read in an earlier pass. Counted so the total is
    // honest rather than silently short.
    state.skipped.push({
      id: comment.id,
      reason: `comment names "${comment.parentId}", which is not in this batch`,
    });
    return;
  }

  const author = comment.author === undefined ? undefined : actorEntity(state, comment.author, emitter);

  const entity = emitter.entity({
    kind: EntityKind.DOCUMENT,
    source: {
      id: comment.id,
      // Scoped, like every other record here: two trackers' comment ids are not
      // the same comment.
      scope: input.repositoryId,
      ...(comment.url === undefined ? {} : { url: comment.url }),
    },
    attributes: {
      // Named for what it is and what it is on, because a document with no
      // title is unreadable in every listing Ferret has.
      title: `Comment on ${commentSubject(parent, comment.parentId)}`,
      description: redactSecrets(comment.body).text,
      mediaType: 'text/markdown',
      ...(comment.url === undefined ? {} : { location: comment.url }),
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      ...(comment.updatedAt === undefined ? {} : { modifiedAt: comment.updatedAt }),
    },
    unknownFields: {
      parentId: comment.parentId,
      ...(comment.author === undefined ? {} : { author: comment.author.identity }),
    },
    ...(comment.updatedAt === undefined ? {} : { sourceObservedAt: comment.updatedAt }),
  });
  addEntity(state, entity, false);

  state.relationships.push(
    emitter.relationship({
      fromId: entity.id,
      type: RelationshipType.DOCUMENT_DESCRIBES_ENTITY,
      toId: parent.id,
      sourceId: comment.id,
    }),
  );

  if (author !== undefined) {
    state.evidence.push(emitter.about(entity, 'author', author.attributes['name']));
  }
}

/**
 * Typed links between issues — EPIC-122.
 *
 * **Direction is normalised to the vendor's outward reading.** A tracker shows
 * the same link on both issues — `FER-1 blocks FER-2` appears on FER-1 as
 * outward and on FER-2 as inward — so modelling each as stated would produce
 * two edges facing each other for one fact, and a repeated ingestion would
 * produce them again. Flipping the inward ones means both readings derive the
 * same edge, which is what makes the pass idempotent whichever issues happen to
 * be in the batch.
 *
 * The vendor's own word for the link goes in `metadata.linkType`, unmapped, for
 * the reason `ISSUE_LINKS_ISSUE` gives: Jira's link types are configured per
 * instance, and any enumeration Ferret wrote would be wrong at the first
 * customer who added one.
 */
function addIssueLinks(
  state: Accumulator,
  issue: ProjectIssue,
  parents: ReadonlyMap<string, CanonicalEntity>,
  input: ProjectModelInput,
  emitter: Emitter,
): void {
  const self = parents.get(issue.id);
  if (self === undefined) return;

  for (const link of issue.links ?? []) {
    // The linked issue as this batch read it, or a stub standing in for one it
    // has not — the same rule a closing reference follows, and for the same
    // reason: an id that resolves to nothing *yet* is still the correct id.
    const target =
      parents.get(link.targetId) ??
      addEntity(
        state,
        emitter.entity({
          kind: EntityKind.ISSUE,
          source: { id: link.targetId, scope: input.repositoryId },
          attributes: link.targetKey === undefined ? {} : { key: link.targetKey },
        }),
        true,
      );

    const [fromId, toId] =
      link.direction === 'outward' ? [self.id, target.id] : [target.id, self.id];

    // A link to itself is not a link. Jira will not produce one, and an edge
    // whose endpoints are equal is a cycle every traversal has to special-case.
    if (fromId === toId) continue;

    state.relationships.push(
      emitter.relationship({
        fromId,
        type: RelationshipType.ISSUE_LINKS_ISSUE,
        toId,
        metadata: { linkType: link.type },
        sourceId: issue.id,
      }),
    );

    state.evidence.push(
      emitter.about(self, 'links', {
        linkType: link.type,
        direction: link.direction,
        target: link.targetKey ?? link.targetId,
      }, { cardinality: 'collection' }),
    );
  }
}

/**
 * What a comment's title names its parent by.
 *
 * The tracker's own key — `#123`, `FER-12` — when the parent carries one,
 * because that is what a person reading a list of documents recognises. Falls
 * back to the parent's source id, which every record has. Typed rather than
 * stringified: `attributes` is `unknown` at the edges, and `String()` over it
 * yields `[object Object]` for a key nobody expected to be one.
 */
function commentSubject(parent: CanonicalEntity, parentId: string): string {
  const key = parent.attributes['key'];
  return typeof key === 'string' && key.length > 0 ? `#${key}` : parentId;
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
    normalized ?? {
      name,
      email: '',
      comparable: '',
      localPart: '',
      domain: '',
      login: undefined,
      // F-11's flag. This stand-in exists to classify a *name* when there is no
      // address at all, which is exactly what the flag reports.
      addressed: false,
    },
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
