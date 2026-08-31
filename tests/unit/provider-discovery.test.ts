import { describe, expect, it } from 'vitest';

import {
  ProviderKind,
  ProviderRegistry,
  discoverProviders,
  type Provider,
  type ProviderModuleExports,
} from '../../src/providers/index.js';

const provider = (id: string): Provider => ({
  id,
  kind: ProviderKind.SOURCE,
  contractVersion: 1,
});

describe('discoverProviders', () => {
  it('discovers a default provider and preserves explicit order', async () => {
    const registry = new ProviderRegistry();
    const loaded: string[] = [];

    const result = await discoverProviders(registry, ['alpha', 'beta'], (specifier): Promise<ProviderModuleExports> => {
      loaded.push(specifier);
      return Promise.resolve({ default: provider(`ferret.source.${specifier}`) });
    });

    expect(loaded).toEqual(['alpha', 'beta']);
    expect(result.modules).toEqual(['alpha', 'beta']);
    expect(result.providers).toEqual(['ferret.source.alpha', 'ferret.source.beta']);
    expect(result.skipped).toEqual([]);
    expect(registry.list()).toHaveLength(2);
  });

  it('accepts named and multiple provider exports', async () => {
    const registry = new ProviderRegistry();

    const result = await discoverProviders(registry, ['bundle', 'single'], (specifier): Promise<ProviderModuleExports> => {
      if (specifier === 'bundle') {
        return Promise.resolve({ providers: [provider('ferret.source.one'), provider('ferret.source.two')] });
      }
      return Promise.resolve({ provider: provider('ferret.source.three') });
    });

    expect(result.providers).toEqual([
      'ferret.source.one',
      'ferret.source.two',
      'ferret.source.three',
    ]);
  });

  it('skips an unavailable module without losing existing providers', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('ferret.source.existing'));

    const result = await discoverProviders(registry, ['missing'], (): Promise<ProviderModuleExports> => {
      throw new Error('module not installed');
    });

    expect(result.providers).toEqual([]);
    expect(result.skipped).toEqual([
      { module: 'missing', reason: 'unavailable', detail: 'module not installed' },
    ]);
    expect(registry.list()).toHaveLength(1);
  });

  it('skips malformed modules and duplicate providers atomically', async () => {
    const registry = new ProviderRegistry();
    registry.register(provider('ferret.source.existing'));

    const result = await discoverProviders(registry, ['bad', 'duplicate', 'duplicate'], (specifier): Promise<ProviderModuleExports> => {
      if (specifier === 'bad') return Promise.resolve({ default: {} as Provider });
      return Promise.resolve({ default: provider('ferret.source.existing') });
    });

    expect(result.providers).toEqual([]);
    expect(result.skipped.map(({ module, reason }) => ({ module, reason }))).toEqual([
      { module: 'bad', reason: 'invalid' },
      { module: 'duplicate', reason: 'duplicate' },
      { module: 'duplicate', reason: 'duplicate' },
    ]);
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects blank specifiers without attempting a load', async () => {
    const registry = new ProviderRegistry();
    let calls = 0;

    const result = await discoverProviders(registry, ['  '], (): Promise<ProviderModuleExports> => {
      calls += 1;
      return Promise.resolve({ default: provider('ferret.source.never') });
    });

    expect(calls).toBe(0);
    expect(result.skipped).toEqual([
      { module: '  ', reason: 'invalid', detail: 'Provider module specifier cannot be empty.' },
    ]);
  });
});
