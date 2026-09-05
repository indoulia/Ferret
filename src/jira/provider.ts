import { z } from 'zod';

import { ErrorCode, FerretError } from '../errors/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import { Capability, CAPABILITY_VERSIONS, type CapabilityDeclaration } from '../providers/capabilities.js';
import {
  ProjectItemState,
  ProjectOperation,
  type ProjectActor,
  type ProjectComment,
  type ProjectIssue,
  type ProjectIssueLink,
  type ProjectPage,
  type ProjectQuery,
  type ProjectRateLimit,
  type ProjectSource,
} from '../providers/contracts/source-project.js';
import { ProviderKind, type Provider, type ProviderContext } from '../providers/contract.js';
import { BaseProvider } from '../providers/sdk/base.js';
import type { ProviderOperationContext } from '../providers/sdk/operation.js';

import { JIRA_API_PATH, JIRA_MAX_PAGE_SIZE, JiraClient, type FetchLike } from './client.js';

/**
 * The Jira provider — EPIC-071.
 *
 * The second implementation of `source.project`, and the point of it: a
 * contract claimed to be written for two providers is a claim until a second
 * provider is written. Three things had to change, and §17 records them.
 */

export const JIRA_PROVIDER_ID = 'ferret.source.jira';
export const JIRA_SOURCE_SYSTEM = 'jira';

export const jiraOptionsSchema = z
  .object({
    /** `https://acme.atlassian.net`. */
    baseUrl: z.string().url(),
    /** Present for Cloud (Basic), absent for Server (Bearer) — client §auth. */
    email: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    pageSize: z.number().int().min(1).max(JIRA_MAX_PAGE_SIZE).optional(),
    /**
     * Project keys `ferret sync` reads when none is named — EPIC-113.
     *
     * A key, `FER`, not `owner/repo`: the spelling is the provider's, which is
     * why this lives beside the provider rather than in the core schema.
     */
    projects: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type JiraProviderOptions = z.infer<typeof jiraOptionsSchema> & {
  readonly fetch?: FetchLike;
};

export class JiraProvider extends BaseProvider implements Provider, ProjectSource {
  readonly id = JIRA_PROVIDER_ID;
  readonly kind = ProviderKind.SOURCE;
  readonly description = 'Jira issues and comments';

  /**
   * Two operations, and the honesty is the point.
   *
   * Jira has no pull requests and no reviews — its development panel is a
   * private API backed by whatever VCS integration an instance happens to have
   * — and no releases in the sense EPIC-073 models. Declaring five and
   * returning empty pages would make "Jira has no pull requests" and "this
   * project has no pull requests" the same answer.
   */
  readonly capabilities: readonly CapabilityDeclaration[] = [
    {
      capability: Capability.SOURCE_PROJECT,
      version: CAPABILITY_VERSIONS[Capability.SOURCE_PROJECT],
      operations: [ProjectOperation.LIST_ISSUES, ProjectOperation.LIST_COMMENTS],
      systems: [JIRA_SOURCE_SYSTEM],
      limits: {
        supportsPagination: true,
        supportsServerSideFilter: true,
        notes:
          'Paged by startAt. No rate-limit headers and no conditional requests: `since` becomes JQL.',
      },
    },
  ];

  readonly configSchema = jiraOptionsSchema;
  readonly secretOptions: readonly string[] = ['token'];

  readonly #options: JiraProviderOptions;
  #client: JiraClient | undefined;

  constructor(options: JiraProviderOptions) {
    super();
    this.#options = options;
  }

  /**
   * The options actually in force: configuration first, constructor last.
   *
   * The same gap the GitHub provider had, and for the same reason — see that
   * provider's note. `baseUrl` is required by the schema, so a provider built
   * with one and configured with none keeps the constructor's; only a
   * configuration that parses contributes anything.
   */
  get effectiveOptions(): JiraProviderOptions {
    const parsed = jiraOptionsSchema.safeParse(this.settings.options);
    const configured: Partial<JiraProviderOptions> = parsed.success ? parsed.data : {};
    // `baseUrl` is stated last and unconditionally: the type requires one at
    // construction, so a caller has always supplied it, and the configured
    // value could only ever replace it with the same address or the wrong one.
    return { ...configured, ...stripUndefined(this.#options), baseUrl: this.#options.baseUrl };
  }

  protected override onInitialize(_context: ProviderContext): void {
    const options = this.effectiveOptions;
    this.#client = new JiraClient({
      baseUrl: options.baseUrl,
      fetch: options.fetch ?? platformFetch(),
      ...(options.email === undefined ? {} : { email: options.email }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
    });
  }

  /**
   * Jira publishes no rate-limit headers — §8.4.
   *
   * `undefined` rather than a fabricated budget. A caller that cannot see a
   * limit should pace itself on `Retry-After`, and inventing numbers would give
   * it a reason not to.
   */
  rateLimit(): ProjectRateLimit | undefined {
    return undefined;
  }

  async checkDependencies(context: ProviderContext): Promise<readonly DependencyCheckResult[]> {
    const client = this.#client;
    if (client === undefined) {
      return [
        {
          name: 'jira',
          status: DependencyStatus.UNKNOWN,
          required: false,
          detail: 'The provider has not been initialized.',
        },
      ];
    }
    try {
      await client.get({ path: `${JIRA_API_PATH}/myself`, signal: context.signal ?? neverAborts() });
      return [{ name: 'jira', status: DependencyStatus.OK, required: false, detail: 'Jira answered.' }];
    } catch (error) {
      const unauthorized =
        error instanceof FerretError && error.code === ErrorCode.SOURCE_UNAUTHORIZED;
      return [
        {
          name: 'jira',
          status: unauthorized ? DependencyStatus.DEGRADED : DependencyStatus.UNAVAILABLE,
          required: false,
          detail: error instanceof Error ? error.message : String(error),
          remediation: unauthorized
            ? 'Check the Jira credentials: Cloud needs an email and an API token, Server a personal access token.'
            : 'Check network access to the Jira instance, then run `ferret doctor`.',
        },
      ];
    }
  }

  /**
   * Issues, by JQL — §8.3.
   *
   * The cursor is a `startAt` offset rather than a URL, which is what makes
   * EPIC-021 §8.1's decision to keep cursors opaque a correct one rather than a
   * lucky one: a caller that had ever parsed GitHub's would break here.
   */
  async listIssues(
    query: ProjectQuery,
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectIssue>> {
    context.signal.throwIfAborted();
    const client = this.#assertReady();
    const startAt = cursorOffset(query.cursor);
    const pageSize = query.pageSize ?? this.#options.pageSize ?? JIRA_MAX_PAGE_SIZE;

    const response = await client.get<JiraSearch>({
      path: `${JIRA_API_PATH}/search`,
      query: {
        jql: jqlFor(query),
        startAt,
        maxResults: pageSize,
        // Named rather than defaulted: Jira returns every field otherwise, and
        // a large instance's custom fields are megabytes Ferret does not read.
        fields:
          'summary,description,status,issuetype,priority,labels,created,updated,resolutiondate,assignee,reporter,issuelinks',
      },
      signal: context.signal,
    });

    const issues = response?.issues ?? [];
    const total = response?.total ?? 0;
    const next = startAt + issues.length;
    return {
      items: issues.map((issue) => toIssue(issue)),
      // Absent on the last page, which is how a caller stops. `total` is Jira's
      // own count and is the only end-of-results signal `/search` gives.
      ...(issues.length > 0 && next < total ? { cursor: String(next) } : {}),
    };
  }

  async listComments(
    query: ProjectQuery & { readonly item: number | string },
    context: ProviderOperationContext,
  ): Promise<ProjectPage<ProjectComment>> {
    context.signal.throwIfAborted();
    const client = this.#assertReady();
    const startAt = cursorOffset(query.cursor);
    const key = issueKey(String(query.item));

    const response = await client.get<JiraComments>({
      path: `${JIRA_API_PATH}/issue/${encodeURIComponent(key)}/comment`,
      query: { startAt, maxResults: query.pageSize ?? JIRA_MAX_PAGE_SIZE },
      signal: context.signal,
    });

    const comments = response?.comments ?? [];
    const next = startAt + comments.length;
    return {
      items: comments.map((comment) => toComment(comment, key)),
      ...(comments.length > 0 && next < (response?.total ?? 0) ? { cursor: String(next) } : {}),
    };
  }

  #assertReady(): JiraClient {
    if (this.#client === undefined) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        'The Jira provider was used before it was initialized',
        { remediation: 'Register the provider with a runtime and initialize it first.' },
      );
    }
    return this.#client;
  }
}

/* -- JQL and identifiers ---------------------------------------------------- */

/**
 * The query, as JQL — §8.3.
 *
 * Jira has no `since` parameter and no conditional requests; incremental
 * reading is `updated >= ...` in the query language. Ordering by `updated ASC`
 * is what makes paging stable enough to resume: a page boundary in a set
 * ordered by anything else moves as issues change.
 *
 * The project key is validated rather than escaped, for EPIC-021 §8.17's
 * reason: it reaches a query, and a legitimate key never contains a quote.
 */
export function jqlFor(query: ProjectQuery): string {
  const clauses = [`project = ${projectKey(query.project)}`];
  if (query.since !== undefined) {
    clauses.push(`updated >= "${jqlInstant(query.since)}"`);
  }
  if (query.state === ProjectItemState.OPEN) clauses.push('resolution IS EMPTY');
  if (query.state === ProjectItemState.CLOSED) clauses.push('resolution IS NOT EMPTY');
  return `${clauses.join(' AND ')} ORDER BY updated ASC`;
}

/**
 * An ISO instant as JQL's own format.
 *
 * `2026-01-02 03:04` — JQL rejects the `T` and the seconds, which is a small
 * enough incompatibility to be easy to miss and total enough to make every
 * incremental query fail.
 */
function jqlInstant(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/u;
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/u;

function projectKey(project: string): string {
  if (!PROJECT_KEY.test(project)) {
    throw new FerretError(ErrorCode.USAGE, `"${project}" is not a Jira project key`, {
      details: { project },
      remediation: 'Name the project by its key, such as `FER`.',
    });
  }
  return project;
}

function issueKey(item: string): string {
  if (!ISSUE_KEY.test(item)) {
    throw new FerretError(ErrorCode.USAGE, `"${item}" is not a Jira issue key`, {
      details: { item },
      remediation: 'Name the issue by its key, such as `FER-12`.',
    });
  }
  return item;
}

/** A cursor is a `startAt` offset — §8.3. Anything else is not one Ferret issued. */
function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FerretError(ErrorCode.CURSOR_INVALID, `"${cursor}" is not a Jira page cursor`, {
      details: { cursor },
      remediation: 'Pass the cursor a previous page returned, or omit it to start again.',
    });
  }
  return offset;
}

/* -- Mapping ---------------------------------------------------------------- */

interface JiraUser {
  readonly accountId?: string;
  readonly key?: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly emailAddress?: string;
}

interface JiraIssue {
  readonly id?: string;
  readonly key: string;
  readonly self?: string;
  readonly fields?: {
    readonly summary?: string;
    readonly description?: unknown;
    readonly status?: { readonly name?: string; readonly statusCategory?: { readonly key?: string } };
    readonly issuetype?: { readonly name?: string };
    readonly priority?: { readonly name?: string };
    readonly labels?: readonly string[];
    readonly created?: string;
    readonly updated?: string;
    readonly resolutiondate?: string | null;
    readonly assignee?: JiraUser;
    readonly reporter?: JiraUser;
    readonly issuelinks?: readonly JiraIssueLink[];
  };
}

/**
 * One link, as Jira reports it on an issue.
 *
 * Exactly one of `outwardIssue` and `inwardIssue` is present: the one that is
 * *not* the issue carrying the link. Which one it is, is the direction.
 */
interface JiraIssueLink {
  readonly type?: {
    readonly name?: string;
    readonly inward?: string;
    readonly outward?: string;
  };
  readonly outwardIssue?: JiraLinkedIssue;
  readonly inwardIssue?: JiraLinkedIssue;
}

interface JiraLinkedIssue {
  readonly id?: string;
  readonly key?: string;
}

interface JiraSearch {
  readonly issues?: readonly JiraIssue[];
  readonly total?: number;
}

interface JiraComment {
  readonly id?: string;
  readonly author?: JiraUser;
  readonly body?: unknown;
  readonly created?: string;
  readonly updated?: string;
  readonly self?: string;
}

interface JiraComments {
  readonly comments?: readonly JiraComment[];
  readonly total?: number;
}

/**
 * A person, keyed on `accountId`.
 *
 * The same reasoning as EPIC-021 §8.7: a display name is not an identity, and
 * Jira Cloud stopped exposing usernames entirely when it introduced GDPR mode.
 * `key` is the Server-era identifier and is the fallback.
 */
function toActor(user: JiraUser | undefined): ProjectActor | undefined {
  if (user === undefined) return undefined;
  const identity = user.accountId ?? user.key ?? user.name;
  if (identity === undefined) return undefined;
  return {
    identity,
    ...(user.name === undefined ? {} : { login: user.name }),
    ...(user.displayName === undefined ? {} : { displayName: user.displayName }),
    ...(user.emailAddress === undefined ? {} : { email: user.emailAddress }),
  };
}

/**
 * Jira's status category, as the contract's lifecycle.
 *
 * `statusCategory` rather than `status`: a status is whatever a project's
 * administrator called a workflow column — "In Review", "Awaiting Deploy" — and
 * comparing those across projects is meaningless. The category is the one
 * cross-project reading Jira itself provides, and the administrator's word is
 * kept verbatim in `state`, which is what EPIC-021 §8.1 built that pair for.
 */
function toLifecycle(category: string | undefined): ProjectItemState {
  return category === 'done' ? ProjectItemState.CLOSED : ProjectItemState.OPEN;
}

/**
 * Atlassian Document Format, as text.
 *
 * A Jira Cloud description is a document tree, not a string. Walking it for
 * `text` nodes is the whole conversion: the formatting is presentation, and
 * EPIC-027 §4 took the same position for Word. A Server instance sends a plain
 * string, which is the other branch.
 */
export function documentText(body: unknown, depth = 0): string {
  if (typeof body === 'string') return body;
  // The depth cap is not decoration: a document is JSON somebody uploaded, and
  // a self-referential one is a stack overflow rather than a parse error.
  if (depth > 32 || typeof body !== 'object' || body === null) return '';
  const node = body as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';

  const parts = node.content
    .map((child) => documentText(child, depth + 1))
    .filter((part) => part.length > 0);
  // Blocks are separated, inline runs are not: a paragraph's `text` nodes are
  // one sentence split at a formatting boundary, and joining those with a
  // newline would break a word wherever somebody bolded half of it.
  return parts.join(BLOCK_CONTAINERS.has(String(node.type)) ? '\n' : '');
}

/** Node types whose children are blocks rather than inline runs. */
const BLOCK_CONTAINERS: ReadonlySet<string> = new Set([
  'doc',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'panel',
  'tableRow',
]);

function toIssue(issue: JiraIssue): ProjectIssue {
  const fields = issue.fields ?? {};
  const status = fields.status?.name ?? 'unknown';
  const description = documentText(fields.description).trim();
  return {
    // The stable id, not the key: a Jira issue can be *moved* between projects
    // and gets a new key when it is. The numeric id survives the move, which is
    // exactly the property EPIC-072 §8.1 needs from an identity.
    id: issue.id ?? issue.key,
    key: issue.key,
    title: fields.summary ?? issue.key,
    ...(description === '' ? {} : { body: description }),
    state: status,
    lifecycle: toLifecycle(fields.status?.statusCategory?.key),
    ...(issue.self === undefined ? {} : { url: issue.self }),
    ...(toActor(fields.reporter) === undefined ? {} : { author: toActor(fields.reporter) }),
    ...instantField('createdAt', fields.created),
    ...instantField('updatedAt', fields.updated),
    ...instantField('closedAt', fields.resolutiondate ?? undefined),
    labels: [...(fields.labels ?? [])],
    // Requested on every search since EPIC-071 and dropped on the floor until
    // EPIC-122, for want of a field to put them in. `issueAttributes` has
    // declared both since EPIC-006.
    ...(fields.issuetype?.name === undefined ? {} : { issueType: fields.issuetype.name }),
    ...(fields.priority?.name === undefined ? {} : { priority: fields.priority.name }),
    ...(toLinks(fields.issuelinks).length === 0 ? {} : { links: toLinks(fields.issuelinks) }),
    assignees: toActor(fields.assignee) === undefined ? [] : [toActor(fields.assignee) as ProjectActor],
  };
}

/**
 * Jira's issue links, in the contract's terms — EPIC-122.
 *
 * A link with no type name, or naming no other issue, is dropped: it carries no
 * fact. Jira reports the same link on both issues, so the pair is deduplicated
 * one layer up by normalising direction rather than here, where only one side
 * is visible.
 */
function toLinks(links: readonly JiraIssueLink[] | undefined): readonly ProjectIssueLink[] {
  const mapped: ProjectIssueLink[] = [];
  for (const link of links ?? []) {
    const name = link.type?.name;
    if (name === undefined || name === '') continue;
    const outward = link.outwardIssue;
    const inward = link.inwardIssue;
    const other = outward ?? inward;
    // The id, not the key: a Jira issue keeps its id across a move between
    // projects and gets a new key, which is the same reason `toIssue` identifies
    // by id. Falling back to the key is better than dropping the link.
    const targetId = other?.id ?? other?.key;
    if (targetId === undefined) continue;
    mapped.push({
      type: name,
      direction: outward !== undefined ? 'outward' : 'inward',
      targetId,
      ...(other?.key === undefined ? {} : { targetKey: other.key }),
    });
  }
  return mapped;
}

function toComment(comment: JiraComment, parentId: string): ProjectComment {
  return {
    id: comment.id ?? `${parentId}/comment`,
    parentId,
    body: documentText(comment.body),
    ...(toActor(comment.author) === undefined ? {} : { author: toActor(comment.author) }),
    ...instantField('createdAt', comment.created),
    ...instantField('updatedAt', comment.updated),
    ...(comment.self === undefined ? {} : { url: comment.self }),
  };
}

/**
 * Jira's instants, in the spelling Ferret's model accepts — EPIC-122.
 *
 * **Jira ingestion had never worked end to end, and this is why.** Jira reports
 * `2026-01-02T03:04:05.000+0000` — a numeric offset with no colon, which is
 * valid ISO 8601 *basic* format and is not what `z.iso.datetime({ offset: true })`
 * accepts. Every issue therefore failed `createEntity` validation, and
 * `modelProject` did exactly what it should with a record it cannot model: it
 * skipped it and counted it. A hundred per cent of a Jira board arrived as a
 * skip count.
 *
 * It survived EPIC-071 because the provider suite asserts the provider's
 * *output* — a `ProjectIssue` with the string on it — and never carried that
 * output across the seam into the model. The fixture had the real Jira spelling
 * from the first day; nothing ever handed it to the thing that rejects it.
 *
 * Normalising here rather than loosening the model is deliberate. A provider's
 * job is to map its vendor's representation onto the contract, and widening
 * `instant` would let every other source emit an offset Ferret cannot compare.
 *
 * An unparseable value yields **nothing**, following the rule EPIC-020 settled
 * for Git's dates: absent is honest, and a wrong instant in a field every
 * consumer reads as one is not.
 */
function toInstant(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  // `+0000` / `-0530` → `+00:00` / `-05:30`. Anything already carrying a colon,
  // or ending in `Z`, is left exactly as the source wrote it.
  const spelled = value.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  return Number.isNaN(Date.parse(spelled)) ? undefined : spelled;
}

/** The field, or nothing at all when the source's value was not an instant. */
function instantField(name: string, value: string | undefined): Record<string, string> {
  const instant = toInstant(value);
  return instant === undefined ? {} : { [name]: instant };
}

function neverAborts(): AbortSignal {
  return new AbortController().signal;
}

function platformFetch(): FetchLike {
  return async (url, init) =>
    fetch(url, { method: init.method, headers: { ...init.headers }, signal: init.signal });
}

/** A fresh provider, for a runtime to register. */
export function createJiraProvider(options: JiraProviderOptions): JiraProvider {
  return new JiraProvider(options);
}

/** A partial object with its `undefined` entries removed — see the GitHub note. */
function stripUndefined<T extends object>(value: T): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) output[key] = entry;
  }
  return output as Partial<T>;
}
