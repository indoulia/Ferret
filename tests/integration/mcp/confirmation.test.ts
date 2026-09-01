import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConfirmationGate,
  EffectChange,
  Permission,
  type OperationPlan,
  type Principal,
} from '../../../src/authorization/index.js';
import { createNullLogger } from '../../../src/index.js';
import { CONFIRM_PARAMETER_DESCRIPTION, createDestructiveToolGuard } from '../../../src/mcp/index.js';

/**
 * Confirmation on the AI surface — EPIC-069, through the real protocol.
 *
 * What only the protocol can show is that the *flow* works: that a refusal
 * reaches a client carrying a token it can read out of the response and send
 * back, and that the second call is the one that acts. A unit test can prove the
 * gate's rules; it cannot prove the token survives being serialized into a tool
 * error and pulled back out of one.
 *
 * The tool driven here is registered **by this test**, through
 * `createDestructiveToolGuard` — the same public composition a product tool uses.
 * EPIC-069 §4 excludes adding a destructive tool to Ferret's own surface, and
 * EPIC-066 registers the first; a confirmation flow nobody has driven through the
 * protocol is a flow nobody has tested, and this resolves that without taking
 * that Epic's scope.
 */

const GRANTED: Principal = {
  id: 'test.granted',
  class: 'agent',
  permissions: [Permission.READ, Permission.CONFIG_WRITE],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const UNGRANTED: Principal = { ...GRANTED, id: 'test.ungranted', permissions: [Permission.READ] };

/** What the tool under test would change, and what it actually did. */
interface Subject {
  value: string;
  /** Every call that reached the handler. The count is the assertion. */
  applied: string[];
}

interface Harness {
  readonly client: Client;
  readonly subject: Subject;
  close: () => Promise<void>;
}

/**
 * A server with one destructive tool on it.
 *
 * Deliberately the smallest such tool that is still honest: it declares
 * `CONFIG_WRITE`, it declares `destructiveHint`, it builds a plan naming what it
 * would overwrite, and it mutates something observable so "did the handler run"
 * is a fact rather than an inference.
 */
async function harness(principal: Principal, gate: ConfirmationGate): Promise<Harness> {
  const subject: Subject = { value: 'warn', applied: [] };
  const logger = createNullLogger();
  const guardDestructive = createDestructiveToolGuard({ principal, logger, confirmations: gate });

  const server = new McpServer({ name: 'ferret-test', version: '0.0.0' });

  server.registerTool(
    'test_set_value',
    {
      title: 'Set the value',
      inputSchema: z.strictObject({
        to: z.string().min(1),
        confirm: z.string().min(1).optional().describe(CONFIRM_PARAMETER_DESCRIPTION),
      }),
      // What a conforming client prompts its user about. Ferret cannot enforce
      // that prompt; declaring the hint is how it asks for it.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ to, confirm }) => {
      const plan = (): OperationPlan => ({
        operation: 'test.set',
        summary: 'Replace the value.',
        effects: [{ target: 'logLevel', change: EffectChange.OVERWRITE, from: subject.value, to }],
      });
      return guardDestructive('test.set', Permission.CONFIG_WRITE, plan, confirm, () => {
        subject.applied.push(to);
        subject.value = to;
        return Promise.resolve({ applied: true, value: subject.value });
      });
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'confirming-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, subject, close: async () => client.close() };
}

interface CallResult {
  readonly body: Record<string, unknown>;
  readonly isError: boolean;
}

async function call(client: Client, args: Record<string, unknown>): Promise<CallResult> {
  const result = (await client.callTool({ name: 'test_set_value', arguments: args })) as {
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

describe('confirming a destructive tool over MCP', () => {
  let live: Harness;

  beforeEach(async () => {
    live = await harness(GRANTED, new ConfirmationGate());
  });

  afterEach(async () => {
    await live.close();
  });

  it('refuses the first call, changes nothing, and returns the plan — AC-1, AC-2, AC-11', async () => {
    const first = await call(live.client, { to: 'debug' });

    // An error, not an empty success: the operation did not happen, and a client
    // that read `applied: false` out of a success would have to be reading
    // carefully. `isError` does not require care.
    expect(first.isError).toBe(true);
    expect(first.body.code).toBe('E_CONFIRMATION_REQUIRED');

    const plan = details(first.body).plan as { operation: string; effects: unknown[] };
    expect(plan.operation).toBe('test.set');
    expect(plan.effects).toStrictEqual([
      { target: 'logLevel', change: 'overwrite', from: 'warn', to: 'debug' },
    ]);

    // The assertion that makes this a confirmation rather than a warning.
    expect(live.subject.applied).toStrictEqual([]);
    expect(live.subject.value).toBe('warn');
  });

  it('performs the operation when the returned token is presented — AC-3, AC-4, AC-11', async () => {
    const first = await call(live.client, { to: 'debug' });
    const token = details(first.body).confirm as string;
    expect(typeof token).toBe('string');

    const second = await call(live.client, { to: 'debug', confirm: token });

    expect(second.isError).toBe(false);
    expect(second.body).toStrictEqual({ applied: true, value: 'debug' });
    // Exactly once. Not zero, and not twice.
    expect(live.subject.applied).toStrictEqual(['debug']);
  });

  it('tells the client how to proceed without it having to guess — AC-3', async () => {
    const first = await call(live.client, { to: 'debug' });
    const remediation = String(first.body.remediation);
    expect(remediation).toContain(String(details(first.body).confirm));
    expect(remediation).toMatch(/call the same tool again/i);
  });

  it('refuses a token issued for a different plan — AC-6', async () => {
    // The escalation this exists to stop: confirm the small change, then present
    // that confirmation for a larger one.
    const first = await call(live.client, { to: 'debug' });
    const token = details(first.body).confirm as string;

    const escalated = await call(live.client, { to: 'trace', confirm: token });

    expect(escalated.isError).toBe(true);
    expect(escalated.body.code).toBe('E_CONFIRMATION_INVALID');
    expect(live.subject.applied).toStrictEqual([]);
  });

  it('refuses the second use of a token — AC-7', async () => {
    const first = await call(live.client, { to: 'debug' });
    const token = details(first.body).confirm as string;
    await call(live.client, { to: 'debug', confirm: token });

    // Note the plan has also moved on — `from` is now 'debug' — so this is
    // refused twice over, and that is the point: one approval, one change.
    const replay = await call(live.client, { to: 'debug', confirm: token });
    expect(replay.isError).toBe(true);
    expect(replay.body.code).toBe('E_CONFIRMATION_INVALID');
    expect(live.subject.applied).toStrictEqual(['debug']);
  });

  it('refuses a token the client made up — AC-5', async () => {
    for (const forged of ['confirm', 'yes', 'A'.repeat(43), 'test.set']) {
      const result = await call(live.client, { to: 'debug', confirm: forged });
      expect(result.body.code, forged).toBe('E_CONFIRMATION_INVALID');
    }
    expect(live.subject.applied).toStrictEqual([]);
  });

  it('does not reuse a confirmation across a restart of the gate', async () => {
    // A pending confirmation is process-local and never persisted: one that
    // survived a restart is one nobody is still present for.
    const first = await call(live.client, { to: 'debug' });
    const token = details(first.body).confirm as string;

    const restarted = await harness(GRANTED, new ConfirmationGate());
    const result = await call(restarted.client, { to: 'debug', confirm: token });
    expect(result.body.code).toBe('E_CONFIRMATION_INVALID');
    expect(restarted.subject.applied).toStrictEqual([]);
    await restarted.close();
  });

  it('discloses a redaction rather than a secret value — AC-10', async () => {
    const gate = new ConfirmationGate();
    const secretive = await harness(GRANTED, gate);
    // Through the same tool, whose target is not secret-named — so this asserts
    // the tool's own values are disclosed, and the gate's own unit tests cover the
    // secret-named path. What matters here is that nothing extra leaks over the
    // wire: no configuration, no credential.
    const first = await call(secretive.client, { to: 'debug' });
    const text = JSON.stringify(first.body);
    expect(text).not.toMatch(/password|secret|connectionString/i);
    await secretive.close();
  });
});

describe('authorization before confirmation — AC-9', () => {
  it('refuses an unpermitted caller with NOT_PERMITTED and discloses no plan', async () => {
    const denied = await harness(UNGRANTED, new ConfirmationGate());
    const result = await call(denied.client, { to: 'debug' });

    expect(result.isError).toBe(true);
    // Not `CONFIRMATION_REQUIRED`. The order is a contract: a plan names
    // configuration paths and current values, and handing that to a caller who
    // may not act is a disclosure about Ferret's state made to someone who was
    // refused.
    expect(result.body.code).toBe('E_NOT_PERMITTED');
    expect(details(result.body).plan).toBeUndefined();
    expect(JSON.stringify(result.body)).not.toContain('logLevel');
    expect(denied.subject.applied).toStrictEqual([]);

    await denied.close();
  });

  it('does not let a valid confirmation substitute for a permission', async () => {
    // Both must hold. A token issued by a gate this server shares proves the
    // caller was once shown a plan; it does not grant anything.
    const gate = new ConfirmationGate();
    const permitted = await harness(GRANTED, gate);
    const first = await call(permitted.client, { to: 'debug' });
    const token = details(first.body).confirm as string;

    const denied = await harness(UNGRANTED, gate);
    const result = await call(denied.client, { to: 'debug', confirm: token });
    expect(result.body.code).toBe('E_NOT_PERMITTED');
    expect(denied.subject.applied).toStrictEqual([]);

    await Promise.all([permitted.close(), denied.close()]);
  });

  it('does not build a plan for a caller it is about to refuse', async () => {
    // `plan` is a thunk for this reason. Building it may read current state, and
    // doing that for a caller about to be refused is work Ferret should not do —
    // asserted by counting, because the ordering is the property.
    let planned = 0;
    const logger = createNullLogger();
    const guardDestructive = createDestructiveToolGuard({
      principal: UNGRANTED,
      logger,
      confirmations: new ConfirmationGate(),
    });

    const server = new McpServer({ name: 'ferret-test', version: '0.0.0' });
    server.registerTool(
      'test_set_value',
      {
        inputSchema: z.strictObject({ to: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ to }) =>
        guardDestructive(
          'test.set',
          Permission.CONFIG_WRITE,
          () => {
            planned += 1;
            return { operation: 'test.set', summary: 'x', effects: [{ target: 'y', change: EffectChange.OVERWRITE, to }] };
          },
          undefined,
          () => Promise.resolve({ applied: true }),
        ),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await call(client, { to: 'debug' });
    expect(result.body.code).toBe('E_NOT_PERMITTED');
    expect(planned).toBe(0);

    await client.close();
  });
});
