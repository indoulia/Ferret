import { describe, expect, it, vi } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_OPERATION_VERSIONS,
  CAPABILITY_VERSIONS,
  Capability,
  CapabilitySupport,
  DEFAULT_PROVIDER_SETTINGS,
  DependencyStatus,
  MINIMUM_CAPABILITY_VERSIONS,
  PROVIDER_CONTRACT_VERSION,
  ProviderKind,
  ProviderRegistry,
  assertSupported,
  createNullLogger,
  declares,
  describeSupport,
  isCapability,
  isSupportedCapabilityVersion,
  operationIntroducedAt,
  RepositoryOperation,
  parseConfig,
  validateCapabilityDeclaration,
  type CapabilityDeclaration,
  type Provider,
  type ProviderContext,
} from '../../src/index.js';

function context(): ProviderContext {
  return {
    logger: createNullLogger(),
    config: parseConfig({}),
    environment: {} as never,
    signal: new AbortController().signal,
    settings: DEFAULT_PROVIDER_SETTINGS,
  };
}

function provider(id: string, capabilities: readonly CapabilityDeclaration[], kind = ProviderKind.SOURCE): Provider {
  return { id, kind, contractVersion: PROVIDER_CONTRACT_VERSION, capabilities };
}

const repositoryCapability: CapabilityDeclaration = {
  capability: Capability.SOURCE_REPOSITORY,
  version: CAPABILITY_VERSIONS[Capability.SOURCE_REPOSITORY],
};

describe('the capability catalogue', () => {
  it('covers every area a provider can serve', () => {
    expect([...CAPABILITIES].sort()).toStrictEqual([
      'embedding',
      'mcp',
      'parser',
      // EPIC-119. The common source boundary, alongside the three
      // system-shaped ones rather than replacing them.
      'source.connector',
      'source.file',
      'source.history',
      'source.project',
      'source.repository',
      'storage',
    ]);
  });

  it('versions each capability independently', () => {
    // Changing what a parser must implement should not invalidate every storage
    // provider, which one shared number would force.
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_VERSIONS[capability]).toBeGreaterThan(0);
      expect(MINIMUM_CAPABILITY_VERSIONS[capability]).toBeLessThanOrEqual(CAPABILITY_VERSIONS[capability]);
    }
  });

  it('recognizes a capability and rejects anything else', () => {
    expect(isCapability(Capability.STORAGE)).toBe(true);
    expect(isCapability('telepathy')).toBe(false);
    expect(isCapability(undefined)).toBe(false);
  });

  it('states a supported span per capability rather than demanding equality', () => {
    expect(isSupportedCapabilityVersion(Capability.PARSER, CAPABILITY_VERSIONS[Capability.PARSER])).toBe(true);
    expect(isSupportedCapabilityVersion(Capability.PARSER, CAPABILITY_VERSIONS[Capability.PARSER] + 1)).toBe(
      false,
    );
    expect(
      isSupportedCapabilityVersion(Capability.PARSER, MINIMUM_CAPABILITY_VERSIONS[Capability.PARSER] - 1),
    ).toBe(false);
    expect(isSupportedCapabilityVersion(Capability.PARSER, 1.5)).toBe(false);
  });
});

describe('declaring a capability', () => {
  it('accepts a well-formed declaration', () => {
    expect(() => {
      validateCapabilityDeclaration('p', repositoryCapability);
    }).not.toThrow();
  });

  it('refuses an unknown capability at registration, not at first use', () => {
    // A provider declaring something it cannot honour is a defect, and every
    // caller that selected it would fail far from the cause.
    let thrown: unknown;
    try {
      validateCapabilityDeclaration('p', { capability: 'telepathy' as Capability, version: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_PROVIDER_INVALID' });
    expect((thrown as { details: { providerId: string } }).details.providerId).toBe('p');
  });

  it('refuses a version this runtime cannot honour, naming the span', () => {
    let thrown: unknown;
    try {
      validateCapabilityDeclaration('p', { ...repositoryCapability, version: 99 });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { message: string }).message).toContain('version 99');
    expect((thrown as { message: string }).message).toContain('this runtime supports');
  });

  it('refuses an empty operation list, which is ambiguous', () => {
    // Omitting the field means "all operations". An empty list reads as "no
    // operations", which is not a capability.
    let thrown: unknown;
    try {
      validateCapabilityDeclaration('p', { ...repositoryCapability, operations: [] });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { remediation: string }).remediation).toContain('Omit `operations`');
  });
});

describe('an operation added after version 1 — EPIC-108 §8.4', () => {
  const v1: CapabilityDeclaration = {
    capability: Capability.SOURCE_REPOSITORY,
    version: 1,
  };
  const v2: CapabilityDeclaration = {
    capability: Capability.SOURCE_REPOSITORY,
    version: 2,
  };

  it('raises the capability version but not the minimum', () => {
    // The whole compatibility rule in two numbers: version 2 is what this
    // runtime is built against, and version 1 is still accepted everywhere the
    // existing contract requires it. Nothing built against 1 stops working.
    expect(CAPABILITY_VERSIONS[Capability.SOURCE_REPOSITORY]).toBe(2);
    expect(MINIMUM_CAPABILITY_VERSIONS[Capability.SOURCE_REPOSITORY]).toBe(1);
    expect(isSupportedCapabilityVersion(Capability.SOURCE_REPOSITORY, 1)).toBe(true);
    expect(isSupportedCapabilityVersion(Capability.SOURCE_REPOSITORY, 2)).toBe(true);
  });

  it('records the version each operation was introduced at, and agrees with the contract', () => {
    // The map is keyed by string literal because `capabilities.ts` may not
    // import the contract — it would reach a logger, and therefore an external
    // package, which the boundary test forbids. This is what keeps the literal
    // and the constant from drifting apart silently.
    expect(operationIntroducedAt(Capability.SOURCE_REPOSITORY, RepositoryOperation.READ_CONTENT)).toBe(2);
    expect(CAPABILITY_OPERATION_VERSIONS[Capability.SOURCE_REPOSITORY]).toStrictEqual({
      [RepositoryOperation.READ_CONTENT]: 2,
    });
  });

  it('leaves every operation that existed at version 1 introduced at 1', () => {
    for (const operation of [
      RepositoryOperation.DISCOVER,
      RepositoryOperation.DESCRIBE,
      RepositoryOperation.LIST_WORKTREES,
      RepositoryOperation.LIST_BRANCHES,
      RepositoryOperation.READ_HISTORY,
      RepositoryOperation.LIST_FILES,
    ]) {
      expect(operationIntroducedAt(Capability.SOURCE_REPOSITORY, operation)).toBe(1);
    }
  });

  it('never lets a version-1 declaration claim it by omitting operations', () => {
    // The hole this closes. "Omitting the field means all of them" is correct
    // only for the operations that existed when the declaration was written; a
    // provider written before this operation existed cannot have meant it, and
    // inferring support from silence is how a missing method becomes a runtime
    // failure instead of an honest verdict.
    expect(v1.operations).toBeUndefined();
    expect(declares(v1, RepositoryOperation.READ_CONTENT)).toBe(false);
  });

  it('never lets a version-1 declaration claim it by naming it either', () => {
    // Stricter than the omission rule, and deliberately so: version 1 covers
    // the six operations that existed at version 1, and that set is closed.
    const naming: CapabilityDeclaration = {
      ...v1,
      operations: [RepositoryOperation.LIST_FILES, RepositoryOperation.READ_CONTENT],
    };
    expect(declares(naming, RepositoryOperation.READ_CONTENT)).toBe(false);
    expect(declares(naming, RepositoryOperation.LIST_FILES)).toBe(true);
  });

  it('lets a version-1 declaration keep every operation it did have', () => {
    // The other half of the rule, and the one that would be easy to break: this
    // must not become "version 1 supports nothing".
    expect(declares(v1, RepositoryOperation.LIST_FILES)).toBe(true);
    expect(declares(v1, RepositoryOperation.READ_HISTORY)).toBe(true);
    expect(declares(v1, RepositoryOperation.DISCOVER)).toBe(true);
  });

  it('lets a version-2 declaration claim it, by omission or by name', () => {
    expect(declares(v2, RepositoryOperation.READ_CONTENT)).toBe(true);
    expect(
      declares({ ...v2, operations: [RepositoryOperation.READ_CONTENT] }, RepositoryOperation.READ_CONTENT),
    ).toBe(true);
  });

  it('lets a version-2 declaration still decline it', () => {
    // Being new enough is necessary, not sufficient. A provider at version 2
    // that does not implement the operation says so, and is believed.
    const partial: CapabilityDeclaration = { ...v2, operations: [RepositoryOperation.LIST_FILES] };
    expect(declares(partial, RepositoryOperation.READ_CONTENT)).toBe(false);
  });

  it('reports the version as the reason, not a bare unimplemented', () => {
    // "Use a different provider" and "update this provider" are different
    // instructions, and an operator who is told the wrong one goes looking in
    // the wrong place. Governance §6.
    const verdict = describeSupport(
      Capability.SOURCE_REPOSITORY,
      { providerId: 'old', declaration: v1 },
      RepositoryOperation.READ_CONTENT,
    );
    expect(verdict.support).toBe(CapabilitySupport.OPERATION_UNSUPPORTED);
    expect(verdict.detail).toContain('version 1');
    expect(verdict.detail).toContain('introduced at version 2');
    expect(verdict.remediation).toContain('version 2 or later');
  });

  it('reports a plain unimplemented when the version is not the problem', () => {
    const verdict = describeSupport(
      Capability.SOURCE_REPOSITORY,
      { providerId: 'partial', declaration: { ...v2, operations: [RepositoryOperation.LIST_FILES] } },
      RepositoryOperation.READ_CONTENT,
    );
    expect(verdict.support).toBe(CapabilitySupport.OPERATION_UNSUPPORTED);
    expect(verdict.detail).toContain('but not the');
    expect(verdict.detail).not.toContain('introduced at');
  });

  it('still accepts a version-1 provider for the capability itself', () => {
    // AC-2's other half. A version-1 source is not rejected; it is simply not
    // asked to read content.
    const verdict = describeSupport(Capability.SOURCE_REPOSITORY, {
      providerId: 'old',
      declaration: v1,
    });
    expect(verdict.support).toBe(CapabilitySupport.SUPPORTED);
  });

  it('is asked and answered through the registry, which is where a caller asks', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('old-source', [v1]));

    const verdict = registry.supports(Capability.SOURCE_REPOSITORY, RepositoryOperation.READ_CONTENT);
    expect(verdict.support).toBe(CapabilitySupport.OPERATION_UNSUPPORTED);
    expect(registry.supports(Capability.SOURCE_REPOSITORY).support).toBe(CapabilitySupport.SUPPORTED);
  });
});

describe('partial implementation', () => {
  it('treats an omitted operation list as full support', () => {
    expect(declares(repositoryCapability, 'listRepositories')).toBe(true);
    expect(declares(repositoryCapability, 'anythingElse')).toBe(true);
  });

  it('lets a provider name only what it implements', () => {
    // A source that can list repositories but not enumerate worktrees is usable
    // for the first, and a caller asks rather than discovering by exception.
    const partial: CapabilityDeclaration = { ...repositoryCapability, operations: ['listRepositories'] };
    expect(declares(partial, 'listRepositories')).toBe(true);
    expect(declares(partial, 'listWorktrees')).toBe(false);
  });
});

describe('describing support', () => {
  it('reports an unavailable capability as a state, not an error', () => {
    // Governance §13: a missing capability should reduce what Ferret can answer,
    // not break what it can.
    const verdict = describeSupport(Capability.EMBEDDING, undefined);
    expect(verdict.support).toBe(CapabilitySupport.UNAVAILABLE);
    expect(verdict.providerId).toBeUndefined();
    expect(verdict.remediation).toContain('embedding');
  });

  it('reports a version this runtime cannot honour', () => {
    const verdict = describeSupport(Capability.PARSER, {
      providerId: 'p',
      declaration: { capability: Capability.PARSER, version: 99 },
    });
    expect(verdict.support).toBe(CapabilitySupport.UNSUPPORTED_VERSION);
    expect(verdict.declaredVersion).toBe(99);
  });

  it('reports an operation a provider does not implement', () => {
    const verdict = describeSupport(
      Capability.SOURCE_REPOSITORY,
      { providerId: 'p', declaration: { ...repositoryCapability, operations: ['listRepositories'] } },
      'listWorktrees',
    );
    expect(verdict.support).toBe(CapabilitySupport.OPERATION_UNSUPPORTED);
    expect(verdict.detail).toContain('listWorktrees');
  });

  it('reports support when everything lines up', () => {
    const verdict = describeSupport(Capability.SOURCE_REPOSITORY, {
      providerId: 'p',
      declaration: repositoryCapability,
    });
    expect(verdict.support).toBe(CapabilitySupport.SUPPORTED);
    expect(verdict.remediation).toBeUndefined();
  });

  it('throws only where a caller genuinely cannot degrade', () => {
    expect(() => {
      assertSupported(describeSupport(Capability.SOURCE_REPOSITORY, { providerId: 'p', declaration: repositoryCapability }));
    }).not.toThrow();

    let thrown: unknown;
    try {
      assertSupported(describeSupport(Capability.EMBEDDING, undefined));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'E_CAPABILITY_UNAVAILABLE' });
  });
});

describe('selecting a provider by capability', () => {
  it('finds the provider that offers a capability', () => {
    const registry = new ProviderRegistry();
    const source = provider('a.source', [repositoryCapability]);
    registry.register(source);

    expect(registry.forCapability(Capability.SOURCE_REPOSITORY)).toBe(source);
    expect(registry.supports(Capability.SOURCE_REPOSITORY).support).toBe(CapabilitySupport.SUPPORTED);
  });

  it('returns nothing for a capability no provider offers', () => {
    const registry = new ProviderRegistry();
    expect(registry.forCapability(Capability.EMBEDDING)).toBeUndefined();
    expect(registry.supports(Capability.EMBEDDING).support).toBe(CapabilitySupport.UNAVAILABLE);
  });

  it('lets two providers offer one capability, and selects deterministically', () => {
    // Registration order decides, so composition — explicit and visible at the
    // call site — determines selection rather than a scoring heuristic nobody
    // can predict.
    const registry = new ProviderRegistry();
    const first = provider('a.first', [repositoryCapability]);
    const second = provider('b.second', [repositoryCapability]);
    registry.registerAll([first, second]);

    expect(registry.forCapability(Capability.SOURCE_REPOSITORY)).toBe(first);
    expect(registry.allForCapability(Capability.SOURCE_REPOSITORY)).toStrictEqual([first, second]);

    // And the same both times, whichever order they were declared in.
    const reversed = new ProviderRegistry();
    reversed.registerAll([second, first]);
    expect(reversed.forCapability(Capability.SOURCE_REPOSITORY)).toBe(second);
  });

  it('lets one provider offer several capabilities', () => {
    const registry = new ProviderRegistry();
    const multi = provider('a.multi', [
      repositoryCapability,
      { capability: Capability.SOURCE_HISTORY, version: CAPABILITY_VERSIONS[Capability.SOURCE_HISTORY] },
    ]);
    registry.register(multi);

    expect(registry.forCapability(Capability.SOURCE_REPOSITORY)).toBe(multi);
    expect(registry.forCapability(Capability.SOURCE_HISTORY)).toBe(multi);
    expect([...registry.capabilities()].sort()).toStrictEqual(['source.history', 'source.repository']);
  });

  it('registers a provider that declares nothing, but never selects it', () => {
    // EPIC-001-era providers keep working. Not being selectable is the honest
    // outcome for something that declares no capability, rather than a silent
    // one.
    const registry = new ProviderRegistry();
    registry.register({ id: 'a.silent', kind: ProviderKind.SOURCE, contractVersion: PROVIDER_CONTRACT_VERSION });

    expect(registry.size).toBe(1);
    expect(registry.capabilities()).toStrictEqual([]);
  });

  it('refuses to register a provider whose declaration is invalid', () => {
    const registry = new ProviderRegistry();
    expect(() => {
      registry.register(provider('a.bad', [{ ...repositoryCapability, version: 99 }]));
    }).toThrow(/E_PROVIDER_INVALID|version 99/);
    // And nothing was half-registered.
    expect(registry.size).toBe(0);
  });

  it('reports declared limits before an operation is attempted', () => {
    // A caller that knows a provider cannot filter server-side will filter
    // locally; one that discovers it at the call site fails, or silently returns
    // everything.
    const registry = new ProviderRegistry();
    registry.register(
      provider('a.limited', [
        { ...repositoryCapability, limits: { supportsServerSideFilter: false, maxPageSize: 100 } },
      ]),
    );

    const declaration = registry.declarationFor(Capability.SOURCE_REPOSITORY);
    expect(declaration?.limits?.supportsServerSideFilter).toBe(false);
    expect(declaration?.limits?.maxPageSize).toBe(100);
  });

  it('reports capabilities through the provider description', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('a.described', [repositoryCapability]));
    expect(registry.describe()[0]?.capabilities).toStrictEqual([Capability.SOURCE_REPOSITORY]);
  });

  it('keeps lifecycle working for capability-declaring providers', async () => {
    const initialize = vi.fn();
    const shutdown = vi.fn();
    const registry = new ProviderRegistry();
    registry.register({ ...provider('a.lifecycle', [repositoryCapability]), initialize, shutdown });

    await registry.initializeAll(context());
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(registry.describe()[0]?.initialized).toBe(true);

    await registry.shutdownAll();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('still reports a capability check when the provider is unhealthy', async () => {
    // Capability declaration and health are independent: a provider can offer a
    // capability and be unable to serve it right now, and conflating the two
    // would make a transient outage look like a missing feature.
    const registry = new ProviderRegistry();
    registry.register({
      ...provider('a.unhealthy', [repositoryCapability]),
      checkDependencies: () => [
        { name: 'upstream', status: DependencyStatus.UNAVAILABLE, required: true, detail: 'down' },
      ],
    });

    expect(registry.supports(Capability.SOURCE_REPOSITORY).support).toBe(CapabilitySupport.SUPPORTED);
    const results = await registry.checkAll(context());
    expect(results[0]?.status).toBe(DependencyStatus.UNAVAILABLE);
  });
});

describe('the storage provider adopts the contract', () => {
  it('declares storage, so the core can select it without naming it', async () => {
    const { createStorageProvider } = await import('../../src/storage/index.js');
    const registry = new ProviderRegistry();
    registry.register(createStorageProvider());

    expect(registry.forCapability(Capability.STORAGE)).toBeDefined();
    expect(registry.supports(Capability.STORAGE).support).toBe(CapabilitySupport.SUPPORTED);
  });

  it('declares its limits honestly', async () => {
    const { createStorageProvider } = await import('../../src/storage/index.js');
    const registry = new ProviderRegistry();
    registry.register(createStorageProvider());

    const declaration = registry.declarationFor(Capability.STORAGE);
    expect(declaration?.systems).toStrictEqual(['postgresql']);
    expect(declaration?.limits?.supportsPagination).toBe(true);
    // Absent rather than optimistically true: incremental reads are the
    // caller's to express through a query.
    expect(declaration?.limits?.supportsIncremental).toBeUndefined();
  });
});

describe('performance', () => {
  it('selects in constant time as providers accumulate', () => {
    // Selection is on the hot path of every operation that reaches a provider.
    // An index rather than a scan through declarations.
    const registry = new ProviderRegistry();
    for (let i = 0; i < 200; i += 1) {
      registry.register(
        provider(`p.${String(i)}`, [
          { capability: Capability.PARSER, version: CAPABILITY_VERSIONS[Capability.PARSER] },
        ]),
      );
    }

    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) registry.forCapability(Capability.PARSER);
    // 10,000 lookups across 200 providers. A scan would be 2,000,000
    // comparisons and would show here.
    expect(performance.now() - started).toBeLessThan(200);
  });
});
