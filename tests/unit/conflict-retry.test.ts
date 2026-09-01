import { describe, expect, it } from 'vitest';

import {
  CONFLICT_MAX_ATTEMPTS,
  CONFLICT_MAX_DELAY_MS,
  classifyDatabaseError,
  isTransientConflict,
  withConflictRetry,
} from '../../src/storage/index.js';
import { ErrorCode } from '../../src/index.js';

/**
 * EPIC-079 — a transient failure costs a retry, not a run.
 *
 * The classification is the whole Epic. Retrying is easy and EPIC-012 already
 * did it; deciding *what* is worth retrying is the part no library can answer,
 * and getting it wrong is expensive in both directions — a retried permission
 * error hammers a system that will never say yes, and an unretried conflict
 * fails a run over something that resolved milliseconds later.
 */

/** A `pg` error, as the driver actually shapes it. */
function pgError(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('classifying a transaction conflict — AC-1', () => {
  it.each([
    ['40001', 'serialization_failure'],
    ['40P01', 'deadlock_detected'],
  ])('treats %s (%s) as a retryable conflict', (code) => {
    const error = classifyDatabaseError(pgError(code), 'storage.entity.upsert');

    expect(error.code).toBe(ErrorCode.STORAGE_CONFLICT);
    expect(error.retryable).toBe(true);
    expect(error.details['sqlstate']).toBe(code);
  });

  it('does not call the database unavailable when it is merely contended', () => {
    // The database is entirely available. A caller that logs "PostgreSQL is
    // unavailable" for a contended row sends an operator to look at the wrong
    // thing, which is why this has its own code rather than reusing one.
    const error = classifyDatabaseError(pgError('40001'), 'storage.entity.upsert');
    expect(error.code).not.toBe(ErrorCode.STORAGE_UNAVAILABLE);
    expect(error.message).toContain('concurrent transaction');
  });

  it.each([
    ['42501', ErrorCode.STORAGE_PERMISSION_DENIED],
    ['28P01', ErrorCode.STORAGE_PERMISSION_DENIED],
    ['3D000', ErrorCode.STORAGE_UNAVAILABLE],
  ])('leaves %s classified as it was — AC-2', (code, expected) => {
    // The other direction of the same judgement. Widening "retryable" until it
    // covers a credential failure is how a denial becomes a hang.
    const error = classifyDatabaseError(pgError(code), 'storage.entity.upsert');
    expect(error.code).toBe(expected);
    expect(error.retryable).toBe(false);
  });

  it('recognises a conflict from the raw driver error too', () => {
    expect(isTransientConflict(pgError('40001'))).toBe(true);
    expect(isTransientConflict(pgError('40P01'))).toBe(true);
    expect(isTransientConflict(pgError('23505'))).toBe(true);
    expect(isTransientConflict(pgError('42501'))).toBe(false);
    expect(isTransientConflict(new Error('no code'))).toBe(false);
  });

  it('treats 23505 as retryable — corrected by evidence', () => {
    // This assertion previously read `toBe(false)`, with the reasoning that a
    // unique violation cannot arise under `ON CONFLICT` and outside it is a
    // genuine constraint failure a retry would only repeat.
    //
    // The first half was wrong. CI produced 23505 from
    // `insert ... on conflict ("id") do update` on a documentation-only pull
    // request (#65): `ferret.entity` has a second unique index on
    // `canonical_key`, and `ON CONFLICT` arbitrates the named index only. Both
    // collide at once because the id is derived from the canonical key, so
    // which one the executor detects first is a race — and detecting the
    // non-arbiter one raises this instead of updating.
    //
    // The second half still holds, and is why the next test exists: retrying a
    // real duplicate repeats it. `withConflictRetry` bounds the attempts, so the
    // cost of being wrong is a few wasted tries and then the same error.
    // Changed because measurement disproved the reasoning, not to make anything
    // pass. Issue #55.
    expect(classifyDatabaseError(pgError('23505'), 'op').retryable).toBe(true);
  });

  it('still gives up on a duplicate that is genuinely a duplicate', async () => {
    // The bound that makes the trade above acceptable. A 23505 that is not a
    // race is retried a few times and then surfaces unchanged, rather than
    // looping — which is the failure mode the original reasoning was guarding
    // against and which still must not happen.
    let attempts = 0;
    await expect(
      withConflictRetry(
        () => {
          attempts += 1;
          return Promise.reject(classifyDatabaseError(pgError('23505'), 'test.op'));
        },
        { label: 'test.op', random: (): number => 0 },
      ),
    ).rejects.toMatchObject({ details: { sqlstate: '23505' } });

    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(5);
  });
});

describe('retrying the transaction — AC-3, AC-5, AC-6', () => {
  const immediate = { label: 'test.op', random: (): number => 0 };

  it('retries a conflict and returns the eventual success', async () => {
    let attempts = 0;
    const result = await withConflictRetry(() => {
      attempts += 1;
      if (attempts < 3) throw classifyDatabaseError(pgError('40001'), 'test.op');
      return Promise.resolve('committed');
    }, immediate);

    expect(result).toBe('committed');
    expect(attempts).toBe(3);
  });

  it('calls the operation again from the beginning — AC-4', async () => {
    // A serialization failure aborts the whole transaction, so a retry that
    // reused it would fail with `25P02` for a reason unrelated to the conflict.
    // The operation is a function that opens its own transaction, and this is
    // what proves it is re-entered rather than resumed.
    const opened: number[] = [];
    let attempts = 0;
    await withConflictRetry(() => {
      attempts += 1;
      opened.push(attempts);
      if (attempts < 2) throw classifyDatabaseError(pgError('40P01'), 'test.op');
      return Promise.resolve(undefined);
    }, immediate);

    expect(opened).toStrictEqual([1, 2]);
  });

  it('does not retry something that is not a conflict — AC-6', async () => {
    let attempts = 0;
    await expect(
      withConflictRetry(() => {
        attempts += 1;
        return Promise.reject(classifyDatabaseError(pgError('42501'), 'test.op'));
      }, immediate),
    ).rejects.toMatchObject({ code: ErrorCode.STORAGE_PERMISSION_DENIED });

    expect(attempts).toBe(1);
  });

  it('does not retry a dropped connection, though it is retryable', async () => {
    // Broader than `error.retryable`, and narrower on purpose: the pool has
    // already lost the session the transaction lived in, so re-running it here
    // retries against a connection that is gone. Reconnection is the pool's job.
    let attempts = 0;
    await expect(
      withConflictRetry(() => {
        attempts += 1;
        return Promise.reject(classifyDatabaseError(pgError('08006'), 'test.op'));
      }, immediate),
    ).rejects.toMatchObject({ code: ErrorCode.STORAGE_UNAVAILABLE });

    expect(attempts).toBe(1);
  });

  it('gives up after a bounded number of attempts — AC-5', async () => {
    let attempts = 0;
    await expect(
      withConflictRetry(() => {
        attempts += 1;
        return Promise.reject(classifyDatabaseError(pgError('40001'), 'test.op'));
      }, immediate),
    ).rejects.toMatchObject({ code: ErrorCode.STORAGE_CONFLICT });

    expect(attempts).toBe(CONFLICT_MAX_ATTEMPTS);
  });

  it('costs one call on the uncontended path — AC-9, §13', async () => {
    let attempts = 0;
    const result = await withConflictRetry(() => {
      attempts += 1;
      return Promise.resolve('first time');
    }, immediate);

    expect(result).toBe('first time');
    expect(attempts).toBe(1);
  });

  it('stops immediately when cancelled — AC-7', async () => {
    // Without waiting out a backoff. A run that was told to stop must stop, not
    // finish its arithmetic first — so what is asserted is the attempt count.
    //
    // The error is the operation's own, not a generic `E_INTERRUPTED`: `retry`
    // rethrows what actually failed when the signal is aborted. That is the more
    // useful of the two — an operator sees the conflict that was in progress
    // rather than only that someone pressed Ctrl-C — and it is asserted here so
    // the choice is recorded rather than rediscovered.
    const controller = new AbortController();
    let attempts = 0;

    const promise = withConflictRetry(() => {
      attempts += 1;
      controller.abort();
      return Promise.reject(classifyDatabaseError(pgError('40001'), 'test.op'));
    }, { label: 'test.op', signal: controller.signal });

    await expect(promise).rejects.toMatchObject({ code: ErrorCode.STORAGE_CONFLICT });
    expect(attempts).toBe(1);
  });

  it('keeps its backoff bounded and short — §13', () => {
    // A row conflict clears when the winning transaction commits, which is
    // milliseconds. A backoff measured in seconds would be waiting for something
    // that already happened.
    expect(CONFLICT_MAX_DELAY_MS).toBeLessThanOrEqual(250);
    expect(CONFLICT_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(CONFLICT_MAX_ATTEMPTS).toBeLessThanOrEqual(8);
  });
});
