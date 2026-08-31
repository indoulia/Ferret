import type { FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { retry } from '../providers/sdk/retry.js';

import { isTransientConflict } from './connection.js';

/**
 * Retrying a transaction PostgreSQL rolled back for conflicting — EPIC-079.
 *
 * The retry primitive is EPIC-012's and is not reimplemented here; what this
 * module supplies is the two things it cannot know on its own — *which* errors
 * are worth another attempt, and *where* another attempt is meaningful.
 *
 * **Where matters more than how.** A serialization failure aborts the whole
 * transaction: every statement issued after it fails with `25P02`, so retrying
 * the failing *statement* retries inside a transaction that can never commit.
 * The unit of retry is the unit of atomicity, which is why this wraps a function
 * that opens its own transaction rather than living inside one.
 *
 * The delays are short and few on purpose. A conflict resolves as soon as the
 * transaction that won commits, which is milliseconds; a long backoff here would
 * turn a contended index into a slow one, and a large attempt count would hide
 * genuine contention that an operator should see.
 */

/** Attempts, including the first. */
export const CONFLICT_MAX_ATTEMPTS = 5;

/** First backoff. Doubles, with full jitter, to {@link CONFLICT_MAX_DELAY_MS}. */
export const CONFLICT_INITIAL_DELAY_MS = 5;

/**
 * Longest a single backoff waits.
 *
 * Bounded, and low. A row conflict clears when the winning transaction commits —
 * a matter of milliseconds — so waiting a second would be waiting for something
 * that already happened. §13: contention must not extend a run without limit.
 */
export const CONFLICT_MAX_DELAY_MS = 250;

/** A signal for a caller that supplied none. Never aborts, allocated once. */
const NEVER_ABORTED: AbortSignal = new AbortController().signal;

export interface ConflictRetryOptions {
  /** Named in the log and in the error when the attempts run out. */
  readonly label: string;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  /** Overridden only by a test that needs a deterministic delay. */
  readonly random?: () => number;
  readonly maxAttempts?: number;
}

/**
 * Runs a transactional operation, retrying only a transaction conflict.
 *
 * Everything else fails on the first attempt, deliberately: retrying a
 * permission error hammers a system that will never say yes and looks to an
 * operator like a hang rather than a denial. `isTransientConflict` reads the
 * SQLSTATE, so the decision is PostgreSQL's rather than a guess about a message.
 *
 * The operation must open its own transaction — it is called again from the
 * beginning, and an attempt that reused an aborted transaction would fail for a
 * reason that has nothing to do with the conflict.
 */
export async function withConflictRetry<T>(
  operation: () => Promise<T>,
  options: ConflictRetryOptions,
): Promise<T> {
  // A signal is required by `retry`; a caller with none gets one that never
  // aborts rather than a special case inside the loop.
  const signal = options.signal ?? NEVER_ABORTED;

  return retry(operation, signal, options.label, {
    maxAttempts: options.maxAttempts ?? CONFLICT_MAX_ATTEMPTS,
    initialDelayMs: CONFLICT_INITIAL_DELAY_MS,
    maxDelayMs: CONFLICT_MAX_DELAY_MS,
    jitter: 'full',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.random === undefined ? {} : { random: options.random }),
    // The whole of this Epic's judgement, in one predicate. `retry` defaults to
    // `error.retryable`, which is broader than this: a dropped connection is
    // retryable and is *not* something to re-run a transaction over here,
    // because the pool has already lost the session that transaction lived in.
    isRetryable: (error: FerretError): boolean =>
      isTransientConflict(error) || isTransientConflict(error.cause),
  });
}
