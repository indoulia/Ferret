import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Capability,
  CapabilitySupport,
  MAX_RECOVERY_ATTEMPTS,
  ProviderKind,
  ProviderLifecycleState,
  ProviderRegistry,
  RecoveryBudget,
  RecoveryRefusal,
  describeRefusal,
  type Provider,
  type ProviderHostContext,
} from '../../src/providers/index.js';
import { ErrorCode, FerretError } from '../../src/errors/index.js';
import { createNullLogger, parseConfig, type FerretConfig } from '../../src/index.js';

/**
 * EPIC-014 — provider lifecycle and recovery.
 *
 * The question this Epic exists to answer is EPIC-093 §16's: *"if a failed
 * optional provider should ever recover without a restart of Ferret, that is
 * EPIC-014's to design."* Before this, a database that was down for ten seconds
 * at start-up cost a long-running MCP server the whole session.
 */

interface Attempted extends Provider {
  readonly calls: () => number;
}

/** A provider whose `initialize` fails a given number of times, then works. */
function flaky(id: string, failures: number): Attempted {
  let calls = 0;
  return {
    id,
    kind: ProviderKind.SOURCE,
    contractVersion: 1,
    capabilities: [{ capability: Capability.SOURCE_REPOSITORY, version: 1 }],
    initialize: () => {
      calls += 1;
      if (calls <= failures) {
        throw new FerretError(ErrorCode.PROVIDER_INIT_FAILED, `"${id}" is not ready`);
      }
    },
    calls: () => calls,
  };
}

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

let registry: ProviderRegistry;

beforeEach(() => {
  registry = new ProviderRegistry();
});

describe('every provider reports exactly one state — AC-1 to AC-4', () => {
  it('reports registered before initialization has run — AC-1', () => {
    registry.register(flaky('src.one', 0));

    expect(registry.stateOf('src.one')?.state).toBe(ProviderLifecycleState.REGISTERED);
    expect(registry.states()).toHaveLength(1);
  });

  it('reports initialized after a successful start — AC-2', async () => {
    registry.register(flaky('src.one', 0));
    await registry.initializeAll(host());

    expect(registry.stateOf('src.one')?.state).toBe(ProviderLifecycleState.INITIALIZED);
    expect(registry.stateOf('src.one')?.attempts).toBe(0);
  });

  it('reports failed, not disabled, for an optional provider that threw — AC-4', async () => {
    // The distinction EPIC-093 §8.4 drew and this Epic keeps: `enabled: false`
    // is a configuration decision and a failure is an event.
    registry.register(flaky('src.broken', 1), { optional: true });
    await registry.initializeAll(host());

    const state = registry.stateOf('src.broken');
    expect(state?.state).toBe(ProviderLifecycleState.FAILED);
    expect(state?.failureCode).toBe(ErrorCode.PROVIDER_INIT_FAILED);
    // The start-up attempt counts, so a provider already at the bound is
    // unrecoverable from the outset rather than after four more tries.
    expect(state?.attempts).toBe(1);
  });

  it('reports released after shutdown', async () => {
    registry.register(flaky('src.one', 0));
    await registry.initializeAll(host());
    await registry.shutdownAll();

    expect(registry.stateOf('src.one')?.state).toBe(ProviderLifecycleState.RELEASED);
  });

  it('reports nothing for a provider it does not have', () => {
    expect(registry.stateOf('src.absent')).toBeUndefined();
  });
});

describe('recovery of a failed optional provider — AC-5 to AC-8', () => {
  it('re-runs initialize and reports initialized — AC-5, AC-6', async () => {
    // Fails once — at start-up — and works on the recovery.
    const provider = flaky('src.flaky', 1);
    registry.register(provider, { optional: true });
    await registry.initializeAll(host());
    expect(registry.stateOf('src.flaky')?.state).toBe(ProviderLifecycleState.FAILED);

    const result = await registry.recover('src.flaky', host());

    expect(result.recovered).toBe(true);
    expect(result.state).toBe(ProviderLifecycleState.INITIALIZED);
    expect(provider.calls()).toBe(2);
  });

  it('makes the capability selectable again — AC-6', async () => {
    registry.register(flaky('src.flaky', 1), { optional: true });
    await registry.initializeAll(host());

    // EPIC-093 §8.3 excludes a failed provider from selection, so before the
    // recovery the capability is unavailable — which is what makes the
    // assertion after it mean something.
    expect(registry.supports(Capability.SOURCE_REPOSITORY).support).toBe(CapabilitySupport.UNAVAILABLE);
    expect(registry.declarationFor(Capability.SOURCE_REPOSITORY)).toBeUndefined();

    await registry.recover('src.flaky', host());

    // The point of recovering at all: the capability is usable by the next
    // operation that asks.
    expect(registry.supports(Capability.SOURCE_REPOSITORY).support).not.toBe(CapabilitySupport.UNAVAILABLE);
    expect(registry.declarationFor(Capability.SOURCE_REPOSITORY)).toBeDefined();
  });

  it('clears the recorded failure from health — AC-7', async () => {
    registry.register(flaky('src.flaky', 1), { optional: true });
    await registry.initializeAll(host());
    expect(registry.failures().map((one) => one.providerId)).toContain('src.flaky');

    await registry.recover('src.flaky', host());

    // EPIC-093 AC-7 reports a startup failure as `degraded`. A recovered
    // provider must stop being reported, or health lies in the other direction.
    expect(registry.failures()).toStrictEqual([]);
    expect(registry.stateOf('src.flaky')?.attempts).toBe(0);
  });

  it('records the new failure and stays failed when recovery fails — AC-8', async () => {
    registry.register(flaky('src.stuck', 99), { optional: true });
    await registry.initializeAll(host());

    const result = await registry.recover('src.stuck', host());

    expect(result.recovered).toBe(false);
    expect(result.state).toBe(ProviderLifecycleState.FAILED);
    expect(result.failureCode).toBe(ErrorCode.PROVIDER_INIT_FAILED);
    expect(result.attempts).toBe(2);
  });
});

describe('the circuit opens after a bounded number of attempts — AC-9, AC-10, AC-16', () => {
  it('becomes unrecoverable at the bound — AC-9', async () => {
    const provider = flaky('src.stuck', 99);
    registry.register(provider, { optional: true });
    await registry.initializeAll(host());

    // One attempt spent at start-up, so the bound is reached after the rest.
    for (let attempt = 1; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
      await registry.recover('src.stuck', host());
    }

    expect(registry.stateOf('src.stuck')?.state).toBe(ProviderLifecycleState.UNRECOVERABLE);
    expect(provider.calls()).toBe(MAX_RECOVERY_ATTEMPTS);
  });

  it('refuses without calling initialize once the circuit is open — AC-10', async () => {
    const provider = flaky('src.stuck', 99);
    registry.register(provider, { optional: true });
    await registry.initializeAll(host());
    for (let attempt = 1; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) {
      await registry.recover('src.stuck', host());
    }
    const spent = provider.calls();

    const result = await registry.recover('src.stuck', host());

    // The assertion that matters: refused *before* trying. An unbounded retry
    // turns a permanent misconfiguration into a permanent stream of warnings.
    expect(result.refused).toBe(RecoveryRefusal.EXHAUSTED);
    expect(provider.calls()).toBe(spent);
  });

  it('resets the count on success, so a later failure is not immediately fatal — AC-16', async () => {
    // Fails at start-up, recovers, and the budget is spent again from zero.
    registry.register(flaky('src.flaky', 1), { optional: true });
    await registry.initializeAll(host());
    await registry.recover('src.flaky', host());

    expect(registry.stateOf('src.flaky')?.attempts).toBe(0);
    // And a provider at zero attempts is not exhausted.
    const budget = new RecoveryBudget();
    expect(budget.exhausted('anything')).toBe(false);
  });

  it('counts per provider, so one failing provider does not exhaust another', () => {
    const budget = new RecoveryBudget();
    for (let attempt = 0; attempt < MAX_RECOVERY_ATTEMPTS; attempt += 1) budget.record('src.a');

    expect(budget.exhausted('src.a')).toBe(true);
    expect(budget.exhausted('src.b')).toBe(false);
  });
});

describe('what recovery refuses — AC-11, AC-12, AC-13', () => {
  it('refuses a required provider, naming the reason — AC-11', async () => {
    // §8.4 — a required provider's failure already tore the process down, so
    // there is nothing in this process to recover. Registered required and
    // never initialized, which is the state a caller could reach.
    registry.register(flaky('src.required', 99));

    const result = await registry.recover('src.required', host());

    expect(result.recovered).toBe(false);
    expect(result.refused).toBe(RecoveryRefusal.REQUIRED);
  });

  it('refuses a provider that is running — AC-12', async () => {
    const provider = flaky('src.fine', 0);
    registry.register(provider, { optional: true });
    await registry.initializeAll(host());

    const result = await registry.recover('src.fine', host());

    expect(result.refused).toBe(RecoveryRefusal.ALREADY_RUNNING);
    // Not restarted: inventing a fault in a working provider is worse than
    // doing nothing.
    expect(provider.calls()).toBe(1);
  });

  it('refuses a provider switched off in configuration — AC-13', async () => {
    const provider = flaky('src.off', 0);
    registry.register(provider, { optional: true });
    const configured = host(parseConfig({ providers: { 'src.off': { enabled: false } } }));
    await registry.initializeAll(configured);

    expect(registry.stateOf('src.off')?.state).toBe(ProviderLifecycleState.DISABLED);
    const result = await registry.recover('src.off', configured);

    // Off is a choice, not a fault.
    expect(result.refused).toBe(RecoveryRefusal.DISABLED);
    expect(provider.calls()).toBe(0);
  });

  it('refuses an id it does not know', async () => {
    const result = await registry.recover('src.absent', host());

    expect(result.refused).toBe(RecoveryRefusal.UNKNOWN);
  });

  it('gives every refusal its own remediation', () => {
    // Five refusals with five different things to do about them; one shared
    // message would make four of them useless.
    const remediations = new Set(
      Object.values(RecoveryRefusal).map((refusal) => describeRefusal('src.x', refusal).remediation),
    );

    expect(remediations.size).toBe(Object.values(RecoveryRefusal).length);
    for (const refusal of Object.values(RecoveryRefusal)) {
      expect(describeRefusal('src.x', refusal).details).toMatchObject({ refusal, providerId: 'src.x' });
    }
  });
});

describe('nothing polls — AC-15', () => {
  it('starts no timer', async () => {
    // §8.6. A poll that recovered a provider unattended would be making a
    // decision nobody asked for at a moment nobody chose — EPIC-078 owns
    // periodic work, and it has to take that decision itself.
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const setTimeout = vi.spyOn(globalThis, 'setTimeout');
    try {
      registry.register(flaky('src.stuck', 99), { optional: true });
      await registry.initializeAll(host());
      await registry.recover('src.stuck', host());

      expect(setInterval).not.toHaveBeenCalled();
      expect(setTimeout).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
      setTimeout.mockRestore();
    }
  });

  it('names no timer in the source', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/providers/lifecycle.ts', import.meta.url), 'utf8'),
    );

    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('setTimeout');
  });
});

describe('state reaches the descriptor and health — AC-14', () => {
  it('describes a failed provider as failed and a recovered one as initialized', async () => {
    registry.register(flaky('src.flaky', 1), { optional: true });
    await registry.initializeAll(host());

    expect(registry.stateOf('src.flaky')?.state).toBe(ProviderLifecycleState.FAILED);
    const described = registry.describe().find((one) => one.id === 'src.flaky');
    expect(described?.initialized).toBe(false);

    await registry.recover('src.flaky', host());

    expect(registry.stateOf('src.flaky')?.state).toBe(ProviderLifecycleState.INITIALIZED);
    expect(registry.describe().find((one) => one.id === 'src.flaky')?.initialized).toBe(true);
  });

  it('reports one state per registered provider, and no more', async () => {
    registry.register(flaky('src.a', 0), { optional: true });
    registry.register(flaky('src.b', 99), { optional: true });
    await registry.initializeAll(host());

    const states = registry.states();
    expect(states.map((one) => one.providerId)).toStrictEqual(['src.a', 'src.b']);
    expect(new Set(states.map((one) => one.state))).toStrictEqual(
      new Set([ProviderLifecycleState.INITIALIZED, ProviderLifecycleState.FAILED]),
    );
  });
});
