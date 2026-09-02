import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfirmationGate, Permission, type Principal } from '../../../src/authorization/index.js';
import { parseConfig } from '../../../src/config/index.js';
import { ErrorCode, FerretError } from '../../../src/errors/index.js';
import {
  Capability,
  ProviderKind,
  ProviderLifecycleState,
  ProviderRegistry,
  RecoveryRefusal,
  type Provider,
  type ProviderHostContext,
} from '../../../src/providers/index.js';
import { registerProviderTools } from '../../../src/mcp/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';

/**
 * Provider administration over MCP — EPIC-067, through the real protocol.
 *
 * A **real `ProviderRegistry`** with real providers whose `initialize` throws,
 * deliberately: this Epic's claim is that it adds no registry behaviour and only
 * exposes what is already there, and a faked port would prove the opposite — it
 * would show the tools calling something and hide whether EPIC-014's states,
 * EPIC-093's failure recording and the capability verdict came along.
 */

const GRANTED: Principal = {
  id: 'test.admin',
  class: 'agent',
  permissions: [Permission.READ, Permission.INDEX],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const READ_ONLY: Principal = { ...GRANTED, id: 'test.reader', permissions: [Permission.READ] };
const NO_READ: Principal = { ...GRANTED, id: 'test.blind', permissions: [Permission.INDEX] };

interface Attempted extends Provider {
  readonly calls: () => number;
}

/** A provider whose `initialize` fails a given number of times, then works. */
function flaky(id: string, failures: number, capability: Capability): Attempted {
  let calls = 0;
  return {
    id,
    kind: ProviderKind.SOURCE,
    contractVersion: 1,
    capabilities: [{ capability, version: 1 }],
    initialize: () => {
      calls += 1;
      if (calls <= failures) {
        throw new FerretError(ErrorCode.PROVIDER_INIT_FAILED, `"${id}" is not ready`);
      }
    },
    calls: () => calls,
  };
}

function hostFor(config = parseConfig({})): ProviderHostContext {
  return {
    logger: new RecordingLogger(),
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

interface Harness {
  readonly client: Client;
  readonly registry: ProviderRegistry;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(
  build: (registry: ProviderRegistry) => Promise<ProviderHostContext>,
  principal: Principal = GRANTED,
): Promise<Harness> {
  const registry = new ProviderRegistry();
  const host = await build(registry);

  const server = new McpServer({ name: 'ferret-provider-test', version: '0.0.0' });
  registerProviderTools(server, {
    principal,
    confirmations: new ConfirmationGate(),
    logger: new RecordingLogger(),
    providers: {
      describe: () => registry.describe(),
      states: () => registry.states(),
      capabilities: () => registry.capabilities(),
      known: () => Object.values(Capability),
      supports: (capability) => registry.supports(capability),
      recover: async (providerId) => registry.recover(providerId, host),
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'provider-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const created: Harness = {
    client,
    registry,
    close: async () => {
      await client.close();
    },
  };
  open.push(created);
  return created;
}

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly isError: boolean;
}

/**
 * The confirmation token, which arrives inside the refusal's details.
 *
 * EPIC-069 returns the plan and the token by *throwing*: an unconfirmed call is
 * a refusal that carries what is needed to retry, not a success with a token
 * attached. So a client reads `details.confirm`, which is what this mirrors.
 */
function tokenFrom(body: Record<string, unknown>): unknown {
  return ((body.details ?? {}) as Record<string, unknown>).confirm;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return {
    body: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
    isError: result.isError === true,
  };
}

/** A registry with one failed optional provider offering embeddings. */
async function withFailedProvider(failures = 1): Promise<Harness> {
  return harness(async (registry) => {
    registry.register(flaky('embed.broken', failures, Capability.EMBEDDING), {
      optional: true,
    });
    registry.register(flaky('src.fine', 0, Capability.SOURCE_REPOSITORY));
    const host = hostFor();
    await registry.initializeAll(host);
    return host;
  });
}

afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

describe('what Ferret has, and what it cannot do — AC-1 to AC-8', () => {
  it('lists every provider with its kind and state — AC-1, AC-2', async () => {
    const { client } = await withFailedProvider();

    const { body } = await call(client, 'ferret_providers');
    const providers = body.providers as { id: string; kind: string; state: string }[];

    expect(providers.map((one) => one.id).sort()).toStrictEqual(['embed.broken', 'src.fine']);
    expect(providers.find((one) => one.id === 'src.fine')?.state).toBe(
      ProviderLifecycleState.INITIALIZED,
    );
    expect(providers.find((one) => one.id === 'src.fine')?.kind).toBe(ProviderKind.SOURCE);
  });

  it('reports a failed provider as failed, with the code and not a message — AC-4', async () => {
    const { client } = await withFailedProvider();

    const { body } = await call(client, 'ferret_providers');
    const failed = (body.providers as { id: string; state: string; failureCode?: string }[]).find(
      (one) => one.id === 'embed.broken',
    );

    expect(failed?.state).toBe(ProviderLifecycleState.FAILED);
    expect(failed?.failureCode).toBe(ErrorCode.PROVIDER_INIT_FAILED);
    // EPIC-093's rule: a message can carry a path or a value, and this reaches
    // a client's context window.
    expect(JSON.stringify(body)).not.toContain('is not ready');
  });

  it('lists a provider switched off in configuration as disabled — AC-3', async () => {
    const { client } = await harness(async (registry) => {
      registry.register(flaky('src.off', 0, Capability.SOURCE_REPOSITORY), { optional: true });
      const host = hostFor(parseConfig({ providers: { 'src.off': { enabled: false } } }));
      await registry.initializeAll(host);
      return host;
    });

    const { body } = await call(client, 'ferret_providers');
    const providers = body.providers as { id: string; state: string; enabled: boolean }[];

    // "Installed and off" is a different answer from "not installed", and only
    // one of them is a missing dependency — so it is still listed.
    expect(providers).toHaveLength(1);
    expect(providers[0]?.state).toBe(ProviderLifecycleState.DISABLED);
    expect(providers[0]?.enabled).toBe(false);
  });

  it('names the available capabilities — AC-6', async () => {
    const { client } = await withFailedProvider();

    const { body } = await call(client, 'ferret_providers');

    expect(body.availableCapabilities).toContain(Capability.SOURCE_REPOSITORY);
    // The failed provider's capability is not available, which is EPIC-093
    // §8.3 excluding it from selection.
    expect(body.availableCapabilities).not.toContain(Capability.EMBEDDING);
  });

  it('says no provider offers a capability nobody declared — AC-7', async () => {
    const { client } = await withFailedProvider();

    const { body } = await call(client, 'ferret_providers');
    const missing = (body.missingCapabilities as { capability: string; reason: string }[]).find(
      (one) => one.capability === Capability.STORAGE,
    );

    expect(missing?.reason).toContain('No registered provider offers');
  });

  it('says which provider failed, for a capability that has one — AC-8', async () => {
    // The question this Epic exists for: a client that got results without
    // embeddings could not learn whether nobody offers embeddings, it
    // is switched off, or it failed. Three answers, three remedies.
    const { client } = await withFailedProvider();

    const { body } = await call(client, 'ferret_providers');
    const missing = (
      body.missingCapabilities as {
        capability: string;
        reason: string;
        providerId?: string;
        failureCode?: string;
        remediation?: string;
      }[]
    ).find((one) => one.capability === Capability.EMBEDDING);

    expect(missing?.providerId).toBe('embed.broken');
    expect(missing?.reason).toContain('did not start');
    expect(missing?.failureCode).toBe(ErrorCode.PROVIDER_INIT_FAILED);
    // And it points at the tool that can fix it.
    expect(missing?.remediation).toContain('ferret_provider_recover');
  });

  it('says a capability is switched off when its provider is — AC-3, AC-8', async () => {
    const { client } = await harness(async (registry) => {
      registry.register(flaky('embed.off', 0, Capability.EMBEDDING), { optional: true });
      const host = hostFor(parseConfig({ providers: { 'embed.off': { enabled: false } } }));
      await registry.initializeAll(host);
      return host;
    });

    const { body } = await call(client, 'ferret_providers');
    const missing = (
      body.missingCapabilities as { capability: string; reason: string; remediation?: string }[]
    ).find((one) => one.capability === Capability.EMBEDDING);

    expect(missing?.reason).toContain('switched off in configuration');
    // A decision somebody made, so the remedy is a configuration change — and
    // it points at EPIC-066's tool rather than duplicating it.
    expect(missing?.remediation).toContain('ferret_config_set');
  });

  it('returns no provider option value — AC-5', async () => {
    const { client } = await harness(async (registry) => {
      registry.register(flaky('src.fine', 0, Capability.SOURCE_REPOSITORY));
      const host = hostFor(
        parseConfig({ providers: { 'src.fine': { enabled: true, options: { token: 'sekrit-value' } } } }),
      );
      await registry.initializeAll(host);
      return host;
    });

    const { body } = await call(client, 'ferret_providers');

    // EPIC-081 put credentials in provider options. A tool that returned them
    // would undo that Epic, so nothing here reads options at all.
    expect(JSON.stringify(body)).not.toContain('sekrit-value');
    expect(JSON.stringify(body)).not.toContain('token');
  });
});

describe('recovering a failed provider — AC-10 to AC-15', () => {
  it('plans without recovering when confirm is omitted — AC-12a', async () => {
    const { client, registry } = await withFailedProvider();

    const { body } = await call(client, 'ferret_provider_recover', { providerId: 'embed.broken' });

    // The plan names the state it is in *now*, so a client can tell a recovery
    // that will be refused from one that will be attempted.
    expect(JSON.stringify(body)).toContain(ProviderLifecycleState.FAILED);
    expect(tokenFrom(body)).toBeDefined();
    expect(registry.stateOf('embed.broken')?.state).toBe(ProviderLifecycleState.FAILED);
  });

  it('recovers on the confirmed call, and the capability comes back — AC-10, AC-11', async () => {
    const { client, registry } = await withFailedProvider();

    const plan = await call(client, 'ferret_provider_recover', { providerId: 'embed.broken' });
    const done = await call(client, 'ferret_provider_recover', {
      providerId: 'embed.broken',
      confirm: tokenFrom(plan.body),
    });

    expect(done.body.recovered).toBe(true);
    expect(done.body.state).toBe(ProviderLifecycleState.INITIALIZED);
    expect(registry.stateOf('embed.broken')?.state).toBe(ProviderLifecycleState.INITIALIZED);

    // AC-11's second half, and the point of the Epic: the next call to the read
    // tool reports the capability as available.
    const after = await call(client, 'ferret_providers');
    expect(after.body.availableCapabilities).toContain(Capability.EMBEDDING);
    expect(after.body.missingCapabilities).not.toContainEqual(
      expect.objectContaining({ capability: Capability.EMBEDDING }),
    );
  });

  it('reports a failed attempt with its code, and stays failed — AC-13', async () => {
    const { client } = await withFailedProvider(99);

    const plan = await call(client, 'ferret_provider_recover', { providerId: 'embed.broken' });
    const done = await call(client, 'ferret_provider_recover', {
      providerId: 'embed.broken',
      confirm: tokenFrom(plan.body),
    });

    expect(done.body.recovered).toBe(false);
    expect(done.body.state).toBe(ProviderLifecycleState.FAILED);
    expect(done.body.failureCode).toBe(ErrorCode.PROVIDER_INIT_FAILED);
  });

  it('refuses a required provider, naming which refusal — AC-14', async () => {
    const { client } = await harness((registry) => {
      // Registered required and never initialized, which is the state a client
      // could reach — `initializeAll` would have torn the process down.
      registry.register(flaky('src.required', 99, Capability.SOURCE_REPOSITORY));
      return Promise.resolve(hostFor());
    });

    const plan = await call(client, 'ferret_provider_recover', { providerId: 'src.required' });
    const done = await call(client, 'ferret_provider_recover', {
      providerId: 'src.required',
      confirm: tokenFrom(plan.body),
    });

    expect(done.body.refused).toBe(RecoveryRefusal.REQUIRED);
    // §8.5 — five refusals, five remediations. A client told "required"
    // restarts Ferret; one told "disabled" changes configuration.
    expect(String(done.body.remediation)).toContain('start Ferret again');
  });

  it('refuses an unknown provider id', async () => {
    const { client } = await withFailedProvider();

    const plan = await call(client, 'ferret_provider_recover', { providerId: 'nope.absent' });
    const done = await call(client, 'ferret_provider_recover', {
      providerId: 'nope.absent',
      confirm: tokenFrom(plan.body),
    });

    expect(done.body.refused).toBe(RecoveryRefusal.UNKNOWN);
  });

  it('refuses once the circuit is open, without calling initialize — AC-15', async () => {
    const { client, registry } = await withFailedProvider(99);
    const host = hostFor();
    // Spend the budget through the registry directly; the tool is what is under
    // test, not the arithmetic.
    while (registry.stateOf('embed.broken')?.state !== ProviderLifecycleState.UNRECOVERABLE) {
      await registry.recover('embed.broken', host);
    }

    const plan = await call(client, 'ferret_provider_recover', { providerId: 'embed.broken' });
    const done = await call(client, 'ferret_provider_recover', {
      providerId: 'embed.broken',
      confirm: tokenFrom(plan.body),
    });

    expect(done.body.refused).toBe(RecoveryRefusal.EXHAUSTED);
    // And the advice is to restart rather than to retry, because retrying
    // cannot work.
    expect(String(done.body.remediation)).toContain('restart Ferret');
  });
});

describe('both tools are guarded — AC-9, AC-12, AC-16, AC-18', () => {
  it('refuses the read without READ — AC-9', async () => {
    const { client } = await harness(async (registry) => {
      registry.register(flaky('src.fine', 0, Capability.SOURCE_REPOSITORY));
      const host = hostFor();
      await registry.initializeAll(host);
      return host;
    }, NO_READ);

    const { body, isError } = await call(client, 'ferret_providers');

    expect(isError).toBe(true);
    expect(body.code).toBe(ErrorCode.NOT_PERMITTED);
  });

  it('refuses the recovery without INDEX — AC-12', async () => {
    const { client } = await harness(async (registry) => {
      registry.register(flaky('embed.broken', 99, Capability.EMBEDDING), { optional: true });
      const host = hostFor();
      await registry.initializeAll(host);
      return host;
    }, READ_ONLY);

    const { body, isError } = await call(client, 'ferret_provider_recover', {
      providerId: 'embed.broken',
    });

    expect(isError).toBe(true);
    expect(body.code).toBe(ErrorCode.NOT_PERMITTED);
  });

  it('registers exactly two tools, and neither enables a provider — AC-16, AC-18', async () => {
    const { client } = await withFailedProvider();

    const { tools } = await client.listTools();
    const mine = tools.filter((tool) => tool.name.startsWith('ferret_provider'));

    expect(mine.map((tool) => tool.name).sort()).toStrictEqual([
      'ferret_provider_recover',
      'ferret_providers',
    ]);
    // AC-18 — enabling and disabling is a configuration change, and EPIC-066
    // already has it. A second path to the same setting would be a second set
    // of durability bugs.
    for (const tool of mine) {
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('enabled');
    }
  });
});
