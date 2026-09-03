/**
 * The GitHub provider — EPIC-021.
 *
 * Published from the package root rather than a subpath: unlike a parser, it
 * brings no dependency at all. The transport is the platform's `fetch`, and the
 * only thing that would make it heavy is a vendor SDK it deliberately does not
 * use.
 */

export {
  GITHUB_PROVIDER_ID,
  GITHUB_SOURCE_SYSTEM,
  GithubProvider,
  createGithubProvider,
  githubOptionsSchema,
  type GithubProviderOptions,
} from './provider.js';

export {
  GITHUB_API_VERSION,
  GITHUB_DEFAULT_BASE_URL,
  GITHUB_MAX_ATTEMPTS,
  GITHUB_MAX_PAGE_SIZE,
  GITHUB_MAX_RETRY_SECONDS,
  GITHUB_RATE_LIMIT_RESERVE,
  GithubClient,
  type FetchLike,
  type GithubClientOptions,
  type GithubRequest,
  type GithubResponse,
  type GithubResult,
} from './client.js';
