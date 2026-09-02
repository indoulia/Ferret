import type { FerretConfig, ProviderVisibleConfig } from '../config/index.js';
import type { DependencyCheckResult } from '../diagnostics/index.js';
import type { EnvironmentReport } from '../environment/index.js';
import type { Logger } from '../logging/index.js';

import type { Capability, CapabilityDeclaration } from './capabilities.js';
import type { ProviderOptionsSchema, ProviderSettings } from './configuration.js';

/**
 * Version of the provider contract itself.
 *
 * A provider declares the version it was built against; the registry refuses
 * anything it cannot honour. Governance §4 requires provider contracts to be
 * versioned.
 */
export const PROVIDER_CONTRACT_VERSION = 1;

/**
 * The oldest contract version this runtime still honours.
 *
 * EPIC-001 compared for exact equality, which made every contract change a
 * flag day: a provider built against version 1 would be refused by a runtime
 * implementing version 2, even where nothing it used had changed. EPIC-010 AC-4
 * requires provider contract compatibility to be *explicit*, so the supported
 * span is stated rather than implied by an equality check.
 *
 * It is currently equal to {@link PROVIDER_CONTRACT_VERSION}, so behaviour is
 * unchanged — which is the right moment to fix the rule, before there is
 * pressure to bend it for a specific provider.
 *
 * Raising this drops support for providers built against older contracts and
 * belongs in a release note, not a refactor.
 */
export const MINIMUM_PROVIDER_CONTRACT_VERSION = 1;

/** True when this runtime can honour a provider built against `version`. */
export function isSupportedContractVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MINIMUM_PROVIDER_CONTRACT_VERSION &&
    version <= PROVIDER_CONTRACT_VERSION
  );
}

/**
 * Categories of replaceable implementation.
 *
 * Governance §4 puts *every* replaceable implementation behind a provider
 * contract, so storage, indexing and the MCP surface are provider kinds rather
 * than separate parallel abstraction stacks. Owning Epics:
 *
 * - `storage`   — EPIC-086 PostgreSQL Storage Layer
 * - `index`     — EPIC-031 Incremental Indexing
 * - `source`    — EPIC-017 Local Repository Discovery, EPIC-021 GitHub, EPIC-071 Jira
 * - `parser`    — EPIC-024 Parser Framework
 * - `mcp`       — EPIC-064 MCP Server
 * - `embedding` — EPIC-054 Semantic Retrieval
 */
export const ProviderKind = {
  STORAGE: 'storage',
  INDEX: 'index',
  SOURCE: 'source',
  PARSER: 'parser',
  MCP: 'mcp',
  EMBEDDING: 'embedding',
} as const;

export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

const KINDS: ReadonlySet<string> = new Set(Object.values(ProviderKind));

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && KINDS.has(value);
}

/** Provider identifiers are lowercase dotted segments, e.g. `ferret.storage.postgres`. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

/**
 * Everything a provider is given at initialization.
 *
 * Providers receive capabilities, never global state: no provider reaches for
 * `process.env` or constructs its own logger, so a provider remains testable
 * and its configuration remains subject to Ferret's precedence rules.
 */
export interface ProviderContext {
  readonly logger: Logger;
  /**
   * Everything Ferret is configured with, minus every credential — EPIC-081.
   *
   * `database.password` is absent from the type, so reaching for it does not
   * compile. A provider that legitimately needs a credential declares it (see
   * {@link ProviderDescriptor.credentials}) and reads it from
   * {@link ProviderContext.credentials}.
   */
  readonly config: ProviderVisibleConfig;
  /**
   * The credentials this provider declared, keyed by the path it declared.
   *
   * Optional, and absent means *none granted* — the safe direction. A context
   * assembled by hand (a test, a conformance harness) therefore grants nothing
   * unless it says so, which is the behaviour a forgotten field should have.
   * Empty for every provider that declared none, which is all of them but one.
   */
  readonly credentials?: Readonly<Record<string, string>>;
  readonly environment: EnvironmentReport;
  /** Aborted when the runtime begins shutting down. */
  readonly signal: AbortSignal;
  /**
   * This provider's own configuration, validated against whatever it declared.
   *
   * Derived per provider by the registry (EPIC-015), so it never contains
   * another provider's options.
   */
  readonly settings: ProviderSettings;
}

/**
 * What the runtime supplies once, for every provider.
 *
 * The registry derives a {@link ProviderContext} from this per provider by
 * adding that provider's settings; the host cannot build one itself because it
 * would have to pick a provider to build it for.
 */
export type ProviderHostContext = Omit<ProviderContext, 'settings' | 'config' | 'credentials'> & {
  /**
   * The whole configuration, credentials included.
   *
   * The host holds it because the host resolved it. What crosses into a
   * provider is the registry's projection of it — EPIC-081 §8.1 — which is why
   * this type and {@link ProviderContext} no longer agree about `config`.
   */
  readonly config: FerretConfig;
};

/**
 * The stable contract every external system and replaceable implementation
 * sits behind.
 *
 * All lifecycle hooks are optional so a provider implements only what it needs.
 * `shutdown` is called in reverse registration order and must be idempotent.
 */
export interface Provider {
  /** Globally unique, stable across releases. */
  readonly id: string;
  readonly kind: ProviderKind;
  /** The {@link PROVIDER_CONTRACT_VERSION} this provider was built against. */
  readonly contractVersion: number;
  readonly description?: string;
  /**
   * What this provider can do, and at which contract version.
   *
   * The core selects a provider by *capability*, never by identity, so this is
   * how a provider becomes reachable at all. `kind` remains as the coarse
   * category EPIC-001 established — useful for grouping and for shutdown order —
   * but it is not what a consumer asks for.
   *
   * Optional so EPIC-001-era providers keep working unchanged; a provider that
   * declares nothing is registered and lifecycle-managed but is never selected
   * for a capability, which is the honest outcome rather than a silent one.
   */
  readonly capabilities?: readonly CapabilityDeclaration[];
  /**
   * The shape of this provider's `options`, validated before `initialize`.
   *
   * Optional: a provider that declares nothing receives its options unchanged.
   * Governance §4 keeps provider-specific validation with the provider — the
   * core knows only that a schema exists and where its failures point.
   */
  readonly configSchema?: ProviderOptionsSchema;
  /**
   * Dotted paths into `options` whose values are credentials.
   *
   * Redaction by key name cannot know that `pat` is a token. Declaring the path
   * is how a provider makes its secrets redactable; a declared path covers
   * everything beneath it.
   */
  readonly secretOptions?: readonly string[];
  /**
   * Credential configuration paths this provider needs — EPIC-081 §8.1.
   *
   * Declared, so that receiving a credential is a visible property of a
   * provider rather than a consequence of being loaded. Today exactly one
   * provider declares anything: the storage provider, which opens the
   * connection the credential exists for.
   *
   * A path not in `CREDENTIAL_CONFIG_PATHS` is ignored rather than honoured —
   * this grants access to known credentials, it does not define new ones.
   */
  readonly credentials?: readonly string[];
  /** Prepare the provider. Throwing here fails runtime initialization. */
  initialize?(context: ProviderContext): Promise<void> | void;
  /** Report on external systems this provider depends on. Must not mutate. */
  checkDependencies?(
    context: ProviderContext,
  ): Promise<readonly DependencyCheckResult[]> | readonly DependencyCheckResult[];
  /** Release resources. Must tolerate being called without `initialize`. */
  shutdown?(): Promise<void> | void;
}

/** Immutable description of a registered provider. */
export interface ProviderDescriptor {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly contractVersion: number;
  readonly description?: string;
  readonly initialized: boolean;
  /**
   * Whether configuration leaves this provider switched on.
   *
   * A disabled provider is still described: "installed and off" is a different
   * answer from "not installed", and only one of them is a missing dependency.
   */
  readonly enabled: boolean;
  /**
   * Why this provider did not start, when it tried and failed — EPIC-093 §8.4.
   *
   * Present only for an *optional* provider whose `initialize` threw. Failed
   * and disabled are different facts: one is a configuration decision and the
   * other is an event, and Governance §6 requires them to look different. An
   * operator asking why content indexing is not running needs to know which
   * happened.
   *
   * The error's code, not its message. A message can carry a path or a value;
   * a code is a fact about the failure.
   */
  readonly failure?: string;
  /** Capabilities declared, so diagnostics can report what a provider offers. */
  readonly capabilities: readonly Capability[];
}

export function describeProvider(
  provider: Provider,
  initialized: boolean,
  enabled = true,
  failure?: string,
): ProviderDescriptor {
  const descriptor: {
    id: string;
    kind: ProviderKind;
    contractVersion: number;
    description?: string;
    initialized: boolean;
    enabled: boolean;
    failure?: string;
    capabilities: readonly Capability[];
  } = {
    id: provider.id,
    kind: provider.kind,
    contractVersion: provider.contractVersion,
    initialized,
    enabled,
    ...(failure === undefined ? {} : { failure }),
    capabilities: (provider.capabilities ?? []).map((declaration) => declaration.capability),
  };
  if (provider.description !== undefined) descriptor.description = provider.description;
  return descriptor;
}
