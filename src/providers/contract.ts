import type { FerretConfig } from '../config/index.js';
import type { DependencyCheckResult } from '../diagnostics/index.js';
import type { EnvironmentReport } from '../environment/index.js';
import type { Logger } from '../logging/index.js';

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
  readonly config: FerretConfig;
  readonly environment: EnvironmentReport;
  /** Aborted when the runtime begins shutting down. */
  readonly signal: AbortSignal;
}

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
}

export function describeProvider(provider: Provider, initialized: boolean): ProviderDescriptor {
  const descriptor: {
    id: string;
    kind: ProviderKind;
    contractVersion: number;
    description?: string;
    initialized: boolean;
  } = {
    id: provider.id,
    kind: provider.kind,
    contractVersion: provider.contractVersion,
    initialized,
  };
  if (provider.description !== undefined) descriptor.description = provider.description;
  return descriptor;
}
