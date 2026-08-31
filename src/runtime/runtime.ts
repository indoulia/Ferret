import {
  defaultConfigSourceList,
  describeConfig,
  resolveConfig,
  type ConfigSource,
  type FerretConfig,
} from '../config/index.js';
import {
  CORE_DEPENDENCY_CHECKS,
  DependencyStatus,
  type DependencyCheck,
  type DependencyCheckContext,
  type DependencyCheckResult,
} from '../diagnostics/index.js';
import { ErrorCode, FerretError, toFerretError } from '../errors/index.js';
import { createLogger, createNullLogger, type LogLevel, type Logger } from '../logging/index.js';
import { detectEnvironment, type EnvironmentReport } from '../environment/index.js';
import {
  ProviderRegistry,
  providerConfigurationWarnings,
  type Provider,
  type ProviderHostContext,
} from '../providers/index.js';
import { RUNTIME_CONTRACT_VERSION, VERSION, versionInfo, type VersionInfo } from '../version.js';

import { DisposableStack, type Disposable } from './disposables.js';
import { RuntimeState } from './lifecycle.js';

export interface RuntimeOptions {
  /**
   * Configuration layers, lowest precedence first.
   *
   * Defaults to the full Governance §16 stack — environment, user file,
   * repository policy, session, explicit. Supplying a list replaces it
   * entirely, which is how a test pins configuration to exactly what it means
   * to exercise.
   */
  readonly configSources?: readonly ConfigSource[];
  /** Overrides the resolved log level. */
  readonly logLevel?: LogLevel;
  /** Supplies a logger. When omitted the runtime builds one from the config. */
  readonly logger?: Logger;
  /** Providers to register before initialization. */
  readonly providers?: readonly Provider[];
  /** Extra dependency checks, appended to the core set. */
  readonly dependencyChecks?: readonly DependencyCheck[];
}

/** Everything a running Ferret exposes to its callers. */
export interface RuntimeContext {
  readonly config: FerretConfig;
  readonly environment: EnvironmentReport;
  readonly logger: Logger;
  readonly providers: ProviderRegistry;
  readonly signal: AbortSignal;
  readonly version: VersionInfo;
  readonly dependencies: readonly DependencyCheckResult[];
}

/**
 * The Ferret runtime.
 *
 * Owns one start/stop cycle:
 *
 * ```text
 * create -> initialize -> validate dependencies -> ready -> shutdown -> stopped
 * ```
 *
 * Both `initialize` and `shutdown` are idempotent and concurrency-safe:
 * overlapping calls join the in-flight operation rather than starting a second
 * one. A failed or completed runtime is terminal - construct a new instance.
 *
 * The runtime holds no knowledge of any concrete provider. Storage, indexing,
 * MCP and source systems reach it only through {@link ProviderRegistry}.
 */
export class FerretRuntime {
  readonly #options: RuntimeOptions;
  readonly #providers = new ProviderRegistry();
  readonly #disposables = new DisposableStack();
  readonly #abort = new AbortController();

  #state: RuntimeState = RuntimeState.CREATED;
  #context: RuntimeContext | undefined;
  #initializing: Promise<void> | undefined;
  #shuttingDown: Promise<void> | undefined;
  #logger: Logger;

  constructor(options: RuntimeOptions = {}) {
    this.#options = options;
    this.#logger = options.logger ?? createNullLogger();
    if (options.providers !== undefined) this.#providers.registerAll(options.providers);
  }

  static create(options: RuntimeOptions = {}): FerretRuntime {
    return new FerretRuntime(options);
  }

  get state(): RuntimeState {
    return this.#state;
  }

  get version(): string {
    return VERSION;
  }

  get contractVersion(): number {
    return RUNTIME_CONTRACT_VERSION;
  }

  get providers(): ProviderRegistry {
    return this.#providers;
  }

  /** Aborted when shutdown begins. Long-running work should observe it. */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * The running context.
   *
   * @throws {FerretError} `E_LIFECYCLE_INVALID_STATE` when not ready. Returning
   * a partially-built context would let callers read configuration that
   * validation has not yet accepted.
   */
  get context(): RuntimeContext {
    if (this.#context === undefined || this.#state !== RuntimeState.READY) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        `Runtime context is unavailable in state "${this.#state}"`,
        {
          details: { state: this.#state },
          remediation: 'Await initialize() before reading the context.',
        },
      );
    }
    return this.#context;
  }

  /** Registers a resource to release during shutdown, in reverse order. */
  registerDisposable(name: string, dispose: Disposable): void {
    this.#disposables.add(name, dispose);
  }

  /**
   * Resolves configuration, detects the environment, validates dependencies and
   * initializes providers.
   *
   * Idempotent: calling it while ready is a no-op, and concurrent calls share
   * one initialization.
   */
  async initialize(): Promise<void> {
    if (this.#state === RuntimeState.READY) return;
    if (this.#initializing !== undefined) return this.#initializing;
    if (this.#state !== RuntimeState.CREATED) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        `Runtime cannot initialize from state "${this.#state}"`,
        {
          details: { state: this.#state },
          remediation: 'A runtime instance runs once. Create a new FerretRuntime.',
        },
      );
    }

    this.#state = RuntimeState.INITIALIZING;
    this.#initializing = this.#doInitialize().finally(() => {
      this.#initializing = undefined;
    });
    return this.#initializing;
  }

  async #doInitialize(): Promise<void> {
    const startedAt = Date.now();
    try {
      const { config, sources } = resolveConfig(this.#options.configSources ?? defaultConfigSourceList());
      const level = this.#options.logLevel ?? config.logLevel;
      this.#logger = this.#options.logger ?? createLogger({ level, base: { component: 'runtime' } });

      const environment = await detectEnvironment();

      const dependencies = await this.#runDependencyChecks(config, environment);
      const blocking = dependencies.filter(
        (result) =>
          result.required &&
          result.status !== DependencyStatus.OK &&
          result.status !== DependencyStatus.DEGRADED,
      );
      if (blocking.length > 0) {
        const first = blocking[0];
        throw new FerretError(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          `Required dependency "${first?.name ?? 'unknown'}" is unavailable: ${first?.detail ?? 'no detail available'}`,
          {
            details: { failed: blocking },
            ...(first?.remediation === undefined ? {} : { remediation: first.remediation }),
          },
        );
      }

      const providerContext: ProviderHostContext = {
        logger: this.#logger.child({ component: 'provider' }),
        config,
        environment,
        signal: this.#abort.signal,
      };
      await this.#providers.initializeAll(providerContext);
      const providerDependencies = await this.#providers.checkAll(providerContext);
      // Reported rather than fatal: a configuration file shared across machines
      // may name a provider only some of them install (EPIC-015 AC-9).
      const configWarnings = providerConfigurationWarnings(
        config,
        this.#providers.describe().map((entry) => entry.id),
      );
      for (const warning of configWarnings) {
        this.#logger.warn(
          { operation: 'runtime.initialize', providerId: warning.providerId, reason: warning.reason },
          `Configuration names provider "${warning.providerId}", which is not registered`,
        );
      }

      this.#context = {
        config,
        environment,
        logger: this.#logger,
        providers: this.#providers,
        signal: this.#abort.signal,
        version: versionInfo(),
        dependencies: [...dependencies, ...providerDependencies],
      };
      this.#state = RuntimeState.READY;

      this.#logger.info(
        {
          operation: 'runtime.initialize',
          durationMs: Date.now() - startedAt,
          configSources: sources,
          config: describeConfig(config, { secret: this.#providers.isSecretConfigPath }),
          providers: this.#providers.describe(),
        },
        'Ferret runtime ready',
      );
    } catch (error) {
      this.#state = RuntimeState.FAILED;
      // A failed start must not leave resources open.
      await this.#providers.shutdownAll();
      await this.#disposables.disposeAll();
      if (!this.#abort.signal.aborted) this.#abort.abort();
      const failure =
        error instanceof FerretError
          ? error
          : new FerretError(
              ErrorCode.INITIALIZATION_FAILED,
              `Runtime initialization failed: ${toFerretError(error).message}`,
              { cause: error },
            );
      this.#logger.error(
        { operation: 'runtime.initialize', durationMs: Date.now() - startedAt, err: failure },
        'Ferret runtime failed to initialize',
      );
      throw failure;
    }
  }

  async #runDependencyChecks(
    config: FerretConfig,
    environment: EnvironmentReport,
  ): Promise<readonly DependencyCheckResult[]> {
    const context: DependencyCheckContext = {
      logger: this.#logger.child({ component: 'diagnostics' }),
      config,
      environment,
      signal: this.#abort.signal,
    };
    const checks = [...CORE_DEPENDENCY_CHECKS, ...(this.#options.dependencyChecks ?? [])];
    const results: DependencyCheckResult[] = [];
    for (const check of checks) {
      try {
        results.push(await check.run(context));
      } catch (error) {
        // A check that cannot run reports `unknown`; it never reports `ok`.
        results.push({
          name: check.name,
          status: DependencyStatus.UNKNOWN,
          required: check.required,
          detail: `Check failed to run: ${toFerretError(error).message}`,
        });
      }
    }
    return results;
  }

  /**
   * Releases providers and resources.
   *
   * Idempotent and safe from any state, including one where initialization
   * never ran. Individual failures are aggregated into a single
   * `E_SHUTDOWN_FAILED` after every resource has been attempted.
   */
  async shutdown(): Promise<void> {
    if (this.#state === RuntimeState.STOPPED) return;
    if (this.#shuttingDown !== undefined) return this.#shuttingDown;

    if (this.#state === RuntimeState.CREATED || this.#state === RuntimeState.FAILED) {
      // Nothing was started, or the failure path has already cleaned up.
      if (!this.#abort.signal.aborted) this.#abort.abort();
      this.#state = RuntimeState.STOPPED;
      this.#context = undefined;
      return;
    }

    if (this.#initializing !== undefined) {
      // Let an in-flight start settle so it cannot open resources behind us.
      await this.#initializing.catch(() => undefined);
      // A failed start already released everything on its own error path.
      // Read through a method so narrowing from the checks above, which
      // predate the await, is not applied to a value the await may have changed.
      if (this.#currentState() === RuntimeState.FAILED) {
        this.#state = RuntimeState.STOPPED;
        this.#context = undefined;
        return;
      }
    }

    this.#state = RuntimeState.STOPPING;
    this.#shuttingDown = this.#doShutdown().finally(() => {
      this.#shuttingDown = undefined;
    });
    return this.#shuttingDown;
  }

  #currentState(): RuntimeState {
    return this.#state;
  }

  async #doShutdown(): Promise<void> {
    const startedAt = Date.now();
    if (!this.#abort.signal.aborted) this.#abort.abort();

    const failures = [
      ...(await this.#providers.shutdownAll()),
      ...(await this.#disposables.disposeAll()),
    ];

    this.#context = undefined;
    this.#state = failures.length > 0 ? RuntimeState.FAILED : RuntimeState.STOPPED;

    if (failures.length > 0) {
      const aggregate = new FerretError(
        ErrorCode.SHUTDOWN_FAILED,
        `${String(failures.length)} resource(s) failed to release during shutdown`,
        { details: { failures: failures.map((failure) => failure.toJSON()) } },
      );
      this.#logger.error(
        { operation: 'runtime.shutdown', durationMs: Date.now() - startedAt, err: aggregate },
        'Ferret runtime shutdown completed with failures',
      );
      throw aggregate;
    }

    this.#logger.info(
      { operation: 'runtime.shutdown', durationMs: Date.now() - startedAt },
      'Ferret runtime stopped',
    );
  }

  /**
   * Initializes, runs `body`, and shuts down even when `body` throws.
   *
   * The supported way to use the runtime for a single operation: it makes
   * leaking a started runtime impossible.
   */
  async run<T>(body: (context: RuntimeContext) => Promise<T> | T): Promise<T> {
    await this.initialize();
    try {
      return await body(this.context);
    } finally {
      await this.shutdown().catch(() => undefined);
    }
  }
}

/** Convenience constructor mirroring {@link FerretRuntime.create}. */
export function createRuntime(options: RuntimeOptions = {}): FerretRuntime {
  return FerretRuntime.create(options);
}
