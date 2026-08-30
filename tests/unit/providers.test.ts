import { describe, expect, it, vi } from 'vitest';

import {
  DependencyStatus,
  ErrorCode,
  FerretError,
  PROVIDER_CONTRACT_VERSION,
  ProviderKind,
  ProviderRegistry,
  createNullLogger,
  isProviderKind,
  parseConfig,
  type Provider,
  type ProviderContext,
} from '../../src/index.js';

function context(): ProviderContext {
  return {
    logger: createNullLogger(),
    config: parseConfig({}),
    environment: {
      ferretVersion: '0.0.0-test',
      node: { version: '22.0.0', major: 22, supportedRange: '>=22.0.0', supported: true },
      platform: process.platform,
      arch: process.arch,
      cwd: '/tmp',
      interactive: false,
      git: { available: true, version: '2.55.0' },
    },
    signal: new AbortController().signal,
  };
}

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id,
    kind: ProviderKind.STORAGE,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    ...overrides,
  };
}

describe('provider validation', () => {
  it('accepts a well-formed provider', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.register(provider('ferret.storage.postgres'))).not.toThrow();
    expect(registry.has('ferret.storage.postgres')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it.each(['Ferret.Storage', 'ferret storage', '_leading', 'trailing.', 'ferret..double', ''])(
    'rejects the malformed id %o',
    (id) => {
      const registry = new ProviderRegistry();
      expect(() => registry.register(provider(id))).toThrow(FerretError);
      expect(registry.size).toBe(0);
    },
  );

  it('rejects an unknown provider kind', () => {
    const registry = new ProviderRegistry();
    const bad = provider('x.y', { kind: 'quantum' as never });
    expect(() => registry.register(bad)).toThrow(/unknown kind/);
  });

  it('rejects a provider built against a different contract version', () => {
    const registry = new ProviderRegistry();
    const bad = provider('x.y', { contractVersion: PROVIDER_CONTRACT_VERSION + 1 });
    let thrown: FerretError | undefined;
    try {
      registry.register(bad);
    } catch (error) {
      thrown = error as FerretError;
    }
    expect(thrown?.code).toBe('E_PROVIDER_INVALID');
    expect(thrown?.details).toMatchObject({ supported: PROVIDER_CONTRACT_VERSION });
  });

  it('rejects a duplicate identifier', () => {
    const registry = new ProviderRegistry();
    registry.register(provider('a.b'));
    let thrown: FerretError | undefined;
    try {
      registry.register(provider('a.b'));
    } catch (error) {
      thrown = error as FerretError;
    }
    expect(thrown?.code).toBe('E_PROVIDER_DUPLICATE');
    expect(registry.size).toBe(1);
  });

  it('recognises every declared provider kind', () => {
    for (const kind of Object.values(ProviderKind)) expect(isProviderKind(kind)).toBe(true);
    expect(isProviderKind('nope')).toBe(false);
  });
});

describe('provider lookup', () => {
  it('lists by kind in registration order', () => {
    const registry = new ProviderRegistry();
    registry.registerAll([
      provider('s.one'),
      provider('i.one', { kind: ProviderKind.INDEX }),
      provider('s.two'),
    ]);

    expect(registry.list(ProviderKind.STORAGE).map((p) => p.id)).toStrictEqual(['s.one', 's.two']);
    expect(registry.list(ProviderKind.INDEX).map((p) => p.id)).toStrictEqual(['i.one']);
    expect(registry.list(ProviderKind.MCP)).toStrictEqual([]);
    expect(registry.get('s.one')?.id).toBe('s.one');
    expect(registry.get('missing')).toBeUndefined();
  });

  it('describes registration and initialization state', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('a.b', { description: 'test provider', initialize: () => undefined }));

    expect(registry.describe()).toStrictEqual([
      {
        id: 'a.b',
        kind: 'storage',
        contractVersion: PROVIDER_CONTRACT_VERSION,
        description: 'test provider',
        initialized: false,
      },
    ]);

    await registry.initializeAll(context());
    expect(registry.describe()[0]?.initialized).toBe(true);
  });
});

describe('provider lifecycle', () => {
  it('initializes in registration order and shuts down in reverse', async () => {
    const events: string[] = [];
    const registry = new ProviderRegistry();
    registry.registerAll([
      provider('first', {
        initialize: () => void events.push('init:first'),
        shutdown: () => void events.push('stop:first'),
      }),
      provider('second', {
        initialize: () => void events.push('init:second'),
        shutdown: () => void events.push('stop:second'),
      }),
    ]);

    await registry.initializeAll(context());
    await registry.shutdownAll();

    expect(events).toStrictEqual(['init:first', 'init:second', 'stop:second', 'stop:first']);
  });

  it('refuses registration once initialization has started', async () => {
    const registry = new ProviderRegistry();
    await registry.initializeAll(context());
    expect(() => registry.register(provider('late.one'))).toThrow(/after the runtime has initialized/);
  });

  it('shuts down already-started providers when a later one fails', async () => {
    const shutdown = vi.fn();
    const registry = new ProviderRegistry();
    registry.registerAll([
      provider('good', { initialize: () => undefined, shutdown }),
      provider('bad', {
        initialize: () => {
          throw new Error('cannot connect');
        },
      }),
    ]);

    let thrown: FerretError | undefined;
    try {
      await registry.initializeAll(context());
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe('E_PROVIDER_INIT_FAILED');
    expect(thrown?.details).toMatchObject({ providerId: 'bad' });
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps the diagnosis a provider made, instead of relabelling it', async () => {
    // The registry adds context; it must not destroy it. A storage provider
    // that reports "database configuration is incomplete" has to keep its code,
    // its remediation and its retryability, because those are what decide the
    // process exit code and what `ferret doctor` shows the user.
    const registry = new ProviderRegistry();
    registry.register(
      provider('picky', {
        initialize: () => {
          throw new FerretError(ErrorCode.CONFIG_MISSING, 'no database configured', {
            details: { missing: ['host'] },
            remediation: 'Set FERRET_DATABASE_HOST.',
            retryable: true,
          });
        },
      }),
    );

    let thrown: FerretError | undefined;
    try {
      await registry.initializeAll(context());
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe('E_CONFIG_MISSING');
    expect(thrown?.remediation).toBe('Set FERRET_DATABASE_HOST.');
    expect(thrown?.retryable).toBe(true);
    // and it still says which provider failed
    expect(thrown?.details).toMatchObject({ providerId: 'picky', missing: ['host'] });
  });

  it('attempts every shutdown even when one throws, and reports the failures', async () => {
    const later = vi.fn();
    const registry = new ProviderRegistry();
    registry.registerAll([
      provider('a', { initialize: () => undefined, shutdown: later }),
      provider('b', {
        initialize: () => undefined,
        shutdown: () => {
          throw new Error('stuck handle');
        },
      }),
    ]);

    await registry.initializeAll(context());
    const failures = await registry.shutdownAll();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('E_SHUTDOWN_FAILED');
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('never shuts down a provider that was not initialized', async () => {
    const shutdown = vi.fn();
    const registry = new ProviderRegistry();
    registry.register(provider('a', { shutdown }));
    expect(await registry.shutdownAll()).toStrictEqual([]);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('collects provider dependency results', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      provider('a', {
        checkDependencies: () => [
          { name: 'a:socket', status: DependencyStatus.OK, required: true },
        ],
      }),
    );

    expect(await registry.checkAll(context())).toStrictEqual([
      { name: 'a:socket', status: 'ok', required: true },
    ]);
  });

  it('records a throwing dependency check as unknown, never as ok', async () => {
    const registry = new ProviderRegistry();
    registry.register(
      provider('a', {
        checkDependencies: () => {
          throw new Error('probe exploded');
        },
      }),
    );

    const results = await registry.checkAll(context());
    expect(results[0]).toMatchObject({ name: 'a:dependencies', status: 'unknown' });
  });
});
