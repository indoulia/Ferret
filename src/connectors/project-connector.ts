import {
  ProjectOperation,
  type ProjectComment,
  type ProjectIssue,
  type ProjectPullRequest,
  type ProjectQuery,
  type ProjectReview,
  type ProjectSource,
} from '../providers/contracts/source-project.js';
import type {
  AcquiredRecord,
  AcquisitionPage,
  AcquisitionRequest,
  NormalizationContext,
  SourceConnector,
  SourceContribution,
  SourceIdentity,
} from '../providers/contracts/source-connector.js';
import { SOURCE_CONNECTOR_CONTRACT_VERSION } from '../providers/contracts/source-connector.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

import { modelProject } from '../project/model.js';

/**
 * The tracker connector — EPIC-119 §8.5, widened by EPIC-121.
 *
 * A contract that has only ever been implemented by a test double is a contract
 * nobody has checked. This adapts the providers Ferret already ships — the
 * GitHub provider (EPIC-021) and the Jira provider (EPIC-071), both of which
 * implement `ProjectSource` — onto the universal boundary, without either of
 * them changing a line.
 *
 * That is the acceptance criterion stated as code: *a concrete source can
 * implement the contract without bespoke ingestion architecture*. This file is
 * the entire adaptation. There is no transport in it, no storage, and no second
 * model — `acquire` calls the operations the provider declared, and `normalize`
 * calls EPIC-072's `modelProject`, which is the same function `ferret sync`
 * calls.
 *
 * **EPIC-119 shipped this with issues only, and said why:** widening it "would
 * mean paging three collections against one cursor". EPIC-120 then did exactly
 * that for a repository — five collections behind one staged cursor — and the
 * ingestor did not change to receive it. So the reason not to widen expired,
 * and EPIC-121 widens it:
 *
 * ```
 * issues → pull requests → reviews → comments
 * ```
 *
 * The last two are **per parent**: the contract numbers reviews by their pull
 * request and comments by their item, so they are one request each. They are
 * therefore batched — {@link ProjectConnectorOptions.fanOut} parents per page —
 * rather than one page per parent, because the ingestor bounds a pass by *pages*
 * and a tracker with four hundred pull requests would otherwise exhaust that
 * bound before it reached the comments.
 *
 * **Comments are the point of the widening.** Every project provider has
 * implemented `listComments` since EPIC-021 and nothing has ever called it:
 * `ProjectSynchronizer` stages issues, pull requests and reviews and stops. A
 * comment is where the reasoning behind a change lives, and a context layer
 * that holds the issue and drops the discussion has kept the agenda and thrown
 * away the meeting.
 */

/** The record kinds this connector acquires. */
export const PROJECT_ISSUE_RECORD = 'issue';
export const PROJECT_PULL_REQUEST_RECORD = 'pull_request';
export const PROJECT_REVIEW_RECORD = 'review';
export const PROJECT_COMMENT_RECORD = 'comment';

export interface ProjectConnectorOptions {
  readonly source: ProjectSource;
  /** The provider id, which is what the connector is attributed as. */
  readonly connectorId: string;
  /** The external system observed — `github`, `jira`. */
  readonly system: string;
  /**
   * Which deployment of that system: `github.com`, `acme.atlassian.net`.
   *
   * Required rather than defaulted. A default would silently file a self-hosted
   * GitHub Enterprise repository under the same identity as a public one with
   * the same `owner/repo`, and the two are not the same source.
   */
  readonly instance: string;
  /** Operations the provider declared. An undeclared one is never called. */
  readonly operations: readonly string[];
  /** A tracker is the system of record for its own issues. Default: true. */
  readonly systemOfRecord?: boolean;
  /**
   * Parents asked about in one page, for the per-parent collections.
   *
   * A bound on *fan-out*, which is a different bound from the page size the
   * request carries: reviews and comments cost one request per parent, so
   * without this a tracker with four hundred pull requests would spend four
   * hundred pages of a twenty-page budget and never reach its comments. Lower
   * it for a rate-limited source; the pass stays correct either way, because a
   * page that did not finish does not advance the cursor.
   */
  readonly fanOut?: number;
}

/** Parents asked about per page. Bounded for the reason `fanOut` gives. */
const DEFAULT_FAN_OUT = 25;

/**
 * A parent this pass acquired: how to address it, and what it *is*.
 *
 * Both, because they are not the same value and assuming they were is the
 * defect this exists to fix. A tracker addresses its sub-collections by
 * *number* — `/issues/130/comments` — while the parent record's identity is
 * whatever the provider gave it, which for GitHub is the GraphQL `node_id`.
 */
interface Parent {
  /** What the sub-collection is addressed by: a number, or the id as a fallback. */
  readonly addressedBy: number | string;
  /** The parent record's own `id`, which its children must name to be linked. */
  readonly id: string;
}

interface Parents {
  readonly pulls: Parent[];
  readonly items: Parent[];
}

/** Records a parent once, keeping the order it was acquired in. */
function remember(known: Parent[], parent: Parent): void {
  if (!known.some((existing) => existing.id === parent.id)) known.push(parent);
}

/**
 * How a tracker's sub-collections address one of its records — EPIC-122.
 *
 * `number` where the tracker numbers, `key` where it keys, and the id only as a
 * last resort. Both fields exist on `ProjectRecord` for exactly this: EPIC-071
 * added `key` because "GitHub numbers its issues and Jira keys them".
 *
 * The id is the wrong answer for Jira and the fallback made it the *only*
 * answer: `toIssue` identifies an issue by its numeric id — deliberately, since
 * that survives a move between projects — while `listComments` requires an
 * issue **key** and throws `E_USAGE` on anything else. So a connector reaching
 * for comments handed `10042` to a method demanding `FER-12` and failed the
 * whole source. Found by reading the Jira provider rather than by running it,
 * which is the only reason it is not a second orphaned-comment story.
 */
function addressOf(record: { number?: number; key?: string; id: string }): number | string {
  return record.number ?? record.key ?? record.id;
}

/**
 * Where a staged acquisition got to.
 *
 * The stages run in a fixed order, and it is the order `modelProject` needs
 * rather than a preference: a review names the pull request it reviews and a
 * comment names the item it is on, so both are skipped-and-counted if their
 * parent is not in the same batch. Reading parents first is what keeps that
 * from happening on a first pass.
 */
const Stage = {
  ISSUES: 'issues',
  PULLS: 'pulls',
  REVIEWS: 'reviews',
  COMMENTS: 'comments',
} as const;

type Stage = (typeof Stage)[keyof typeof Stage];

interface StagedCursor {
  readonly stage: Stage;
  /** The running collection's own cursor, as the provider defined it. */
  readonly inner?: string;
  /** How many parents of a per-parent stage have been asked about. */
  readonly done?: number;
}

export function projectSourceConnector(options: ProjectConnectorOptions): SourceConnector {
  const operations = new Set(options.operations);
  const fanOut = Math.max(1, options.fanOut ?? DEFAULT_FAN_OUT);

  /**
   * The parents this pass has acquired, by source identity.
   *
   * `listReviews` and `listComments` are addressed by a parent's *number*,
   * which arrived on an earlier page and which `acquire` is not handed again.
   * Kept per identity rather than per call for the same reason EPIC-120's
   * connector caches its repository description: the alternative is re-reading
   * every issue and pull request on every page, which is the traffic the paging
   * exists to avoid. A pass that is cut short never advances its cursor, so a
   * cache that is lost costs a re-read rather than a gap.
   */
  const acquired = new Map<string, Parents>();

  const parentsFor = (identity: SourceIdentity): Parents => {
    const key = `${identity.system}/${identity.instance}/${identity.resource}`;
    const existing = acquired.get(key);
    if (existing !== undefined) return existing;
    const fresh: Parents = { pulls: [], items: [] };
    acquired.set(key, fresh);
    return fresh;
  };

  return {
    connectorId: options.connectorId,
    contractVersion: SOURCE_CONNECTOR_CONTRACT_VERSION,
    system: options.system,
    systemOfRecord: options.systemOfRecord ?? true,

    identify(resource: string): SourceIdentity {
      return { system: options.system, instance: options.instance, resource: resource.trim() };
    },

    async acquire(
      request: AcquisitionRequest,
      context: ProviderOperationContext,
    ): Promise<AcquisitionPage> {
      const parents = parentsFor(request.identity);
      // A stage the provider cannot serve is stepped over **here**, not by
      // returning an empty page that costs one of the ingestor's twenty.
      // Jira is the source that made this matter: it declares issues and
      // comments and nothing else, so every pass spent two pages arriving at a
      // `pulls` stage and a `reviews` stage it was never going to use. Measured
      // on GitHub first, where a deliberately tight page limit truncated before
      // the comment stage for no other reason.
      const cursor = skipUnsupported(decodeStage(request.cursor), operations);

      if (cursor.stage === Stage.ISSUES) {
        const page = await options.source.listIssues(queryFor(request, cursor), context);

        // `304 Not Modified` is carried through rather than collapsed into an
        // empty page: the caller's copy being current is a different fact from
        // there being nothing. It ends the pass — a tracker that says nothing
        // changed has said so about the whole of it.
        if (page.unchanged === true) {
          return {
            records: [],
            unchanged: true,
            ...(page.etag === undefined ? {} : { checkpoint: { etag: page.etag } }),
          };
        }

        for (const issue of page.items) {
          remember(parents.items, { addressedBy: addressOf(issue), id: issue.id });
        }

        return {
          records: page.items.map((issue) => issueRecord(issue)),
          cursor:
            page.cursor === undefined
              ? nextStageCursor(Stage.ISSUES, operations)
              : encodeStage({ stage: Stage.ISSUES, inner: page.cursor }),
          ...(page.etag === undefined ? {} : { checkpoint: { etag: page.etag } }),
        };
      }

      if (cursor.stage === Stage.PULLS) {
        const page = await options.source.listPullRequests?.(queryFor(request, cursor), context);
        const items = page?.items ?? [];

        for (const pull of items) {
          if (typeof pull.number === 'number') {
            remember(parents.pulls, { addressedBy: pull.number, id: pull.id });
          }
          remember(parents.items, { addressedBy: addressOf(pull), id: pull.id });
        }

        return {
          records: items.map((pull) => pullRequestRecord(pull)),
          cursor:
            page?.cursor === undefined
              ? nextStageCursor(Stage.PULLS, operations)
              : encodeStage({ stage: Stage.PULLS, inner: page.cursor }),
        };
      }

      if (cursor.stage === Stage.REVIEWS) {
        const done = cursor.done ?? 0;
        // A pull request with no number cannot be asked about — the contract
        // numbers reviews by their parent — so `parents.pulls` holds only the
        // numbered ones rather than this guessing at the rest.
        const batch = parents.pulls.slice(done, done + fanOut);
        const records: AcquiredRecord[] = [];
        for (const parent of batch) {
          if (typeof parent.addressedBy !== 'number') continue;
          const page = await options.source.listReviews?.(
            { project: request.identity.resource, pullRequest: parent.addressedBy },
            context,
          );
          for (const review of page?.items ?? []) {
            // Re-parented for the reason `reparent` gives, and by the same
            // rule: the caller knows which pull request it asked about.
            records.push(reviewRecord({ ...review, pullRequestId: parent.id }));
          }
        }

        const reached = done + Math.min(fanOut, Math.max(0, parents.pulls.length - done));
        return {
          records,
          cursor:
            reached >= parents.pulls.length
              ? nextStageCursor(Stage.REVIEWS, operations)
              : encodeStage({ stage: Stage.REVIEWS, done: reached }),
        };
      }

      if (!operations.has(ProjectOperation.LIST_COMMENTS)) return { records: [] };

      const done = cursor.done ?? 0;
      const batch = parents.items.slice(done, done + fanOut);
      const records: AcquiredRecord[] = [];
      for (const parent of batch) {
        const page = await options.source.listComments?.(
          { project: request.identity.resource, item: parent.addressedBy },
          context,
        );
        for (const comment of page?.items ?? []) {
          records.push(commentRecord({ ...comment, parentId: parent.id }));
        }
      }

      const reached = done + Math.min(fanOut, Math.max(0, parents.items.length - done));
      return {
        records,
        // Absent means the pass is over, which is what lets the cursor advance.
        ...(reached >= parents.items.length
          ? {}
          : { cursor: encodeStage({ stage: Stage.COMMENTS, done: reached }) }),
      };
    },

    normalize(
      records: readonly AcquiredRecord[],
      context: NormalizationContext,
    ): SourceContribution {
      // The payloads are the provider's own values, put back the way they came.
      // Nothing is re-parsed: the record builders carried each record whole
      // precisely so this step is a projection rather than a second decoding.
      const issues = payloads<ProjectIssue>(records, PROJECT_ISSUE_RECORD);
      const pullRequests = payloads<ProjectPullRequest>(records, PROJECT_PULL_REQUEST_RECORD);
      const reviews = payloads<ProjectReview>(records, PROJECT_REVIEW_RECORD);
      const comments = payloads<ProjectComment>(records, PROJECT_COMMENT_RECORD);

      const modelled = modelProject(
        {
          repositoryId: context.sourceEntityId,
          project: context.identity.resource,
          ...(issues.length === 0 ? {} : { issues }),
          ...(pullRequests.length === 0 ? {} : { pullRequests }),
          ...(reviews.length === 0 ? {} : { reviews }),
          ...(comments.length === 0 ? {} : { comments }),
        },
        context.emitter,
      );

      return {
        entities: modelled.entities,
        relationships: modelled.relationships,
        evidence: modelled.evidence,
        placeholderEntityIds: modelled.placeholderEntityIds,
        skipped: modelled.skipped.map((record) => ({
          id: record.id,
          kind: kindOf(records, record.id),
          reason: record.reason,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/**
 * One issue, as an acquired record.
 *
 * The id is the tracker's own — `owner/repo#123`, `FER-12` — which is what makes
 * repeated ingestion idempotent: the canonical entity id derives from it, so
 * acquiring the same issue on Monday and again on Tuesday writes one row.
 */
function issueRecord(issue: ProjectIssue): AcquiredRecord {
  return {
    id: issue.id,
    kind: PROJECT_ISSUE_RECORD,
    payload: issue,
    metadata: {
      title: issue.title,
      ...(issue.url === undefined ? {} : { url: issue.url }),
      ...(issue.createdAt === undefined ? {} : { createdAt: issue.createdAt }),
      ...(issue.updatedAt === undefined ? {} : { updatedAt: issue.updatedAt }),
      ...(issue.labels === undefined ? {} : { labels: issue.labels }),
      attributes: { state: issue.state, lifecycle: issue.lifecycle },
    },
  };
}

function pullRequestRecord(pull: ProjectPullRequest): AcquiredRecord {
  return {
    id: pull.id,
    kind: PROJECT_PULL_REQUEST_RECORD,
    payload: pull,
    metadata: {
      title: pull.title,
      ...(pull.url === undefined ? {} : { url: pull.url }),
      ...(pull.createdAt === undefined ? {} : { createdAt: pull.createdAt }),
      ...(pull.updatedAt === undefined ? {} : { updatedAt: pull.updatedAt }),
      ...(pull.labels === undefined ? {} : { labels: pull.labels }),
      attributes: {
        state: pull.state,
        lifecycle: pull.lifecycle,
        ...(pull.mergeCommit === undefined ? {} : { mergeCommit: pull.mergeCommit }),
        ...(pull.targetBranch === undefined ? {} : { targetBranch: pull.targetBranch }),
      },
    },
  };
}

function reviewRecord(review: ProjectReview): AcquiredRecord {
  return {
    id: review.id,
    kind: PROJECT_REVIEW_RECORD,
    payload: review,
    metadata: {
      ...(review.submittedAt === undefined ? {} : { createdAt: review.submittedAt }),
      attributes: {
        pullRequest: review.pullRequestId,
        state: review.state,
        approved: review.approved,
      },
    },
  };
}

/**
 * One comment, re-parented onto the record the connector actually asked about.
 *
 * **The caller's answer outranks the provider's guess, and this is why.**
 * `GithubProvider.listComments` is handed an item *number* and synthesises
 * `parentId` as `owner/repo#123`, because a number is all it has. But the same
 * provider gives that issue an `id` of `node_id` whenever GitHub supplies one —
 * which the live API always does. So the comment names `indoulia/Ferret#130`
 * and the issue is `I_kwDOUIiLgM6…`, they never match, and `modelProject`
 * correctly skips every comment as an orphan.
 *
 * Found by running this connector against the real GitHub API: 25 comments
 * acquired, 25 skipped. It could not be found from a fixture, because a fixture
 * without a `node_id` falls back to exactly the form the provider synthesises
 * and the two agree by accident.
 *
 * The connector is the one component holding both halves — it chose the number
 * and it has the record that number came from — so it states the parent rather
 * than leaving a provider to infer it from an address.
 */
function commentRecord(comment: ProjectComment): AcquiredRecord {
  return {
    id: comment.id,
    kind: PROJECT_COMMENT_RECORD,
    // The body is carried verbatim and is **untrusted content a stranger
    // wrote**. It is not interpreted here; `modelProject` redacts it before it
    // reaches an attribute.
    payload: comment,
    metadata: {
      ...(comment.url === undefined ? {} : { url: comment.url }),
      ...(comment.createdAt === undefined ? {} : { createdAt: comment.createdAt }),
      ...(comment.updatedAt === undefined ? {} : { updatedAt: comment.updatedAt }),
      // The source's own version marker: an edited comment reports a later
      // instant, and that is what a change-detection pass would compare.
      ...(comment.updatedAt === undefined ? {} : { version: comment.updatedAt }),
      attributes: { parentId: comment.parentId },
    },
  };
}

// ---------------------------------------------------------------------------
// Cursor and page helpers
// ---------------------------------------------------------------------------

function queryFor(request: AcquisitionRequest, cursor: StagedCursor): ProjectQuery {
  return {
    project: request.identity.resource,
    ...(cursor.inner === undefined ? {} : { cursor: cursor.inner }),
    ...(request.since === undefined ? {} : { since: request.since }),
    ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
  };
}

/** The stages in the order they run. Parents before the collections that name them. */
const STAGE_ORDER: readonly Stage[] = [Stage.ISSUES, Stage.PULLS, Stage.REVIEWS, Stage.COMMENTS];

/** Which declared operation each stage needs. A stage without one cannot run. */
const STAGE_OPERATION: Readonly<Record<Stage, string>> = {
  [Stage.ISSUES]: ProjectOperation.LIST_ISSUES,
  [Stage.PULLS]: ProjectOperation.LIST_PULL_REQUESTS,
  [Stage.REVIEWS]: ProjectOperation.LIST_REVIEWS,
  [Stage.COMMENTS]: ProjectOperation.LIST_COMMENTS,
};

/**
 * The first stage at or after this one that the provider can actually serve.
 *
 * An operation the provider did not declare is never called — `source.project`
 * refused discovery-by-exception and this keeps that — but *stepping over* it
 * must not cost a page either. Returns the last stage when nothing remains,
 * which reads as an empty terminal page and ends the pass.
 */
function skipUnsupported(cursor: StagedCursor, operations: ReadonlySet<string>): StagedCursor {
  let index = STAGE_ORDER.indexOf(cursor.stage);
  if (index < 0) return cursor;
  if (operations.has(STAGE_OPERATION[cursor.stage])) return cursor;
  // Only the first stage keeps its position: once a stage is skipped, whatever
  // place the old cursor carried belonged to a collection that is not running.
  while (index < STAGE_ORDER.length - 1) {
    index += 1;
    const stage = STAGE_ORDER[index] as Stage;
    if (operations.has(STAGE_OPERATION[stage])) return startOf(stage);
  }
  return startOf(STAGE_ORDER[STAGE_ORDER.length - 1] as Stage);
}

/** A cursor naming the next servable stage, or none when the pass is over. */
function nextStageCursor(current: Stage, operations: ReadonlySet<string>): string | undefined {
  const index = STAGE_ORDER.indexOf(current);
  for (let next = index + 1; next < STAGE_ORDER.length; next += 1) {
    const stage = STAGE_ORDER[next] as Stage;
    if (operations.has(STAGE_OPERATION[stage])) return encodeStage(startOf(stage));
  }
  // Absent means the pass finished, which is what lets the cursor advance.
  return undefined;
}

/** A per-parent stage starts at the first parent; a paged one at its first page. */
function startOf(stage: Stage): StagedCursor {
  return stage === Stage.REVIEWS || stage === Stage.COMMENTS ? { stage, done: 0 } : { stage };
}

function encodeStage(cursor: StagedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Read a staged cursor, treating anything unreadable as the beginning.
 *
 * A cursor is opaque to the ingestor, which stores and returns it verbatim, so
 * a truncated or hand-edited one arrives here as a string that means nothing.
 * Starting over re-reads a tracker, which is free — every write is an
 * idempotent upsert. Throwing would fail a source over a value the source did
 * not produce.
 */
function decodeStage(cursor: string | undefined): StagedCursor {
  if (cursor === undefined) return { stage: Stage.ISSUES };
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return { stage: Stage.ISSUES };
    const { stage, inner, done } = decoded as { stage?: unknown; inner?: unknown; done?: unknown };
    if (!isStage(stage)) return { stage: Stage.ISSUES };
    return {
      stage,
      ...(typeof inner === 'string' ? { inner } : {}),
      ...(typeof done === 'number' && Number.isInteger(done) && done >= 0 ? { done } : {}),
    };
  } catch {
    return { stage: Stage.ISSUES };
  }
}

function isStage(value: unknown): value is Stage {
  return (
    value === Stage.ISSUES ||
    value === Stage.PULLS ||
    value === Stage.REVIEWS ||
    value === Stage.COMMENTS
  );
}

/** The payloads of one record kind, in the order they were acquired. */
function payloads<T>(records: readonly AcquiredRecord[], kind: string): readonly T[] {
  const selected: T[] = [];
  for (const record of records) {
    if (record.kind === kind) selected.push(record.payload as T);
  }
  return selected;
}

/**
 * What kind of record an id belonged to.
 *
 * `modelProject` reports a skipped record by id and does not say what it was,
 * because it models four collections into one graph. Looking it back up keeps
 * the connector's own report honest — before this, every skipped record of
 * every kind was reported as an `issue`.
 */
function kindOf(records: readonly AcquiredRecord[], id: string): string {
  return records.find((record) => record.id === id)?.kind ?? PROJECT_ISSUE_RECORD;
}
