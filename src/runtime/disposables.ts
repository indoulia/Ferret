import { ErrorCode, FerretError, toFerretError } from '../errors/index.js';

/** A resource-releasing callback. Must tolerate being called once only. */
export type Disposable = () => Promise<void> | void;

/**
 * Last-in, first-out registry of resource-releasing callbacks.
 *
 * Every disposable is attempted even if an earlier one throws, so a single
 * failing handle cannot strand the rest. Failures are returned, not raised,
 * because shutdown must complete.
 */
export class DisposableStack {
  readonly #entries: Array<{ readonly name: string; readonly dispose: Disposable }> = [];
  #draining = false;

  add(name: string, dispose: Disposable): void {
    this.#entries.push({ name, dispose });
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Disposes everything in reverse registration order, exactly once. */
  async disposeAll(): Promise<readonly FerretError[]> {
    if (this.#draining) return [];
    this.#draining = true;
    const failures: FerretError[] = [];
    while (this.#entries.length > 0) {
      const entry = this.#entries.pop();
      if (entry === undefined) break;
      try {
        await entry.dispose();
      } catch (error) {
        failures.push(
          new FerretError(
            ErrorCode.SHUTDOWN_FAILED,
            `Failed to release "${entry.name}": ${toFerretError(error).message}`,
            { details: { resource: entry.name }, cause: error },
          ),
        );
      }
    }
    this.#draining = false;
    return failures;
  }
}
