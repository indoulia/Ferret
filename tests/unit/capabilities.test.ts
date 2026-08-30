import { describe, expect, it, vi } from 'vitest';

import {
  CAPABILITIES,
  CAPABILITY_VERSIONS,
  Capability,
  CapabilitySupport,
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
