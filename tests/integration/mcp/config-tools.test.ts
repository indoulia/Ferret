import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ANONYMOUS_PRINCIPAL,
  ConfirmationGate,
  Permission,
  type Principal,
} from '../../../src/authorization/index.js';
import { ConfigStore, defaultConfigSources, resolveConfig } from '../../../src/config/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';
import { registerConfigTools } from '../../../src/mcp/index.js';

/**
 * Configuration over MCP — EPIC-066, through the real protocol.
 *
 * Governance §1 and §16 require configuration to be performed through the
 * connected AI client, and EPIC-059/065's validation recorded that it could not
 * be: "An AI client cannot index, configure or manage providers — only read."
 *
 * A real `ConfigStore` over a real temporary file, deliberately. The point of
 * this Epic is that it *wraps* EPIC-003 rather than reimplementing it, and a fake
 * store would prove the opposite — it would show the tools calling something, and
 * hide whether the lock, the validation, the atomic write and the journal came
 * along.
 */

const GRANTED: Principal = {
  id: 'test.config',
  class: 'agent',
  permissions: [Permission.READ, Permission.CONFIG_READ, Permission.CONFIG_WRITE],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const READ_ONLY: Principal = { ...GRANTED, id: 'test.reader', permissions: [Permission.CONFIG_READ] };

interface Harness {
  readonly client: Client;
  readonly store: ConfigStore;
  readonly directory: string;
  readonly logger: RecordingLogger;
  close: () => Promise<void>;
}

async function harness(principal: Principal = GRANTED): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'ferret-config-tools-'));
  const configPath = join(directory, 'config.json');
  // A variable the secret-reference test resolves against. EPIC-003 refuses a
  // reference it cannot resolve, which is correct and is not what that test is
  // about.
  const env = { FERRET_DATABASE_PASSWORD: 'from-the-environment' };
  const store = new ConfigStore({ path: configPath, auditPath: join(directory, 'audit.jsonl'), env });

  // Recording rather than null — EPIC-091 AC-12 asserts what a write logs.
  const logger = new RecordingLogger();
  const server = new McpServer({ name: 'ferret-config-test', version: '0.0.0' });
  registerConfigTools(server, {
    principal,
    confirmations: new ConfirmationGate(),
    configuration: {
      // `repository: false` and an empty env so the test is hermetic: what this
      // asserts about precedence must not depend on the developer's own
      // environment or on whatever repository the suite happens to run in.
      resolve: () => resolveConfig(defaultConfigSources({ configPath, env: {}, repository: false }).sources),
      store,
    },
    logger,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'config-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    client,
    store,
    directory,
    logger,
    close: async () => {
      await client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly isError: boolean;
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

function details(body: Record<string, unknown>): Record<string, unknown> {
  return (body.details ?? {}) as Record<string, unknown>;
}

/** The two-call flow, as an AI client actually runs it. */
async function confirmAndCall(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ first: CallResult; second: CallResult }> {
  const first = await call(client, name, args);
  const token = details(first.body).confirm as string;
  const second = await call(client, name, { ...args, confirm: token });
  return { first, second };
}

describe('reading configuration over MCP', () => {
  let live: Harness;

  beforeEach(async () => {
    live = await harness();
    live.store.set('logLevel', 'debug');
    live.store.set('database.host', 'db.internal');
  });

  afterEach(async () => {
    await live.close();
  });

  it('registers five read tools and two write tools — AC-1 … AC-13', async () => {
    const { tools } = await live.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toStrictEqual([
      'ferret_config_audit',
      'ferret_config_describe',
      'ferret_config_exclusions',
      'ferret_config_schema',
      'ferret_config_set',
      'ferret_config_unset',
      'ferret_config_validate',
    ]);

    // Exactly two are destructive, and both say so — which is what makes a
    // conforming client prompt its user before calling them.
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint === true);
    expect(destructive.map((tool) => tool.name).sort()).toStrictEqual([
      'ferret_config_set',
      'ferret_config_unset',
    ]);
  });

  it('describes the whole configuration with the layer that supplied each value — AC-1', async () => {
    const result = await call(live.client, 'ferret_config_describe');

    expect(result.isError).toBe(false);
    const configuration = result.body.configuration as Record<string, unknown>;
    expect(configuration.logLevel).toBe('debug');
    // Governance §16 makes precedence the model, so a value without its origin
    // cannot be reasoned about.
    expect((result.body.origins as Record<string, string>)['logLevel']).toMatch(/^file:/);
    expect(result.body.unwritableThroughThisSurface).toStrictEqual(['authorization']);
  });

  it('reads one value by dotted path, with its origin — AC-2', async () => {
    const result = await call(live.client, 'ferret_config_describe', { path: 'database.host' });
    expect(result.body).toMatchObject({ path: 'database.host', value: 'db.internal', set: true, redacted: false });
    expect(result.body.origin).toMatch(/^file:/);
  });

  it('distinguishes an unset value from one set to null — Gov §6', async () => {
    const result = await call(live.client, 'ferret_config_describe', { path: 'database.user' });
    // `null` with `set: false` beside it. A bare `null` would be indistinguishable
    // from a value that is genuinely null, and Ferret must never manufacture
    // certainty about which it is.
    expect(result.body).toMatchObject({ value: null, set: false });
  });

  it('never returns a stored credential — AC-9', async () => {
    live.store.set('database.password', 'hunter2');

    const whole = await call(live.client, 'ferret_config_describe');
    const one = await call(live.client, 'ferret_config_describe', { path: 'database.password' });
    const audit = await call(live.client, 'ferret_config_audit');
    const validate = await call(live.client, 'ferret_config_validate');
    const schema = await call(live.client, 'ferret_config_schema');

    // Every read tool, not just the obvious one: a password extractable through
    // any of five surfaces is extractable.
    for (const [name, result] of [
      ['describe (whole)', whole],
      ['describe (path)', one],
      ['audit', audit],
      ['validate', validate],
      ['schema', schema],
    ] as const) {
      expect(JSON.stringify(result.body), name).not.toContain('hunter2');
    }
    // Masked, not merely absent — so the caller knows a value is there.
    expect(one.body).toMatchObject({ value: '[redacted]', redacted: true, set: true });
  });

  it('exports a schema an agent can discover keys from — AC-3', async () => {
    const result = await call(live.client, 'ferret_config_schema');
    const schema = result.body.schema as { properties?: Record<string, unknown> };

    // The gap EPIC-003's validation named: "an agent must use get/set rather than
    // discovering the schema".
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['logLevel', 'database', 'exclude', 'providers']),
    );
    // Said in the same response as the schema, because an agent that read the
    // schema alone would try to write `authorization` and be refused for a reason
    // the schema does not explain.
    expect(result.body.unwritableThroughThisSurface).toStrictEqual(['authorization']);
    expect(result.body.secretPathsTakeAReference).toContain('$secret');
  });

  it('reports the configuration as valid but not usable without a database — AC-11', async () => {
    const result = await call(live.client, 'ferret_config_validate');
    // Two different facts, and collapsing them would be EPIC-004's `unknown`
    // mistake: the configuration parses, and it is still missing what Ferret
    // needs to run.
    expect(result.body.valid).toBe(true);
    expect(result.body.usable).toBe(false);
    expect(result.body.missingDatabaseFields).toStrictEqual(['database', 'user', 'password']);
  });

  it('reports an invalid configuration as an answer rather than a failure — AC-11', async () => {
    // The one input a validate tool most needs to survive.
    writeFileSync(join(live.directory, 'config.json'), JSON.stringify({ version: 1, config: { logLevel: 'shouty' } }));
    const result = await call(live.client, 'ferret_config_validate');
    expect(result.body.valid).toBe(false);
    expect(String(result.body.problem)).toMatch(/logLevel/);
  });

  it('reads the change journal — AC-12', async () => {
    const result = await call(live.client, 'ferret_config_audit');
    const entries = result.body.entries as { path: string; action: string }[];

    // The last two, in order, rather than the whole journal: EPIC-003 also
    // records the file being created, and asserting the exact contents would tie
    // this test to that Epic's bookkeeping rather than to what it is checking.
    expect(entries.slice(-2).map((entry) => entry.path)).toStrictEqual(['logLevel', 'database.host']);
    for (const entry of entries.slice(-2)) expect(entry.action).toBe('set');
  });

  it('lists exclusions and tests a path against them — AC-13', async () => {
    const list = await call(live.client, 'ferret_config_exclusions');
    // Ferret's defaults *plus* the user's. `config.exclude` alone would read as
    // "nothing is excluded" on a default installation, which is the opposite of
    // the truth.
    expect(Number(list.body.count)).toBeGreaterThan(0);

    const excluded = await call(live.client, 'ferret_config_exclusions', { path: 'node_modules/left-pad/index.js' });
    expect(excluded.body.excluded).toBe(true);
    // The rule that decided it, so "why is this excluded" is answerable without
    // the caller re-deriving it.
    expect(excluded.body.rule).not.toBeNull();

    const kept = await call(live.client, 'ferret_config_exclusions', { path: 'src/index.ts' });
    expect(kept.body).toMatchObject({ excluded: false, rule: null });
  });
});

describe('changing configuration over MCP', () => {
  let live: Harness;

  beforeEach(async () => {
    live = await harness();
  });

  afterEach(async () => {
    await live.close();
  });

  it('refuses the first call, discloses the plan, and writes nothing — AC-7', async () => {
    const first = await call(live.client, 'ferret_config_set', { path: 'logLevel', value: 'debug' });

    expect(first.isError).toBe(true);
    expect(first.body.code).toBe('E_CONFIRMATION_REQUIRED');
    expect(details(first.body).plan).toMatchObject({
      operation: 'config.set',
      // `SET`, not `OVERWRITE`: nothing was stored there. The distinction is the
      // difference between "you are adding a value" and "you are discarding one".
      effects: [{ target: 'logLevel', change: 'set', to: 'debug' }],
    });
    expect(live.store.exists).toBe(false);
  });

  it('stores the value on confirmation, and it is readable back — AC-4', async () => {
    const { second } = await confirmAndCall(live.client, 'ferret_config_set', {
      path: 'database.host',
      value: 'db.internal',
    });

    expect(second.isError).toBe(false);
    expect(second.body).toMatchObject({ path: 'database.host', stored: true, journalled: true });

    // Read back through the tool, not through the store: what matters is that an
    // AI client sees its own change.
    const read = await call(live.client, 'ferret_config_describe', { path: 'database.host' });
    expect(read.body.value).toBe('db.internal');
  });

  it('logs the path and the principal of a write — EPIC-091 AC-12', async () => {
    // EPIC-066 §262 wrote this line as "loggable" and never wrote it. A
    // configuration write is the one MCP operation that changes what Ferret is,
    // and an operator asking "who changed this" had nothing to read.
    await confirmAndCall(live.client, 'ferret_config_set', { path: 'database.host', value: 'db.internal' });

    const written = live.logger.records.find((r) => r.fields['operation'] === 'mcp.config.stored');
    expect(written).toBeDefined();
    expect(written?.fields['path']).toBe('database.host');
    expect(written?.fields['principal']).toBe(GRANTED.id);
    expect(written?.fields['redacted']).toBe(false);
  });

  it('logs a credential write without the reference it stored — EPIC-091 AC-12', async () => {
    // The path that actually holds a secret. EPIC-066 refuses a literal here, so
    // what is written is a reference — and the log line records that the path
    // was written and that its value is one Ferret would mask, never the value.
    await confirmAndCall(live.client, 'ferret_config_set', {
      path: 'database.password',
      // The one variable the store's environment actually has, because the
      // write validates by resolving: a reference to an unset variable is
      // correctly refused, and that is a different test.
      value: { $secret: { env: 'FERRET_DATABASE_PASSWORD' } },
    });

    const written = live.logger.records.find((r) => r.fields['operation'] === 'mcp.config.stored');
    expect(written?.fields['path']).toBe('database.password');
    expect(written?.fields['redacted']).toBe(true);
    expect(JSON.stringify(live.logger.records)).not.toContain('from-the-environment');
  });

  it('reports OVERWRITE and the previous value when replacing — AC-7', async () => {
    live.store.set('logLevel', 'warn');
    const first = await call(live.client, 'ferret_config_set', { path: 'logLevel', value: 'trace' });
    expect(details(first.body).plan).toMatchObject({
      effects: [{ target: 'logLevel', change: 'overwrite', from: 'warn', to: 'trace' }],
    });
  });

  it('removes a value on confirmation, restoring the default — AC-5', async () => {
    live.store.set('logLevel', 'trace');
    const { first, second } = await confirmAndCall(live.client, 'ferret_config_unset', { path: 'logLevel' });

    expect(details(first.body).plan).toMatchObject({
      operation: 'config.unset',
      effects: [{ target: 'logLevel', change: 'unset', from: 'trace' }],
    });
    expect(second.body).toMatchObject({ path: 'logLevel', removed: true });

    const read = await call(live.client, 'ferret_config_describe', { path: 'logLevel' });
    // Back to the schema default, not absent: unsetting restores rather than
    // deletes the concept.
    expect(read.body).toMatchObject({ value: 'warn', origin: 'default' });
  });

  it('accepts a non-string value as its real type — AC-4', async () => {
    const { second } = await confirmAndCall(live.client, 'ferret_config_set', {
      path: 'database.port',
      value: 6543,
    });
    expect(second.isError).toBe(false);
    const read = await call(live.client, 'ferret_config_describe', { path: 'database.port' });
    expect(read.body.value).toBe(6543);
  });

  it('refuses an invalid value and leaves the file byte-identical — AC-10', async () => {
    live.store.set('logLevel', 'warn');
    const before = readFileSync(live.store.path, 'utf8');

    const { second } = await confirmAndCall(live.client, 'ferret_config_set', {
      path: 'logLevel',
      value: 'shouty',
    });

    expect(second.isError).toBe(true);
    expect(second.body.code).toBe('E_CONFIG_INVALID');
    // EPIC-003's guarantee, exercised through the surface most likely to hit it.
    expect(readFileSync(live.store.path, 'utf8')).toBe(before);
  });

  it('persists a scope selector that reaches the access context — AC-14', async () => {
    // `validation/EPIC-009-VALIDATION.md` §115: "Scope selectors are not
    // persisted. They are evaluated from whatever a caller supplies." They are
    // now — through the same file `principalFrom` reads.
    //
    // Written directly rather than through the tool because `authorization` is
    // unwritable over MCP by design (AC-8); what AC-14 needs is that a selector
    // *stored* in configuration survives and resolves.
    live.store.set('authorization', {
      principalId: 'scoped.agent',
      principalClass: 'agent',
      permissions: ['read'],
      permittedScopes: ['team-a'],
      scope: { include: [{ kind: 'repository', id: 'repo-one' }], exclude: [] },
    });

    const result = await call(live.client, 'ferret_config_describe', { path: 'authorization.permittedScopes' });
    expect(result.body.value).toStrictEqual(['team-a']);

    const { principalFrom, accessContextFor } = await import('../../../src/authorization/index.js');
    const { config } = resolveConfig(
      defaultConfigSources({ configPath: live.store.path, env: {}, repository: false }).sources,
    );
    const principal = principalFrom(config);
    expect(principal.permittedScopes).toStrictEqual(['team-a']);
    expect(accessContextFor(principal).permittedScopes).toStrictEqual(['team-a']);
    expect(accessContextFor(principal).scope.include).toStrictEqual([
      { kind: 'repository', id: 'repo-one' },
    ]);
  });
});

describe('what a configuration tool refuses', () => {
  let live: Harness;

  beforeEach(async () => {
    live = await harness();
  });

  afterEach(async () => {
    await live.close();
  });

  it('refuses to write any authorization path — AC-8', async () => {
    // The rule that makes the rest of the authorization model mean anything. A
    // client granted CONFIG_WRITE must not be able to grant itself MUTATE.
    for (const path of [
      'authorization',
      'authorization.permissions',
      'authorization.permittedScopes',
      'authorization.principalId',
      'authorization.scope.include',
    ]) {
      const result = await call(live.client, 'ferret_config_set', { path, value: ['mutate'] });
      expect(result.body.code, path).toBe('E_NOT_PERMITTED');
      // Refused *before* a plan is built, so a denied caller does not learn the
      // current grant in the course of being refused.
      expect(details(result.body).plan, path).toBeUndefined();
    }

    const removal = await call(live.client, 'ferret_config_unset', { path: 'authorization.permissions' });
    expect(removal.body.code).toBe('E_NOT_PERMITTED');
    expect(live.store.exists).toBe(false);
  });

  it('refuses a literal credential and names the reference form — AC-9', async () => {
    const result = await call(live.client, 'ferret_config_set', {
      path: 'database.password',
      value: 'hunter2',
    });
    expect(result.body.code).toBe('E_USAGE');
    expect(String(result.body.remediation)).toContain('$secret');
    expect(live.store.exists).toBe(false);
  });

  it('accepts a secret reference, which is the point of refusing the literal', async () => {
    const { second } = await confirmAndCall(live.client, 'ferret_config_set', {
      path: 'database.password',
      value: { $secret: { env: 'FERRET_DATABASE_PASSWORD' } },
    });
    expect(second.isError).toBe(false);
    expect(second.body).toMatchObject({ stored: true, redacted: true });
  });

  it('refuses a path that addresses object internals — AC-16', async () => {
    // Issue #81, fixed in EPIC-003. This surface is the reason it mattered: the
    // path is a string a model chooses.
    for (const path of ['__proto__.polluted', 'a.constructor.b', 'prototype']) {
      const result = await call(live.client, 'ferret_config_set', { path, value: 'OWNED' });
      expect(result.body.code, path).toBe('E_USAGE');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a confirmation issued for a different path — EPIC-069 AC-6', async () => {
    const first = await call(live.client, 'ferret_config_set', { path: 'logLevel', value: 'debug' });
    const token = details(first.body).confirm as string;

    // A token issued to change the log level must not change the database host.
    const elsewhere = await call(live.client, 'ferret_config_set', {
      path: 'database.host',
      value: 'attacker.example',
      confirm: token,
    });
    expect(elsewhere.body.code).toBe('E_CONFIRMATION_INVALID');
    expect(live.store.exists).toBe(false);
  });

  it('refuses a write to a caller granted only CONFIG_READ — AC-6', async () => {
    const reader = await harness(READ_ONLY);
    const write = await call(reader.client, 'ferret_config_set', { path: 'logLevel', value: 'debug' });
    expect(write.body.code).toBe('E_NOT_PERMITTED');
    // And the read it *was* granted still works, so the refusal means something.
    const read = await call(reader.client, 'ferret_config_describe');
    expect(read.isError).toBe(false);
    await reader.close();
  });

  it('refuses everything to the anonymous principal — AC-6', async () => {
    // EPIC-068 grants the default principal `READ` and nothing else. Configuration
    // holds credentials by design, so `config.read` is deliberately not granted
    // out of the box — specification §16 records that decision.
    const anonymous = await harness(ANONYMOUS_PRINCIPAL);
    for (const [name, args] of [
      ['ferret_config_describe', {}],
      ['ferret_config_schema', {}],
      ['ferret_config_validate', {}],
      ['ferret_config_audit', {}],
      ['ferret_config_exclusions', {}],
      ['ferret_config_set', { path: 'logLevel', value: 'debug' }],
      ['ferret_config_unset', { path: 'logLevel' }],
    ] as const) {
      const result = await call(anonymous.client, name, args);
      expect(result.body.code, name).toBe('E_NOT_PERMITTED');
    }
    await anonymous.close();
  });

  it('reports a malformed path rather than throwing from a handler', async () => {
    // Two different layers, and the difference is worth pinning. An empty string
    // violates the tool's own schema, so the SDK refuses it before any handler
    // runs, and reports a protocol-level validation error rather than one of
    // Ferret's — which is right, and is why this is asserted on the text rather
    // than parsed for a Ferret code.
    const schemaViolation = (await live.client.callTool({
      name: 'ferret_config_describe',
      arguments: { path: '' },
    })) as { content: { text: string }[]; isError?: boolean };
    expect(schemaViolation.isError).toBe(true);
    expect(schemaViolation.content[0]?.text).toMatch(/validation error/i);

    // A well-formed string that is not a usable path reaches `parsePath` inside
    // the guard, and comes back as a structured error with a code to branch on.
    // Before the fix this escaped `serializeError` and arrived unredacted with no
    // code at all.
    for (const path of ['.', 'a..b', 'a.']) {
      const result = await call(live.client, 'ferret_config_describe', { path });
      expect(result.isError, path).toBe(true);
      expect(result.body.code, path).toBe('E_USAGE');
    }

    // And the server is still serving, which is the actual claim.
    const after = await call(live.client, 'ferret_config_schema');
    expect(after.isError).toBe(false);
  });
});
