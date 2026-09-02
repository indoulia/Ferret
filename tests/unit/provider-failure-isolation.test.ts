import { describe, expect, it } from 'vitest';

import {
  Capability,
  CapabilitySupport,
  ErrorCode,
  FerretError,
  ProviderKind,
  ProviderRegistry,
  parseConfig,
  type ProviderHostContext,
} from '../../src/index.js';
import { BaseProvider } from '../../src/providers/sdk/base.js';
import { RecordingLogger } from '../support/recording-logger.js';

/**
 * EPIC-093 — one provider's failure is not every provider's failure.
 *
 * Before this, every provider was required because none of them could be
 * optional: `initializeAll` shut down everything already started and rethrew on
 * any failure. A parser that could not load its grammar took down `ferret
 * index`, even though EPIC-108 built five skip reasons for exactly that case —
 * reasons only reachable if the runtime starts at all.
 *
 * The tests below are written around the two behaviours that must stay
 * different: a required provider still fails the start, and an optional one
 * does not tear down what already worked.
 */

class Working extends BaseProvider {
  readonly id: string;
  readonly kind = ProviderKind.SOURCE;
  readonly capabilities = [
    { capability: Capability.SOURCE_REPOSITORY, support: CapabilitySupport.SUPPORTED, version: 1 },
  ];
  initializeCount = 0;
  shutdownCount = 0;

  constructor(id = 'test.working') {
    super();
    this.id = id;
  }

  protected override onInitialize(): void {
    this.initializeCount += 1;
  }

  protected override onShutdown(): void {
    this.shutdownCount += 1;
  }
}

class Failing extends BaseProvider {
  readonly id: string;
  readonly kind = ProviderKind.PARSER;
  readonly capabilities = [
    { capability: Capability.PARSER, support: CapabilitySupport.SUPPORTED, version: 1 },
  ];

  constructor(id = 'test.failing') {
    super();
    this.id = id;
  }

  protected override onInitialize(): never {
    throw new FerretError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'the grammar could not be loaded', {
      details: {},
      remediation: 'Reinstall the package.',
    });
  }
}

function hostContext(): ProviderHostContext & { logger: RecordingLogger } {
  const logger = new RecordingLogger();
  return {
    logger,
    config: parseConfig({}),
    environment: {} as never,
    signal: new AbortController().signal,
  };
}

describe('an optional provider that fails does not stop the start — AC-1, AC-3', () => {
  it('starts the runtime anyway', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Working());
    registry.register(new Failing(), { optional: true });

    await expect(registry.initializeAll(hostContext())).resolves.toBeUndefined();
  });

  it('leaves a provider that already started running', async () => {
    // The behaviour most easily got wrong, because the required path
    // deliberately does the opposite: it tears everything down. Registration
    // order puts the good provider first so it is already initialized when the
    // optional one throws.
    const working = new Working();
    const registry = new ProviderRegistry();
    registry.register(working);
    registry.register(new Failing(), { optional: true });

    await registry.initializeAll(hostContext());

    expect(working.initializeCount).toBe(1);
    expect(working.shutdownCount).toBe(0);
    expect(registry.describe().find((one) => one.id === 'test.working')?.initialized).toBe(true);
  });

  it('starts providers registered after the failing one', async () => {
    // A failure part way through must not skip the rest of the list.
    const later = new Working('test.later');
    const registry = new ProviderRegistry();
    registry.register(new Failing(), { optional: true });
    registry.register(later);

    await registry.initializeAll(hostContext());

    expect(later.initializeCount).toBe(1);
  });
});

describe('a required provider still fails the start — AC-2, AC-9', () => {
  it('rethrows, with the provider own classification preserved', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Failing());

    await expect(registry.initializeAll(hostContext())).rejects.toMatchObject({
      // Not relabelled as a generic init failure: the provider said what was
      // wrong and that survives, which EPIC-013 was careful about and this Epic
      // must not undo.
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });

  it('shuts down what already started, as it always did', async () => {
    const working = new Working();
    const registry = new ProviderRegistry();
    registry.register(working);
    registry.register(new Failing());

    await expect(registry.initializeAll(hostContext())).rejects.toThrow();

    expect(working.shutdownCount).toBe(1);
  });

  it('is the default, so an unmarked registration is unchanged', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Failing());

    await expect(registry.initializeAll(hostContext())).rejects.toThrow();
  });
});

describe('a failed provider offers nothing — AC-4', () => {
  it('is not selected for the capability it declared', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Failing(), { optional: true });
    await registry.initializeAll(hostContext());

    // Handing a caller an object whose `initialize` threw is worse than handing
    // it nothing: the failure resurfaces later with no context about why.
    expect(registry.forCapability(Capability.PARSER)).toBeUndefined();
    expect(registry.supports(Capability.PARSER).support).toBe(CapabilitySupport.UNAVAILABLE);
    expect(registry.allForCapability(Capability.PARSER)).toStrictEqual([]);
  });

  it('leaves another provider of the same capability selectable', async () => {
    // Isolation has to mean the capability survives when something else offers
    // it, or it is just a quieter outage.
    class SecondParser extends BaseProvider {
      readonly id = 'test.parser.second';
      readonly kind = ProviderKind.PARSER;
      readonly capabilities = [
        { capability: Capability.PARSER, support: CapabilitySupport.SUPPORTED, version: 1 },
      ];
    }

    const registry = new ProviderRegistry();
    registry.register(new Failing(), { optional: true });
    registry.register(new SecondParser());
    await registry.initializeAll(hostContext());

    expect(registry.forCapability(Capability.PARSER)?.id).toBe('test.parser.second');
  });
});

describe('the failure is visible — AC-5, AC-6, AC-7', () => {
  it('describes a failed provider distinctly from a disabled and an initialized one', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Working());
    registry.register(new Failing(), { optional: true });
    await registry.initializeAll(hostContext());

    const described = registry.describe();
    const failed = described.find((one) => one.id === 'test.failing');
    const started = described.find((one) => one.id === 'test.working');

    expect(failed?.initialized).toBe(false);
    // Enabled *and* not initialized *and* carrying a reason — which is what
    // separates "it broke" from "it was switched off".
    expect(failed?.enabled).toBe(true);
    expect(failed?.failure).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(started?.failure).toBeUndefined();
    expect(started?.initialized).toBe(true);
  });

  it('logs it once, at warn, with the code and not the message', async () => {
    const host = hostContext();
    const registry = new ProviderRegistry();
    registry.register(new Failing(), { optional: true });
    await registry.initializeAll(host);

    const logged = host.logger.records.filter(
      (record) => record.fields['operation'] === 'provider.initialize.failed',
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.level).toBe('warn');
    expect(logged[0]?.fields['code']).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    // A message can carry a path or a value; a code is a fact about the failure.
    expect(JSON.stringify(logged[0])).not.toContain('the grammar could not be loaded');
  });

  it('reports it as degraded in the dependency checks', async () => {
    const host = hostContext();
    const registry = new ProviderRegistry();
    registry.register(new Failing(), { optional: true });
    await registry.initializeAll(host);

    const results = await registry.checkAll(host);
    const startup = results.find((one) => one.name === 'test.failing:startup');

    expect(startup?.status).toBe('degraded');
    expect(startup?.required).toBe(false);
    expect(startup?.remediation).toContain('ferret doctor');
  });

  it('reports nothing when nothing failed', async () => {
    // A clean start must stay clean: a health surface that always says
    // something is the one nobody reads.
    const host = hostContext();
    const registry = new ProviderRegistry();
    registry.register(new Working());
    await registry.initializeAll(host);

    expect(registry.failures()).toStrictEqual([]);
    expect((await registry.checkAll(host)).filter((one) => one.name.endsWith(':startup'))).toStrictEqual([]);
  });
});

describe('shutdown skips what never started — AC-8', () => {
  it('does not attempt to stop a failed provider', async () => {
    const registry = new ProviderRegistry();
    registry.register(new Working());
    registry.register(new Failing(), { optional: true });
    await registry.initializeAll(hostContext());

    // No failure is returned for the provider that never started, because it
    // was never asked to stop.
    await expect(registry.shutdownAll()).resolves.toStrictEqual([]);
  });
});
