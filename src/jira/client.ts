import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * The Jira HTTP surface — EPIC-071.
 *
 * Deliberately the same shape as `src/github/client.ts` and deliberately not
 * the same protocol: this Epic exists to find out whether EPIC-021's contract
 * was written for two providers or for one, and copying GitHub's transport
 * wholesale would have answered the question by assumption.
 *
 * What actually differs is recorded in the spec: pagination is `startAt`, not a
 * `Link` header; there are no rate-limit headers to read; conditional requests
 * are not offered on search. Each is a divergence the contract had to absorb.
 */

/** Jira Cloud's REST version. Server and Data Center use `/rest/api/2`. */
export const JIRA_API_PATH = '/rest/api/3';

/** Jira's own ceiling for a search page. Asking for more is clamped. */
export const JIRA_MAX_PAGE_SIZE = 100;

export const JIRA_MAX_ATTEMPTS = 3;

/** The longest `Retry-After` honoured rather than surfaced. */
export const JIRA_MAX_RETRY_SECONDS = 60;

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<JiraResponse>;

export interface JiraResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface JiraClientOptions {
  /** `https://acme.atlassian.net`. */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /**
   * The account the token belongs to.
   *
   * Present means Basic — Jira Cloud's API tokens are used as
   * `email:token` — and absent means Bearer, which is what Server and Data
   * Center personal access tokens are. One field decides, rather than a mode
   * flag somebody has to keep consistent with the credential they pasted.
   */
  readonly email?: string;
  readonly token?: string;
  readonly userAgent?: string;
  readonly maxAttempts?: number;
  readonly maxRetrySeconds?: number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface JiraRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly signal: AbortSignal;
}

export class JiraClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #authorization: string | undefined;
  readonly #userAgent: string;
  readonly #maxAttempts: number;
  readonly #maxRetrySeconds: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  constructor(options: JiraClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#fetch = options.fetch;
    this.#authorization = authorizationFor(options.email, options.token);
    this.#userAgent = options.userAgent ?? 'ferret';
    this.#maxAttempts = options.maxAttempts ?? JIRA_MAX_ATTEMPTS;
    this.#maxRetrySeconds = options.maxRetrySeconds ?? JIRA_MAX_RETRY_SECONDS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * One request. `GET` only, for EPIC-021 §8.2's reason.
   *
   * Read-only structurally: the method is not a parameter, so a token with
   * write scope still cannot transition an issue through this provider.
   */
  async get<T>(request: JiraRequest): Promise<T | undefined> {
    const url = this.#url(request);

    for (let attempt = 1; ; attempt += 1) {
      request.signal.throwIfAborted();
      const response = await this.#fetch(url, {
        method: 'GET',
        headers: this.#headers(),
        signal: request.signal,
      });

      if (response.status >= 200 && response.status < 300) {
        const text = await response.text();
        return text.length === 0 ? undefined : (JSON.parse(text) as T);
      }

      const wait = this.#retryDelay(response);
      if (wait === undefined || attempt >= this.#maxAttempts) {
        throw await this.#error(response, url, attempt);
      }
      await this.#sleep(wait, request.signal);
    }
  }

  #url(request: JiraRequest): string {
    const base = `${this.#baseUrl}${request.path}`;
    const entries = Object.entries(request.query ?? {}).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    if (entries.length === 0) return base;
    const query = entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');
    return `${base}?${query}`;
  }

  #headers(): Record<string, string> {
    return {
      accept: 'application/json',
      'user-agent': this.#userAgent,
      ...(this.#authorization === undefined ? {} : { authorization: this.#authorization }),
    };
  }

  /**
   * How long to wait, or `undefined` for "do not".
   *
   * Jira publishes no rate-limit headers, so `Retry-After` on a 429 is the only
   * signal there is — which is why EPIC-071 §8.4 cannot offer GitHub's reserve.
   * A 401 or 403 never retries: neither improves by being asked again.
   */
  #retryDelay(response: JiraResponse): number | undefined {
    const retryAfter = Number(response.headers.get('retry-after') ?? '');
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter <= this.#maxRetrySeconds ? retryAfter * 1000 : undefined;
    }
    if (response.status === 429) return 1000;
    if (response.status === 502 || response.status === 503 || response.status === 504) return 1000;
    return undefined;
  }

  /**
   * A refusal that names the cause and never the credential.
   *
   * Jira reports failures as `errorMessages` and `errors`, both of which
   * describe the request rather than its headers.
   */
  async #error(response: JiraResponse, url: string, attempts: number): Promise<FerretError> {
    let message = '';
    try {
      const body: unknown = JSON.parse(await response.text());
      if (typeof body === 'object' && body !== null) {
        const messages = (body as { errorMessages?: unknown }).errorMessages;
        if (Array.isArray(messages) && typeof messages[0] === 'string') message = messages[0];
      }
    } catch {
      // An HTML error page from a proxy. The status is the fact.
    }

    const unauthorized = response.status === 401 || response.status === 403;
    return new FerretError(
      unauthorized ? ErrorCode.SOURCE_UNAUTHORIZED : ErrorCode.SOURCE_UNAVAILABLE,
      `Jira responded ${String(response.status)}${message === '' ? '' : `: ${message}`}`,
      {
        details: {
          status: response.status,
          // The path, never the query: a JQL query is caller-supplied text.
          url: url.split('?')[0] ?? url,
          attempts,
        },
        retryable: !unauthorized,
        remediation: unauthorized
          ? 'Check the configured Jira credentials: Cloud needs an email and an API token, Server a personal access token.'
          : 'The Jira API is unavailable or rate-limiting; retry later.',
      },
    );
  }
}

/**
 * Basic for Cloud, Bearer for Server.
 *
 * Jira Cloud's API tokens authenticate as `email:token` over Basic — not
 * because anyone likes it, but because that is what Atlassian documents. A
 * token with no email is a Server or Data Center personal access token, which
 * is a Bearer. Deciding from the credential's *shape* rather than from a mode
 * flag means the two cannot be configured inconsistently.
 */
function authorizationFor(email: string | undefined, token: string | undefined): string | undefined {
  if (token === undefined) return undefined;
  if (email === undefined) return `Bearer ${token}`;
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
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
