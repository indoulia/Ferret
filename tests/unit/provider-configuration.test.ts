import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_PROVIDER_SETTINGS,
  DependencyStatus,
  ErrorCode,
  FerretError,
  PROVIDER_CONTRACT_VERSION,
  Capability,
  CapabilitySupport,
  ProviderKind,
  ProviderRegistry,
  createNullLogger,
  describeConfig,
  parseConfig,
  providerConfigurationWarnings,
  providerSettings,
  resolveConfig,
  secretOptionPredicate,
  type ConfigSource,
  type FerretConfig,
  type Provider,
  type ProviderHostContext,
  type ProviderSettings,
} from '../../src/index.js';

const CAPABILITY = Capability.SOURCE_REPOSITORY;

function host(config: FerretConfig = parseConfig({})): ProviderHostContext {
  return {
    logger: createNullLogger(),
    config,
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
    kind: ProviderKind.SOURCE,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    ...overrides,
  };
}

/** A source of a literal fragment, so a test can drive `resolveConfig` directly. */
function fragmentSource(fragment: Record<string, unknown>): ConfigSource {
  return { name: 'test', precedence: 500, read: () => fragment };
}

describe('provider settings resolution', () => {
  it('gives a provider its own slice and no other provider options — AC-1', () => {
    const config = parseConfig({
      providers: {
        'ferret.source.git': { options: { depth: 10 } },
        'ferret.source.github': { options: { token: 'ghp_other' } },
      },
    });

    const settings = providerSettings(provider('ferret.source.git'), config);

    expect(settings.enabled).toBe(true);
    expect(settings.options).toStrictEqual({ depth: 10 });
    expect(JSON.stringify(settings)).not.toContain('ghp_other');
  });

  it('defaults to enabled with empty options when the provider is unconfigured', () => {
    const settings = providerSettings(provider('ferret.source.git'), parseConfig({}));
    expect(settings).toStrictEqual(DEFAULT_PROVIDER_SETTINGS);
  });

  it('applies a declared schema, including its defaults — AC-2', () => {
    const config = parseConfig({ providers: { 'ferret.source.git': { options: { depth: '25' } } } });
    const schema = z.object({
      depth: z.coerce.number().int().default(50),
      followTags: z.boolean().default(false),
    });

    const settings = providerSettings(provider('ferret.source.git', { configSchema: schema }), config);

    expect(settings.options).toStrictEqual({ depth: 25, followTags: false });
  });

  it('names the failing option path and echoes no value — AC-3', () => {
    const config = parseConfig({
      providers: { 'ferret.source.github': { options: { auth: { token: 12345 } } } },
    });
    const schema = z.object({ auth: z.object({ token: z.string() }) });

    let thrown: FerretError | undefined;
    try {
      providerSettings(provider('ferret.source.github', { configSchema: schema }), config);
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown).toBeInstanceOf(FerretError);
    expect(thrown?.code).toBe(ErrorCode.CONFIG_INVALID);
    expect(thrown?.message).toContain('ferret.source.github');
    expect(thrown?.message).toContain('auth.token');
    const rendered = `${thrown?.message ?? ''} ${JSON.stringify(thrown?.details ?? {})}`;
    expect(rendered).not.toContain('12345');
    expect(thrown?.details).toMatchObject({ providerId: 'ferret.source.github' });
  });

  it('keeps a credential out of the validation error — AC-3', () => {
    const config = parseConfig({
      providers: { 'ferret.source.github': { options: { token: 'ghp_live_credential' } } },
    });
    const schema = z.object({ token: z.string().min(64) });

    expect(() =>
      providerSettings(provider('ferret.source.github', { configSchema: schema }), config),
    ).toThrow(FerretError);

    try {
      providerSettings(provider('ferret.source.github', { configSchema: schema }), config);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('ghp_live_credential');
      expect((error as FerretError).message).not.toContain('ghp_live_credential');
    }
  });

  it('passes options through untouched when no schema is declared — AC-4', () => {
    const config = parseConfig({
      providers: { 'ferret.source.git': { options: { anything: { nested: [1, 2] } } } },
    });

    const settings = providerSettings(provider('ferret.source.git'), config);

    expect(settings.options).toStrictEqual({ anything: { nested: [1, 2] } });
  });
});

describe('disabled providers', () => {
  const disabled = parseConfig({ providers: { 'ferret.source.git': { enabled: false } } });

  function capable(id: string, overrides: Partial<Provider> = {}): Provider {
    return provider(id, {
      capabilities: [{ capability: CAPABILITY, version: 1 }],
      ...overrides,
    });
  }

  it('is not initialized, and reports as disabled — AC-5', async () => {
    const initialize = vi.fn();
    const registry = new ProviderRegistry();
    registry.register(capable('ferret.source.git', { initialize }));

    await registry.initializeAll(host(disabled));

    expect(initialize).not.toHaveBeenCalled();
    const [described] = registry.describe();
    expect(described).toMatchObject({ id: 'ferret.source.git', enabled: false, initialized: false });
  });

  it('is not selected for its capability — AC-5', async () => {
    const registry = new ProviderRegistry();
    registry.register(capable('ferret.source.git'));

    await registry.initializeAll(host(disabled));

    expect(registry.forCapability(CAPABILITY)).toBeUndefined();
    expect(registry.allForCapability(CAPABILITY)).toStrictEqual([]);
    expect(registry.supports(CAPABILITY).support).toBe(CapabilitySupport.UNAVAILABLE);
  });

  it('lets an enabled provider behind a disabled one win the capability', async () => {
    const registry = new ProviderRegistry();
    registry.register(capable('ferret.source.git'));
    registry.register(capable('ferret.source.github'));

    await registry.initializeAll(host(disabled));

    expect(registry.forCapability(CAPABILITY)?.id).toBe('ferret.source.github');
  });

  it('is not asked for dependency checks', async () => {
    const checkDependencies = vi.fn().mockReturnValue([
      { name: 'git', status: DependencyStatus.OK, required: true },
    ]);
    const registry = new ProviderRegistry();
    registry.register(capable('ferret.source.git', { checkDependencies }));

    const context = host(disabled);
    await registry.initializeAll(context);
    const results = await registry.checkAll(context);

    expect(checkDependencies).not.toHaveBeenCalled();
    expect(results).toStrictEqual([]);
  });

  it('is not shut down, because it was never initialized — AC-6', async () => {
    const shutdown = vi.fn();
    const registry = new ProviderRegistry();
    registry.register(capable('ferret.source.git', { shutdown }));

    await registry.initializeAll(host(disabled));
    await registry.shutdownAll();

    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe('per-provider context', () => {
  it('hands each provider only its own settings — AC-1', async () => {
    const seen = new Map<string, ProviderSettings>();
    const capture = (id: string): Provider =>
      provider(id, {
        initialize: (context) => {
          seen.set(id, context.settings);
        },
      });

    const registry = new ProviderRegistry();
    registry.register(capture('ferret.source.git'));
    registry.register(capture('ferret.source.github'));

    await registry.initializeAll(
      host(
        parseConfig({
          providers: {
            'ferret.source.git': { options: { depth: 1 } },
            'ferret.source.github': { options: { token: 'ghp_secret' } },
          },
        }),
      ),
    );

    expect(seen.get('ferret.source.git')?.options).toStrictEqual({ depth: 1 });
    expect(seen.get('ferret.source.github')?.options).toStrictEqual({ token: 'ghp_secret' });
  });

  it('validates before initialize, and leaves nothing initialized on failure — AC-10', async () => {
    const first = vi.fn();
    const shutdown = vi.fn();
    const second = vi.fn();
    const registry = new ProviderRegistry();
    registry.register(provider('ferret.source.git', { initialize: first, shutdown }));
    registry.register(
      provider('ferret.source.github', {
        configSchema: z.object({ token: z.string() }),
        initialize: second,
      }),
    );

    const config = parseConfig({ providers: { 'ferret.source.github': { options: {} } } });

    await expect(registry.initializeAll(host(config))).rejects.toThrow(FerretError);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(registry.describe().every((entry) => !entry.initialized)).toBe(true);
  });
});

describe('provider option secrets', () => {
  it('resolves a secret reference in provider options — AC-7', () => {
    const resolved = resolveConfig(
      [fragmentSource({ providers: { 'ferret.source.github': { options: { token: { $secret: { env: 'GH_PAT' } } } } } })],
      { env: { GH_PAT: 'ghp_from_environment' } },
    );

    const settings = providerSettings(provider('ferret.source.github'), resolved.config);
    expect(settings.options).toStrictEqual({ token: 'ghp_from_environment' });
  });

  it('fails resolution when the reference cannot be resolved, naming only the source — AC-7', () => {
    let thrown: FerretError | undefined;
    try {
      resolveConfig(
        [fragmentSource({ providers: { 'ferret.source.github': { options: { token: { $secret: { env: 'GH_PAT' } } } } } })],
        { env: {} },
      );
    } catch (error) {
      thrown = error as FerretError;
    }

    expect(thrown?.code).toBe(ErrorCode.CONFIG_INVALID);
    expect(thrown?.message).toContain('GH_PAT');
  });

  it('redacts a declared secret option whose key name looks innocuous — AC-8', () => {
    const config = parseConfig({
      providers: { 'ferret.source.github': { options: { pat: 'ghp_live', depth: 5 } } },
    });
    const providers = [provider('ferret.source.github', { secretOptions: ['pat'] })];

    const described = describeConfig(config, { secret: secretOptionPredicate(providers) });

    expect(JSON.stringify(described)).not.toContain('ghp_live');
    expect(JSON.stringify(described)).toContain('[redacted]');
    // Redaction is targeted: a non-secret option is still visible.
    expect(JSON.stringify(described)).toContain('"depth":5');
  });

  it('redacts a nested declared secret, and the whole subtree of a declared prefix — AC-8', () => {
    // `endpoint` and `pat` are both innocuous to the key-name rule, so what is
    // under test here is the declaration and nothing else.
    const config = parseConfig({
      providers: {
        'ferret.source.github': { options: { endpoint: { pat: 'ghp_live', login: 'octocat' } } },
      },
    });

    const nested = describeConfig(config, {
      secret: secretOptionPredicate([provider('ferret.source.github', { secretOptions: ['endpoint.pat'] })]),
    });
    expect(JSON.stringify(nested)).not.toContain('ghp_live');
    expect(JSON.stringify(nested)).toContain('octocat');

    const subtree = describeConfig(config, {
      secret: secretOptionPredicate([provider('ferret.source.github', { secretOptions: ['endpoint'] })]),
    });
    expect(JSON.stringify(subtree)).not.toContain('ghp_live');
    expect(JSON.stringify(subtree)).not.toContain('octocat');
  });

  it('still redacts by key name when no provider declares anything', () => {
    const config = parseConfig({ database: { password: 'hunter2' } });
    expect(JSON.stringify(describeConfig(config))).not.toContain('hunter2');
  });

  it('does not redact another provider because one declared the same option name', () => {
    const config = parseConfig({
      providers: {
        'ferret.source.github': { options: { pat: 'ghp_live' } },
        'ferret.source.git': { options: { pat: 'not-a-secret-here' } },
      },
    });

    const described = describeConfig(config, {
      secret: secretOptionPredicate([provider('ferret.source.github', { secretOptions: ['pat'] })]),
    });

    expect(JSON.stringify(described)).not.toContain('ghp_live');
    expect(JSON.stringify(described)).toContain('not-a-secret-here');
  });

  it('is available from the registry for the providers it holds', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('ferret.source.github', { secretOptions: ['pat'] }));
    const config = parseConfig({ providers: { 'ferret.source.github': { options: { pat: 'ghp_live' } } } });

    await registry.initializeAll(host(config));

    expect(JSON.stringify(describeConfig(config, { secret: registry.isSecretConfigPath }))).not.toContain(
      'ghp_live',
    );
  });
});

describe('configuration warnings', () => {
  it('reports a configured id no registered provider claims — AC-9', () => {
    const config = parseConfig({
      providers: {
        'ferret.source.git': { options: {} },
        'ferret.source.githbu': { options: {} },
      },
    });

    const warnings = providerConfigurationWarnings(config, ['ferret.source.git']);

    expect(warnings).toStrictEqual([
      { providerId: 'ferret.source.githbu', reason: 'unregistered' },
    ]);
  });

  it('is empty when every configured id is registered', () => {
    const config = parseConfig({ providers: { 'ferret.source.git': { enabled: false } } });
    expect(providerConfigurationWarnings(config, ['ferret.source.git'])).toStrictEqual([]);
  });

  it('does not fail startup — AC-9', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('ferret.source.git'));
    const config = parseConfig({ providers: { 'ferret.source.unknown': { options: {} } } });

    await expect(registry.initializeAll(host(config))).resolves.toBeUndefined();
  });
});
