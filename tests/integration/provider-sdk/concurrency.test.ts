import { getEventListeners } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  BaseProvider,
  BatchEmitter,
  Capability,
  ErrorCode,
  FerretError,
  ProviderKind,
  ProviderState,
  RateLimiter,
  abortableDelay,
  encodeCursor,
  decodeCursor,
  linkSignals,
  retry,
  withDeadline,
  type CapabilityDeclaration,
} from '../../../src/index.js';
import { createBarrier, createTestProviderContext } from '../../../src/providers/sdk/testing.js';

/**
 * Concurrency, durability, reliability and performance for the Provider SDK.
 *
 * These are the tests the SDK exists for. Every helper it publishes is correct
 * in the single-caller case almost by construction; each of them has a failure
 * mode that appears only when two callers interleave, when a queue is abandoned
 * mid-wait, or after a million iterations. Those failures present as
 * *"indexing sometimes hangs"* — never as themselves — which is exactly why
 * they have to be provoked deliberately rather than waited for.
 *
 * Node runs one thread. "Concurrent" here means interleaved across `await`
 * points, which is enough to produce every defect below.
 */

const CAPABILITIES: readonly CapabilityDeclaration[] = [
  { capability: Capability.SOURCE_REPOSITORY, version: 1 },
];

/** A provider that opens something in `initialize` and must close it exactly once. */
class ResourceProvider extends BaseProvider {
  readonly id = 'test.resource';
  readonly kind = ProviderKind.SOURCE;
  readonly capabilities = CAPABILITIES;

  /** Every resource ever opened, in order. */
  readonly opened: number[] = [];
  readonly closed: number[] = [];
  initializeCalls = 0;
  shutdownCalls = 0;

  #next = 0;
  readonly #barrier: Promise<unknown> | undefined;
  readonly #failWith: Error | undefined;

  constructor(options: { barrier?: Promise<unknown>; failWith?: Error } = {}) {
    super();
    this.#barrier = options.barrier;
    this.#failWith = options.failWith;
  }

  protected override async onInitialize(): Promise<void> {
    this.initializeCalls += 1;
    const handle = (this.#next += 1);
    if (this.#barrier !== undefined) await this.#barrier;
    if (this.#failWith !== undefined) throw this.#failWith;
    this.opened.push(handle);
  }

  protected override onShutdown(): void {
    this.shutdownCalls += 1;
    for (const handle of this.opened) this.closed.push(handle);
  }

  get leaked(): number[] {
    return this.opened.filter((handle) => !this.closed.includes(handle));
  }
}

describe('BaseProvider under concurrent lifecycle calls', () => {
  it('initializes exactly once when several callers race', async () => {
    // A provider that opens a connection pool in `initialize` and is
    // initialized twice has two pools, and nothing will ever close the second.
    const barrier = createBarrier();
    const provider = new ResourceProvider({ barrier: barrier.promise });
    const context = createTestProviderContext();

    const callers = Array.from({ length: 32 }, () => provider.initialize(context));
    barrier.release();
    await Promise.all(callers);

    expect(provider.initializeCalls).toBe(1);
    expect(provider.state).toBe(ProviderState.READY);
  });

  it('gives every racing caller the same failure, and stays retryable', async () => {
    const barrier = createBarrier();
    const failing = new ResourceProvider({
      barrier: barrier.promise,
      failWith: new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'database is starting up', {
        retryable: true,
      }),
    });

    const callers = Array.from({ length: 16 }, () =>
      failing.initialize(createTestProviderContext()).then(
        () => 'resolved',
        (error: unknown) => (error instanceof FerretError ? error.code : 'other'),
      ),
    );
    barrier.release();

    const outcomes = await Promise.all(callers);
    expect(new Set(outcomes)).toStrictEqual(new Set([ErrorCode.STORAGE_UNAVAILABLE]));
    expect(failing.initializeCalls).toBe(1);
    // The trap in the obvious fix for the race: caching the promise caches the
    // rejection, and a provider that failed because the database was briefly
    // down could never succeed again without a process restart.
    expect(failing.state).toBe(ProviderState.CREATED);
  });

  it('does not leak what initialization created when shutdown races it', async () => {
    // The dangerous ordering. Shutdown arrives while `initialize` is still
    // running, tears down what does not exist yet, reports success — and the
    // connection opened a moment later is never closed by anyone.
    const barrier = createBarrier();
    const provider = new ResourceProvider({ barrier: barrier.promise });

    const initializing = provider.initialize(createTestProviderContext());
    const stopping = provider.shutdown();

    barrier.release();
    await Promise.all([initializing, stopping]);

    expect(provider.opened).toHaveLength(1);
    expect(provider.leaked).toStrictEqual([]);
    expect(provider.state).toBe(ProviderState.STOPPED);
  });

  it('does not treat a failed initialization as a shutdown failure', async () => {
    const barrier = createBarrier();
    const provider = new ResourceProvider({
      barrier: barrier.promise,
      failWith: new FerretError(ErrorCode.CONFIG_MISSING, 'no password'),
    });

    const initializing = provider.initialize(createTestProviderContext()).catch(() => 'failed');
    const stopping = provider.shutdown();
    barrier.release();

    // The caller of `initialize` still gets the error; shutdown succeeds, since
    // failing to start is not failing to stop.
    await expect(initializing).resolves.toBe('failed');
    await expect(stopping).resolves.toBeUndefined();
    expect(provider.state).toBe(ProviderState.STOPPED);
  });

  it('shuts down exactly once when several callers race', async () => {
    const provider = new ResourceProvider();
    await provider.initialize(createTestProviderContext());

    await Promise.all(Array.from({ length: 32 }, () => provider.shutdown()));
    expect(provider.shutdownCalls).toBe(1);
  });

  it('refuses an initialization that arrives during shutdown', async () => {
    const barrier = createBarrier();
    const provider = new ResourceProvider({ barrier: barrier.promise });
    const initializing = provider.initialize(createTestProviderContext());
    const stopping = provider.shutdown();

    const late = provider.initialize(createTestProviderContext()).then(
      () => 'resolved',
      (error: unknown) => (error instanceof FerretError ? error.code : 'other'),
    );

    barrier.release();
    await Promise.all([initializing, stopping]);
    // Reviving a provider that is being torn down would resurrect it halfway
    // through its own teardown. Constructing a new instance is the only sane
    // answer, and saying so is better than silently doing something else.
    await expect(late).resolves.toBe(ErrorCode.LIFECYCLE_INVALID_STATE);
  });

  it('survives a storm of interleaved starts and stops', async () => {
    // Not a scenario anyone designs; it is what a signal arriving during
    // startup, twice, actually looks like.
    for (let round = 0; round < 25; round += 1) {
      const provider = new ResourceProvider();
      const context = createTestProviderContext();
      const operations: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i += 1) {
        operations.push(provider.initialize(context).catch(() => undefined));
        operations.push(provider.shutdown().catch(() => undefined));
      }
      await Promise.all(operations);

      expect(provider.state).toBe(ProviderState.STOPPED);
      expect(provider.leaked).toStrictEqual([]);
      expect(provider.shutdownCalls).toBeLessThanOrEqual(1);
    }
  });
});

describe('rate limiter under contention', () => {
  const never = new AbortController().signal;

  it('never exceeds its rate, however many callers arrive at once', async () => {
    // 6,000/minute is 100/second. With a burst of 10, sixty acquisitions cannot
    // finish sooner than 500ms however they are scheduled.
    const limiter = new RateLimiter({ perMinute: 6_000, burst: 10 });
    const started = performance.now();

    await Promise.all(Array.from({ length: 60 }, () => limiter.acquire(never)));
    const elapsed = performance.now() - started;

    expect(limiter.stats.granted).toBe(60);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });

  it('serves waiters in arrival order', async () => {
    const limiter = new RateLimiter({ perMinute: 12_000, burst: 1 });
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        limiter.acquire(never).then(() => {
          order.push(index);
        }),
      ),
    );

    // Letting a cheap request overtake is how a large one waits forever behind
    // an endless stream of small ones — a starvation bug that only shows under
    // sustained load, which is when nobody is watching.
    expect(order).toStrictEqual(Array.from({ length: 40 }, (_unused, index) => index));
  });

  it('does not stall the queue when the waiter at its head gives up', async () => {
    // The defect this class exists to prevent. Rejecting the abandoned waiter
    // and returning leaves the drain scheduled for a moment computed from a
    // head that has since departed, and everything behind it waits for a timer
    // that was set for someone else. It looks like a hang, and it is
    // intermittent.
    const limiter = new RateLimiter({ perMinute: 600, burst: 1 });
    await limiter.acquire(never);

    const abandoned = new AbortController();
    const head = limiter.acquire(abandoned.signal).catch((error: unknown) =>
      error instanceof FerretError ? error.code : 'other',
    );
    const behind = Array.from({ length: 5 }, () => limiter.acquire(never));

    abandoned.abort();
    await expect(head).resolves.toBe(ErrorCode.INTERRUPTED);

    const started = performance.now();
    await Promise.all(behind);
    // 600/minute is 10/second, so five tokens is roughly half a second. What is
    // being asserted is that it is not *unbounded*.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(limiter.stats.waiting).toBe(0);
  });

  it('loses no budget to waiters that gave up', async () => {
    const limiter = new RateLimiter({ perMinute: 6_000, burst: 1 });
    await limiter.acquire(never);

    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const abandoned = controllers.map((controller) =>
      limiter.acquire(controller.signal).then(
        () => 'granted',
        () => 'abandoned',
      ),
    );
    const survivors = Array.from({ length: 5 }, () => limiter.acquire(never));

    for (const controller of controllers) controller.abort();

    expect(await Promise.all(abandoned)).toStrictEqual(Array.from({ length: 20 }, () => 'abandoned'));
    await Promise.all(survivors);

    // A waiter that gave up must not have consumed a token on its way out.
    expect(limiter.stats.granted).toBe(6);
    expect(limiter.stats.waiting).toBe(0);
  });

  it('does not starve an expensive request behind a stream of cheap ones', async () => {
    const limiter = new RateLimiter({ perMinute: 30_000, burst: 8 });
    await limiter.acquire(never, 8);

    let expensiveDone = false;
    const expensive = limiter.acquire(never, 8).then(() => {
      expensiveDone = true;
    });

    // Two hundred one-token requests arriving behind it. Under a bucket that
    // lets whatever fits go first, the expensive one never runs.
    const cheap: Promise<void>[] = [];
    for (let i = 0; i < 200; i += 1) cheap.push(limiter.acquire(never, 1));

    await expensive;
    expect(expensiveDone).toBe(true);
    await Promise.all(cheap);
  });

  it('leaves nothing waiting and no listener attached after a wholesale cancel', async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
    await limiter.acquire(never);

    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;
    const queued = Array.from({ length: 50 }, () =>
      limiter.acquire(controller.signal).catch(() => 'cancelled'),
    );

    limiter.cancelAll('provider shutdown');
    expect(await Promise.all(queued)).toStrictEqual(Array.from({ length: 50 }, () => 'cancelled'));
    expect(limiter.stats.waiting).toBe(0);
    // A cancelled waiter that leaves its abort listener behind leaks one per
    // request, on a signal that lives as long as the process.
    expect(getEventListeners(controller.signal, 'abort').length).toBe(before);
  });

  it('detaches the abort listener of every waiter it serves', async () => {
    const limiter = new RateLimiter({ perMinute: 60_000, burst: 1 });
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, 'abort').length;

    await Promise.all(Array.from({ length: 200 }, () => limiter.acquire(controller.signal)));

    expect(getEventListeners(controller.signal, 'abort').length).toBe(before);
  });
});

describe('durability', () => {
  it('leaks no listener across many derived signals', () => {
    // The shape a real index has: one long-lived shutdown signal, one derived
    // signal per file. At eleven Node prints a warning; at a million the
    // process is holding a million closures over work that finished long ago.
    const root = new AbortController();
    const before = getEventListeners(root.signal, 'abort').length;

    for (let i = 0; i < 50_000; i += 1) {
      const derived = linkSignals(root.signal, new AbortController().signal);
      derived.dispose();
    }

    expect(getEventListeners(root.signal, 'abort').length).toBe(before);
  });

  it('leaks no listener across many deadlines', () => {
    const root = new AbortController();
    const before = getEventListeners(root.signal, 'abort').length;

    for (let i = 0; i < 20_000; i += 1) {
      const derived = withDeadline(root.signal, 3_600_000, 'operation');
      derived.dispose();
    }

    expect(getEventListeners(root.signal, 'abort').length).toBe(before);
  });

  it('leaves no timer behind when a delay is cancelled', async () => {
    // A backoff interrupted by Ctrl-C must not keep `ferret index` alive for
    // the remaining thirty seconds. Counting live handles is the only way to
    // see the difference between "rejected" and "rejected and cleaned up".
    const baseline = countTimers();
    const controller = new AbortController();

    const sleeping = Array.from({ length: 5_000 }, () =>
      abortableDelay(60_000, controller.signal, 'backoff').catch(() => undefined),
    );
    controller.abort();
    await Promise.all(sleeping);

    expect(countTimers()).toBeLessThanOrEqual(baseline + 2);
  });

  it('cancels quickly rather than waiting out the delay', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const sleeping = Array.from({ length: 1_000 }, () =>
      abortableDelay(120_000, controller.signal, 'backoff').catch(() => undefined),
    );
    controller.abort();
    await Promise.all(sleeping);

    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('reliability', () => {
  it('converges against a dependency that fails most of the time', async () => {
    // Not a smooth failure and not a clean one: a dependency that is up, mostly,
    // and refuses seven times in ten. Every operation must still complete.
    //
    // Each operation carries its *own* pseudo-random stream, seeded from its
    // index. A shared generator would make the outcome depend on the order two
    // hundred concurrent retries happen to interleave in, and a reliability
    // test that is itself unreliable teaches nobody anything. Seeded this way
    // the run is identical every time, and thirty attempts against a 70%
    // failure rate leaves a residual probability around 1 in 44,000 per
    // operation — a budget, not a coin toss.
    const stream = (index: number): (() => number) => {
      let seed = (index + 1) * 2654435761;
      return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
    };

    const signal = new AbortController().signal;
    const results = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) => {
        const random = stream(index);
        return retry(
          () =>
            random() < 0.7
              ? Promise.reject(new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'reset', { retryable: true }))
              : Promise.resolve(index),
          signal,
          'read',
          { maxAttempts: 30, initialDelayMs: 1, maxDelayMs: 4, jitter: 'none' },
        );
      }),
    );

    expect(results).toHaveLength(200);
    expect(new Set(results).size).toBe(200);
  });

  it('gives up on a dependency that is genuinely down, rather than never', async () => {
    const signal = new AbortController().signal;
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        retry(
          () => Promise.reject(new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'down', { retryable: true })),
          signal,
          'read',
          { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 2, jitter: 'none' },
        ).catch((error: unknown) => (error instanceof FerretError ? error.code : 'other')),
      ),
    );
    expect(new Set(outcomes)).toStrictEqual(new Set([ErrorCode.STORAGE_UNAVAILABLE]));
  });

  it('abandons every in-flight retry the moment the runtime stops', async () => {
    const controller = new AbortController();
    const started = performance.now();

    const pending = Array.from({ length: 500 }, () =>
      retry(
        () => Promise.reject(new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'down', { retryable: true })),
        controller.signal,
        'read',
        { maxAttempts: 50, initialDelayMs: 30_000, jitter: 'none' },
      ).catch((error: unknown) => (error instanceof FerretError ? error.code : 'other')),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    expect(new Set(await Promise.all(pending))).toStrictEqual(new Set([ErrorCode.INTERRUPTED]));
    // Five hundred retries each sleeping thirty seconds. If cancellation did
    // not reach into the backoff, this would take four hours.
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('deduplicates correctly when producers interleave', async () => {
    // Two async producers walking overlapping history, which is what a commit
    // walk and its parent walk actually do.
    const batch = new BatchEmitter({
      sourceSystem: 'git',
      producer: 'ferret.source.git',
      producerVersion: '1.0.0',
    });

    const producer = async (offset: number): Promise<void> => {
      for (let i = 0; i < 500; i += 1) {
        batch.entity({
          kind: 'repository',
          source: { id: `repo-${String((i + offset) % 500)}` },
          attributes: { name: `repo-${String((i + offset) % 500)}` },
        });
        if (i % 50 === 0) await Promise.resolve();
      }
    };

    await Promise.all([producer(0), producer(250), producer(125)]);

    expect(batch.counts.entities).toBe(500);
    expect(batch.counts.duplicates).toBe(1_000);
  });
});

describe('performance', () => {
  it('emits an entity with its evidence within budget', () => {
    const batch = new BatchEmitter({
      sourceSystem: 'git',
      producer: 'ferret.source.git',
      producerVersion: '1.0.0',
    });

    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      const entity = batch.entity({
        kind: 'file',
        source: { id: `src/file-${String(i)}.ts`, scope: 'repo' },
        attributes: { path: `src/file-${String(i)}.ts` },
      });
      batch.about(entity, 'attributes.path', `src/file-${String(i)}.ts`);
    }
    const elapsed = performance.now() - started;

    expect(batch.counts.entities).toBe(10_000);
    // Emission is on the ingestion hot path: this is 20,000 validations and
    // 40,000 SHA-256 digests. The ceiling is set well above the observed figure
    // so it catches an order-of-magnitude regression rather than CI weather.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('round-trips a cursor within budget', () => {
    const asOffset = (state: unknown): { offset: number } => state as { offset: number };
    const started = performance.now();

    for (let i = 0; i < 100_000; i += 1) {
      const cursor = encodeCursor('ferret.source.git', Capability.SOURCE_REPOSITORY, { offset: i });
      decodeCursor('ferret.source.git', Capability.SOURCE_REPOSITORY, cursor, asOffset);
    }

    // Every page of every enumeration pays this twice. The validation added for
    // security — length, alphabet, envelope, forbidden keys — is the part worth
    // holding to a ceiling, since it is easy to make it walk something large.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('grants an uncontended token within budget', async () => {
    const limiter = new RateLimiter({ perMinute: 60_000_000, burst: 200_000 });
    const signal = new AbortController().signal;
    const started = performance.now();

    for (let i = 0; i < 100_000; i += 1) await limiter.acquire(signal);

    // The uncontended path must not allocate a promise and a linked-list node
    // per call; every provider request pays it.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

/** Live timer handles, so a "cleaned up" claim can be checked rather than asserted. */
function countTimers(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;
}
