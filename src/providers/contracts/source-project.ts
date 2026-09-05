import type { ProviderOperationContext } from '../sdk/operation.js';

/**
 * What a `source.project` provider is asked, and what it returns — EPIC-021.
 *
 * `Capability.SOURCE_PROJECT` has existed since EPIC-013 with the comment
 * *"Issues, pull requests, reviews, releases, deployments"* and no contract
 * behind it. This is the contract, and it is deliberately written for two
 * providers at once: GitHub here, Jira in EPIC-071. A contract shaped around one
 * vendor's JSON is a contract the second provider has to break.
 *
 * **It returns records, not knowledge.** Turning a pull request into entities,
 * relationships and evidence is EPIC-072's; turning a release into a deployment
 * fact is EPIC-073's. The separation is the same one EPIC-024 draws between a
 * parser and the canonical model, and for the same reason: a transport that
 * also modelled would make every modelling change a transport change.
 */

/** What a provider offers. Declared per operation, never wholesale. */
export const ProjectOperation = {
  /** Enumerate issues. */
  LIST_ISSUES: 'list-issues',
  /** Enumerate pull requests, or a tracker's equivalent. */
  LIST_PULL_REQUESTS: 'list-pull-requests',
  /** Enumerate the reviews on one pull request. */
  LIST_REVIEWS: 'list-reviews',
  /** Enumerate comments on an issue or pull request. */
  LIST_COMMENTS: 'list-comments',
  /** Enumerate releases. */
  LIST_RELEASES: 'list-releases',
  /** Enumerate deployments — EPIC-073. */
  LIST_DEPLOYMENTS: 'list-deployments',
  /** Enumerate the statuses of one deployment — EPIC-073 §8.3. */
  LIST_DEPLOYMENT_STATUSES: 'list-deployment-statuses',
} as const;

export type ProjectOperation = (typeof ProjectOperation)[keyof typeof ProjectOperation];

/**
 * Where a record is in its own lifecycle.
 *
 * Three states, because they are what every tracker agrees on. A vendor's own
 * status — `in review`, `blocked`, a custom workflow column — is richer and is
 * kept verbatim in `state`, which is the honest place for a value Ferret cannot
 * compare across systems.
 */
export const ProjectItemState = {
  OPEN: 'open',
  CLOSED: 'closed',
  MERGED: 'merged',
} as const;

export type ProjectItemState = (typeof ProjectItemState)[keyof typeof ProjectItemState];

/**
 * A person, as the source system names them.
 *
 * `identity` is the provider-scoped stable id — a GitHub node id, a Jira account
 * id — and is what EPIC-040's resolution keys on. `login` and `email` are
 * whatever the system chose to expose, and either may be absent: GitHub hides
 * an email by default, and a deleted account has no login at all.
 */
export interface ProjectActor {
  readonly identity: string;
  readonly login?: string;
  readonly displayName?: string;
  readonly email?: string;
}

/**
 * Fields every project record carries.
 *
 * `body` is **untrusted text a stranger wrote**. It is carried verbatim and is
 * never interpreted here: an issue body containing instructions is data, and
 * the MCP surface already says so of everything it renders.
 */
export interface ProjectRecord {
  /** Stable within the source system. `owner/repo#123`, `PROJ-45`. */
  readonly id: string;
  /** The number a person would quote, where the tracker uses numbers. */
  readonly number?: number;
  /**
   * The key a person would quote, where the tracker uses keys — EPIC-071 §8.5.
   *
   * `FER-12`. Added by the second implementation, which is what §8.1 said this
   * contract was for: GitHub numbers its issues and Jira keys them, and a
   * contract with only `number` would have made every Jira issue arrive without
   * the identifier its users actually say out loud.
   */
  readonly key?: string;
  readonly title: string;
  readonly body?: string;
  readonly state: string;
  /** The comparable reading of `state`. */
  readonly lifecycle: ProjectItemState;
  readonly url?: string;
  readonly author?: ProjectActor;
  /** ISO-8601, as the source reported it. */
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly closedAt?: string;
  readonly labels?: readonly string[];
  /**
   * The tracker's own word for what kind of work this is — `Bug`, `Story`.
   *
   * Added by EPIC-122, and the canonical model had `issueAttributes.issueType`
   * waiting for it since EPIC-006. The Jira provider had been *requesting* the
   * field on every search and dropping it on the floor for want of somewhere to
   * put it.
   */
  readonly issueType?: string;
  /** The tracker's own priority name — `High`. Not a comparable reading. */
  readonly priority?: string;
}

export interface ProjectIssue extends ProjectRecord {
  /**
   * Issues this one is linked to — EPIC-122.
   *
   * Optional because most trackers have nothing like it and GitHub does not:
   * a source with no concept of a typed issue link reports none, rather than
   * being made to invent one.
   */
  readonly links?: readonly ProjectIssueLink[];
  readonly assignees?: readonly ProjectActor[];
}

export interface ProjectPullRequest extends ProjectRecord {
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  /** The merge commit, when there is one. EPIC-072 joins this to history. */
  readonly mergeCommit?: string;
  readonly mergedAt?: string;
  readonly draft?: boolean;
  readonly requestedReviewers?: readonly ProjectActor[];
}

/**
 * One issue related to another, as the tracker states it — EPIC-122.
 *
 * `type` is the **vendor's** name for the relationship — `Blocks`,
 * `Duplicates`, `Relates`, and whatever else an administrator has configured.
 * It is carried rather than mapped, because Jira's link types are defined per
 * instance: any fixed enumeration Ferret wrote would be wrong at the first
 * customer who added one, and a link Ferret could not name would be a link it
 * dropped.
 */
export interface ProjectIssueLink {
  readonly type: string;
  /**
   * Which way the tracker stated it, from the issue carrying the link.
   *
   * `outward` is "this issue blocks that one"; `inward` is "this issue is
   * blocked by that one". Both are reported because a tracker shows a link on
   * *both* issues and only the direction distinguishes them — collapsing them
   * would make "what is blocking this" and "what is this blocking" the same
   * question.
   */
  readonly direction: 'outward' | 'inward';
  /** The other issue's id, as the source identifies it. */
  readonly targetId: string;
  /** The key a person would quote for it — `FER-13`. */
  readonly targetKey?: string;
}

/** One review. `state` is the vendor's; `approved` is the comparable reading. */
export interface ProjectReview {
  readonly id: string;
  readonly pullRequestId: string;
  readonly reviewer?: ProjectActor;
  readonly state: string;
  readonly approved: boolean;
  readonly body?: string;
  readonly submittedAt?: string;
}

export interface ProjectComment {
  readonly id: string;
  /** The issue or pull request this belongs to. */
  readonly parentId: string;
  readonly author?: ProjectActor;
  readonly body: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
}

export interface ProjectRelease {
  readonly id: string;
  readonly tag: string;
  readonly name?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly publishedAt?: string;
  readonly author?: ProjectActor;
  readonly url?: string;
}

/**
 * Where a deployment got to — EPIC-073 §8.4.
 *
 * The comparable reading of a vendor's own word, the way `ProjectItemState` is.
 * `IN_PROGRESS` is separate from `PENDING` because the difference is what an
 * operator asks about: a deployment that has not started can be cancelled, and
 * one that is running cannot.
 */
export const DeploymentState = {
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  /** Superseded by a later deployment to the same environment. */
  INACTIVE: 'inactive',
} as const;

export type DeploymentState = (typeof DeploymentState)[keyof typeof DeploymentState];

/**
 * A deployment, as the source system records it.
 *
 * **`state` is absent here on purpose.** A deployment's outcome lives in a
 * separate statuses collection on every system that has the concept, so filling
 * it in would mean one request per deployment — and EPIC-021 §8.4 exists
 * because Ferret is spending somebody else's rate limit. The caller asks for
 * statuses when it wants them.
 */
export interface ProjectDeployment {
  readonly id: string;
  /** The commit deployed, when the source names one. */
  readonly revision?: string;
  /** The ref requested — a tag, a branch. Not necessarily the revision. */
  readonly ref?: string;
  readonly environment?: string;
  readonly description?: string;
  /** Whether the source considers this a production environment. */
  readonly production?: boolean;
  readonly creator?: ProjectActor;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
}

/** One status of one deployment. The latest is its current state. */
export interface ProjectDeploymentStatus {
  readonly id: string;
  readonly deploymentId: string;
  /** The vendor's own word. */
  readonly state: string;
  /** The comparable reading. */
  readonly lifecycle: DeploymentState;
  readonly environment?: string;
  readonly description?: string;
  readonly createdAt?: string;
  readonly url?: string;
}

/**
 * One page, and how to ask for the next.
 *
 * `cursor` is opaque and provider-defined — a GitHub `Link` URL, a Jira
 * `startAt`. A caller that constructed one itself would be guessing at a
 * pagination scheme it cannot see, which EPIC-075 already refused for sync
 * cursors.
 *
 * `unchanged` is the conditional-request answer: the server said nothing has
 * changed since the caller's `etag`, so there are no items *and that is not the
 * same as an empty page*. Collapsing the two would make "nothing exists" and
 * "nothing changed" the same fact.
 */
export interface ProjectPage<T> {
  readonly items: readonly T[];
  readonly cursor?: string;
  readonly etag?: string;
  readonly unchanged?: boolean;
}

export interface ProjectQuery {
  /** The repository or project, as the provider names it: `owner/repo`. */
  readonly project: string;
  /** Continue from a previous page. */
  readonly cursor?: string;
  /** Only records updated at or after this ISO-8601 instant. */
  readonly since?: string;
  /** From a previous page, for a conditional request. */
  readonly etag?: string;
  /** Provider-enforced ceiling applies regardless. */
  readonly pageSize?: number;
  /** Include records the source considers closed. Default: everything. */
  readonly state?: ProjectItemState;
}

/**
 * What the source system says about how much traffic is left.
 *
 * Reported rather than hidden, because a caller that cannot see the budget
 * cannot pace itself, and a provider that silently blocks for an hour is
 * indistinguishable from one that hung. EPIC-021 §8.4.
 */
export interface ProjectRateLimit {
  readonly limit: number;
  readonly remaining: number;
  /** ISO-8601 instant at which `remaining` returns to `limit`. */
  readonly resetsAt?: string;
  /** The provider stopped short of the limit deliberately. */
  readonly reserved?: number;
}

/**
 * The `source.project` capability.
 *
 * **Only `listIssues` is required** — EPIC-071 §8.2. The first draft required
 * five methods, which was a contract written for one provider while claiming to
 * be written for two: Jira has no pull requests and no reviews, and a second
 * implementation would have had to return empty pages indistinguishable from
 * "there are none".
 *
 * What a provider offers is its `operations` declaration, the way the Git
 * provider declares `RepositoryOperation`. The method being absent and the
 * operation being undeclared are then the same fact, stated once.
 */
export interface ProjectSource {
  listIssues(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectIssue>>;
  listPullRequests?(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectPullRequest>>;
  listReviews?(
    query: ProjectQuery & { readonly pullRequest: number },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectReview>>;
  listComments?(
    query: ProjectQuery & { readonly item: number | string },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectComment>>;
  listReleases?(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectRelease>>;
  /** EPIC-073. Optional: not every tracker has the concept. */
  listDeployments?(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectDeployment>>;
  /** EPIC-073 §8.3. One request per deployment, so the caller chooses. */
  listDeploymentStatuses?(
    query: ProjectQuery & { readonly deployment: string },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectDeploymentStatus>>;
  /** What the last response said about the budget, without spending any. */
  rateLimit(): ProjectRateLimit | undefined;
}

/** True when a provider also implements the project-source capability. */
export function isProjectSource(value: unknown): value is ProjectSource {
  if (typeof value !== 'object' || value === null) return false;
  // `listIssues` alone: a provider that cannot list the things a tracker exists
  // to track is not a project source, and everything beyond that is declared
  // per operation. The first version required four methods and would have
  // refused the Jira provider — EPIC-071 §8.2.
  return typeof (value as Partial<ProjectSource>).listIssues === 'function';
}
