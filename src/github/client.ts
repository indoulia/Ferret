import { ErrorCode, FerretError } from '../errors/index.js';
import type { ProjectRateLimit } from '../providers/contracts/source-project.js';

/**
 * The GitHub HTTP surface — EPIC-021.
 *
 * Everything that knows about GitHub's protocol lives here: authentication,
 * pagination, rate limits, conditional requests and retries. `provider.ts` knows
 * the `source.project` contract and maps JSON onto it, and nothing else in
 * Ferret knows GitHub exists.
 *
 * `fetch` is injected. Not for mockability as an end in itself, but because a
 * provider that reaches a global cannot be given a different base URL, a
 * different timeout or a recorded transcript — and a network test that needs
 * the network is a test that does not run in CI.
 */

/** api.github.com. An Enterprise Server install overrides it. */
export const GITHUB_DEFAULT_BASE_URL = 'https://api.github.com';

/** The API version header GitHub asks callers to pin. */
export const GITHUB_API_VERSION = '2022-11-28';

/** GitHub's own maximum. Asking for more is silently clamped by the server. */
export const GITHUB_MAX_PAGE_SIZE = 100;

/**
 * How much of the rate limit is never spent — §8.4.
 *
 * A shared token is not Ferret's alone. Stopping with a reserve leaves the
 * user's own `gh` invocation working, and the alternative — spending to zero —
 * makes Ferret the reason somebody else's tooling started failing.
 */
export const GITHUB_RATE_LIMIT_RESERVE = 100;

/** How many times a retryable response is retried. */
export const GITHUB_MAX_ATTEMPTS = 3;

/** The longest `Retry-After` that is honoured rather than surfaced. */
export const GITHUB_MAX_RETRY_SECONDS = 60;

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<GithubResponse>;

/** The part of a `Response` this client uses. */
export interface GithubResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface GithubClientOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly fetch: FetchLike;
  readonly userAgent?: string;
  /** Seconds. A wait beyond this is reported rather than slept through. */
  readonly maxRetrySeconds?: number;
  readonly maxAttempts?: number;
  readonly rateLimitReserve?: number;
  /** Injected so a test does not spend the wall clock it is asserting about. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface GithubRequest {
  /** Either a path — `/repos/o/r/issues` — or a full URL from a `Link` header. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly etag?: string;
  readonly signal: AbortSignal;
}

export interface GithubResult<T> {
  readonly body: T | undefined;
  /** The `Link` header's `rel="next"`, absent on the last page. */
  readonly next?: string;
  readonly etag?: string;
  /** A `304`: the caller's `etag` still matches — §8.5. */
  readonly unchanged: boolean;
}

export class GithubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #maxRetrySeconds: number;
  readonly #maxAttempts: number;
  readonly #reserve: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  #rateLimit: ProjectRateLimit | undefined;

  constructor(options: GithubClientOptions) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? GITHUB_DEFAULT_BASE_URL).replace(/\/+$/u, '');
    this.#fetch = options.fetch;
    this.#userAgent = options.userAgent ?? 'ferret';
    this.#maxRetrySeconds = options.maxRetrySeconds ?? GITHUB_MAX_RETRY_SECONDS;
    this.#maxAttempts = options.maxAttempts ?? GITHUB_MAX_ATTEMPTS;
    this.#reserve = options.rateLimitReserve ?? GITHUB_RATE_LIMIT_RESERVE;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /** What the last response said. No request is made to find out — §8.4. */
  rateLimit(): ProjectRateLimit | undefined {
    return this.#rateLimit;
  }

  /**
   * One request, with the protocol's obligations honoured.
   *
   * `GET` only. This provider is read-only (§8.2) and the method is not a
   * parameter, so a future caller cannot make it one by accident.
   */
  async get<T>(request: GithubRequest): Promise<GithubResult<T>> {
    const url = this.#url(request);

    for (let attempt = 1; ; attempt += 1) {
      request.signal.throwIfAborted();
      this.#assertBudget();

      const response = await this.#fetch(url, {
        method: 'GET',
        headers: this.#headers(request.etag),
        signal: request.signal,
      });

      this.#recordRateLimit(response);

      if (response.status === 304) {
        // Not an empty page — §8.5. A 304 also costs no rate limit, which is
        // the whole reason conditional requests are worth the bookkeeping.
        return { body: undefined, unchanged: true, ...etagOf(response) };
      }
      if (response.status >= 200 && response.status < 300) {
        const text = await response.text();
        return {
          body: text.length === 0 ? undefined : (JSON.parse(text) as T),
          unchanged: false,
          ...nextOf(response),
          ...etagOf(response),
        };
      }

      const wait = this.#retryDelay(response);
      if (wait === undefined || attempt >= this.#maxAttempts) {
        throw await this.#error(response, url, attempt);
      }
      await this.#sleep(wait, request.signal);
    }
  }

  /** Every page, following `Link` until there is no `rel="next"` — §8.3. */
  async *paginate<T>(request: GithubRequest): AsyncGenerator<GithubResult<T[]>> {
    let current: GithubRequest | undefined = request;
    while (current !== undefined) {
      const page: GithubResult<T[]> = await this.get<T[]>(current);
      yield page;
      // The URL is GitHub's own, taken from the header, never constructed here:
      // a client that built `?page=n+1` would be guessing at a scheme the
      // server is free to change, and would silently re-read page 1 when it did.
      current =
        page.next === undefined || page.unchanged
          ? undefined
          : { path: page.next, signal: request.signal };
    }
  }

  #url(request: GithubRequest): string {
    const base = request.path.startsWith('http') ? request.path : `${this.#baseUrl}${request.path}`;
    const entries = Object.entries(request.query ?? {}).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (entries.length === 0) return base;
    const separator = base.includes('?') ? '&' : '?';
    const query = entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `${base}${separator}${query}`;
  }

  #headers(etag: string | undefined): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      'user-agent': this.#userAgent,
      ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }),
      ...(etag === undefined ? {} : { 'if-none-match': etag }),
    };
  }

  /**
   * Refuses to spend the last of the budget — §8.4.
   *
   * Before the request rather than after: a check that ran afterwards would
   * report the exhaustion it had just caused.
   */
  #assertBudget(): void {
    const limit = this.#rateLimit;
    if (limit === undefined || limit.remaining > this.#reserve) return;
    throw new FerretError(
      ErrorCode.SOURCE_UNAVAILABLE,
      `GitHub rate limit nearly exhausted: ${String(limit.remaining)} of ${String(limit.limit)} left, reserving ${String(this.#reserve)}`,
      {
        details: {
          remaining: limit.remaining,
          limit: limit.limit,
          ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
        },
        retryable: true,
        remediation:
          limit.resetsAt === undefined
            ? 'Wait for the rate limit window to reset.'
            : `Wait until ${limit.resetsAt}, or use a token with a higher limit.`,
      },
    );
  }

  /**
   * Records the budget, only when the response actually stated one.
   *
   * `header()` rather than `Number(headers.get(…))`, and the difference is a
   * defect a test caught: `Number(null)` is `0` and `Number.isFinite(0)` is
   * true, so a response with **no** rate-limit headers — a 503 from a gateway,
   * a 403 from a proxy — was recorded as a budget of zero, and `#assertBudget`
   * then refused every subsequent request until the process restarted. One bad
   * gateway response would have taken the client down for good.
   */
  #recordRateLimit(response: GithubResponse): void {
    const limit = header(response, 'x-ratelimit-limit');
    const remaining = header(response, 'x-ratelimit-remaining');
    if (limit === undefined || remaining === undefined) return;
    const reset = header(response, 'x-ratelimit-reset') ?? Number.NaN;
    this.#rateLimit = {
      limit,
      remaining,
      reserved: this.#reserve,
      ...(Number.isFinite(reset) && reset > 0
        ? { resetsAt: new Date(reset * 1000).toISOString() }
        : {}),
    };
  }

  /**
   * How long to wait before retrying, or `undefined` for "do not".
   *
   * `Retry-After` is GitHub's secondary-rate-limit signal and is honoured
   * exactly; a 403 or 429 carrying `x-ratelimit-remaining: 0` is the primary
   * limit and waits until the reset. Everything else retryable — 502, 503, 504 —
   * backs off. A 401 or a 404 never retries: neither improves by being asked
   * again, and retrying a 401 is how a token gets a machine blocked.
   */
  #retryDelay(response: GithubResponse): number | undefined {
    const retryAfter = header(response, 'retry-after');
    if (retryAfter !== undefined && retryAfter > 0) {
      return retryAfter <= this.#maxRetrySeconds ? retryAfter * 1000 : undefined;
    }

    if (response.status === 403 || response.status === 429) {
      if (header(response, 'x-ratelimit-remaining') !== 0) return undefined;
      const reset = header(response, 'x-ratelimit-reset');
      if (reset === undefined) return undefined;
      const wait = reset * 1000 - Date.now();
      return wait > 0 && wait <= this.#maxRetrySeconds * 1000 ? wait : undefined;
    }

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return 1000;
    }
    return undefined;
  }

  /**
   * A refusal that names the cause and never the credential.
   *
   * The response body is read for GitHub's own `message`, which is safe — it is
   * the server's description of the request, not the request's headers. The
   * token appears in no branch here, which `credential-isolation.test.ts` is
   * the general assertion of.
   */
  async #error(response: GithubResponse, url: string, attempts: number): Promise<FerretError> {
    let message = '';
    try {
      const body: unknown = JSON.parse(await response.text());
      if (typeof body === 'object' && body !== null) {
        const named = (body as { message?: unknown }).message;
        if (typeof named === 'string') message = named;
      }
    } catch {
      // A non-JSON body from a proxy or a gateway. The status is the fact.
    }

    const code =
      response.status === 401 || response.status === 403
        ? ErrorCode.SOURCE_UNAUTHORIZED
        : ErrorCode.SOURCE_UNAVAILABLE;

    return new FerretError(
      code,
      `GitHub responded ${String(response.status)}${message === '' ? '' : `: ${message}`}`,
      {
        details: {
          status: response.status,
          // The path, never the query: a query can carry a search term, and a
          // search term can carry anything the caller put in it.
          url: url.split('?')[0] ?? url,
          attempts,
        },
        retryable: code === ErrorCode.SOURCE_UNAVAILABLE,
        remediation:
          response.status === 401
            ? 'Check the configured GitHub token: it is missing, expired or revoked.'
            : response.status === 403
              ? 'The token lacks access to this repository, or a secondary rate limit is in force.'
              : 'The GitHub API is unavailable; retry later.',
      },
    );
  }
}

/** A numeric header, or `undefined` when it is absent or not a number. */
function header(response: GithubResponse, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function nextOf(response: GithubResponse): { next?: string } {
  const link = response.headers.get('link');
  if (link === null) return {};
  // `<https://…&page=2>; rel="next", <…>; rel="last"` — the server's own URLs.
  const match = /<([^>]+)>\s*;\s*rel="next"/u.exec(link);
  return match?.[1] === undefined ? {} : { next: match[1] };
}

function etagOf(response: GithubResponse): { etag?: string } {
  const etag = response.headers.get('etag');
  return etag === null ? {} : { etag };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
