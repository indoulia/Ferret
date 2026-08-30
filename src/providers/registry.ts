import { ErrorCode, FerretError, toFerretError } from '../errors/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';

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
  #sealed = false;

  /**
   * Validates and records a provider.
   *
   * @throws {FerretError} `E_PROVIDER_INVALID` for a malformed provider,
   * `E_PROVIDER_DUPLICATE` when the identifier is already taken.
   */
  register(provider: Provider): void {
    if (this.#sealed) {
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        'Providers cannot be registered after the runtime has initialized',
        { details: { providerId: provider?.id }, remediation: 'Register providers before calling initialize().' },
      );
    }
    this.#validate(provider);
    if (this.#providers.has(provider.id)) {
      throw new FerretError(
        ErrorCode.PROVIDER_DUPLICATE,
        `A provider with id "${provider.id}" is already registered`,
        { details: { providerId: provider.id } },
      );
    }
    this.#providers.set(provider.id, provider);
    this.#order.push(provider.id);
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

  describe(): readonly ProviderDescriptor[] {
    return this.list().map((provider) => describeProvider(provider, this.#initialized.has(provider.id)));
  }

  get size(): number {
    return this.#providers.size;
  }

  /**
   * Initializes every provider in registration order.
   *
   * On the first failure, providers already initialized are shut down before
   * the error propagates, so a failed start leaves nothing open.
   */
  async initializeAll(context: ProviderContext): Promise<void> {
    this.#sealed = true;
    for (const provider of this.list()) {
      try {
        await provider.initialize?.(context);
        this.#initialized.add(provider.id);
      } catch (error) {
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
  async checkAll(context: ProviderContext): Promise<readonly DependencyCheckResult[]> {
    const results: DependencyCheckResult[] = [];
    for (const provider of this.list()) {
      if (provider.checkDependencies === undefined) continue;
      try {
        results.push(...(await provider.checkDependencies(context)));
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
    return failures;
  }
}
