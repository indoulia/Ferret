import { watch, type FSWatcher } from 'node:fs';

import { EventSubject, type SourceEvent } from './normalize.js';

/**
 * Watching a directory for repositories — EPIC-077 §8.6.
 *
 * Four validation documents park "no incremental repository discovery" here,
 * each with the same sentence: *"It needs a filesystem watcher."* This is that
 * watcher, and it is deliberately the smallest thing that could be one.
 *
 * **A watcher is a hint, not a source of truth.** `fs.watch` drops events under
 * load, reports different things on every platform, and says nothing at all
 * about what happened while the process was not running. So it emits the same
 * `SourceEvent` a webhook does — *something here changed, go and look* — and
 * EPIC-078's periodic reconciliation remains the thing that is actually
 * correct. A watcher that was trusted instead of reconciliation would be a
 * cache with no invalidation.
 */

/**
 * How long to wait for a burst to finish.
 *
 * A `git clone` produces thousands of events over several seconds; a `git
 * checkout` of a branch produces hundreds. Emitting one event per file would
 * make the watcher itself the load. The debounce is per watched root, so two
 * roots do not silence each other.
 */
export const DEFAULT_WATCH_DEBOUNCE_MS = 1_000;

/** How many roots one watcher will hold open. */
export const MAX_WATCHED_ROOTS = 64;

export interface WatchOptions {
  readonly debounceMs?: number;
  /** Injected so a test does not spend the wall clock it is asserting about. */
  readonly schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
  /** Injected so a test does not need a filesystem. */
  readonly open?: (root: string, onChange: (path: string) => void) => { close(): void };
}

export interface WatchedRoot {
  readonly root: string;
  close(): void;
}

/**
 * Watch roots, and call back once per quiet burst.
 *
 * The callback receives a `SourceEvent` with the same shape a webhook produces,
 * so a caller has one path to a targeted re-read rather than two.
 */
export class RepositoryWatcher {
  readonly #onEvent: (event: SourceEvent) => void;
  readonly #debounceMs: number;
  readonly #schedule: NonNullable<WatchOptions['schedule']>;
  readonly #open: NonNullable<WatchOptions['open']>;
  readonly #watchers = new Map<string, { handle: { close(): void }; pending?: { cancel(): void } }>();
  #sequence = 0;

  constructor(onEvent: (event: SourceEvent) => void, options: WatchOptions = {}) {
    this.#onEvent = onEvent;
    this.#debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#open = options.open ?? defaultOpen;
  }

  get watching(): readonly string[] {
    return [...this.#watchers.keys()];
  }

  /**
   * Start watching a root.
   *
   * Idempotent: watching the same root twice keeps one watcher, because two
   * would double every event and the second would be indistinguishable from a
   * real change.
   */
  add(root: string): void {
    if (this.#watchers.has(root)) return;
    if (this.#watchers.size >= MAX_WATCHED_ROOTS) {
      throw new Error(`Refusing to watch more than ${String(MAX_WATCHED_ROOTS)} roots`);
    }
    const handle = this.#open(root, () => {
      this.#touch(root);
    });
    this.#watchers.set(root, { handle });
  }

  remove(root: string): void {
    const entry = this.#watchers.get(root);
    if (entry === undefined) return;
    entry.pending?.cancel();
    entry.handle.close();
    this.#watchers.delete(root);
  }

  /** Stop every watcher. Safe to call twice. */
  close(): void {
    for (const root of [...this.#watchers.keys()]) this.remove(root);
  }

  /**
   * A change in `root`, debounced.
   *
   * The pending timer is replaced rather than extended, which is what makes a
   * burst emit once at its end rather than once per file.
   */
  #touch(root: string): void {
    const entry = this.#watchers.get(root);
    if (entry === undefined) return;
    entry.pending?.cancel();
    entry.pending = this.#schedule(() => {
      // Re-read: the root may have been removed while the timer was pending.
      const current = this.#watchers.get(root);
      if (current === undefined) return;
      current.pending = undefined;
      this.#sequence += 1;
      this.#onEvent({
        // Not a vendor's delivery id — there is no sender — so one is minted
        // that is unique per watcher and monotonic, which is what
        // `DeliveryLedger` needs and all it needs.
        deliveryId: `watch-${String(this.#sequence)}-${String(Date.now())}`,
        sourceSystem: 'filesystem',
        subject: EventSubject.REPOSITORY,
        project: root,
        event: 'filesystem.changed',
        occurredAt: new Date().toISOString(),
      });
    }, this.#debounceMs);
  }
}

/**
 * `fs.watch`, recursively.
 *
 * `recursive: true` works on Windows, macOS and — since Node 20 — Linux, and
 * Ferret's engine floor is Node 22. An error is swallowed rather than thrown:
 * a watch that fails to attach means no hints from that root, and
 * reconciliation still covers it. Failing the process because a directory
 * became unwatchable would make the optimisation load-bearing.
 */
function defaultOpen(root: string, onChange: (path: string) => void): { close(): void } {
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
      onChange(typeof filename === 'string' ? filename : root);
    });
    watcher.on('error', () => {
      // A watched directory removed underneath us. Not fatal.
    });
  } catch {
    return { close: () => undefined };
  }
  const handle = watcher;
  return {
    close: () => {
      handle.close();
    },
  };
}

function defaultSchedule(callback: () => void, delayMs: number): { cancel(): void } {
  const timer = setTimeout(callback, delayMs);
  // A watcher must not hold a process open: it is an optimisation, and an
  // optimisation that prevents exit is a hang.
  timer.unref?.();
  return {
    cancel: () => {
      clearTimeout(timer);
    },
  };
}
