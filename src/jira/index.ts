/**
 * The Jira provider — EPIC-071.
 *
 * The second implementation of `source.project`, which is what turned that
 * contract's claim to be written for two providers into a fact. Like the GitHub
 * provider it brings no dependency: the transport is the platform's `fetch`.
 */

export {
  JIRA_PROVIDER_ID,
  JIRA_SOURCE_SYSTEM,
  JiraProvider,
  createJiraProvider,
  documentText,
  jiraOptionsSchema,
  jqlFor,
  type JiraProviderOptions,
} from './provider.js';

export {
  JIRA_API_PATH,
  JIRA_MAX_ATTEMPTS,
  JIRA_MAX_PAGE_SIZE,
  JIRA_MAX_RETRY_SECONDS,
  JiraClient,
  type FetchLike,
  type JiraClientOptions,
  type JiraRequest,
  type JiraResponse,
} from './client.js';
