import { getEventListeners } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  BaseProvider,
  BatchEmitter,
  Capability,
  Emitter,
  ErrorCode,
  FerretError,
  MAX_CURSOR_LENGTH,
  ProviderKind,
  ProviderState,
  RateLimiter,
  abortableDelay,
  decodeCursor,
  encodeCursor,
  linkSignals,
  nextDelayMs,
  paginate,
  retry,
  throwIfAborted,
  withDeadline,
  type CapabilityDeclaration,
  type Page,
  type ProviderContext,
} from '../../src/index.js';
import {
  CapturingLogger,
  createTestOperationContext,
  createTestProviderContext,
} from '../../src/providers/sdk/testing.js';

const IDENTITY = { sourceSystem: 'git', producer: 'ferret.source.git', producerVersion: '1.0.0' };

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof FerretError ? error.code : `not-a-ferret-error:${String(error)}`;
  }
  return 'did-not-throw';
}

async function asyncCodeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof FerretError ? error.code : `not-a-ferret-error:${String(error)}`;
  }
  return 'did-not-throw';
}

describe('cancellation helpers', () => {
  it('stops at a checkpoint once cancellation is requested', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal, 'walk')).not.toThrow();
    controller.abort();
    expect(codeOf(() => throwIfAborted(controller.signal, 'walk'))).toBe(ErrorCode.INTERRUPTED);
  });

  it('returns a single source signal unwrapped rather than allocating', () => {
    const controller = new AbortController();
    const derived = linkSignals(controller.signal);
    // The common case is "derive from the one signal I was given". Wrapping it
    // would add a listener per unit of work for no benefit at all.
    expect(derived.signal).toBe(controller.signal);
  });

  it('aborts when the first of several sources does, carrying the reason', () => {
    const first = new AbortController();
    const second = new AbortController();
    const derived = linkSignals(first.signal, second.signal);

    expect(derived.signal.aborted).toBe(false);
    second.abort('shutdown');
    expect(derived.signal.aborted).toBe(true);
    expect(derived.signal.reason).toBe('shutdown');
    derived.dispose();
  });

  it('is already aborted when a source was aborted before linking', () => {
    const first = new AbortController();
    first.abort('too late');
    const derived = linkSignals(first.signal, new AbortController().signal);
    expect(derived.signal.aborted).toBe(true);
    expect(derived.signal.reason).toBe('too late');
  });

  it('removes every listener it added when disposed', () => {
    const root = new AbortController();
    const other = new AbortController();
    const before = countAbortListeners(root.signal);

    const derived = linkSignals(root.signal, other.signal);
    expect(countAbortListeners(root.signal)).toBe(before + 1);

    derived.dispose();
    expect(countAbortListeners(root.signal)).toBe(before);
  });

  it('releases its listeners once it has aborted, without waiting for disposal', () => {
    const root = new AbortController();
    const other = new AbortController();
    const before = countAbortListeners(root.signal);

    linkSignals(root.signal, other.signal);
    other.abort();

    // Nothing will ever fire again, so holding the listener would be a leak
    // that no `dispose` call is coming to clean up.
    expect(countAbortListeners(root.signal)).toBe(before);
  });

  it('is disposable with `using`, so the listener cannot be forgotten', () => {
    const root = new AbortController();
    const before = countAbortListeners(root.signal);
    {
      using derived = linkSignals(root.signal, new AbortController().signal);
      expect(derived.signal.aborted).toBe(false);
      expect(countAbortListeners(root.signal)).toBe(before + 1);
    }
    expect(countAbortListeners(root.signal)).toBe(before);
  });

  it('aborts on a deadline with a classified reason', async () => {
    const root = new AbortController();
    const derived = withDeadline(root.signal, 10, 'fetch');
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(derived.signal.aborted).toBe(true);
    const reason: unknown = derived.signal.reason;
    expect(reason).toBeInstanceOf(FerretError);
    expect((reason as FerretError).code).toBe(ErrorCode.INTERRUPTED);
    expect((reason as FerretError).message).toContain('10ms deadline');
    derived.dispose();
  });

  it('cancels the deadline timer when the work finishes first', () => {
    const root = new AbortController();
    const before = countAbortListeners(root.signal);
    const derived = withDeadline(root.signal, 3_600_000, 'index');
    derived.dispose();

    // An hour-long deadline for work that took a second must not keep a timer
    // and a composite signal alive for the remaining fifty-nine minutes.
    expect(countAbortListeners(root.signal)).toBe(before);
  });

  it('refuses a deadline that is not a positive duration', () => {
    const signal = new AbortController().signal;
    expect(codeOf(() => withDeadline(signal, 0, 'index'))).toBe(ErrorCode.USAGE);
    expect(codeOf(() => withDeadline(signal, Number.NaN, 'index'))).toBe(ErrorCode.USAGE);
  });

  it('sleeps, and stops sleeping when cancelled', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const sleep = abortableDelay(30_000, controller.signal, 'backoff');
    setTimeout(() => controller.abort(), 10);

    expect(await asyncCodeOf(() => sleep)).toBe(ErrorCode.INTERRUPTED);
    // Not "it eventually rejected" — that a thirty-second sleep did not take
    // thirty seconds is the entire property.
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('checks cancellation even for a zero-length delay', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await asyncCodeOf(() => abortableDelay(0, controller.signal, 'backoff'))).toBe(
      ErrorCode.INTERRUPTED,
    );
  });
});

describe('retry', () => {
  const never = new AbortController().signal;
  const noJitter = { jitter: 'none' as const, initialDelayMs: 1, maxAttempts: 5 };

  function transient(message = 'connection reset'): FerretError {
    return new FerretError(ErrorCode.STORAGE_UNAVAILABLE, message, { retryable: true });
  }

  it('returns the first success without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(retry(operation, never, 'read', noJitter)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure until it succeeds', async () => {
    let attempts = 0;
    const value = await retry(
      () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(transient());
        return Promise.resolve(attempts);
      },
      never,
      'read',
      noJitter,
    );
    expect(value).toBe(3);
  });

  it('never retries an error the taxonomy says is not worth retrying', async () => {
    // The direction that matters most: hammering a permission denial looks to
    // an operator like a hang rather than a refusal, and the system on the
    // other end will never say yes.
    const operation = vi.fn().mockRejectedValue(
      new FerretError(ErrorCode.STORAGE_PERMISSION_DENIED, 'permission denied for table entity'),
    );
    expect(await asyncCodeOf(() => retry(operation, never, 'read', noJitter))).toBe(
      ErrorCode.STORAGE_PERMISSION_DENIED,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt budget and reports the last failure', async () => {
    const operation = vi.fn().mockRejectedValue(transient('still down'));
    expect(await asyncCodeOf(() => retry(operation, never, 'read', noJitter))).toBe(
      ErrorCode.STORAGE_UNAVAILABLE,
    );
    expect(operation).toHaveBeenCalledTimes(5);
  });

  it('classifies an unclassified throw rather than letting it escape raw', async () => {
    const error = await retry(() => Promise.reject(new TypeError('x is not a function')), never, 'read', {
      ...noJitter,
      maxAttempts: 1,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FerretError);
    expect((error as FerretError).code).toBe(ErrorCode.UNKNOWN);
  });

  it('tells the operation which attempt it is on', async () => {
    const seen: number[] = [];
    await retry(
      (attempt) => {
        seen.push(attempt);
        return attempt < 3 ? Promise.reject(transient()) : Promise.resolve(attempt);
      },
      never,
      'read',
      noJitter,
    );
    expect(seen).toStrictEqual([1, 2, 3]);
  });

  it('stops immediately when cancelled mid-backoff', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(transient());
    const started = performance.now();

    const pending = retry(operation, controller.signal, 'read', {
      maxAttempts: 10,
      initialDelayMs: 10_000,
      jitter: 'none',
    });
    setTimeout(() => controller.abort(), 10);

    expect(await asyncCodeOf(() => pending)).toBe(ErrorCode.INTERRUPTED);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not mistake the operation cancelling itself for a transient failure', async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockImplementation(() => {
      controller.abort();
      throwIfAborted(controller.signal, 'read');
      return Promise.resolve();
    });
    expect(await asyncCodeOf(() => retry(operation, controller.signal, 'read', noJitter))).toBe(
      ErrorCode.INTERRUPTED,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();
    expect(await asyncCodeOf(() => retry(operation, controller.signal, 'read', noJitter))).toBe(
      ErrorCode.INTERRUPTED,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('rejects an attempt budget below one rather than looping', async () => {
    expect(
      await asyncCodeOf(() => retry(() => Promise.resolve(1), never, 'read', { maxAttempts: 0 })),
    ).toBe(ErrorCode.USAGE);
  });

  it('grows the delay geometrically and clamps it', () => {
    const error = transient();
    const options = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 500, jitter: 'none' as const };
    expect(nextDelayMs(1, error, options)).toBe(100);
    expect(nextDelayMs(2, error, options)).toBe(200);
    expect(nextDelayMs(3, error, options)).toBe(400);
    expect(nextDelayMs(4, error, options)).toBe(500);
    expect(nextDelayMs(9, error, options)).toBe(500);
  });

  it('samples within the backoff window when jittering', () => {
    const error = transient();
    const options = { initialDelayMs: 100, multiplier: 2, maxDelayMs: 10_000 };
    for (const random of [0, 0.25, 0.5, 0.999]) {
      const delay = nextDelayMs(3, error, { ...options, random: () => random });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(400);
    }
    // Without jitter, twenty workers that failed together retry together, and
    // keep doing so. The whole point is that they do not agree.
    expect(nextDelayMs(3, error, { ...options, random: () => 0.1 })).not.toBe(
      nextDelayMs(3, error, { ...options, random: () => 0.9 }),
    );
  });

  it('obeys an upstream that says when to come back, within the ceiling', () => {
    const advertised = new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'slow down', {
      retryable: true,
      details: { retryAfterMs: 5_000 },
    });
    expect(nextDelayMs(1, advertised, { initialDelayMs: 10, maxDelayMs: 60_000 })).toBe(5_000);
    // The value came from a system Ferret does not control, so it is clamped.
    expect(nextDelayMs(1, advertised, { initialDelayMs: 10, maxDelayMs: 1_000 })).toBe(1_000);
  });

  it('logs the error class on each retry and never the arguments', async () => {
    const logger = new CapturingLogger();
    const secret = 'hunter2';
    await retry(
      () =>
        Promise.reject(
          new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'connection failed', { retryable: true }),
        ),
      never,
      `connect(password=${secret})`,
      { ...noJitter, maxAttempts: 2, logger },
    ).catch(() => undefined);

    const debug = logger.at('debug');
    expect(debug).toHaveLength(1);
    expect(debug[0]?.fields['code']).toBe(ErrorCode.STORAGE_UNAVAILABLE);
    // A retried request may carry a credential in the name it was given — the
    // natural name is built from the thing being called — and this is the line
    // that would print it on every single attempt. The capturing logger does
    // not redact, so this asserts the module's own guarantee rather than the
    // one it inherits from the production logger.
    expect(JSON.stringify(debug[0]?.fields)).not.toContain(secret);
  });

  it('lets a provider override the retryability decision', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new FerretError(ErrorCode.UNKNOWN, 'HTTP 503'))
      .mockResolvedValue('ok');
    await expect(
      retry(operation, never, 'fetch', {
        ...noJitter,
        isRetryable: (error) => error.message.includes('503'),
      }),
    ).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe('cursors', () => {
  const PROVIDER = 'ferret.source.git';
  const asOffset = (state: unknown): { offset: number } => {
    if (typeof state !== 'object' || state === null || typeof (state as { offset?: unknown }).offset !== 'number') {
      throw new Error('not an offset');
    }
    return state as { offset: number };
  };

  it('round-trips a position', () => {
    const cursor = encodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, { offset: 42 });
    expect(decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, cursor, asOffset)).toStrictEqual({
      offset: 42,
    });
  });

  it('refuses a cursor issued by a different provider', () => {
    // The failure this prevents is silent: an unbound cursor decodes cleanly
    // into a position that means something else, and the enumeration resumes at
    // nonsense without anything going wrong visibly.
    const cursor = encodeCursor('ferret.source.github', Capability.SOURCE_REPOSITORY, { offset: 42 });
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, cursor, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it('refuses a cursor issued for a different capability', () => {
    const cursor = encodeCursor(PROVIDER, Capability.SOURCE_HISTORY, { offset: 42 });
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, cursor, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'not a cursor!'],
    ['base64url of nothing useful', Buffer.from('null', 'utf8').toString('base64url')],
    ['base64url of an array', Buffer.from('[1,2,3]', 'utf8').toString('base64url')],
    ['truncated', encodeCursor('p', Capability.PARSER, { offset: 1 }).slice(0, 6)],
  ])('refuses a cursor that is %s', (_label, cursor) => {
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, cursor, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it('refuses an oversized cursor before decoding it', () => {
    // A cursor holds a position, not a payload. Without a bound, a hostile
    // client makes Ferret base64-decode and JSON-parse an arbitrarily large
    // string on every request, at no cost to itself.
    const oversized = 'A'.repeat(MAX_CURSOR_LENGTH + 1);
    const error = captureError(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, oversized, asOffset));
    expect(error.code).toBe(ErrorCode.CURSOR_INVALID);
    expect(error.details['maximum']).toBe(MAX_CURSOR_LENGTH);
  });

  it('refuses a cursor carrying a prototype-polluting key', () => {
    const hostile = Buffer.from(
      JSON.stringify({ v: 1, p: PROVIDER, c: Capability.SOURCE_REPOSITORY, s: { __proto__: { admin: true } } }),
      'utf8',
    ).toString('base64url');
    // JSON.parse itself is safe here; the danger is downstream, where a
    // provider spreads the decoded position into another object.
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, hostile, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it('refuses a cursor nested more deeply than any position needs', () => {
    let nested: unknown = { end: true };
    for (let i = 0; i < 64; i += 1) nested = { next: nested };
    const deep = Buffer.from(
      JSON.stringify({ v: 1, p: PROVIDER, c: Capability.SOURCE_REPOSITORY, s: nested }),
      'utf8',
    ).toString('base64url');
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, deep, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it('refuses an envelope version this build does not understand', () => {
    const future = Buffer.from(
      JSON.stringify({ v: 2, p: PROVIDER, c: Capability.SOURCE_REPOSITORY, s: {} }),
      'utf8',
    ).toString('base64url');
    expect(codeOf(() => decodeCursor(PROVIDER, Capability.SOURCE_REPOSITORY, future, asOffset))).toBe(
      ErrorCode.CURSOR_INVALID,
    );
  });

  it('never echoes what a rejected cursor contained', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwx';
    const hostile = Buffer.from(`{"v":1,"p":"x","c":"parser","s":"${secret}"` , 'utf8').toString('base64url');
    const error = captureError(() => decodeCursor(PROVIDER, Capability.PARSER, hostile, asOffset));
    expect(JSON.stringify(error.toJSON())).not.toContain(secret);
  });

  it('refuses to encode a position that is not plain data', () => {
    // `JSON.stringify` throws a bare `TypeError` for both of these, which would
    // escape unclassified from a function whose contract is "a Ferret error or
    // it worked".
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(codeOf(() => encodeCursor(PROVIDER, Capability.PARSER, cyclic))).toBe(ErrorCode.USAGE);
    expect(codeOf(() => encodeCursor(PROVIDER, Capability.PARSER, { at: 1n }))).toBe(ErrorCode.USAGE);
  });

  it('refuses to encode a position too large to be a position', () => {
    expect(codeOf(() => encodeCursor(PROVIDER, Capability.PARSER, { blob: 'x'.repeat(8192) }))).toBe(
      ErrorCode.USAGE,
    );
  });
});

describe('paginate', () => {
  const context = createTestOperationContext();

  function pages<T>(...batches: readonly (readonly T[])[]): (request: { cursor?: string }) => Promise<Page<T>> {
    return (request) => {
      const index = request.cursor === undefined ? 0 : Number(request.cursor);
      const items = batches[index] ?? [];
      return Promise.resolve({
        items,
        cursor: index + 1 < batches.length ? String(index + 1) : undefined,
      });
    };
  }

  it('walks every page as one stream', async () => {
    const collected: number[] = [];
    for await (const item of paginate(pages([1, 2], [3], [4, 5]), context)) collected.push(item);
    expect(collected).toStrictEqual([1, 2, 3, 4, 5]);
  });

  it('continues past an empty page that still has a successor', async () => {
    // The classic truncation: a filtered enumeration finds nothing in one
    // window, the caller stops, and the result is silently short.
    const collected: number[] = [];
    for await (const item of paginate(pages([1], [], [2]), context)) collected.push(item);
    expect(collected).toStrictEqual([1, 2]);
  });

  it('resumes from a caller-supplied cursor', async () => {
    const collected: number[] = [];
    for await (const item of paginate(pages([1], [2], [3]), context, { cursor: '2' })) collected.push(item);
    expect(collected).toStrictEqual([3]);
  });

  it('turns a provider that never advances into an error rather than a hang', async () => {
    const stuck = (): Promise<Page<number>> => Promise.resolve({ items: [1], cursor: 'same' });
    expect(
      await asyncCodeOf(async () => {
        for await (const _ of paginate(stuck, context)) void _;
      }),
    ).toBe(ErrorCode.PROVIDER_INVALID);
  });

  it('stops between pages when cancelled', async () => {
    const cancellable = createTestOperationContext();
    let fetched = 0;
    const endless = (): Promise<Page<number>> => {
      fetched += 1;
      if (fetched === 2) cancellable.abort();
      return Promise.resolve({ items: [fetched], cursor: String(fetched) });
    };

    expect(
      await asyncCodeOf(async () => {
        for await (const _ of paginate(endless, cancellable)) void _;
      }),
    ).toBe(ErrorCode.INTERRUPTED);
    expect(fetched).toBe(2);
  });
});

describe('emission', () => {
  const emitter = new Emitter(IDENTITY);

  function repository(id: string): ReturnType<Emitter['entity']> {
    return emitter.entity({ kind: 'repository', source: { id }, attributes: { name: id } });
  }

  it('fills in the source system a provider would otherwise repeat', () => {
    expect(repository('ferret').source.system).toBe('git');
  });

  it('lets a provider override the system when it observed a different one', () => {
    const entity = emitter.entity({
      kind: 'repository',
      source: { id: 'ferret', system: 'github' },
      attributes: { name: 'ferret' },
    });
    expect(entity.source.system).toBe('github');
  });

  it('attaches producer and version to every piece of evidence', () => {
    const evidence = emitter.observed({
      subjectId: repository('ferret').id,
      field: 'attributes.name',
      statement: 'ferret',
    });
    // Governance §21: without this, "re-extract everything the old parser
    // touched" is unanswerable, months later, for whatever one provider emitted.
    expect(evidence.producer).toBe(IDENTITY.producer);
    expect(evidence.producerVersion).toBe(IDENTITY.producerVersion);
    expect(evidence.sourceSystem).toBe('git');
  });

  it('distinguishes what was read from what was concluded', () => {
    const subject = repository('ferret');
    const observed = emitter.observed({ subjectId: subject.id, field: 'a', statement: 1 });
    const inferred = emitter.inferred({
      subjectId: subject.id,
      field: 'b',
      statement: 2,
      derivedFrom: [observed.id],
    });
    expect(observed.method).toBe('observed');
    expect(inferred.method).toBe('inferred');
    expect(inferred.derivedFrom).toStrictEqual([observed.id]);
  });

  it('refuses an inference that names nothing it rests on', () => {
    expect(
      codeOf(() =>
        emitter.inferred({
          subjectId: repository('ferret').id,
          statement: 'guess',
          derivedFrom: [],
        }),
      ),
    ).toBe(ErrorCode.EVIDENCE_INVALID);
  });

  it('links evidence to the entity it is about, so staleness is detectable', () => {
    const subject = repository('ferret');
    const evidence = emitter.about(subject, 'attributes.name', 'ferret');
    expect(evidence.subjectId).toBe(subject.id);
    // Evidence whose recorded source hash no longer matches its subject is
    // exactly what "stale" means, and this is what makes the comparison possible.
    expect(evidence.sourceContentHash).toBe(subject.contentHash);
  });

  it('redacts a secret encountered in source content', () => {
    const subject = repository('ferret');
    const evidence = emitter.observed({
      subjectId: subject.id,
      field: 'file.content',
      statement: { line: 'DATABASE_PASSWORD=hunter2' },
    });
    // Ferret indexes configuration files and will encounter these. Storing one
    // merely because it was seen is EPIC-008's security requirement.
    expect(JSON.stringify(evidence.statement)).not.toContain('hunter2');
    expect(evidence.redacted).toBe(true);
  });

  it('fills in the source system on relationships too', () => {
    const from = repository('a');
    const to = repository('b');
    const relationship = emitter.relationship({
      fromId: from.id,
      type: 'entity_supersedes_entity',
      toId: to.id,
    });
    expect(relationship.sourceSystem).toBe('git');
  });
});

describe('batch emission', () => {
  it('collapses a fact emitted twice into one record', () => {
    // Governance §10: re-ingesting unchanged content is a no-op. A provider that
    // walks a commit and its parent emits the same author twice, and passing
    // both on means two upserts and two chances to interleave badly.
    const batch = new BatchEmitter(IDENTITY);
    const input = {
      kind: 'developer',
      source: { id: 'alice@example.com' },
      attributes: { emails: ['alice@example.com'] },
    };
    const first = batch.entity(input);
    const second = batch.entity(input);

    expect(second.id).toBe(first.id);
    expect(batch.entities).toHaveLength(1);
    expect(batch.counts.duplicates).toBe(1);
  });

  it('keeps entities, relationships and evidence separate', () => {
    const batch = new BatchEmitter(IDENTITY);
    const a = batch.entity({ kind: 'repository', source: { id: 'a' }, attributes: { name: 'a' } });
    const b = batch.entity({ kind: 'repository', source: { id: 'b' }, attributes: { name: 'b' } });
    batch.relationship({ fromId: a.id, type: 'entity_supersedes_entity', toId: b.id });
    batch.about(a, 'attributes.name', 'a');

    expect(batch.counts).toStrictEqual({ entities: 2, relationships: 1, evidence: 1, duplicates: 0 });
    expect(batch.size).toBe(4);
  });

  it('can be emptied and reused', () => {
    const batch = new BatchEmitter(IDENTITY);
    batch.entity({ kind: 'repository', source: { id: 'a' }, attributes: { name: 'a' } });
    batch.clear();
    expect(batch.size).toBe(0);
    expect(batch.counts.duplicates).toBe(0);
  });
});

describe('BaseProvider', () => {
  class Recording extends BaseProvider {
    readonly id = 'test.recording';
    readonly kind = ProviderKind.SOURCE;
    readonly capabilities: readonly CapabilityDeclaration[] = [
      { capability: Capability.SOURCE_REPOSITORY, version: 1 },
    ];

    initialized = 0;
    stopped = 0;
    seenConfig: string | undefined;

    protected override onInitialize(context: ProviderContext): void {
      this.initialized += 1;
      this.seenConfig = context.environment.ferretVersion;
    }

    protected override onShutdown(): void {
      this.stopped += 1;
    }

    readConfig(): string {
      return this.context.environment.ferretVersion;
    }

    log(): void {
      this.logger.info({ operation: 'test' }, 'hello');
    }
  }

  it('moves through the lifecycle and reports where it is', async () => {
    const provider = new Recording();
    expect(provider.state).toBe(ProviderState.CREATED);

    await provider.initialize(createTestProviderContext());
    expect(provider.state).toBe(ProviderState.READY);
    expect(provider.initialized).toBe(1);

    await provider.shutdown();
    expect(provider.state).toBe(ProviderState.STOPPED);
    expect(provider.stopped).toBe(1);
  });

  it('is a no-op when initialized again after it is ready', async () => {
    const provider = new Recording();
    const context = createTestProviderContext();
    await provider.initialize(context);
    await provider.initialize(context);
    expect(provider.initialized).toBe(1);
  });

  it('refuses to be used before it is initialized', () => {
    const provider = new Recording();
    expect(codeOf(() => provider.readConfig())).toBe(ErrorCode.LIFECYCLE_INVALID_STATE);
  });

  it('refuses to be used after it is stopped', async () => {
    const provider = new Recording();
    await provider.initialize(createTestProviderContext());
    await provider.shutdown();
    expect(codeOf(() => provider.readConfig())).toBe(ErrorCode.LIFECYCLE_INVALID_STATE);
  });

  it('refuses to be revived once stopped', async () => {
    const provider = new Recording();
    await provider.initialize(createTestProviderContext());
    await provider.shutdown();
    expect(await asyncCodeOf(() => provider.initialize(createTestProviderContext()))).toBe(
      ErrorCode.LIFECYCLE_INVALID_STATE,
    );
  });

  it('tolerates a shutdown it was never initialized for', async () => {
    const provider = new Recording();
    await expect(provider.shutdown()).resolves.toBeUndefined();
    // Nothing was created, so nothing is released. Calling the hook anyway
    // would make every provider's teardown defensive for no reason.
    expect(provider.stopped).toBe(0);
    expect(provider.state).toBe(ProviderState.STOPPED);
  });

  it('binds its logger to its own identity', async () => {
    const provider = new Recording();
    const context = createTestProviderContext();
    await provider.initialize(context);
    provider.log();
    expect(context.logger.records[0]?.fields['provider']).toBe('test.recording');
  });

  it('preserves a classified initialization failure instead of relabelling it', async () => {
    class Misconfigured extends BaseProvider {
      readonly id = 'test.misconfigured';
      readonly kind = ProviderKind.STORAGE;
      readonly capabilities: readonly CapabilityDeclaration[] = [];
      protected override onInitialize(): void {
        throw new FerretError(ErrorCode.CONFIG_MISSING, 'FERRET_DATABASE_PASSWORD is not set', {
          remediation: 'Set FERRET_DATABASE_PASSWORD.',
        });
      }
    }

    const error = await new Misconfigured().initialize(createTestProviderContext()).then(
      () => undefined,
      (thrown: unknown) => thrown as FerretError,
    );
    expect(error).toBeInstanceOf(FerretError);
    if (error === undefined) throw new Error('unreachable');

    // The mistake EPIC-002 made and this codebase has paid for once already: a
    // generic wrapper turns the one sentence that told the operator what to do
    // into "a provider failed to initialize".
    expect(error.code).toBe(ErrorCode.CONFIG_MISSING);
    expect(error.remediation).toBe('Set FERRET_DATABASE_PASSWORD.');
    expect(error.details['providerId']).toBe('test.misconfigured');
  });

  it('classifies an unclassified initialization failure', async () => {
    class Broken extends BaseProvider {
      readonly id = 'test.broken';
      readonly kind = ProviderKind.STORAGE;
      readonly capabilities: readonly CapabilityDeclaration[] = [];
      protected override onInitialize(): void {
        throw new TypeError('undefined is not a function');
      }
    }
    expect(await asyncCodeOf(() => new Broken().initialize(createTestProviderContext()))).toBe(
      ErrorCode.PROVIDER_INIT_FAILED,
    );
  });

  it('can be initialized again after a failure', async () => {
    // The trap in the obvious fix for concurrent initialization: caching the
    // promise caches the rejection, so a provider that failed because the
    // database was briefly down can never succeed again without a restart.
    let attempts = 0;
    class Flaky extends BaseProvider {
      readonly id = 'test.flaky';
      readonly kind = ProviderKind.STORAGE;
      readonly capabilities: readonly CapabilityDeclaration[] = [];
      protected override onInitialize(): void {
        attempts += 1;
        if (attempts === 1) throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'down', { retryable: true });
      }
    }

    const provider = new Flaky();
    await provider.initialize(createTestProviderContext()).catch(() => undefined);
    expect(provider.state).toBe(ProviderState.CREATED);

    await provider.initialize(createTestProviderContext());
    expect(provider.state).toBe(ProviderState.READY);
    expect(attempts).toBe(2);
  });

  it('defaults to the current contract version', () => {
    expect(new Recording().contractVersion).toBeGreaterThan(0);
  });
});

describe('rate limiter', () => {
  const never = new AbortController().signal;

  it('serves an uncontended request immediately', async () => {
    const limiter = new RateLimiter({ perMinute: 60 });
    const started = performance.now();
    await limiter.acquire(never);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('reports what it has and what it is holding', async () => {
    const limiter = new RateLimiter({ perMinute: 600, burst: 10 });
    await limiter.acquire(never, 4);
    const stats = limiter.stats;
    expect(stats.granted).toBe(1);
    expect(stats.available).toBeLessThanOrEqual(6);
    expect(stats.waiting).toBe(0);
  });

  it('refuses a request larger than the bucket rather than waiting forever', async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 });
    expect(await asyncCodeOf(() => limiter.acquire(never, 3))).toBe(ErrorCode.USAGE);
  });

  it.each([0, -1, Number.NaN])('refuses a cost of %s', async (cost) => {
    const limiter = new RateLimiter({ perMinute: 60 });
    expect(await asyncCodeOf(() => limiter.acquire(never, cost))).toBe(ErrorCode.USAGE);
  });

  it('refuses to exist without a positive rate', () => {
    expect(codeOf(() => new RateLimiter({ perMinute: 0 }))).toBe(ErrorCode.USAGE);
  });

  it('is built from a provider’s declared limits, or not at all', () => {
    expect(RateLimiter.fromLimits({ rateLimitPerMinute: 5000 })).toBeInstanceOf(RateLimiter);
    expect(RateLimiter.fromLimits({ supportsPagination: true })).toBeUndefined();
    expect(RateLimiter.fromLimits(undefined)).toBeUndefined();
  });

  it('refuses immediately when cancellation was already requested', async () => {
    const limiter = new RateLimiter({ perMinute: 60 });
    const controller = new AbortController();
    controller.abort();
    expect(await asyncCodeOf(() => limiter.acquire(controller.signal))).toBe(ErrorCode.INTERRUPTED);
  });

  it('rejects everything queued when it is cancelled wholesale', async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
    await limiter.acquire(never);
    const queued = [limiter.acquire(never), limiter.acquire(never)];
    const settled = Promise.allSettled(queued);
    limiter.cancelAll('provider shutdown');

    const results = await settled;
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(limiter.stats.waiting).toBe(0);
  });
});

/**
 * How many abort listeners a signal is holding.
 *
 * `AbortSignal` is an `EventTarget`, which has no public listener count — and a
 * leak that nothing can count is a leak nothing will notice until it is a
 * warning at eleven and unbounded memory at a million. Node exposes
 * `getEventListeners` for exactly this.
 */
function countAbortListeners(signal: AbortSignal): number {
  return getEventListeners(signal, 'abort').length;
}

function captureError(run: () => unknown): FerretError {
  try {
    run();
  } catch (error) {
    if (error instanceof FerretError) return error;
    throw error;
  }
  throw new Error('expected a FerretError');
}
