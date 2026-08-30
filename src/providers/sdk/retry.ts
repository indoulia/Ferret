import type { Logger } from '../../logging/index.js';
import { ErrorCode, FerretError, redactString, toFerretError } from '../../errors/index.js';

import { abortableDelay, isAbortError, throwIfAborted } from './cancellation.js';

/**
 * Retrying, decided by Ferret's error taxonomy rather than by guesswork.
 *
 * The delivery brief forbids reinventing retry mechanisms, so the reuse decision
 * is recorded in the Epic specification §15 rather than left implicit. In short:
 * the backoff formula is the easy half and the platform already supplies the
 * cancellable sleep; the hard half is deciding *whether an error is worth
 * retrying at all*, and no general-purpose library can answer that — it has to
 * be told, through a predicate, which is the entire remaining surface.
 *
 * Getting the decision wrong is expensive in both directions. Retrying a
 * permission error hammers a system that will never say yes, and looks to an
 * operator like a hang rather than a denial. Not retrying a dropped connection
 * turns a one-second blip into a failed index of a hundred thousand files.
 * EPIC-009 already classifies every error Ferret raises, so the answer exists;
 * this module's job is to use it.
 */

export interface RetryAttemptInfo {
  /** 1-based. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly error: FerretError;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  readonly maxAttempts?: number;
  /** Delay before the second attempt, before jitter. Default 100ms. */
  readonly initialDelayMs?: number;
  /** Ceiling on any single delay. Default 30s. */
  readonly maxDelayMs?: number;
  /** Growth per attempt. Default 2. */
  readonly multiplier?: number;
  /**
   * Jitter strategy. Default `full`.
   *
   * Full jitter — a uniform sample from `[0, backoff]` — rather than the
   * textbook fixed backoff, because fixed backoff synchronises. Twenty workers
   * that all fail against the same rate-limited API at the same instant will,
   * without jitter, all retry at the same instant, and keep doing so. `none`
   * exists for tests that need a deterministic schedule.
   */
  readonly jitter?: 'full' | 'none';
  /**
   * Overrides the default retryability decision.
   *
   * The default is {@link FerretError.retryable}, which is the classification
   * EPIC-009 already makes. Override it when a provider knows something the
   * taxonomy cannot — a specific upstream status code, say.
   */
  readonly isRetryable?: (error: FerretError, attempt: number) => boolean;
  readonly onRetry?: (info: RetryAttemptInfo) => void;
  readonly logger?: Logger;
  /** Injectable for tests. Default `Math.random`. */
  readonly random?: () => number;
}

const DEFAULTS = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  multiplier: 2,
} as const;

/**
 * The delay before attempt `attempt + 1`, given the error that ended `attempt`.
 *
 * Exported because a provider that knows its upstream's rate-limit headers wants
 * to reason about the schedule, and because a formula nobody can inspect is a
 * formula nobody can test.
 *
 * An upstream that *tells* Ferret when to come back wins over the formula: a
 * `retryAfterMs` in the error's details is an instruction, not a hint, and
 * ignoring it is how a client gets banned rather than throttled. It is still
 * clamped by `maxDelayMs`, because the value arrives from a system Ferret does
 * not control (Governance §12).
 */
export function nextDelayMs(
  attempt: number,
  error: FerretError,
  options: RetryOptions = {},
): number {
  const initial = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const max = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const multiplier = options.multiplier ?? DEFAULTS.multiplier;

  const advertised = error.details['retryAfterMs'];
  if (typeof advertised === 'number' && Number.isFinite(advertised) && advertised >= 0) {
    return Math.min(advertised, max);
  }

  const backoff = Math.min(initial * Math.pow(multiplier, attempt - 1), max);
  if ((options.jitter ?? 'full') === 'none') return backoff;
  return (options.random ?? Math.random)() * backoff;
}

/**
 * Runs `operation`, retrying while the error says it is worth retrying.
 *
 * Cancellation wins over retrying, always and immediately: an aborted operation
 * does not sleep out its backoff first, and a cancellation raised *by* the
 * operation is never mistaken for a transient failure worth repeating.
 *
 * `operation` receives the 1-based attempt number, so a provider that wants to
 * widen a timeout or drop to a cheaper path on a later attempt can.
 */
export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  signal: AbortSignal,
  name: string,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new FerretError(ErrorCode.USAGE, `Retry of ${name} needs at least one attempt`, {
      details: { operation: name, maxAttempts },
      remediation: 'Pass a positive integer for `maxAttempts`.',
    });
  }

  const retryable = options.isRetryable ?? ((error: FerretError): boolean => error.retryable);
  // The operation name is chosen by the provider author, and the natural way to
  // choose it is from whatever is being called — `GET ${url}`, say, where the
  // URL may carry userinfo credentials in its authority component. It is then
  // printed on *every* attempt, which makes it the highest-frequency leak path
  // in the module. The production logger redacts on the way out, but a
  // guarantee this module states in its own specification should not depend on
  // a downstream layer to hold.
  const label = redactString(name);

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(signal, name);
    try {
      return await operation(attempt);
    } catch (raw) {
      // A cancellation is not a transient failure. Sleeping and trying again
      // would be the exact opposite of what the caller asked for.
      if (isAbortError(raw) || signal.aborted) throw raw;

      const error = toFerretError(raw);
      const last = attempt >= maxAttempts;
      if (last || !retryable(error, attempt)) {
        options.logger?.warn(
          { operation: 'provider.retry.exhausted', target: label, attempt, maxAttempts, err: error },
          last && retryable(error, attempt)
            ? `${label} failed after ${String(attempt)} attempts`
            : `${label} failed with a non-retryable error`,
        );
        throw error;
      }

      const delayMs = nextDelayMs(attempt, error, options);
      // Deliberately logs the classification, never the arguments: a retried
      // request may carry a credential, and this line is the one that would
      // print it every time (specification §11).
      options.logger?.debug(
        { operation: 'provider.retry.attempt', target: label, attempt, maxAttempts, delayMs, code: error.code },
        `${label} failed with ${error.code}; retrying in ${String(Math.round(delayMs))}ms`,
      );
      options.onRetry?.({ attempt, maxAttempts, delayMs, error });

      await abortableDelay(delayMs, signal, name);
    }
  }
}
