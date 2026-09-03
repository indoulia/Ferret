import { z } from 'zod';

import { Capability, CAPABILITY_VERSIONS } from '../providers/capabilities.js';
import {
  ProjectItemState,
  ProjectOperation,
  type ProjectActor,
  type ProjectComment,
  type ProjectIssue,
  type ProjectPage,
  type ProjectPullRequest,
  type ProjectQuery,
  type ProjectRateLimit,
  type ProjectRelease,
  type ProjectReview,
  type ProjectSource,
} from '../providers/contracts/source-project.js';
import { ProviderKind, type Provider, type ProviderContext } from '../providers/contract.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import type { CapabilityDeclaration } from '../providers/capabilities.js';
import { BaseProvider } from '../providers/sdk/base.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import {
  GITHUB_MAX_PAGE_SIZE,
  GithubClient,
  type FetchLike,
} from './client.js';

/**
 * The GitHub provider — EPIC-021.
 *
 * Fills `Capability.SOURCE_PROJECT`, which has been declared since EPIC-013
 * with nothing behind it. It returns records; EPIC-072 and EPIC-073 turn them
 * into knowledge.
 */

export const GITHUB_PROVIDER_ID = 'ferret.source.github';
export const GITHUB_SOURCE_SYSTEM = 'github';

/**
 * The provider's options.
 *
 * `token` is declared in `secretOptions`, so it is redacted everywhere the
 * configuration is rendered and may be written as a `$secret` reference —
 * `{"$secret": {"env": "FERRET_GITHUB_TOKEN"}}` — which `resolveSecrets`
 * resolves before this provider is constructed. No new mechanism was needed and
 * none was invented.
 */
export const githubOptionsSchema = z
  .object({
    token: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    userAgent: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(GITHUB_MAX_PAGE_SIZE).optional(),
    rateLimitReserve: z.number().int().min(0).optional(),
  })
  .strict();

export type GithubProviderOptions = z.infer<typeof githubOptionsSchema> & {
  /** Injected. Absent means the platform's `fetch`. */
  readonly fetch?: FetchLike;
};

export class GithubProvider extends BaseProvider implements Provider, ProjectSource {
  readonly id = GITHUB_PROVIDER_ID;
  readonly kind = ProviderKind.SOURCE;
  readonly description = 'GitHub issues, pull requests, reviews and releases';

  /**
   * What this provider offers, named per operation.
   *
   * The limits are honest: GitHub pages, filters server-side by `since` and
   * `state`, and has a rate limit that is the defining constraint of the whole
   * capability — which is why it is declared rather than discovered.
   */
  readonly capabilities: readonly CapabilityDeclaration[] = [
    {
      capability: Capability.SOURCE_PROJECT,
      version: CAPABILITY_VERSIONS[Capability.SOURCE_PROJECT],
      operations: [
        ProjectOperation.LIST_ISSUES,
        ProjectOperation.LIST_PULL_REQUESTS,
        ProjectOperation.LIST_REVIEWS,
        ProjectOperation.LIST_COMMENTS,
        ProjectOperation.LIST_RELEASES,
      ],
      systems: [GITHUB_SOURCE_SYSTEM],
      limits: {
        supportsPagination: true,
        supportsServerSideFilter: true,
        notes:
          'Rate-limited: 5 000 requests/hour authenticated, 60 unauthenticated. A reserve is never spent.',
      },
    },
  ];

  readonly configSchema = githubOptionsSchema;

  /**
   * The token, declared so it is redactable.
   *
   * Redaction by key name cannot know that `token` is a credential — the
   * contract's own comment says so — and a provider that did not declare it
   * would have it printed by `describeConfig` the first time somebody ran
   * `ferret config show`.
   */
  readonly secretOptions: readonly string[] = ['token'];

  readonly #options: GithubProviderOptions;
  #client: GithubClient | undefined;

  constructor(options: GithubProviderOptions = {}) {
    super();
    this.#options = options;
  }

  protected override onInitialize(_context: ProviderContext): void {
    const fetchImpl = this.#options.fetch ?? platformFetch();
    this.#client = new GithubClient({
      fetch: fetchImpl,
      ...(this.#options.token === undefined ? {} : { token: this.#options.token }),
      ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
      ...(this.#options.userAgent === undefined ? {} : { userAgent: this.#options.userAgent }),
      ...(this.#options.rateLimitReserve === undefined
        ? {}
        : { rateLimitReserve: this.#options.rateLimitReserve }),
    });
  }

  /**
   * Reports whether GitHub is reachable and the token is accepted.
   *
   * `/rate_limit` rather than `/user`: it is the one endpoint that costs
   * nothing against the budget, so a health check cannot become the reason a
   * budget ran out. It also answers the question a caller actually has, which
   * is how much traffic is left.
   */
  async checkDependencies(context: ProviderContext): Promise<readonly DependencyCheckResult[]> {
    const client = this.#client;
    if (client === undefined) {
      return [
        {
          name: 'github',
          status: DependencyStatus.UNKNOWN,
          required: false,
          detail: 'The provider has not been initialized.',
        },
      ];
    }

    try {
      await client.get({ path: '/rate_limit', signal: context.signal ?? neverAborts() });
      const limit = client.rateLimit();
      return [
        {
          name: 'github',
          status: DependencyStatus.OK,
          required: false,
          detail:
            limit === undefined
              ? 'GitHub answered.'
              : `GitHub answered; ${String(limit.remaining)} of ${String(limit.limit)} requests left.`,
        },
      ];
    } catch (error) {
      const unauthorized =
        error instanceof FerretError && error.code === ErrorCode.SOURCE_UNAUTHORIZED;
      return [
        {
          name: 'github',
          // A rejected token is `degraded`, not `unavailable`: GitHub answered,
          // and the difference is what tells an operator to look at the token
          // rather than at the network.
          status: unauthorized ? DependencyStatus.DEGRADED : DependencyStatus.UNAVAILABLE,
          required: false,
          detail: error instanceof Error ? error.message : String(error),
          remediation: unauthorized
            ? 'Set a valid GitHub token in the provider options, or as a $secret reference.'
            : 'Check network access to the GitHub API, then run `ferret doctor`.',
        },
      ];
    }
  }

  rateLimit(): ProjectRateLimit | undefined {
    return this.#client?.rateLimit();
  }

  async listIssues(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectIssue>> {
    const page = await this.#page<GithubIssue>(`/repos/${project(query)}/issues`, query, context, {
      state: apiState(query.state),
      since: query.since,
      sort: 'updated',
      direction: 'asc',
    });
    return {
      ...page,
      // §8.6. GitHub returns pull requests from the issues endpoint, because in
      // its data model a pull request *is* an issue. Ferret's model does not
      // agree, and a caller asking for issues that received pull requests would
      // double-count every one of them against `listPullRequests`.
      items: (page.raw ?? [])
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => toIssue(issue, query.project)),
    };
  }

  async listPullRequests(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectPullRequest>> {
    const page = await this.#page<GithubPullRequest>(`/repos/${project(query)}/pulls`, query, context, {
      state: apiState(query.state),
      sort: 'updated',
      direction: 'asc',
    });
    return {
      ...page,
      items: (page.raw ?? []).map((pull) => toPullRequest(pull, query.project)),
    };
  }

  async listReviews(
    query: ProjectQuery & { readonly pullRequest: number },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectReview>> {
    const path = `/repos/${project(query)}/pulls/${String(query.pullRequest)}/reviews`;
    const page = await this.#page<GithubReview>(path, query, context, {});
    const parent = `${query.project}#${String(query.pullRequest)}`;
    return { ...page, items: (page.raw ?? []).map((review) => toReview(review, parent)) };
  }

  async listComments(
    query: ProjectQuery & { readonly item: number },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectComment>> {
    const path = `/repos/${project(query)}/issues/${String(query.item)}/comments`;
    const page = await this.#page<GithubComment>(path, query, context, { since: query.since });
    const parent = `${query.project}#${String(query.item)}`;
    return { ...page, items: (page.raw ?? []).map((comment) => toComment(comment, parent)) };
  }

  async listReleases(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectRelease>> {
    const page = await this.#page<GithubRelease>(`/repos/${project(query)}/releases`, query, context, {});
    return { ...page, items: (page.raw ?? []).map((release) => toRelease(release, query.project)) };
  }

  /** One page: the request, the conditional headers, and the cursor back. */
  async #page<T>(
    path: string,
    query: ProjectQuery,
    context: ProviderOperationContext,
    parameters: Readonly<Record<string, string | number | undefined>>,
  ): Promise<{ raw?: readonly T[]; cursor?: string; etag?: string; unchanged?: boolean; items: never[] }> {
    context.signal.throwIfAborted();
    const client = this.#client;
    if (client === undefined) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        'The GitHub provider was used before it was initialized',
        { remediation: 'Register the provider with a runtime and initialize it first.' },
      );
    }

    const result = await client.get<T[]>({
      // A cursor is GitHub's own `Link` URL, so it carries its own parameters
      // and must not have this call's appended to it — §8.3.
      path: query.cursor ?? path,
      ...(query.cursor === undefined
        ? { query: { ...parameters, per_page: query.pageSize ?? GITHUB_MAX_PAGE_SIZE } }
        : {}),
      ...(query.etag === undefined ? {} : { etag: query.etag }),
      signal: context.signal,
    });

    return {
      items: [],
      ...(result.body === undefined ? {} : { raw: result.body }),
      ...(result.next === undefined ? {} : { cursor: result.next }),
      ...(result.etag === undefined ? {} : { etag: result.etag }),
      ...(result.unchanged ? { unchanged: true } : {}),
    };
  }
}

/* -- Mapping. GitHub's JSON on the left, the contract on the right. --------- */

interface GithubUser {
  readonly node_id?: string;
  readonly id?: number;
  readonly login?: string;
  readonly name?: string;
  readonly email?: string | null;
}

interface GithubIssue {
  readonly node_id?: string;
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly html_url?: string;
  readonly user?: GithubUser;
  readonly assignees?: readonly GithubUser[];
  readonly labels?: readonly (string | { readonly name?: string })[];
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly closed_at?: string | null;
  /** Present exactly when the "issue" is really a pull request — §8.6. */
  readonly pull_request?: unknown;
}

interface GithubPullRequest extends GithubIssue {
  readonly head?: { readonly ref?: string };
  readonly base?: { readonly ref?: string };
  readonly merge_commit_sha?: string | null;
  readonly merged_at?: string | null;
  readonly draft?: boolean;
  readonly requested_reviewers?: readonly GithubUser[];
}

interface GithubReview {
  readonly node_id?: string;
  readonly id?: number;
  readonly user?: GithubUser;
  readonly state: string;
  readonly body?: string | null;
  readonly submitted_at?: string;
}

interface GithubComment {
  readonly node_id?: string;
  readonly id?: number;
  readonly user?: GithubUser;
  readonly body?: string | null;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly html_url?: string;
}

interface GithubRelease {
  readonly node_id?: string;
  readonly id?: number;
  readonly tag_name: string;
  readonly name?: string | null;
  readonly body?: string | null;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly published_at?: string | null;
  readonly author?: GithubUser;
  readonly html_url?: string;
}

/**
 * A person, keyed on the `node_id` GitHub guarantees is stable.
 *
 * A login is not an identity: GitHub lets an account be renamed and the name
 * reused, so keying on it would silently merge two people. `node_id` is the
 * identifier that survives a rename, and the numeric id is the fallback for an
 * Enterprise Server old enough not to send one.
 */
function toActor(user: GithubUser | undefined): ProjectActor | undefined {
  if (user === undefined) return undefined;
  const identity = user.node_id ?? (user.id === undefined ? undefined : `github:${String(user.id)}`);
  if (identity === undefined) return undefined;
  return {
    identity,
    ...(user.login === undefined ? {} : { login: user.login }),
    ...(user.name === undefined || user.name === null ? {} : { displayName: user.name }),
    ...(user.email === undefined || user.email === null ? {} : { email: user.email }),
  };
}

function labelsOf(labels: GithubIssue['labels']): readonly string[] {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label.name))
    .filter((name): name is string => name !== undefined);
}

function base(record: GithubIssue, project: string, lifecycle: ProjectItemState) {
  return {
    id: record.node_id ?? `${project}#${String(record.number)}`,
    number: record.number,
    title: record.title,
    state: record.state,
    lifecycle,
    ...(record.body === undefined || record.body === null ? {} : { body: record.body }),
    ...(record.html_url === undefined ? {} : { url: record.html_url }),
    ...(toActor(record.user) === undefined ? {} : { author: toActor(record.user) }),
    ...(record.created_at === undefined ? {} : { createdAt: record.created_at }),
    ...(record.updated_at === undefined ? {} : { updatedAt: record.updated_at }),
    ...(record.closed_at === undefined || record.closed_at === null
      ? {}
      : { closedAt: record.closed_at }),
    labels: labelsOf(record.labels),
  };
}

function toIssue(issue: GithubIssue, project: string): ProjectIssue {
  return {
    ...base(issue, project, issue.state === 'closed' ? ProjectItemState.CLOSED : ProjectItemState.OPEN),
    assignees: (issue.assignees ?? [])
      .map((user) => toActor(user))
      .filter((actor): actor is ProjectActor => actor !== undefined),
  };
}

function toPullRequest(pull: GithubPullRequest, project: string): ProjectPullRequest {
  // `merged` is not a GitHub state — the API says `closed` and carries
  // `merged_at`. Reporting `closed` for a merged pull request would erase the
  // distinction EPIC-072 exists to model.
  const lifecycle =
    pull.merged_at !== undefined && pull.merged_at !== null
      ? ProjectItemState.MERGED
      : pull.state === 'closed'
        ? ProjectItemState.CLOSED
        : ProjectItemState.OPEN;

  return {
    ...base(pull, project, lifecycle),
    ...(pull.head?.ref === undefined ? {} : { sourceBranch: pull.head.ref }),
    ...(pull.base?.ref === undefined ? {} : { targetBranch: pull.base.ref }),
    ...(pull.merge_commit_sha === undefined || pull.merge_commit_sha === null
      ? {}
      : { mergeCommit: pull.merge_commit_sha }),
    ...(pull.merged_at === undefined || pull.merged_at === null
      ? {}
      : { mergedAt: pull.merged_at }),
    ...(pull.draft === undefined ? {} : { draft: pull.draft }),
    requestedReviewers: (pull.requested_reviewers ?? [])
      .map((user) => toActor(user))
      .filter((actor): actor is ProjectActor => actor !== undefined),
  };
}

function toReview(review: GithubReview, pullRequestId: string): ProjectReview {
  return {
    id: review.node_id ?? `${pullRequestId}/review/${String(review.id ?? '')}`,
    pullRequestId,
    state: review.state,
    // `APPROVED` only. `COMMENTED` is not approval and neither is
    // `CHANGES_REQUESTED`; treating anything else as approval would make a
    // review count that a compliance question depends on quietly wrong.
    approved: review.state.toUpperCase() === 'APPROVED',
    ...(toActor(review.user) === undefined ? {} : { reviewer: toActor(review.user) }),
    ...(review.body === undefined || review.body === null ? {} : { body: review.body }),
    ...(review.submitted_at === undefined ? {} : { submittedAt: review.submitted_at }),
  };
}

function toComment(comment: GithubComment, parentId: string): ProjectComment {
  return {
    id: comment.node_id ?? `${parentId}/comment/${String(comment.id ?? '')}`,
    parentId,
    body: comment.body ?? '',
    ...(toActor(comment.user) === undefined ? {} : { author: toActor(comment.user) }),
    ...(comment.created_at === undefined ? {} : { createdAt: comment.created_at }),
    ...(comment.updated_at === undefined ? {} : { updatedAt: comment.updated_at }),
    ...(comment.html_url === undefined ? {} : { url: comment.html_url }),
  };
}

function toRelease(release: GithubRelease, project: string): ProjectRelease {
  return {
    id: release.node_id ?? `${project}/release/${String(release.id ?? release.tag_name)}`,
    tag: release.tag_name,
    ...(release.name === undefined || release.name === null ? {} : { name: release.name }),
    ...(release.body === undefined || release.body === null ? {} : { body: release.body }),
    ...(release.draft === undefined ? {} : { draft: release.draft }),
    ...(release.prerelease === undefined ? {} : { prerelease: release.prerelease }),
    ...(release.published_at === undefined || release.published_at === null
      ? {}
      : { publishedAt: release.published_at }),
    ...(toActor(release.author) === undefined ? {} : { author: toActor(release.author) }),
    ...(release.html_url === undefined ? {} : { url: release.html_url }),
  };
}

/**
 * `owner/repo`, validated.
 *
 * Validated rather than interpolated: the value reaches a URL path, and a
 * project name containing `../` would reach an endpoint the caller did not ask
 * for. Refusing is the whole check — there is nothing to sanitise, because a
 * legitimate GitHub repository name never contains a slash beyond the one.
 */
function project(query: ProjectQuery): string {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(query.project)) {
    throw new FerretError(
      ErrorCode.USAGE,
      `"${query.project}" is not an owner/repository name`,
      {
        details: { project: query.project },
        remediation: 'Name the repository as `owner/repo`.',
      },
    );
  }
  return query.project;
}

/** GitHub's vocabulary for `state`, which is not the contract's. */
function apiState(state: ProjectItemState | undefined): string {
  if (state === ProjectItemState.OPEN) return 'open';
  if (state === ProjectItemState.CLOSED) return 'closed';
  return 'all';
}

function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

function platformFetch(): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, {
      method: init.method,
      headers: { ...init.headers },
      signal: init.signal,
    });
    return response;
  };
}

/** A fresh provider, for a runtime to register. */
export function createGithubProvider(options: GithubProviderOptions = {}): GithubProvider {
  return new GithubProvider(options);
}
