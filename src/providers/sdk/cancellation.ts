import { setTimeout as delay } from 'node:timers/promises';

import { ErrorCode, FerretError } from '../../errors/index.js';

/**
 * Cancellation, without the leaks.
 *
 * Every provider operation observes an `AbortSignal` (EPIC-011 invariant 2), and
 * almost every one of them wants a *derived* signal — this operation's own
 * cancellation, or a deadline, on top of the runtime's shutdown signal. The
 * naive way to do that is `root.addEventListener('abort', ...)` per unit of
 * work, and the naive way leaks: a long-lived root signal accumulates one
 * listener per file indexed. At eleven Node prints a warning; at a million the
 * process is holding a million closures over work that finished long ago.
 *
 * So the rule here is that **everything derived is disposable**, and disposing
 * removes what it added. Node 22's `AbortSignal.any` and `AbortSignal.timeout`
 * do the composition correctly — Governance §5, reuse before reinvent — but
 * neither gives you a handle to drop early, and the timer behind
 * `AbortSignal.timeout` keeps the event loop alive until it fires. This module
 * is the thin layer that makes both releasable.
 */

/** An abort reason that survives serialization into a log or an AI client. */
export function interrupted(operation: string, cause?: unknown): FerretError {
  return new FerretError(ErrorCode.INTERRUPTED, `${operation} was cancelled`, {
    details: { operation },
    remediation: 'Re-run the operation if the cancellation was not intentional.',
    retryable: true,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Stops now if cancellation has already been requested.
 *
 * The check to put at the top of a loop body. Cheap enough to call per item, and
 * an operation that only checks its signal before starting is not cancellable in
 * any sense a user would recognise.
 *
 * @throws {FerretError} `E_INTERRUPTED`.
 */
export function throwIfAborted(signal: AbortSignal, operation: string): void {
  if (signal.aborted) throw interrupted(operation, signal.reason);
}

/**
 * A signal derived from others, with the listeners it added releasable.
 *
 * `dispose` is idempotent and safe to call after the signal has already
 * aborted.
 */
export interface DerivedSignal extends Disposable {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Combines signals into one that aborts when the first of them does.
 *
 * Always dispose it. `AbortSignal.any` is specified to hold the composite weakly
 * once nothing else references it, so a forgotten one is collected *eventually*
 * — but "eventually, at the garbage collector's discretion" is not a resource
 * policy, and the whole point of a derived signal is that its lifetime is
 * shorter and more predictable than its parents'.
 *
 * Passing a single signal returns it directly rather than wrapping it: the
 * common case of "derive from the one signal I was given" should not allocate.
 */
export function linkSignals(...signals: readonly AbortSignal[]): DerivedSignal {
  const sources = signals.filter((signal): signal is AbortSignal => signal !== undefined);

  if (sources.length === 0) {
    return asDerived(new AbortController().signal, () => undefined);
  }
  if (sources.length === 1) {
    // Safe: length was just checked. `noUncheckedIndexedAccess` cannot see that.
    return asDerived(sources[0] as AbortSignal, () => undefined);
  }

  const controller = new AbortController();
  const onAbort = function onAbort(this: AbortSignal): void {
    controller.abort(this.reason);
    release();
  };

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    for (const source of sources) source.removeEventListener('abort', onAbort);
  };

  for (const source of sources) {
    if (source.aborted) {
      controller.abort(source.reason);
      release();
      return asDerived(controller.signal, release);
    }
  }
  for (const source of sources) source.addEventListener('abort', onAbort, { once: true });

  return asDerived(controller.signal, release);
}

/**
 * A signal that also aborts once `timeoutMs` has elapsed.
 *
 * `AbortSignal.timeout` would do this in one call, and its timer is unref'd so
 * it does not hold the event loop open. What it does not offer is *cancelling
 * the deadline* when the work finishes early, which matters when the deadline is
 * an hour and the work took a second: the composite stays alive, referenced by
 * the timer, for the remaining fifty-nine minutes.
 */
export function withDeadline(signal: AbortSignal, timeoutMs: number, operation: string): DerivedSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new FerretError(ErrorCode.USAGE, `Deadline for ${operation} must be a positive number of milliseconds`, {
      details: { operation, timeoutMs },
      remediation: 'Pass a positive timeout, or omit the deadline entirely.',
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(
      new FerretError(ErrorCode.INTERRUPTED, `${operation} exceeded its ${String(timeoutMs)}ms deadline`, {
        details: { operation, timeoutMs },
        remediation: 'Raise the deadline, or reduce the amount of work in one operation.',
        retryable: true,
      }),
    );
  }, timeoutMs);
  // Nothing should stay alive merely because a deadline has not expired yet.
  timer.unref?.();

  const linked = linkSignals(signal, controller.signal);

  let released = false;
  return asDerived(linked.signal, () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    linked.dispose();
  });
}

function asDerived(signal: AbortSignal, dispose: () => void): DerivedSignal {
  return {
    signal,
    dispose,
    [Symbol.dispose]: dispose,
  };
}

/**
 * Sleeps, unless cancelled first.
 *
 * `timers/promises` already clears its timer on abort, which is the property
 * that matters: a backoff interrupted by Ctrl-C must not keep `ferret index`
 * alive for the remaining thirty seconds. This wrapper exists only to turn the
 * platform's `AbortError` into a classified {@link FerretError}, so a caller
 * never has to branch on a `DOMException`.
 *
 * @throws {FerretError} `E_INTERRUPTED`.
 */
export async function abortableDelay(ms: number, signal: AbortSignal, operation: string): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal, operation);
    return;
  }
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (isAbortError(error)) throw interrupted(operation, signal.reason ?? error);
    throw error;
  }
}

/** True for the platform's abort rejection, whatever shape the runtime uses. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof FerretError) return error.code === ErrorCode.INTERRUPTED;
  return error instanceof Error && error.name === 'AbortError';
}
