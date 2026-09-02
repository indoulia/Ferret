import { credentialsFor, withoutCredentialFields } from '../config/index.js';
import { ErrorCode, FerretError, toFerretError } from '../errors/index.js';
import {
  MAX_RECOVERY_ATTEMPTS,
  ProviderLifecycleState,
  RecoveryBudget,
  RecoveryRefusal,
  type ProviderLifecycle,
  type RecoveryResult,
} from './lifecycle.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';

import {
  describeSupport,
  validateCapabilityDeclaration,
  type Capability,
  type CapabilityDeclaration,
  type CapabilityVerdict,
} from './capabilities.js';
import {
  providerSettings,
  secretOptionPredicate,
  type ProviderSettings,
} from './configuration.js';
import {
  MINIMUM_PROVIDER_CONTRACT_VERSION,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_ID_PATTERN,
  isSupportedContractVersion,
  describeProvider,
  isProviderKind,
  type Provider,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHostContext,
  type ProviderKind,
} from './contract.js';

/**
 * Holds the providers a runtime instance knows about and drives their
 * lifecycle.
 *
 * The registry is the only place the core learns that a provider exists. Core
 * code addresses providers by {@link ProviderKind}, never by concrete identity,
 * which is what keeps `src/index.ts` free of vendor imports.
 *
 * Automatic discovery from installed packages is EPIC-013; the registry is
 * shaped to accept it without a contract change.
 */
export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();
  readonly #order: string[] = [];
  readonly #initialized = new Set<string>();
  /**
   * Capability index, built at registration.
   *
   * A map rather than a scan because selection is on the hot path of every
   * operation that reaches a provider, and because it makes "which provider
   * offers this" a lookup rather than a search through declarations.
   */
  readonly #byCapability = new Map<Capability, Array<{ providerId: string; declaration: CapabilityDeclaration }>>();
  /**
   * Providers configuration switched off, learned at {@link initializeAll}.
   *
   * Empty before then, which is honest rather than convenient: the registry has
   * no configuration until the runtime hands it one, and nothing selects a
   * provider before initialization because registration seals at that point.
   */
  readonly #disabled = new Set<string>();
  /**
   * Providers registered as survivable — EPIC-093 §8.1.
   *
   * At registration, not on the provider, because a provider cannot know
   * whether it is essential: the same parser is optional for `ferret index` and
   * required for `ferret index --content`. The caller composing the runtime is
   * the only component with that context.
   */
  readonly #optional = new Set<string>();
  /**
   * Optional providers whose `initialize` threw, and the code it threw with.
   *
   * Separate from {@link #disabled} deliberately: `enabled: false` is a
   * configuration decision and this is an event (§8.4).
   */
  readonly #failed = new Map<string, string>();
  #secretPredicate: ((path: readonly string[]) => boolean) | undefined;
  #sealed = false;
  /**
   * Failed initialize attempts per provider — EPIC-014 §8.3.
   *
   * Separate from {@link #failed}, which records *that* a provider failed and
   * with which code. This records *how many times*, which is what the circuit
   * needs and what a single code cannot carry.
   */
  readonly #budget = new RecoveryBudget();
  /** True once {@link shutdownAll} has run, so `released` is distinguishable. */
  #released = false;

  /**
   * Validates and records a provider.
   *
   * @throws {FerretError} `E_PROVIDER_INVALID` for a malformed provider,
   * `E_PROVIDER_DUPLICATE` when the identifier is already taken.
   */
  register(provider: Provider, options: { readonly optional?: boolean } = {}): void {
    if (this.#sealed) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        'Providers cannot be registered after the runtime has initialized',
        { details: { providerId: provider?.id }, remediation: 'Register providers before calling initialize().' },
      );
    }
    this.#validate(provider);
    // Required is the default — EPIC-093 §8.2. A caller that does not opt in
    // gets exactly the behaviour it had before this Epic.
    if (options.optional === true) this.#optional.add(provider.id);
    if (this.#providers.has(provider.id)) {
      throw new FerretError(
        ErrorCode.PROVIDER_DUPLICATE,
        `A provider with id "${provider.id}" is already registered`,
        { details: { providerId: provider.id } },
      );
    }
    // Validated *before* anything is recorded, so a rejected provider leaves no
    // trace. Registering it first and validating after would leave a
    // half-registered provider behind on failure — present in `size` and in
    // `describe()`, absent from the capability index — and the inconsistency
    // would outlive the error that caused it.
    //
    // Validation happens at registration rather than at first use because a
    // provider declaring a capability it cannot honour is a defect: every caller
    // that selected it would fail, far from the cause. Here it is a startup
    // error naming the provider.
    for (const declaration of provider.capabilities ?? []) {
      validateCapabilityDeclaration(provider.id, declaration);
    }

    this.#providers.set(provider.id, provider);
    this.#order.push(provider.id);
    this.#secretPredicate = undefined;

    for (const declaration of provider.capabilities ?? []) {
      const offered = this.#byCapability.get(declaration.capability) ?? [];
      offered.push({ providerId: provider.id, declaration });
      this.#byCapability.set(declaration.capability, offered);
    }
  }

  /** Registers several providers. Registration is not transactional. */
  registerAll(providers: Iterable<Provider>): void {
    for (const provider of providers) this.register(provider);
  }

  #validate(provider: Provider): void {
    const invalid = (message: string, details: Record<string, unknown>): FerretError =>
      new FerretError(ErrorCode.PROVIDER_INVALID, message, {
        details,
        remediation: `Providers must declare a unique dotted id, a known kind and a contractVersion between ${MINIMUM_PROVIDER_CONTRACT_VERSION} and ${PROVIDER_CONTRACT_VERSION}.`,
      });

    if (typeof provider !== 'object' || provider === null) {
      throw invalid('Provider must be an object', { received: typeof provider });
    }
    if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) {
      throw invalid(`Provider id "${String(provider.id)}" is not a valid dotted identifier`, {
        providerId: String(provider.id),
      });
    }
    if (!isProviderKind(provider.kind)) {
      throw invalid(`Provider "${provider.id}" declares unknown kind "${String(provider.kind)}"`, {
        providerId: provider.id,
        kind: String(provider.kind),
      });
    }
    if (!isSupportedContractVersion(provider.contractVersion)) {
      // A stated range rather than exact equality (EPIC-010 AC-4): a contract
      // change should not be a flag day for providers that use nothing it
      // altered. The range is currently a single version, so this is the same
      // behaviour with the rule made explicit.
      throw invalid(
        `Provider "${provider.id}" targets contract version ${String(provider.contractVersion)}, but this runtime supports ${MINIMUM_PROVIDER_CONTRACT_VERSION}–${PROVIDER_CONTRACT_VERSION}`,
        {
          providerId: provider.id,
          declared: provider.contractVersion,
          supported: PROVIDER_CONTRACT_VERSION,
          minimumSupported: MINIMUM_PROVIDER_CONTRACT_VERSION,
        },
      );
    }
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  get(id: string): Provider | undefined {
    return this.#providers.get(id);
  }

  /** Providers of a kind, in registration order. */
  list(kind?: ProviderKind): readonly Provider[] {
    const all = this.#order.map((id) => this.#providers.get(id)).filter((p): p is Provider => p !== undefined);
    return kind === undefined ? all : all.filter((provider) => provider.kind === kind);
  }

  /**
   * The provider offering a capability, or `undefined` when none does.
   *
   * **Registration order decides**, and deliberately: the first provider
   * registered for a capability wins, so composition — which is explicit and
   * visible at the call site — determines selection rather than a scoring
   * heuristic nobody can predict. EPIC-013 adds discovery, and will need to make
   * the resulting order equally explicit.
   */
  forCapability(capability: Capability): Provider | undefined {
    const first = this.#offered(capability)[0];
    return first === undefined ? undefined : this.#providers.get(first.providerId);
  }

  /** Every provider offering a capability, in registration order. */
  allForCapability(capability: Capability): readonly Provider[] {
    return this.#offered(capability)
      .map((entry) => this.#providers.get(entry.providerId))
      .filter((provider): provider is Provider => provider !== undefined);
  }

  /** What a provider declared about a capability it offers. */
  declarationFor(capability: Capability): CapabilityDeclaration | undefined {
    return this.#offered(capability)[0]?.declaration;
  }

  /**
   * Capability offers from providers that are switched on and did start.
   *
   * A disabled provider stays in the index — `describe()` still reports it, and
   * re-enabling it is a configuration change rather than a re-registration —
   * but it must not be *selected*, or turning a provider off would leave it
   * quietly serving every request (EPIC-015 AC-5).
   *
   * A **failed** provider is excluded for a sharper reason — EPIC-093 §8.3.
   * Handing a caller an object whose `initialize` threw is worse than handing
   * it nothing: the failure resurfaces later, somewhere with no context about
   * why, and the caller has no way to fall back to another provider it could
   * have selected instead.
   */
  #offered(
    capability: Capability,
  ): ReadonlyArray<{ providerId: string; declaration: CapabilityDeclaration }> {
    const offered = this.#byCapability.get(capability) ?? [];
    if (this.#disabled.size === 0 && this.#failed.size === 0) return offered;
    return offered.filter((entry) => !this.#disabled.has(entry.providerId) && !this.#failed.has(entry.providerId));
  }

  /**
   * Whether a capability — optionally a specific operation — is usable.
   *
   * Returns a verdict rather than throwing, because a missing capability is a
   * *reportable state*: Ferret should say semantic retrieval is unavailable
   * rather than failing when someone happens to search (Governance §13).
   */
  supports(capability: Capability, operation?: string): CapabilityVerdict {
    return describeSupport(capability, this.#offered(capability)[0], operation);
  }

  /** Capabilities at least one enabled provider offers. */
  capabilities(): readonly Capability[] {
    return [...this.#byCapability.keys()].filter((capability) => this.#offered(capability).length > 0);
  }

  describe(): readonly ProviderDescriptor[] {
    return this.list().map((provider) =>
      describeProvider(
        provider,
        this.#initialized.has(provider.id),
        !this.#disabled.has(provider.id),
        this.#failed.get(provider.id),
      ),
    );
  }

  /**
   * Optional providers that failed to start, with the code they failed with.
   *
   * For the health path — EPIC-093 AC-7. Empty on a clean start, which is what
   * makes a non-empty result worth reporting.
   */
  failures(): readonly { readonly providerId: string; readonly code: string }[] {
    return [...this.#failed.entries()].map(([providerId, code]) => ({ providerId, code }));
  }

  /**
   * Where a provider is — EPIC-014 §8.1.
   *
   * Derived from the sets that already hold the facts rather than stored beside
   * them: two places recording the same thing is how they come to disagree.
   */
  stateOf(providerId: string): ProviderLifecycle | undefined {
    if (!this.#providers.has(providerId)) return undefined;

    const attempts = this.#budget.attemptsFor(providerId);
    const failureCode = this.#failed.get(providerId);
    const state = ((): ProviderLifecycleState => {
      if (this.#initialized.has(providerId)) return ProviderLifecycleState.INITIALIZED;
      if (this.#released) return ProviderLifecycleState.RELEASED;
      if (this.#disabled.has(providerId)) return ProviderLifecycleState.DISABLED;
      if (failureCode === undefined) return ProviderLifecycleState.REGISTERED;
      // The circuit as a state rather than a flag beside one: `unrecoverable`
      // is what an operator needs to read, and deriving it here means `recover`
      // and the health report cannot disagree about it.
      return this.#budget.exhausted(providerId) ? ProviderLifecycleState.UNRECOVERABLE : ProviderLifecycleState.FAILED;
    })();

    return { providerId, state, attempts, ...(failureCode === undefined ? {} : { failureCode }) };
  }

  /** Every provider's state, in registration order. */
  states(): readonly ProviderLifecycle[] {
    return this.list()
      .map((provider) => this.stateOf(provider.id))
      .filter((one): one is ProviderLifecycle => one !== undefined);
  }

  /**
   * One bounded attempt to initialize a failed optional provider — §8.2.
   *
   * Not a loop, not a timer, and never called from `initializeAll`: a start-up
   * that retried would turn a five-second start into a minute of silence, and
   * EPIC-093's contract is that the start *continues*.
   *
   * Answers EPIC-093 §16's open question — "if a failed optional provider
   * should ever recover without a restart of Ferret, that is EPIC-014's to
   * design."
   */
  async recover(providerId: string, host: ProviderHostContext): Promise<RecoveryResult> {
    const refusal = this.#refuseRecovery(providerId);
    if (refusal !== undefined) {
      const current = this.stateOf(providerId);
      host.logger.debug(
        { operation: 'provider.recover.refused', providerId, refusal },
        `Recovery of "${providerId}" was refused: ${refusal}`,
      );
      return {
        providerId,
        state: current?.state ?? ProviderLifecycleState.REGISTERED,
        recovered: false,
        refused: refusal,
        attempts: current?.attempts ?? 0,
        ...(current?.failureCode === undefined ? {} : { failureCode: current.failureCode }),
      };
    }

    const provider = this.#providers.get(providerId);
    if (provider === undefined) {
      return {
        providerId,
        state: ProviderLifecycleState.REGISTERED,
        recovered: false,
        refused: RecoveryRefusal.UNKNOWN,
        attempts: 0,
      };
    }

    try {
      // §16 — a failed provider may hold a half-open resource, and refusing to
      // retry because the cleanup of a previous failure failed would leave it
      // stuck for the wrong reason.
      await provider.shutdown?.();
    } catch (error) {
      host.logger.debug(
        { operation: 'provider.recover.release-failed', providerId, code: toFerretError(error).code },
        `Releasing "${providerId}" before recovery failed; continuing`,
      );
    }

    try {
      const settings = providerSettings(provider, host.config);
      await provider.initialize?.(this.#contextFor(host, provider, settings));
      this.#initialized.add(providerId);
      this.#failed.delete(providerId);
      // §8.3 — the count resets on success only.
      this.#budget.clear(providerId);
      host.logger.info(
        { operation: 'provider.recover.succeeded', providerId, kind: provider.kind },
        `Provider "${providerId}" recovered; the capabilities it offers are available again`,
      );
      return { providerId, state: ProviderLifecycleState.INITIALIZED, recovered: true, attempts: 0 };
    } catch (error) {
      const classified = toFerretError(error);
      this.#failed.set(providerId, classified.code);
      const attempts = this.#budget.record(providerId);
      host.logger.warn(
        // The code, never the message — EPIC-093's rule, for its reason: a
        // message can carry a path or a value, and this reaches a terminal.
        { operation: 'provider.recover.failed', providerId, code: classified.code, attempts },
        `Recovery of "${providerId}" failed (attempt ${String(attempts)} of ${String(MAX_RECOVERY_ATTEMPTS)})`,
      );
      return {
        providerId,
        state: this.#budget.exhausted(providerId) ? ProviderLifecycleState.UNRECOVERABLE : ProviderLifecycleState.FAILED,
        recovered: false,
        failureCode: classified.code,
        attempts,
      };
    }
  }

  /** Why a recovery may not proceed, or `undefined` when it may. */
  #refuseRecovery(providerId: string): RecoveryRefusal | undefined {
    if (!this.#providers.has(providerId)) return RecoveryRefusal.UNKNOWN;
    if (this.#initialized.has(providerId)) return RecoveryRefusal.ALREADY_RUNNING;
    if (this.#disabled.has(providerId)) return RecoveryRefusal.DISABLED;
    // §8.4 — a required provider's failure already tore the process down, so
    // there is nothing in this process to recover.
    if (!this.#optional.has(providerId)) return RecoveryRefusal.REQUIRED;
    if (this.#budget.exhausted(providerId)) return RecoveryRefusal.EXHAUSTED;
    return undefined;
  }

  /**
   * Whether a configuration path holds a secret a registered provider declared.
   *
   * A bound field rather than a method so it can be handed to `describeConfig`
   * on its own — the caller that renders configuration should not have to keep
   * the registry alongside it just to call back into it.
   */
  readonly isSecretConfigPath = (path: readonly string[]): boolean => {
    // Built once and cached: `describeConfig` calls this for every leaf, and
    // rebuilding the index per leaf would make rendering quadratic in the
    // number of providers.
    this.#secretPredicate ??= secretOptionPredicate(this.list());
    return this.#secretPredicate(path);
  };

  get size(): number {
    return this.#providers.size;
  }

  /**
   * The host context, narrowed to one provider.
   *
   * Two narrowings, and they are the same idea applied twice. EPIC-015 gave a
   * provider its own `settings` so it never sees another provider's options;
   * EPIC-081 removes every credential from `config` and hands back only the
   * ones this provider *declared*. The registry is where both belong: it is the
   * only code that knows which provider a context is being built for.
   */
  #contextFor(host: ProviderHostContext, provider: Provider, settings: ProviderSettings): ProviderContext {
    const { config, ...rest } = host;
    return {
      ...rest,
      config: withoutCredentialFields(config),
      credentials: credentialsFor(config, provider.credentials ?? []),
      settings,
    };
  }

  /**
   * Initializes every provider in registration order.
   *
   * On the first failure, providers already initialized are shut down before
   * the error propagates, so a failed start leaves nothing open.
   */
  async initializeAll(host: ProviderHostContext): Promise<void> {
    this.#sealed = true;
    this.#released = false;
    for (const provider of this.list()) {
      try {
        // Settings are resolved *inside* the try so a rejected schema is
        // handled the same way a failed initialize is: providers already
        // initialized are shut down, and the diagnosis the provider's own
        // schema produced survives into the error the caller sees.
        const settings = providerSettings(provider, host.config);
        if (!settings.enabled) {
          this.#disabled.add(provider.id);
          continue;
        }
        this.#disabled.delete(provider.id);
        await provider.initialize?.(this.#contextFor(host, provider, settings));
        this.#initialized.add(provider.id);
        this.#failed.delete(provider.id);
      } catch (error) {
        // EPIC-093 AC-1. An optional provider's failure is recorded and the
        // start continues; providers already initialized are *not* torn down,
        // which is the opposite of what the required path below does and is the
        // behaviour most easily got wrong.
        //
        // Isolation is not silence (§8.5): the failure is logged, described,
        // and surfaced in health. A provider that fails quietly converts a loud
        // failure into a silent capability gap, which is harder to diagnose
        // than the crash it replaced.
        if (this.#optional.has(provider.id)) {
          const classified = toFerretError(error);
          this.#failed.set(provider.id, classified.code);
          // EPIC-014 §8.3 — the start-up attempt counts, so a provider that
          // has already failed four times is `unrecoverable` from the outset
          // rather than after four more.
          this.#budget.record(provider.id);
          host.logger.warn(
            {
              operation: 'provider.initialize.failed',
              providerId: provider.id,
              kind: provider.kind,
              // The code, never the message: a message can carry a path or a
              // value, and this line reaches an operator's terminal.
              code: classified.code,
            },
            `Optional provider "${provider.id}" did not start; Ferret continues without it`,
          );
          continue;
        }
        // A provider that already classified its own failure keeps that
        // classification. Re-labelling "your database password is missing" as
        // "a provider failed to initialize" would cost the user the exit code,
        // the remediation and the retryability that make the error actionable —
        // exactly what EPIC-004 turns into `ferret doctor` advice. The provider
        // identity is added to the details rather than replacing the diagnosis.
        const classified = error instanceof FerretError ? error : undefined;
        const failure = new FerretError(
          classified?.code ?? ErrorCode.PROVIDER_INIT_FAILED,
          `Provider "${provider.id}" failed to initialize: ${toFerretError(error).message}`,
          {
            details: { ...(classified?.details ?? {}), providerId: provider.id, kind: provider.kind },
            ...(classified?.remediation === undefined ? {} : { remediation: classified.remediation }),
            retryable: classified?.retryable ?? false,
            cause: error,
          },
        );
        await this.shutdownAll();
        throw failure;
      }
    }
  }

  /** Runs every provider's dependency checks. A throwing check yields `unknown`. */
  async checkAll(host: ProviderHostContext): Promise<readonly DependencyCheckResult[]> {
    const results: DependencyCheckResult[] = [];

    // EPIC-093 AC-7. A provider that failed to start is reported here, before
    // anything else, because health is where an operator looks and because
    // isolation is not silence (§8.5): a capability quietly missing is harder
    // to diagnose than the crash it replaced.
    //
    // `required: false` — the provider was registered optional, so Ferret is
    // working as designed. Degraded, not unavailable.
    for (const { providerId, code } of this.failures()) {
      // EPIC-014 §8.5, AC-14 — the state is named, and the two states have
      // different advice. A `failed` provider can be recovered without
      // restarting Ferret; an `unrecoverable` one has spent its budget and
      // saying "try again" would be advice that cannot work.
      const exhausted = this.#budget.exhausted(providerId);
      const attempts = this.#budget.attemptsFor(providerId);
      results.push({
        name: `${providerId}:startup`,
        status: DependencyStatus.DEGRADED,
        required: false,
        detail: exhausted
          ? `The provider did not start (${code}) after ${String(attempts)} attempt(s) and will not be retried; Ferret is running without the capabilities it offers`
          : `The provider did not start (${code}); Ferret is running without the capabilities it offers`,
        remediation: exhausted
          ? `Fix the underlying failure — \`ferret doctor\` reports it — and start Ferret again, or disable "${providerId}" in configuration to stop attempting it.`
          : `Run \`ferret doctor\` for the underlying failure, or disable "${providerId}" in configuration to stop attempting it.`,
      });
    }

    for (const provider of this.list()) {
      if (provider.checkDependencies === undefined) continue;
      // A provider that is switched off has no dependencies worth reporting:
      // its external system being down is not a Ferret problem.
      if (this.#disabled.has(provider.id)) continue;
      // Nor has one that never started: its check would run against an object
      // whose `initialize` threw, and would report a confusing second failure
      // rather than the first one.
      if (this.#failed.has(provider.id)) continue;
      try {
        const settings = providerSettings(provider, host.config);
        results.push(...(await provider.checkDependencies(this.#contextFor(host, provider, settings))));
      } catch (error) {
        results.push({
          name: `${provider.id}:dependencies`,
          status: DependencyStatus.UNKNOWN,
          required: false,
          detail: `Dependency check failed: ${toFerretError(error).message}`,
        });
      }
    }
    return results;
  }

  /**
   * Shuts down initialized providers in reverse registration order.
   *
   * Every provider is attempted even when an earlier one fails, so one bad
   * provider cannot strand another's resources. Failures are collected and
   * returned rather than thrown.
   */
  async shutdownAll(): Promise<readonly FerretError[]> {
    const failures: FerretError[] = [];
    for (const provider of [...this.list()].reverse()) {
      if (!this.#initialized.has(provider.id)) continue;
      try {
        await provider.shutdown?.();
      } catch (error) {
        failures.push(
          new FerretError(
            ErrorCode.SHUTDOWN_FAILED,
            `Provider "${provider.id}" failed to shut down: ${toFerretError(error).message}`,
            { details: { providerId: provider.id }, cause: error },
          ),
        );
      } finally {
        this.#initialized.delete(provider.id);
      }
    }
    this.#released = true;
    return failures;
  }
}
