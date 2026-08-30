import type { Logger } from '../../logging/index.js';
import { ErrorCode, FerretError } from '../../errors/index.js';
import type { CapabilityLimits } from '../capabilities.js';

import { interrupted } from './cancellation.js';

/**
 * A fair token bucket, for providers whose upstream has a published rate limit.
 *
 * EPIC-011 lets a provider *declare* `rateLimitPerMinute`. Declaring it without
 * honouring it is worse than not declaring it, so this is the mechanism that
 * turns the declaration into behaviour.
 *
 * Two properties do the real work, and both are about what happens under
 * contention rather than in the easy case:
 *
 * **Fairness.** Waiters are served strictly in arrival order, even when a later
 * one is cheaper and could be served immediately. Letting cheap requests
 * overtake is how a large request waits forever behind an endless stream of
 * small ones — a starvation bug that only appears under sustained load, which is
 * exactly when nobody is watching.
 *
 * **Abort does not stall the queue.** When a waiter gives up, the bucket must
 * re-examine the queue immediately. The tempting implementation rejects the
 * waiter and returns, leaving the drain scheduled for a moment computed from a
 * head that has since departed — every request behind it then waits for a timer
 * that was set for someone else. It looks like a hang, it is intermittent, and
 * it is the reason this class exists rather than ten lines inside each provider.
 *
 * Node runs one thread, so "concurrent" here means interleaved across `await`
 * points. That is enough to produce every one of the above.
 */

export interface RateLimiterOptions {
  /** Sustained rate. Must be positive. */
  readonly perMinute: number;
  /**
   * How much may be spent at once after an idle period.
   *
   * Defaults to one second's worth, at least one. A bucket that can hold a full
   * minute's allowance lets an idle Ferret spend the entire budget in a burst,
   * which is precisely the shape most upstreams penalise.
   */
  readonly burst?: number;
  readonly logger?: Logger;
  /** Log a wait longer than this. Default 1s. A silent wait looks like a hang. */
  readonly slowWaitMs?: number;
  /** Injectable monotonic clock, in milliseconds. */
  readonly now?: () => number;
}

interface Waiter {
  readonly cost: number;
  readonly queuedAt: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
  settled: boolean;
  prev: Waiter | undefined;
  next: Waiter | undefined;
}

export interface RateLimiterStats {
  readonly available: number;
  readonly waiting: number;
  readonly granted: number;
  readonly perMinute: number;
  readonly burst: number;
}

export class RateLimiter {
  readonly #perMs: number;
  readonly #burst: number;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #slowWaitMs: number;

  #tokens: number;
  #lastRefill: number;
  #granted = 0;

  // A linked list rather than an array: an aborted waiter is removed from the
  // middle, and doing that to an array is O(n) per abort — quadratic exactly
  // when a shutdown cancels every queued request at once.
  #head: Waiter | undefined;
  #tail: Waiter | undefined;
  #waiting = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.perMinute) || options.perMinute <= 0) {
      throw new FerretError(ErrorCode.USAGE, 'A rate limit must be a positive number of requests per minute', {
        details: { perMinute: options.perMinute },
        remediation: 'Pass a positive `perMinute`, or do not create a limiter at all.',
      });
    }
    this.#perMs = options.perMinute / 60_000;
    this.#burst = Math.max(1, options.burst ?? Math.ceil(options.perMinute / 60));
    this.#now = options.now ?? ((): number => performance.now());
    this.#logger = options.logger;
    this.#slowWaitMs = options.slowWaitMs ?? 1_000;
    this.#tokens = this.#burst;
    this.#lastRefill = this.#now();
  }

  /** Creates a limiter from a provider's declared limits, or nothing if it declared none. */
  static fromLimits(limits: CapabilityLimits | undefined, options: Omit<RateLimiterOptions, 'perMinute'> = {}):
    | RateLimiter
    | undefined {
    const perMinute = limits?.rateLimitPerMinute;
    if (perMinute === undefined) return undefined;
    return new RateLimiter({ ...options, perMinute });
  }

  get stats(): RateLimiterStats {
    this.#refill();
    return {
      available: Math.floor(this.#tokens),
      waiting: this.#waiting,
      granted: this.#granted,
      perMinute: this.#perMs * 60_000,
      burst: this.#burst,
    };
  }

  /**
   * Waits until `cost` tokens are available, or until cancelled.
   *
   * Resolves in arrival order. Rejects with `E_INTERRUPTED` if the signal aborts
   * while queued — and a rejected waiter never consumes a token, so nothing is
   * lost from the budget by giving up.
   *
   * @throws {FerretError} `E_USAGE` if `cost` exceeds the burst, which could
   * never be satisfied and would otherwise wait forever.
   */
  async acquire(signal: AbortSignal, cost = 1): Promise<void> {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new FerretError(ErrorCode.USAGE, 'A rate-limit acquisition must cost a positive amount', {
        details: { cost },
        remediation: 'Pass a positive cost, or omit it to spend one token.',
      });
    }
    if (cost > this.#burst) {
      throw new FerretError(
        ErrorCode.USAGE,
        `An acquisition costing ${String(cost)} can never be satisfied by a bucket holding ${String(this.#burst)}`,
        {
          details: { cost, burst: this.#burst },
          remediation: 'Reduce the cost, or raise the limiter’s burst so the request can fit.',
        },
      );
    }
    if (signal.aborted) throw interrupted('rate-limit acquisition', signal.reason);

    this.#refill();

    // Only take the fast path when nobody is already waiting. Overtaking is
    // what produces starvation.
    if (this.#waiting === 0 && this.#tokens >= cost) {
      this.#tokens -= cost;
      this.#granted += 1;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cost,
        queuedAt: this.#now(),
        resolve,
        reject,
        detach: () => signal.removeEventListener('abort', onAbort),
        settled: false,
        prev: this.#tail,
        next: undefined,
      };

      const onAbort = (): void => {
        if (waiter.settled) return;
        this.#remove(waiter);
        waiter.reject(interrupted('rate-limit acquisition', signal.reason));
        // The head may have just departed. Re-examining is what keeps the
        // waiters behind it from inheriting a timer set for someone else.
        this.#drain();
      };

      signal.addEventListener('abort', onAbort, { once: true });

      if (this.#tail === undefined) this.#head = waiter;
      else this.#tail.next = waiter;
      this.#tail = waiter;
      this.#waiting += 1;

      this.#drain();
    });
  }

  /**
   * Rejects everything queued.
   *
   * Called at shutdown: a provider being torn down should not leave callers
   * waiting on a budget that will never be spent.
   */
  cancelAll(reason: string): void {
    let waiter = this.#head;
    this.#head = undefined;
    this.#tail = undefined;
    this.#waiting = 0;
    this.#clearTimer();
    while (waiter !== undefined) {
      const next = waiter.next;
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.detach();
        waiter.reject(interrupted(reason));
      }
      waiter = next;
    }
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#lastRefill = now;
    this.#tokens = Math.min(this.#burst, this.#tokens + elapsed * this.#perMs);
  }

  #remove(waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    waiter.detach();
    if (waiter.prev === undefined) this.#head = waiter.next;
    else waiter.prev.next = waiter.next;
    if (waiter.next === undefined) this.#tail = waiter.prev;
    else waiter.next.prev = waiter.prev;
    waiter.prev = undefined;
    waiter.next = undefined;
    this.#waiting -= 1;
  }

  #drain(): void {
    this.#refill();

    for (;;) {
      const head = this.#head;
      if (head === undefined) {
        this.#clearTimer();
        return;
      }
      if (this.#tokens < head.cost) break;

      this.#remove(head);
      this.#tokens -= head.cost;
      this.#granted += 1;

      const waited = this.#now() - head.queuedAt;
      if (waited >= this.#slowWaitMs) {
        this.#logger?.debug(
          { operation: 'provider.ratelimit.wait', waitedMs: Math.round(waited), waiting: this.#waiting },
          `Rate limit held a request for ${String(Math.round(waited))}ms`,
        );
      }
      head.resolve();
    }

    const head = this.#head;
    if (head === undefined) {
      this.#clearTimer();
      return;
    }

    // Schedule for the moment the head becomes affordable, and no sooner: a
    // fixed poll interval either burns CPU or adds latency, depending on which
    // number was guessed.
    const shortfall = head.cost - this.#tokens;
    const waitMs = Math.max(1, Math.ceil(shortfall / this.#perMs));
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#drain();
    }, waitMs);
    // Deliberately **not** unref'd. This timer is only ever scheduled when a
    // caller is waiting, and an awaited promise does not keep the event loop
    // alive by itself — so unref'ing it lets a process whose only outstanding
    // work is a rate-limited request exit with that request unresolved.
    // Silently, and only when the limiter is actually doing its job.
    //
    // The timer is cleared the moment the queue empties, so an idle limiter
    // holds nothing.
  }

  #clearTimer(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
