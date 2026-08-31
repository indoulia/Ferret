import { ErrorCode, FerretError, toFerretError } from '../../errors/index.js';
import type { Logger } from '../../logging/index.js';
import type { CapabilityDeclaration } from '../capabilities.js';
import type { ProviderSettings } from '../configuration.js';
import type { Provider, ProviderContext, ProviderKind } from '../contract.js';
import { PROVIDER_CONTRACT_VERSION } from '../contract.js';

/**
 * The lifecycle half of the provider contract, implemented once.
 *
 * EPIC-001 made `initialize` and `shutdown` optional hooks, which is the right
 * contract and leaves every provider to re-derive the same four properties. They
 * look trivial written down and are consistently got wrong:
 *
 * 1. **Initialize exactly once**, even when two callers race. A provider that
 *    opens a connection pool in `initialize` and is initialized twice has two
 *    pools, one of which nothing will ever close.
 * 2. **A failed initialize can be retried.** The obvious fix for (1) is to cache
 *    the promise — which caches the *rejection* too, so a provider that failed
 *    because the database was briefly down can never succeed again without a
 *    restart.
 * 3. **Shutdown waits for an in-flight initialize.** Tearing down while
 *    initialization is still running leaks precisely the resources it is
 *    creating, and the leak is invisible because shutdown reported success.
 * 4. **Shutdown is idempotent and tolerates never having initialized.** The
 *    contract already requires it; nothing enforced it.
 *
 * Node runs one thread, so "race" here means interleaved across `await` points.
 * That is more than enough: `Promise.all([p.initialize(ctx), p.initialize(ctx)])`
 * is a realistic composition-root mistake, and a signal arriving mid-startup is
 * not a mistake at all.
 *
 * Subclasses override {@link onInitialize} and {@link onShutdown} and get all
 * four properties without thinking about them.
 */

export const ProviderState = {
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  SHUTTING_DOWN: 'shutting-down',
  STOPPED: 'stopped',
} as const;

export type ProviderState = (typeof ProviderState)[keyof typeof ProviderState];

export abstract class BaseProvider implements Provider {
  abstract readonly id: string;
  abstract readonly kind: ProviderKind;
  abstract readonly capabilities: readonly CapabilityDeclaration[];

  readonly contractVersion: number = PROVIDER_CONTRACT_VERSION;

  #state: ProviderState = ProviderState.CREATED;
  #context: ProviderContext | undefined;
  #logger: Logger | undefined;
  #initializing: Promise<void> | undefined;
  #shuttingDown: Promise<void> | undefined;

  get state(): ProviderState {
    return this.#state;
  }

  /**
   * Everything the runtime gave this provider.
   *
   * @throws {FerretError} `E_LIFECYCLE_INVALID_STATE` before initialization or
   * after shutdown. Throwing beats returning `undefined`: a provider that reads
   * its configuration before it has any should fail where the mistake is, not
   * three frames later on a property of `undefined`.
   */
  protected get context(): ProviderContext {
    if (this.#context === undefined || this.#state === ProviderState.STOPPED) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        `Provider "${this.id}" was used while ${this.#state}`,
        {
          details: { providerId: this.id, state: this.#state },
          remediation: 'Initialize the provider before using it, and do not use it after shutdown.',
        },
      );
    }
    return this.#context;
  }

  /** The runtime logger, bound to this provider's identity. */
  protected get logger(): Logger {
    if (this.#logger === undefined) {
      this.#logger = this.context.logger.child({ provider: this.id });
    }
    return this.#logger;
  }

  /** Aborted when the runtime begins shutting down. */
  protected get signal(): AbortSignal {
    return this.context.signal;
  }

  /** This provider's own configuration, validated against what it declared. */
  protected get settings(): ProviderSettings {
    return this.context.settings;
  }

  /**
   * This provider's validated options.
   *
   * Typed by the subclass, which is the only code that knows its own schema:
   * `protected override get options(): GitOptions` is the intended shape. The
   * cast is the one place the untyped configuration record meets the type the
   * provider declared, and it is sound exactly when `configSchema` matches that
   * type — which is the provider's own contract with itself.
   */
  protected get options(): Readonly<Record<string, unknown>> {
    return this.context.settings.options;
  }

  async initialize(context: ProviderContext): Promise<void> {
    if (this.#state === ProviderState.READY) return;
    if (this.#state === ProviderState.SHUTTING_DOWN || this.#state === ProviderState.STOPPED) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        `Provider "${this.id}" cannot be initialized while ${this.#state}`,
        {
          details: { providerId: this.id, state: this.#state },
          remediation: 'Construct a new provider instance rather than reviving a stopped one.',
        },
      );
    }
    // Second caller joins the first rather than starting a parallel one.
    if (this.#initializing !== undefined) return this.#initializing;

    this.#state = ProviderState.INITIALIZING;
    this.#context = context;
    this.#logger = context.logger.child({ provider: this.id });

    const run = (async (): Promise<void> => {
      try {
        await this.onInitialize(context);
      } catch (error) {
        // Reset rather than remember. A cached rejected promise would make a
        // transient failure permanent for the life of the process.
        this.#state = ProviderState.CREATED;
        this.#context = undefined;
        this.#logger = undefined;
        throw wrapInit(this.id, error);
      }
      // A shutdown that arrived mid-initialization has already moved the state
      // on; overwriting it here would resurrect a provider that is being torn
      // down, and `shutdown` is awaiting this promise precisely so it can clean
      // up what we just created.
      if (this.#state === ProviderState.INITIALIZING) this.#state = ProviderState.READY;
      this.#logger?.debug({ operation: 'provider.initialized' }, `Provider "${this.id}" initialized`);
    })();

    this.#initializing = run;
    try {
      await run;
    } finally {
      this.#initializing = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#state === ProviderState.STOPPED) return;
    if (this.#shuttingDown !== undefined) return this.#shuttingDown;

    const inFlight = this.#initializing;
    this.#state = ProviderState.SHUTTING_DOWN;

    const run = (async (): Promise<void> => {
      if (inFlight !== undefined) {
        // Whatever initialization was creating, it is ours to release. Its
        // failure is not a shutdown failure, so it is swallowed here — the
        // caller of `initialize` still receives it.
        await inFlight.catch(() => undefined);
      }
      try {
        if (this.#context !== undefined) await this.onShutdown();
      } finally {
        this.#state = ProviderState.STOPPED;
        this.#context = undefined;
        this.#logger = undefined;
      }
    })();

    this.#shuttingDown = run;
    try {
      await run;
    } finally {
      this.#shuttingDown = undefined;
    }
  }

  /**
   * Prepare the provider. Called at most once per successful lifecycle.
   *
   * Anything created here must be released in {@link onShutdown}, which is
   * guaranteed to run even when a shutdown arrives while this is still running.
   */
  protected onInitialize(_context: ProviderContext): Promise<void> | void {
    return undefined;
  }

  /**
   * Release resources. Called at most once, and never before
   * {@link onInitialize} has settled.
   *
   * Not called at all if the provider was never initialized, so it may assume
   * `context` was available — though it must still tolerate a partially
   * completed initialization, since a shutdown can arrive halfway through one.
   */
  protected onShutdown(): Promise<void> | void {
    return undefined;
  }
}

/**
 * Preserves a classified failure rather than relabelling it.
 *
 * The same mistake EPIC-002 made and this codebase has already paid for once: a
 * wrapper that replaces every provider error with a generic one turns "the
 * `FERRET_DATABASE_PASSWORD` environment variable is not set" into "a provider
 * failed to initialize", and the operator loses the only sentence that told them
 * what to do.
 */
function wrapInit(providerId: string, error: unknown): FerretError {
  const classified = toFerretError(error, ErrorCode.PROVIDER_INIT_FAILED);
  if (FerretError.is(error)) {
    return new FerretError(classified.code, classified.message, {
      details: { ...classified.details, providerId },
      ...(classified.remediation === undefined ? {} : { remediation: classified.remediation }),
      retryable: classified.retryable,
      cause: error,
    });
  }
  return new FerretError(ErrorCode.PROVIDER_INIT_FAILED, `Provider "${providerId}" failed to initialize: ${classified.message}`, {
    details: { providerId },
    remediation: 'Check the provider’s configuration and the availability of the system it depends on.',
    cause: error,
  });
}
