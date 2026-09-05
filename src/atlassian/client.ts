import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * The Atlassian HTTP surface, shared by the products that sit on it — EPIC-123.
 *
 * This is `src/jira/client.ts` (EPIC-071), lifted out unchanged so that a second
 * Atlassian product can *be* that transport rather than resemble it. Jira and
 * Confluence Cloud are the same host, the same credential, the same
 * `Retry-After` and the same 401/403 semantics; the only things that differ are
 * the path and the shape of the error body. A second copy would have been two
 * places to fix a backoff bug, and `indexing/ports.ts` already records what
 * happens then: the duplication is invisible until the second caller makes it
 * real.
 *
 * `JiraClient` is now a binding of this with `product: 'Jira'`, and EPIC-071's
 * own tests are what prove the lift was faithful — they exercise this code
 * through that name and were not changed.
 *
 * Providers stay isolated from each other: Confluence does not import
 * `src/jira`, Jira does not import `src/confluence`, and both import this.
 */

export const ATLASSIAN_MAX_ATTEMPTS = 3;

/** The longest `Retry-After` honoured rather than surfaced. */
export const ATLASSIAN_MAX_RETRY_SECONDS = 60;

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
) => Promise<AtlassianResponse>;

export interface AtlassianResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface AtlassianClientOptions {
  /** `https://acme.atlassian.net`. */
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /**
   * The account the token belongs to.
   *
   * Present means Basic — Atlassian Cloud's API tokens are used as
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
  /**
   * Which product this client is talking to, for what a failure says.
   *
   * Only ever used in an error message and its remediation. An operator reading
   * "Confluence responded 401" should not have to work out which of two
   * credentials to check.
   */
  readonly product?: string;
}

export interface AtlassianRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly signal: AbortSignal;
}

export class AtlassianClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #authorization: string | undefined;
  readonly #userAgent: string;
  readonly #maxAttempts: number;
  readonly #maxRetrySeconds: number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #product: string;

  constructor(options: AtlassianClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#fetch = options.fetch;
    this.#authorization = authorizationFor(options.email, options.token);
    this.#userAgent = options.userAgent ?? 'ferret';
    this.#maxAttempts = options.maxAttempts ?? ATLASSIAN_MAX_ATTEMPTS;
    this.#maxRetrySeconds = options.maxRetrySeconds ?? ATLASSIAN_MAX_RETRY_SECONDS;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#product = options.product ?? 'Atlassian';
  }

  /**
   * One request. `GET` only, for EPIC-021 §8.2's reason.
   *
   * Read-only structurally: the method is not a parameter, so a token with
   * write scope still cannot change anything through this client.
   */
  async get<T>(request: AtlassianRequest): Promise<T | undefined> {
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

  #url(request: AtlassianRequest): string {
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
   * Atlassian publishes no rate-limit headers, so `Retry-After` on a 429 is the
   * only signal there is — which is why EPIC-071 §8.4 cannot offer GitHub's
   * reserve. A 401 or 403 never retries: neither improves by being asked again.
   */
  #retryDelay(response: AtlassianResponse): number | undefined {
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
   * Both products describe the request rather than its headers, and they spell
   * it differently: Jira reports `errorMessages`, Confluence v2 reports
   * `errors[].title`. Both are read, because a message an operator can act on
   * is worth more than a status code and neither shape is the caller's fault.
   */
  async #error(response: AtlassianResponse, url: string, attempts: number): Promise<FerretError> {
    let message = '';
    try {
      const body: unknown = JSON.parse(await response.text());
      if (typeof body === 'object' && body !== null) {
        const messages = (body as { errorMessages?: unknown }).errorMessages;
        if (Array.isArray(messages) && typeof messages[0] === 'string') message = messages[0];
        if (message === '') {
          const errors = (body as { errors?: unknown }).errors;
          const first = Array.isArray(errors) ? (errors[0] as { title?: unknown }) : undefined;
          if (typeof first?.title === 'string') message = first.title;
        }
      }
    } catch {
      // An HTML error page from a proxy. The status is the fact.
    }

    const unauthorized = response.status === 401 || response.status === 403;
    return new FerretError(
      unauthorized ? ErrorCode.SOURCE_UNAUTHORIZED : ErrorCode.SOURCE_UNAVAILABLE,
      `${this.#product} responded ${String(response.status)}${message === '' ? '' : `: ${message}`}`,
      {
        details: {
          status: response.status,
          // The path, never the query: a JQL or CQL query is caller-supplied text.
          url: url.split('?')[0] ?? url,
          attempts,
        },
        retryable: !unauthorized,
        remediation: unauthorized
          ? `Check the configured ${this.#product} credentials: Cloud needs an email and an API token, Server a personal access token.`
          : `The ${this.#product} API is unavailable or rate-limiting; retry later.`,
      },
    );
  }
}

/**
 * Basic for Cloud, Bearer for Server.
 *
 * Atlassian Cloud's API tokens authenticate as `email:token` over Basic — not
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
