import { describe, expect, it } from 'vitest';

import {
  Compatibility,
  MINIMUM_PROVIDER_CONTRACT_VERSION,
  PROVIDER_CONTRACT_VERSION,
  SURFACE_POLICIES,
  VersionedSurface,
  assertSafeToWrite,
  checkCompatibility,
  databaseSchemaPolicy,
  isArtifactStale,
  isSupportedContractVersion,
  summarizeCompatibility,
  type SurfacePolicy,
} from '../../src/index.js';

function policy(overrides: Partial<SurfacePolicy> = {}): SurfacePolicy {
  return {
    surface: VersionedSurface.ENTITY_SCHEMA,
    current: 3,
    minimumSupported: 2,
    upgradeHint: 'run the upgrade',
    newerHint: 'upgrade Ferret',
    ...overrides,
  };
}

describe('the compatibility policy', () => {
  it('accepts the current version and permits writing', () => {
    const verdict = checkCompatibility(policy(), 3);
    expect(verdict.compatibility).toBe(Compatibility.CURRENT);
    expect(verdict.safeToWrite).toBe(true);
    expect(verdict.remediation).toBeUndefined();
  });

  it('refuses anything newer than this build writes', () => {
    // A newer version may have moved a field, and reading it under the old
    // meaning applies an interpretation the writer never intended — silently,
    // which is the worst way to be wrong.
    const verdict = checkCompatibility(policy(), 4);
    expect(verdict.compatibility).toBe(Compatibility.TOO_NEW);
    expect(verdict.safeToWrite).toBe(false);
    expect(verdict.remediation).toBe('upgrade Ferret');
  });

  it('offers an upgrade for an older but supported version', () => {
    const verdict = checkCompatibility(policy(), 2);
    expect(verdict.compatibility).toBe(Compatibility.UPGRADABLE);
    expect(verdict.remediation).toBe('run the upgrade');
  });

  it('refuses to write to an upgradable surface before it is upgraded', () => {
    // A write that landed first would be in a shape the upgrade then has to
    // reconcile, which is how a migration acquires special cases.
    expect(checkCompatibility(policy(), 2).safeToWrite).toBe(false);
  });

  it('refuses a version older than it still supports, rather than half-migrating', () => {
    const verdict = checkCompatibility(policy(), 1);
    expect(verdict.compatibility).toBe(Compatibility.TOO_OLD);
    expect(verdict.safeToWrite).toBe(false);
    expect(verdict.detail).toContain('no longer supports');
  });

  it('names the surface, the version found and the version expected', () => {
    // A caller has to be able to act on this without reading Ferret's source.
    const verdict = checkCompatibility(policy(), 9);
    expect(verdict.surface).toBe(VersionedSurface.ENTITY_SCHEMA);
    expect(verdict.found).toBe(9);
    expect(verdict.expected).toBe(3);
    expect(verdict.minimumSupported).toBe(2);
  });

  it('treats a database that has never been migrated as upgradable, not broken', () => {
    // Version 0 is an empty database, which is the ordinary starting point.
    const verdict = checkCompatibility(databaseSchemaPolicy(5), 0);
    expect(verdict.compatibility).toBe(Compatibility.UPGRADABLE);
    expect(verdict.remediation).toContain('ferret init');
  });

  it('covers every versioned surface Ferret has', () => {
    // Four surfaces grew the same refusal in isolation; the point of this Epic
    // is that there is one policy rather than four copies of a reflex.
    expect(Object.keys(SURFACE_POLICIES).sort()).toStrictEqual([
      'config-file',
      'database-schema',
      'derived-artifact',
      'entity-schema',
      'provider-contract',
    ]);
    for (const surface of Object.values(SURFACE_POLICIES)) {
      expect(surface.upgradeHint.length).toBeGreaterThan(0);
      expect(surface.newerHint.length).toBeGreaterThan(0);
    }
  });
});

describe('refusing unsafe writes', () => {
  it('raises a pending-migration error for an upgradable surface', () => {
    let thrown: unknown;
    try {
      assertSafeToWrite(checkCompatibility(policy(), 2));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_MIGRATION_PENDING' });
    expect((thrown as { remediation: string }).remediation).toBe('run the upgrade');
  });

  it('raises an unsupported-schema error for a version that is too new', () => {
    expect(() => {
      assertSafeToWrite(checkCompatibility(policy(), 99));
    }).toThrow(/version 99/);
  });

  it('passes silently when the surface is current', () => {
    expect(() => {
      assertSafeToWrite(checkCompatibility(policy(), 3));
    }).not.toThrow();
  });
});

describe('summarizing several surfaces', () => {
  it('is safe to write only when every surface is', () => {
    const all = [checkCompatibility(policy(), 3), checkCompatibility(policy(), 2)];
    expect(summarizeCompatibility(all).safeToWrite).toBe(false);
    expect(summarizeCompatibility([checkCompatibility(policy(), 3)]).safeToWrite).toBe(true);
  });

  it('separates what can be upgraded from what blocks entirely', () => {
    // Different remedies: one is "run the upgrade", the other is "install a
    // different Ferret". Conflating them sends an operator the wrong way.
    const report = summarizeCompatibility([
      checkCompatibility(policy({ surface: VersionedSurface.DATABASE_SCHEMA }), 2),
      checkCompatibility(policy({ surface: VersionedSurface.ENTITY_SCHEMA }), 99),
    ]);
    expect(report.upgradable).toStrictEqual([VersionedSurface.DATABASE_SCHEMA]);
    expect(report.blocking).toStrictEqual([VersionedSurface.ENTITY_SCHEMA]);
  });

  it('is safe on an empty report', () => {
    expect(summarizeCompatibility([]).safeToWrite).toBe(true);
  });
});

describe('provider contract compatibility', () => {
  it('states a supported span rather than demanding exact equality', () => {
    // EPIC-001 compared for equality, which made every contract change a flag
    // day for providers that used nothing it altered.
    expect(isSupportedContractVersion(PROVIDER_CONTRACT_VERSION)).toBe(true);
    expect(isSupportedContractVersion(MINIMUM_PROVIDER_CONTRACT_VERSION)).toBe(true);
  });

  it('refuses a contract newer than this runtime implements', () => {
    expect(isSupportedContractVersion(PROVIDER_CONTRACT_VERSION + 1)).toBe(false);
  });

  it('refuses a contract older than the supported minimum', () => {
    expect(isSupportedContractVersion(MINIMUM_PROVIDER_CONTRACT_VERSION - 1)).toBe(false);
  });

  it('refuses a version that is not a whole number', () => {
    expect(isSupportedContractVersion(1.5)).toBe(false);
    expect(isSupportedContractVersion(Number.NaN)).toBe(false);
  });
});

describe('derived artefact staleness', () => {
  const built = { producer: 'ferret.parser.pdf', producerVersion: '6.3.289' };

  it('is stale when the producer version changed', () => {
    expect(isArtifactStale(built, { ...built, producerVersion: '7.0.0' })).toBe(true);
  });

  it('is stale when a different producer would build it now', () => {
    expect(isArtifactStale(built, { ...built, producer: 'ferret.parser.pdfium' })).toBe(true);
  });

  it('is fresh when nothing changed', () => {
    expect(isArtifactStale(built, { ...built })).toBe(false);
  });

  it('treats any version difference as stale, including an apparent downgrade', () => {
    // A producer version is an opaque token — a semver, a git sha, a model name
    // — so Ferret cannot know whether a change was breaking. The conservative
    // direction is the only one that cannot serve a stale answer.
    expect(isArtifactStale(built, { ...built, producerVersion: '6.3.288' })).toBe(true);
    expect(isArtifactStale(built, { ...built, producerVersion: 'sha-abc123' })).toBe(true);
  });
});
