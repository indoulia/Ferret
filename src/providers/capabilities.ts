import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * What a provider can *do*, as opposed to what it *is*.
 *
 * EPIC-001 gave providers a lifecycle: registered, initialized, health-checked,
 * shut down. What it did not express is capability, and the difference only
 * becomes visible at the second provider.
 *
 * A Git source provider and a GitHub source provider have almost nothing in
 * common as classes and everything in common as capabilities — both enumerate
 * repositories, both fetch history, neither parses a PDF. Without capability
 * contracts every consuming Epic invents its own coupling: EPIC-017 would import
 * a Git provider directly, EPIC-021 a GitHub one, and "replacing a provider does
 * not require unrelated core changes" would be false by the time three existed.
 *
 * So the core asks for a *capability* and is handed whichever provider offers
 * it. Nothing in `src/` outside a provider names a concrete provider, and the
 * boundary test proves it.
 */

export const Capability = {
  /** Persist and read canonical knowledge. */
  STORAGE: 'storage',
  /** Discover repositories, branches and worktrees. */
  SOURCE_REPOSITORY: 'source.repository',
  /** Enumerate commits and the changes they made. */
  SOURCE_HISTORY: 'source.history',
  /** Enumerate and read files. */
  SOURCE_FILE: 'source.file',
  /** Issues, pull requests, reviews, releases, deployments. */
  SOURCE_PROJECT: 'source.project',
  /**
   * Acquire, identify and normalize records from any source — EPIC-119.
   *
   * The common boundary the three above are *not*: each of them is shaped
   * around what one kind of system holds, and a source that is neither a Git
   * checkout nor a tracker can implement none of them. A connector declares
   * this instead, and reaches the same storage, index and retrieval path.
   */
  SOURCE_CONNECTOR: 'source.connector',
  /** Turn file content into structured extraction. */
  PARSER: 'parser',
  /** Produce vectors for semantic retrieval. */
  EMBEDDING: 'embedding',
  /** Serve the AI control plane. */
  MCP: 'mcp',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export const CAPABILITIES: readonly Capability[] = Object.freeze(Object.values(Capability));

const KNOWN: ReadonlySet<string> = new Set(CAPABILITIES);

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * The version of each capability contract, independent of the others.
 *
 * Per-capability rather than one number for all of them: changing what a parser
 * must implement should not invalidate every storage provider. EPIC-010's
 * runtime-wide `PROVIDER_CONTRACT_VERSION` still governs the *shape* of a
 * provider; these govern the shape of each capability.
 */
export const CAPABILITY_VERSIONS: Readonly<Record<Capability, number>> = Object.freeze({
  [Capability.STORAGE]: 1,
  // EPIC-108 raised this to 2 when the content-read operation was added. The
  // minimum stays 1 below, so nothing built against version 1 stops working;
  // what a version-1 provider does *not* get is the new operation, which
  // `operationIntroducedAt` enforces rather than trusting a declaration.
  [Capability.SOURCE_REPOSITORY]: 2,
  [Capability.SOURCE_HISTORY]: 1,
  [Capability.SOURCE_FILE]: 1,
  [Capability.SOURCE_PROJECT]: 1,
  [Capability.SOURCE_CONNECTOR]: 1,
  [Capability.PARSER]: 1,
  [Capability.EMBEDDING]: 1,
  [Capability.MCP]: 1,
});

/**
 * The oldest version of each capability this runtime still accepts.
 *
 * Currently equal to the current version, so the span is a single version —
 * stated rather than implied, exactly as EPIC-010 did for the provider contract.
 * Raising one drops support for providers built against the older contract and
 * belongs in a release note.
 */
export const MINIMUM_CAPABILITY_VERSIONS: Readonly<Record<Capability, number>> = Object.freeze({
  [Capability.STORAGE]: 1,
  [Capability.SOURCE_REPOSITORY]: 1,
  [Capability.SOURCE_HISTORY]: 1,
  [Capability.SOURCE_FILE]: 1,
  [Capability.SOURCE_PROJECT]: 1,
  [Capability.SOURCE_CONNECTOR]: 1,
  [Capability.PARSER]: 1,
  [Capability.EMBEDDING]: 1,
  [Capability.MCP]: 1,
});

/**
 * The capability version at which an operation became part of the contract.
 *
 * Only operations introduced *after* version 1 appear; everything else was
 * there from the start and needs no entry.
 *
 * This exists because of one specific hole. {@link declares} returns `true` when
 * a declaration omits `operations` — "omitting the field means all of them" —
 * and that reading is correct only for the operations that existed when the
 * declaration was written. Without this map, adding an operation makes every
 * already-written declaration silently begin claiming it, and the failure
 * surfaces as a missing method at the call site rather than as an honest
 * unsupported verdict. EPIC-108 §8.4.
 *
 * The keys are string literals rather than the `RepositoryOperation` constants
 * because `contracts/source-repository.ts` reaches a logger and therefore an
 * external package, and the capability contract is asserted to reach neither.
 * `tests/unit/capabilities.test.ts` asserts the literals and the constants
 * agree, so the duplication cannot drift unnoticed.
 */
export const CAPABILITY_OPERATION_VERSIONS: Readonly<
  Partial<Record<Capability, Readonly<Record<string, number>>>>
> = Object.freeze({
  [Capability.SOURCE_REPOSITORY]: Object.freeze({
    // EPIC-108: reading a file's bytes at a revision.
    readFileContent: 2,
  }),
});

/**
 * The capability version an operation was introduced at. 1 unless recorded.
 *
 * An unknown operation answers 1, deliberately: this function decides whether a
 * declaration is too old to be claiming something, and an operation nobody has
 * recorded is not one this runtime added.
 */
export function operationIntroducedAt(capability: Capability, operation: string): number {
  return CAPABILITY_OPERATION_VERSIONS[capability]?.[operation] ?? 1;
}

/**
 * A provider's declared limits.
 *
 * Honesty about what a provider *cannot* do is as useful as knowing what it can.
 * A caller that knows a provider cannot filter server-side will fetch and filter
 * locally; one that discovers it at the call site fails, or silently returns
 * everything. Governance §6 forbids manufacturing certainty, and a caller
 * assuming a capability it never checked is doing exactly that.
 */
export interface CapabilityLimits {
  /** Whether results can be requested in pages. */
  readonly supportsPagination?: boolean;
  /** Whether the source can filter, rather than the caller filtering after. */
  readonly supportsServerSideFilter?: boolean;
  /** Whether the source can return only what changed since a cursor. */
  readonly supportsIncremental?: boolean;
  /** Largest page the source will return, when it is bounded. */
  readonly maxPageSize?: number;
  /** Requests per minute the source permits, when it is rate limited. */
  readonly rateLimitPerMinute?: number;
  /** Anything else the provider wants a caller to know before it asks. */
  readonly notes?: string;
}

/**
 * One capability a provider offers.
 *
 * `operations` is what makes *partial* implementation usable. A source provider
 * that can list repositories but not read history declares
 * `source.repository` and omits `source.history`; a provider that implements
 * most of a capability names the operations it actually supports, and a caller
 * asks before calling rather than discovering by exception.
 */
export interface CapabilityDeclaration {
  readonly capability: Capability;
  /** The contract version this implementation was built against. */
  readonly version: number;
  /**
   * Operations within the capability that this provider supports.
   *
   * Omitted means "all of them" — all of them *at the version being declared*.
   * It never reaches forward into an operation added later; see
   * {@link CAPABILITY_OPERATION_VERSIONS}. Naming a subset is how a provider is
   * honest about a partial implementation rather than failing at the call.
   */
  readonly operations?: readonly string[];
  readonly limits?: CapabilityLimits;
  /** The external systems this capability talks to, e.g. `['github']`. */
  readonly systems?: readonly string[];
}

export const CapabilitySupport = {
  /** Declared, at a supported version. */
  SUPPORTED: 'supported',
  /** Declared, but at a version this runtime cannot honour. */
  UNSUPPORTED_VERSION: 'unsupported-version',
  /** Declared, but this particular operation is not implemented. */
  OPERATION_UNSUPPORTED: 'operation-unsupported',
  /** Not declared by any registered provider. */
  UNAVAILABLE: 'unavailable',
} as const;

export type CapabilitySupport = (typeof CapabilitySupport)[keyof typeof CapabilitySupport];

export interface CapabilityVerdict {
  readonly capability: Capability;
  readonly support: CapabilitySupport;
  /** The provider that offers it, when one does. */
  readonly providerId: string | undefined;
  readonly declaredVersion: number | undefined;
  readonly detail: string;
  readonly remediation: string | undefined;
}

/** True when this runtime can honour a capability declared at `version`. */
export function isSupportedCapabilityVersion(capability: Capability, version: number): boolean {
  const current = CAPABILITY_VERSIONS[capability];
  const minimum = MINIMUM_CAPABILITY_VERSIONS[capability];
  return Number.isInteger(version) && version >= minimum && version <= current;
}

/**
 * Validates a declaration at registration.
 *
 * A provider declaring a capability it does not implement is a **defect, not a
 * degradation** — every caller that selects it would fail, and the failure would
 * appear far from its cause. Refusing at registration turns it into a startup
 * error naming the provider.
 *
 * @throws {FerretError} `E_PROVIDER_INVALID`.
 */
export function validateCapabilityDeclaration(providerId: string, declaration: CapabilityDeclaration): void {
  const invalid = (message: string, details: Record<string, unknown>, remediation: string): FerretError =>
    new FerretError(ErrorCode.PROVIDER_INVALID, message, {
      details: { providerId, ...details },
      remediation,
    });

  if (!isCapability(declaration.capability)) {
    throw invalid(
      `Provider "${providerId}" declares unknown capability "${String(declaration.capability)}"`,
      { capability: String(declaration.capability), known: CAPABILITIES },
      `Declare one of: ${CAPABILITIES.join(', ')}.`,
    );
  }

  if (!isSupportedCapabilityVersion(declaration.capability, declaration.version)) {
    throw invalid(
      `Provider "${providerId}" declares ${declaration.capability} at version ${String(declaration.version)}, but this runtime supports ${String(MINIMUM_CAPABILITY_VERSIONS[declaration.capability])}–${String(CAPABILITY_VERSIONS[declaration.capability])}`,
      {
        capability: declaration.capability,
        declared: declaration.version,
        supported: CAPABILITY_VERSIONS[declaration.capability],
        minimumSupported: MINIMUM_CAPABILITY_VERSIONS[declaration.capability],
      },
      'Update the provider to a supported capability version, or upgrade Ferret.',
    );
  }

  if (declaration.operations !== undefined && declaration.operations.length === 0) {
    // An empty list is ambiguous — it reads as "no operations", which is not a
    // capability. Omitting the field means "all of them"; a partial
    // implementation names what it has.
    throw invalid(
      `Provider "${providerId}" declares ${declaration.capability} with an empty operation list`,
      { capability: declaration.capability },
      'Omit `operations` to declare full support, or name the operations this provider implements.',
    );
  }
}

/**
 * True when a declaration covers a named operation.
 *
 * Two questions, in this order, and the order is the point.
 *
 * **Is the declaration new enough to be talking about this operation at all?**
 * A provider declaring version 1 is describing the operation set that existed at
 * version 1, and that set is closed. It is never considered to support anything
 * added later — not by omitting `operations`, and not by naming it either. A
 * declaration written before an operation existed cannot have meant it, and a
 * declaration that names an operation its version does not contain is claiming
 * something it was not built against. EPIC-108 §8.4, parts 3 and 4.
 *
 * **Then: did it name the operation, or claim all of them?** The original rule,
 * unchanged, and applied only within the version's own operation set.
 */
export function declares(declaration: CapabilityDeclaration, operation: string): boolean {
  if (declaration.version < operationIntroducedAt(declaration.capability, operation)) return false;
  return declaration.operations === undefined || declaration.operations.includes(operation);
}

/**
 * Explains what a capability's availability is, without throwing.
 *
 * A capability with no provider is a *reportable state*, not an error: Ferret
 * says semantic retrieval is unavailable rather than failing when someone
 * happens to search. EPIC-004's diagnostics surface these directly.
 */
export function describeSupport(
  capability: Capability,
  declaration: { providerId: string; declaration: CapabilityDeclaration } | undefined,
  operation?: string,
): CapabilityVerdict {
  if (declaration === undefined) {
    return {
      capability,
      support: CapabilitySupport.UNAVAILABLE,
      providerId: undefined,
      declaredVersion: undefined,
      detail: `No registered provider offers ${capability}`,
      remediation: `Install and configure a provider that implements ${capability}.`,
    };
  }

  const { providerId, declaration: declared } = declaration;

  if (!isSupportedCapabilityVersion(capability, declared.version)) {
    return {
      capability,
      support: CapabilitySupport.UNSUPPORTED_VERSION,
      providerId,
      declaredVersion: declared.version,
      detail: `Provider "${providerId}" offers ${capability} at version ${String(declared.version)}, which this runtime cannot honour`,
      remediation: 'Update the provider, or upgrade Ferret.',
    };
  }

  if (operation !== undefined && !declares(declared, operation)) {
    // Two ways to not support an operation, and they send a reader to different
    // places: a provider that could implement it and did not, and a provider
    // declared against a contract version that did not contain it. Saying which
    // is the difference between "use another provider" and "update this one".
    const introduced = operationIntroducedAt(capability, operation);
    const tooOld = declared.version < introduced;
    return {
      capability,
      support: CapabilitySupport.OPERATION_UNSUPPORTED,
      providerId,
      declaredVersion: declared.version,
      detail: tooOld
        ? `Provider "${providerId}" declares ${capability} at version ${String(declared.version)}, and the "${operation}" operation was introduced at version ${String(introduced)}`
        : `Provider "${providerId}" implements ${capability} but not the "${operation}" operation`,
      remediation: tooOld
        ? `Update the provider to declare ${capability} version ${String(introduced)} or later, and implement ${operation}.`
        : `Use a provider that implements ${operation}, or take the path that does not need it.`,
    };
  }

  return {
    capability,
    support: CapabilitySupport.SUPPORTED,
    providerId,
    declaredVersion: declared.version,
    detail: `Provider "${providerId}" offers ${capability} at version ${String(declared.version)}`,
    remediation: undefined,
  };
}

/**
 * Refuses to proceed when a capability is not usable.
 *
 * For the call sites that genuinely cannot degrade. Most should ask
 * {@link describeSupport} and adapt instead — Governance §13 wants a missing
 * capability to reduce what Ferret can answer, not to break what it can.
 */
export function assertSupported(verdict: CapabilityVerdict): void {
  if (verdict.support === CapabilitySupport.SUPPORTED) return;
  throw new FerretError(ErrorCode.CAPABILITY_UNAVAILABLE, verdict.detail, {
    details: {
      capability: verdict.capability,
      support: verdict.support,
      ...(verdict.providerId === undefined ? {} : { providerId: verdict.providerId }),
    },
    ...(verdict.remediation === undefined ? {} : { remediation: verdict.remediation }),
  });
}
