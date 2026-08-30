import { ErrorCode, FerretError } from '../errors/index.js';

/**
 * One compatibility policy for every versioned surface.
 *
 * By EPIC-009 Ferret had four independently versioned things — the database
 * schema, the entity envelope, the configuration file and the provider contract
 * — each of which had grown the same reflex in isolation: *refuse anything
 * newer than this build understands*. That reflex is right, but four copies of
 * it is not a policy. Nobody could say what Ferret supports without reading four
 * modules, and nothing stopped the fifth surface from choosing differently.
 *
 * This module states the policy once:
 *
 * - **Newer than we understand → refuse, before any write.** A newer version may
 *   have moved a field, and reading it under the old meaning applies an
 *   interpretation the writer never intended — silently, which is the worst way
 *   to be wrong.
 * - **Older but supported → upgrade.** Deterministically, along a path that is
 *   tested from every version Ferret still claims to read.
 * - **Older than supported → refuse, with the version that can read it.** An
 *   honest dead end beats a partial migration.
 * - **Downgrade → refuse.** Ferret does not write data an older build can read,
 *   and pretending otherwise loses whatever the newer version added.
 */

/** A thing that carries a version and can therefore be incompatible. */
export const VersionedSurface = {
  /** The PostgreSQL schema, versioned by applied migrations (EPIC-002). */
  DATABASE_SCHEMA: 'database-schema',
  /** The canonical entity envelope (EPIC-006). */
  ENTITY_SCHEMA: 'entity-schema',
  /** The persisted configuration file format (EPIC-003). */
  CONFIG_FILE: 'config-file',
  /** The provider contract a provider is built against (EPIC-001). */
  PROVIDER_CONTRACT: 'provider-contract',
  /** A derived artefact — an index, an embedding, a summary (EPIC-031, EPIC-054). */
  DERIVED_ARTIFACT: 'derived-artifact',
} as const;

export type VersionedSurface = (typeof VersionedSurface)[keyof typeof VersionedSurface];

export interface SurfacePolicy {
  readonly surface: VersionedSurface;
  /** The version this build writes. */
  readonly current: number;
  /**
   * The oldest version this build can still read and upgrade from.
   *
   * Narrowing this is a breaking change for anyone on an older version, and
   * belongs in a release note rather than a refactor.
   */
  readonly minimumSupported: number;
  /** What a caller should do when the stored version is too old. */
  readonly upgradeHint: string;
  /** What a caller should do when the stored version is too new. */
  readonly newerHint: string;
}

export const Compatibility = {
  /** The stored version is exactly what this build writes. */
  CURRENT: 'current',
  /** Older, supported, and upgradable. */
  UPGRADABLE: 'upgradable',
  /** Newer than this build understands. Refuse. */
  TOO_NEW: 'too-new',
  /** Older than this build still supports. Refuse. */
  TOO_OLD: 'too-old',
} as const;

export type Compatibility = (typeof Compatibility)[keyof typeof Compatibility];

export interface CompatibilityVerdict {
  readonly surface: VersionedSurface;
  readonly found: number;
  readonly expected: number;
  readonly minimumSupported: number;
  readonly compatibility: Compatibility;
  /** True when Ferret may write to this surface as it stands. */
  readonly safeToWrite: boolean;
  readonly detail: string;
  readonly remediation: string | undefined;
}

/**
 * The policy for every surface the core ships.
 *
 * Versions are currently all `1` because nothing has evolved yet — which is the
 * right moment to fix the rules, before there is pressure to bend them for a
 * specific migration.
 */
export const SURFACE_POLICIES: Readonly<Record<VersionedSurface, SurfacePolicy>> = Object.freeze({
  [VersionedSurface.DATABASE_SCHEMA]: {
    surface: VersionedSurface.DATABASE_SCHEMA,
    current: 0, // Filled in from the shipped migration set; see `databaseSchemaPolicy`.
    minimumSupported: 0,
    upgradeHint: 'Run `ferret init` to apply the pending migrations.',
    newerHint:
      'This database was migrated by a newer Ferret. Upgrade Ferret (`npm install -g @indoulia/ferret@latest`) rather than downgrading the database.',
  },
  [VersionedSurface.ENTITY_SCHEMA]: {
    surface: VersionedSurface.ENTITY_SCHEMA,
    current: 1,
    minimumSupported: 1,
    upgradeHint: 'Re-index the source, or run `ferret init` to apply a migration that rewrites it.',
    newerHint: 'This data was written by a newer Ferret. Upgrade Ferret rather than downgrading the data.',
  },
  [VersionedSurface.CONFIG_FILE]: {
    surface: VersionedSurface.CONFIG_FILE,
    current: 1,
    minimumSupported: 1,
    upgradeHint: 'Ferret will rewrite the file in the current format on the next `ferret config set`.',
    newerHint:
      'This file was written by a newer Ferret. Upgrade Ferret, or delete the file — Ferret starts with no configuration at all.',
  },
  [VersionedSurface.PROVIDER_CONTRACT]: {
    surface: VersionedSurface.PROVIDER_CONTRACT,
    current: 1,
    minimumSupported: 1,
    upgradeHint: 'Update the provider to a build targeting a supported contract version.',
    newerHint: 'This provider targets a newer contract than this Ferret implements. Upgrade Ferret.',
  },
  [VersionedSurface.DERIVED_ARTIFACT]: {
    surface: VersionedSurface.DERIVED_ARTIFACT,
    current: 1,
    minimumSupported: 1,
    upgradeHint: 'Rebuild the derived artefact; the producer that made it has changed.',
    newerHint: 'This artefact was built by a newer Ferret. Upgrade Ferret rather than rebuilding downward.',
  },
});

/** The database schema's policy, whose current version comes from the migrations. */
export function databaseSchemaPolicy(targetVersion: number): SurfacePolicy {
  return {
    ...SURFACE_POLICIES[VersionedSurface.DATABASE_SCHEMA],
    current: targetVersion,
    // Ferret can bring any earlier version forward, including an empty database,
    // because every migration in the shipped set is replayable in order.
    minimumSupported: 0,
  };
}

/**
 * Classifies a stored version against a policy.
 *
 * Pure, so the rules can be tested exhaustively rather than only through the
 * subsystems that apply them.
 */
export function checkCompatibility(policy: SurfacePolicy, found: number): CompatibilityVerdict {
  const base = {
    surface: policy.surface,
    found,
    expected: policy.current,
    minimumSupported: policy.minimumSupported,
  };

  if (found > policy.current) {
    return {
      ...base,
      compatibility: Compatibility.TOO_NEW,
      // Never. A newer version may have moved a field, and writing to it under
      // the old meaning corrupts what the newer build understands.
      safeToWrite: false,
      detail: `${policy.surface} is at version ${String(found)}, but this Ferret writes version ${String(policy.current)}`,
      remediation: policy.newerHint,
    };
  }

  if (found < policy.minimumSupported) {
    return {
      ...base,
      compatibility: Compatibility.TOO_OLD,
      safeToWrite: false,
      detail: `${policy.surface} is at version ${String(found)}, which this Ferret no longer supports (minimum ${String(policy.minimumSupported)})`,
      remediation: policy.upgradeHint,
    };
  }

  if (found < policy.current) {
    return {
      ...base,
      compatibility: Compatibility.UPGRADABLE,
      // Deliberately false. An upgradable surface must be upgraded *before* it
      // is written to, or a write lands in a shape the upgrade then has to
      // reconcile — which is how a migration acquires special cases.
      safeToWrite: false,
      detail: `${policy.surface} is at version ${String(found)} and can be upgraded to ${String(policy.current)}`,
      remediation: policy.upgradeHint,
    };
  }

  return {
    ...base,
    compatibility: Compatibility.CURRENT,
    safeToWrite: true,
    detail: `${policy.surface} is at the current version ${String(found)}`,
    remediation: undefined,
  };
}

/**
 * Refuses to proceed when a surface cannot be written to.
 *
 * AC-3: incompatible versions must fail clearly **before unsafe writes**. Called
 * at the boundary of every write path, so the check cannot be forgotten in one
 * of them.
 */
export function assertSafeToWrite(verdict: CompatibilityVerdict): void {
  if (verdict.safeToWrite) return;

  const code =
    verdict.compatibility === Compatibility.UPGRADABLE
      ? ErrorCode.MIGRATION_PENDING
      : ErrorCode.SCHEMA_UNSUPPORTED;

  throw new FerretError(code, verdict.detail, {
    details: {
      surface: verdict.surface,
      found: verdict.found,
      expected: verdict.expected,
      minimumSupported: verdict.minimumSupported,
      compatibility: verdict.compatibility,
    },
    ...(verdict.remediation === undefined ? {} : { remediation: verdict.remediation }),
  });
}

/**
 * Whether an artefact built by one producer version is still valid.
 *
 * Governance §21 requires parsers, models and extraction mechanisms to be
 * versioned where changes affect reproducibility. A derived index built by
 * `pdf@6.3.289` is not interchangeable with one the current parser would build,
 * and treating them as equivalent means serving results nobody could reproduce.
 *
 * String comparison rather than semver: a producer version is an opaque token
 * that may be a semver, a git sha or a model name. Ferret cannot know whether a
 * change was breaking, so **any** difference marks the artefact for rebuild —
 * the conservative direction, and the one that cannot serve a stale answer.
 */
export function isArtifactStale(
  built: { readonly producer: string; readonly producerVersion: string },
  current: { readonly producer: string; readonly producerVersion: string },
): boolean {
  return built.producer !== current.producer || built.producerVersion !== current.producerVersion;
}

export interface CompatibilityReport {
  readonly verdicts: readonly CompatibilityVerdict[];
  /** True when every surface may be written to. */
  readonly safeToWrite: boolean;
  /** Surfaces that need upgrading before Ferret can write. */
  readonly upgradable: readonly VersionedSurface[];
  /** Surfaces this build cannot use at all. */
  readonly blocking: readonly VersionedSurface[];
}

/** Aggregates verdicts so one place can answer "is this installation usable". */
export function summarizeCompatibility(verdicts: readonly CompatibilityVerdict[]): CompatibilityReport {
  return {
    verdicts,
    safeToWrite: verdicts.every((verdict) => verdict.safeToWrite),
    upgradable: verdicts
      .filter((verdict) => verdict.compatibility === Compatibility.UPGRADABLE)
      .map((verdict) => verdict.surface),
    blocking: verdicts
      .filter(
        (verdict) =>
          verdict.compatibility === Compatibility.TOO_NEW || verdict.compatibility === Compatibility.TOO_OLD,
      )
      .map((verdict) => verdict.surface),
  };
}
