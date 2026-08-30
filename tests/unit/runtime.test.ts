import { describe, expect, it, vi } from 'vitest';

import {
  DependencyStatus,
  DisposableStack,
  PACKAGE_NAME,
  PROVIDER_CONTRACT_VERSION,
  ProviderKind,
  RuntimeState,
  canTransition,
  createNullLogger,
  createRuntime,
  environmentSource,
  isTerminal,
  type ConfigSource,
  type FerretError,
  type DependencyCheck,
  type Provider,
  type RuntimeOptions,
} from '../../src/index.js';

const emptyEnvironment: ConfigSource = {
  name: 'test',
  precedence: 0,
  read: () => ({}),
};

function runtimeOptions(overrides: RuntimeOptions = {}): RuntimeOptions {
  return {
    configSources: [emptyEnvironment],
    logger: createNullLogger(),
    ...overrides,
  };
}

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return { id, kind: ProviderKind.STORAGE, contractVersion: PROVIDER_CONTRACT_VERSION, ...overrides };
}

const failingRequiredCheck: DependencyCheck = {
  name: 'required-thing',
  required: true,
  run: () => ({
    name: 'required-thing',
    status: DependencyStatus.UNAVAILABLE,
    required: true,
    detail: 'the thing is absent',
    remediation: 'install the thing',
  }),
};

describe('lifecycle state machine', () => {
  it('permits only the documented transitions', () => {
    expect(canTransition(RuntimeState.CREATED, RuntimeState.INITIALIZING)).toBe(true);
    expect(canTransition(RuntimeState.INITIALIZING, RuntimeState.READY)).toBe(true);
    expect(canTransition(RuntimeState.READY, RuntimeState.STOPPING)).toBe(true);
    expect(canTransition(RuntimeState.STOPPING, RuntimeState.STOPPED)).toBe(true);

    expect(canTransition(RuntimeState.CREATED, RuntimeState.READY)).toBe(false);
    expect(canTransition(RuntimeState.STOPPED, RuntimeState.INITIALIZING)).toBe(false);
    expect(canTransition(RuntimeState.FAILED, RuntimeState.READY)).toBe(false);
  });

  it('treats stopped and failed as terminal', () => {
    expect(isTerminal(RuntimeState.STOPPED)).toBe(true);
    expect(isTerminal(RuntimeState.FAILED)).toBe(true);
    expect(isTerminal(RuntimeState.READY)).toBe(false);
  });
});

describe('successful initialization', () => {
  it('moves created -> ready and exposes a complete context', async () => {
    const runtime = createRuntime(runtimeOptions());
    expect(runtime.state).toBe('created');

    await runtime.initialize();

    expect(runtime.state).toBe('ready');
    expect(runtime.context.version.version).toBe(runtime.version);
    expect(runtime.context.environment.node.version).toBe(process.versions.node);
    expect(runtime.context.dependencies.some((d) => d.name === 'node-version')).toBe(true);
    expect(runtime.signal.aborted).toBe(false);

    await runtime.shutdown();
    expect(runtime.state).toBe('stopped');
  });

  it('refuses to hand out a context before it is ready', () => {
    const runtime = createRuntime(runtimeOptions());
    let thrown: FerretError | undefined;
    try {
      void runtime.context;
    } catch (error) {
      thrown = error as FerretError;
    }
    expect(thrown?.code).toBe('E_LIFECYCLE_INVALID_STATE');
  });

  it('reads configuration from the environment source by default', async () => {
    const runtime = createRuntime({
      logger: createNullLogger(),
      configSources: [environmentSource({ FERRET_DATABASE_HOST: 'db.example' })],
    });
    await runtime.initialize();
    expect(runtime.context.config.database.host).toBe('db.example');
    await runtime.shutdown();
  });
});

describe('idempotency', () => {
  it('makes a second initialize a no-op', async () => {
    const initialize = vi.fn();
    const runtime = createRuntime(runtimeOptions({ providers: [provider('a', { initialize })] }));

    await runtime.initialize();
    await runtime.initialize();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(runtime.state).toBe('ready');
    await runtime.shutdown();
  });

  it('joins concurrent initialize calls into one initialization', async () => {
    const initialize = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const runtime = createRuntime(runtimeOptions({ providers: [provider('a', { initialize })] }));

    await Promise.all([runtime.initialize(), runtime.initialize(), runtime.initialize()]);

    expect(initialize).toHaveBeenCalledTimes(1);
    await runtime.shutdown();
  });

  it('makes a second shutdown a no-op', async () => {
    const shutdown = vi.fn();
    const runtime = createRuntime(runtimeOptions({ providers: [provider('a', { shutdown })] }));

    await runtime.initialize();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.state).toBe('stopped');
  });

  it('joins concurrent shutdown calls', async () => {
    const shutdown = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const runtime = createRuntime(runtimeOptions({ providers: [provider('a', { shutdown })] }));

    await runtime.initialize();
    await Promise.all([runtime.shutdown(), runtime.shutdown()]);

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('shuts down safely without ever having initialized', async () => {
    const runtime = createRuntime(runtimeOptions());
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(runtime.state).toBe('stopped');
    expect(runtime.signal.aborted).toBe(true);
  });

  it('refuses to restart a stopped runtime', async () => {
    const runtime = createRuntime(runtimeOptions());
    await runtime.initialize();
    await runtime.shutdown();

    await expect(runtime.initialize()).rejects.toMatchObject({
      code: 'E_LIFECYCLE_INVALID_STATE',
      remediation: expect.stringContaining('runs once'),
    });
  });

  it('supports repeated start/stop cycles across separate instances', async () => {
    for (let i = 0; i < 3; i += 1) {
      const runtime = createRuntime(runtimeOptions());
      await runtime.initialize();
      expect(runtime.state).toBe('ready');
      await runtime.shutdown();
      expect(runtime.state).toBe('stopped');
    }
  });
});

describe('initialization failure', () => {
  it('fails with E_CONFIG_INVALID when configuration is rejected', async () => {
    const runtime = createRuntime({
      logger: createNullLogger(),
      configSources: [environmentSource({ FERRET_DATABASE_PORT: '0' })],
    });

    let thrown: FerretError | undefined;
    try {
      await runtime.initialize();
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe('E_CONFIG_INVALID');
    expect(runtime.state).toBe('failed');
  });

  it('fails with E_DEPENDENCY_UNAVAILABLE and carries the remediation forward', async () => {
    const runtime = createRuntime(runtimeOptions({ dependencyChecks: [failingRequiredCheck] }));

    let thrown: FerretError | undefined;
    try {
      await runtime.initialize();
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe('E_DEPENDENCY_UNAVAILABLE');
    expect(thrown?.remediation).toBe('install the thing');
    expect(runtime.state).toBe('failed');
  });

  it('does not block startup on an optional dependency', async () => {
    const runtime = createRuntime(
      runtimeOptions({
        dependencyChecks: [
          {
            name: 'optional-thing',
            required: false,
            run: () => ({
              name: 'optional-thing',
              status: DependencyStatus.UNAVAILABLE,
              required: false,
            }),
          },
        ],
      }),
    );

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(runtime.context.dependencies.some((d) => d.name === 'optional-thing')).toBe(true);
    await runtime.shutdown();
  });

  it('records a throwing dependency check as unknown rather than ok', async () => {
    const runtime = createRuntime(
      runtimeOptions({
        dependencyChecks: [
          {
            name: 'exploding',
            required: false,
            run: () => {
              throw new Error('probe failed');
            },
          },
        ],
      }),
    );

    await runtime.initialize();
    expect(runtime.context.dependencies.find((d) => d.name === 'exploding')?.status).toBe('unknown');
    await runtime.shutdown();
  });

  it('wraps an unexpected provider failure as E_PROVIDER_INIT_FAILED', async () => {
    const runtime = createRuntime(
      runtimeOptions({
        providers: [
          provider('boom', {
            initialize: () => {
              throw new Error('unexpected');
            },
          }),
        ],
      }),
    );

    await expect(runtime.initialize()).rejects.toMatchObject({ code: 'E_PROVIDER_INIT_FAILED' });
    expect(runtime.state).toBe('failed');
  });

  it('leaves no resources open after a failed start', async () => {
    const dispose = vi.fn();
    const providerShutdown = vi.fn();
    const runtime = createRuntime(
      runtimeOptions({
        dependencyChecks: [failingRequiredCheck],
        providers: [provider('a', { initialize: () => undefined, shutdown: providerShutdown })],
      }),
    );
    runtime.registerDisposable('handle', dispose);

    await expect(runtime.initialize()).rejects.toThrow();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtime.signal.aborted).toBe(true);
    // The provider never started, so it is never stopped.
    expect(providerShutdown).not.toHaveBeenCalled();
  });

  it('allows shutdown after a failed start and reaches a terminal state', async () => {
    const runtime = createRuntime(runtimeOptions({ dependencyChecks: [failingRequiredCheck] }));
    await expect(runtime.initialize()).rejects.toThrow();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(runtime.state).toBe('stopped');
  });
});

describe('shutdown', () => {
  it('aborts the runtime signal so in-flight work can observe it', async () => {
    const runtime = createRuntime(runtimeOptions());
    await runtime.initialize();
    const { signal } = runtime.context;
    expect(signal.aborted).toBe(false);

    await runtime.shutdown();
    expect(signal.aborted).toBe(true);
  });

  it('releases disposables in reverse registration order', async () => {
    const events: string[] = [];
    const runtime = createRuntime(runtimeOptions());
    runtime.registerDisposable('first', () => void events.push('first'));
    runtime.registerDisposable('second', () => void events.push('second'));

    await runtime.initialize();
    await runtime.shutdown();

    expect(events).toStrictEqual(['second', 'first']);
  });

  it('aggregates release failures into one E_SHUTDOWN_FAILED', async () => {
    const runtime = createRuntime(runtimeOptions());
    runtime.registerDisposable('bad', () => {
      throw new Error('handle stuck');
    });
    await runtime.initialize();

    let thrown: FerretError | undefined;
    try {
      await runtime.shutdown();
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe('E_SHUTDOWN_FAILED');
    expect(runtime.state).toBe('failed');
  });

  it('drops the context so stale configuration cannot be read after stopping', async () => {
    const runtime = createRuntime(runtimeOptions());
    await runtime.initialize();
    await runtime.shutdown();
    expect(() => runtime.context).toThrow(/E_LIFECYCLE_INVALID_STATE|unavailable/);
  });
});

describe('run()', () => {
  it('initializes, runs the body and shuts down', async () => {
    const runtime = createRuntime(runtimeOptions());
    const result = await runtime.run((context) => context.version.name);

    expect(result).toBe(PACKAGE_NAME);
    expect(runtime.state).toBe('stopped');
  });

  it('shuts down even when the body throws, and propagates the error', async () => {
    const runtime = createRuntime(runtimeOptions());
    await expect(runtime.run(() => Promise.reject(new Error('body failed')))).rejects.toThrow(
      'body failed',
    );
    expect(runtime.state).toBe('stopped');
  });
});

describe('DisposableStack', () => {
  it('disposes in reverse order and empties itself', async () => {
    const events: string[] = [];
    const stack = new DisposableStack();
    stack.add('a', () => void events.push('a'));
    stack.add('b', () => void events.push('b'));

    expect(stack.size).toBe(2);
    expect(await stack.disposeAll()).toStrictEqual([]);
    expect(events).toStrictEqual(['b', 'a']);
    expect(stack.size).toBe(0);
  });

  it('attempts every disposable even when one throws', async () => {
    const later = vi.fn();
    const stack = new DisposableStack();
    stack.add('later', later);
    stack.add('bad', () => {
      throw new Error('nope');
    });

    const failures = await stack.disposeAll();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.details).toMatchObject({ resource: 'bad' });
    expect(later).toHaveBeenCalledTimes(1);
  });
});
