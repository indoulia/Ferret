import {
  ATLASSIAN_MAX_ATTEMPTS,
  ATLASSIAN_MAX_RETRY_SECONDS,
  AtlassianClient,
  type AtlassianClientOptions,
  type AtlassianRequest,
  type AtlassianResponse,
  type FetchLike,
} from '../atlassian/client.js';

/**
 * The Jira HTTP surface — EPIC-071, transport shared since EPIC-123.
 *
 * Deliberately the same shape as `src/github/client.ts` and deliberately not
 * the same protocol: EPIC-071 existed to find out whether EPIC-021's contract
 * was written for two providers or for one, and copying GitHub's transport
 * wholesale would have answered the question by assumption.
 *
 * What actually differs is recorded in the spec: pagination is `startAt`, not a
 * `Link` header; there are no rate-limit headers to read; conditional requests
 * are not offered on search. Each is a divergence the contract had to absorb.
 * None of them lives in the transport, which is why the transport could move.
 *
 * **The HTTP itself is now `src/atlassian/client.ts`**, shared with Confluence.
 * Jira and Confluence Cloud are the same host, the same credential, the same
 * `Retry-After` and the same 401/403 semantics; the second product would have
 * been a second copy of all of it. What stays here is what is Jira's: the REST
 * version, the page ceiling, and the name callers already import.
 */

/** Jira Cloud's REST version. Server and Data Center use `/rest/api/2`. */
export const JIRA_API_PATH = '/rest/api/3';

/** Jira's own ceiling for a search page. Asking for more is clamped. */
export const JIRA_MAX_PAGE_SIZE = 100;

export const JIRA_MAX_ATTEMPTS = ATLASSIAN_MAX_ATTEMPTS;

/** The longest `Retry-After` honoured rather than surfaced. */
export const JIRA_MAX_RETRY_SECONDS = ATLASSIAN_MAX_RETRY_SECONDS;

export type { FetchLike };
export type JiraResponse = AtlassianResponse;
export type JiraRequest = AtlassianRequest;
export type JiraClientOptions = Omit<AtlassianClientOptions, 'product'>;

/**
 * The Atlassian client, told which product it is talking to.
 *
 * A subclass rather than a factory so that `new JiraClient(...)` — which is what
 * `JiraProvider` and EPIC-071's suite both write — keeps working untouched.
 * Those tests exercising this name are what prove the extraction was faithful.
 */
export class JiraClient extends AtlassianClient {
  constructor(options: JiraClientOptions) {
    super({ ...options, product: 'Jira' });
  }
}
