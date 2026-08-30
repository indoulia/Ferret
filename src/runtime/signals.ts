import type { Logger } from '../logging/index.js';

/** Signals that request a graceful stop, with the exit code each implies. */
export const SHUTDOWN_SIGNALS: Readonly<Record<string, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export interface SignalHandlerOptions {
  /**
   * Releases whatever is running. Takes a callback rather than a runtime so a
   * caller that has not constructed one yet — or owns several — can still wire
   * signals up.
   */
  readonly shutdown: () => Promise<void>;
  readonly logger: Logger;
  /** Called once shutdown has settled, with the exit code the signal implies. */
  readonly onExit: (code: number) => void;
  /** Milliseconds to wait for a graceful stop before exiting anyway. */
  readonly graceMs?: number;
}

/**
 * Routes termination signals into a graceful runtime shutdown.
 *
 * A second signal exits immediately: an operator pressing Ctrl-C twice is
 * asking to stop now, and refusing would be worse than an unclean exit.
 *
 * A grace timer bounds the wait so a wedged resource cannot make Ferret
 * unkillable. The timer is unref'd so it never itself keeps the process alive.
 *
 * Platform note: Node.js does not deliver `SIGTERM` on Windows. Registration is
 * still attempted and failures are ignored, so behaviour degrades to `SIGINT`
 * only rather than crashing at startup.
 *
 * @returns a function that removes every handler installed here.
 */
export function installSignalHandlers(options: SignalHandlerOptions): () => void {
  const { shutdown, logger, onExit } = options;
  const graceMs = options.graceMs ?? 10_000;
  const registered: Array<[NodeJS.Signals, () => void]> = [];
  let handling = false;

  const handle = (signal: NodeJS.Signals, exitCode: number) => () => {
    if (handling) {
      logger.warn({ operation: 'runtime.signal', signal }, 'Second signal received, exiting immediately');
      onExit(exitCode);
      return;
    }
    handling = true;
    logger.info({ operation: 'runtime.signal', signal }, 'Signal received, shutting down');

    const timer = setTimeout(() => {
      logger.warn(
        { operation: 'runtime.signal', signal, graceMs },
        'Graceful shutdown exceeded its grace period, exiting',
      );
      onExit(exitCode);
    }, graceMs);
    timer.unref();

    void shutdown()
      .catch((error: unknown) => {
        logger.error({ operation: 'runtime.signal', signal, err: error }, 'Shutdown failed after signal');
      })
      .finally(() => {
        clearTimeout(timer);
        onExit(exitCode);
      });
  };

  for (const [name, exitCode] of Object.entries(SHUTDOWN_SIGNALS)) {
    const signal = name as NodeJS.Signals;
    const listener = handle(signal, exitCode);
    try {
      process.on(signal, listener);
      registered.push([signal, listener]);
    } catch {
      // Unsupported on this platform (notably SIGTERM on Windows). Reported by
      // `ferret env`, not fatal.
    }
  }

  return () => {
    for (const [signal, listener] of registered) process.off(signal, listener);
    registered.length = 0;
  };
}
