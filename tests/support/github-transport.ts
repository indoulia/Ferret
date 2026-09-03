import type { FetchLike, GithubResponse } from '../../src/github/index.js';

/**
 * A recorded GitHub transport — EPIC-021 §8.11.
 *
 * Response *shapes* rather than a mocked client: the behaviours under test are
 * protocol behaviours — a `Link` header, a `304`, an `x-ratelimit-remaining` —
 * and a mock that returned parsed pages would assert nothing about any of them.
 */

export interface RecordedResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export class RecordedTransport {
  readonly calls: RecordedCall[] = [];
  readonly #responses: RecordedResponse[];
  readonly #fallback: RecordedResponse;

  constructor(responses: readonly RecordedResponse[], fallback?: RecordedResponse) {
    this.#responses = [...responses];
    this.#fallback = fallback ?? { status: 200, body: [] };
  }

  /** What is left unplayed. A test that expected three calls made three. */
  get remaining(): number {
    return this.#responses.length;
  }

  readonly fetch: FetchLike = (url, init) => {
    this.calls.push({ url, headers: init.headers });
    const recorded = this.#responses.shift() ?? this.#fallback;
    return Promise.resolve(toResponse(recorded));
  };
}

function toResponse(recorded: RecordedResponse): GithubResponse {
  const headers = new Map(
    Object.entries(recorded.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    status: recorded.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(recorded.body === undefined ? '' : JSON.stringify(recorded.body)),
  };
}

/** Headers that say the budget is healthy, so a test opts in to exhaustion. */
export function healthyRateLimit(remaining = 4_000): Record<string, string> {
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
  };
}
