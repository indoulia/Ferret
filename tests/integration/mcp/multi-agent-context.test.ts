import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission, type Principal } from '../../../src/authorization/index.js';
import {
  ContextKind,
  ContextTransition,
  LifecycleState,
  createEngineeringMemory,
  createNullLogger,
  createSession,
} from '../../../src/index.js';
import { createToolGuard, registerContextTools } from '../../../src/mcp/index.js';
import {
  DurableContextStore,
  SessionStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-132 — two agents, one durable context, neither owning it.
 *
 * **Proof of the architecture, not a new mechanism.** The Epic says so
 * explicitly, and nothing is built here: two genuinely distinct clients are
 * composed over one real store and one real database, and the four properties
 * are asserted across the boundary between them.
 *
 * The two agents differ in every way a client can: a different principal id, a
 * different set of permissions, a different producer identity, a different MCP
 * server and a different transport. What they share is the store — which is the
 * whole claim.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/** An agent that records and curates. */
const ALICE: Principal = {
  id: 'agent.alice',
  class: 'agent',
  permissions: [Permission.READ, Permission.RECORD, Permission.MUTATE],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

/** A different agent, on a different client, holding less. */
const BOB: Principal = {
  id: 'agent.bob',
  class: 'agent',
  permissions: [Permission.READ, Permission.RECORD],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

let db: TestDatabase;
let handle: FerretDatabase;
let sessions: SessionStore;
let alice: Client;
let bob: Client;

async function agent(principal: Principal, producer: string): Promise<Client> {
  const server = new McpServer({ name: `ferret-${principal.id}`, version: '0.0.0' });
  registerContextTools({
    server,
    guard: createToolGuard({ principal, logger: new RecordingLogger() }),
    // One store. Two clients. Neither owns it.
    context: new DurableContextStore(handle),
    sessions,
    actorId: principal.id,
    permittedScopes: principal.permittedScopes,
    producer,
    producerVersion: '0.0.0',
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: principal.id, version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ body: Record<string, unknown>; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = result.content[0]?.text ?? '{}';
  // A refused call returns a diagnostic rather than an envelope; keeping the
  // raw text means a failure says what it was instead of throwing here.
  const body = ((): Record<string, unknown> => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  })();
  return { body, isError: result.isError === true };
}

describeDb(`two agents over one durable context (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('multi-agent');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    sessions = new SessionStore(handle);

    alice = await agent(ALICE, 'agent.alice/1.0');
    bob = await agent(BOB, 'agent.bob/2.0');
  });

  afterAll(async () => {
    await alice.close();
    await bob.close();
    await db.drop();
  });

  it('lets one agent read what another recorded', async () => {
    const recorded = await call(alice, 'ferret_context_record', {
      statement: 'The connector contract is the only way a new source reaches the index',
      contextKind: ContextKind.CONSTRAINT,
    });
    const id = (recorded.body['context'] as Record<string, unknown>)['id'] as string;

    const found = await call(bob, 'ferret_context_find', {});
    const ids = (found.body['context'] as Record<string, unknown>[]).map((one) => one['id']);

    expect(ids).toContain(id);
  });

  it('shows the second agent who said it, not who asked', async () => {
    const recorded = await call(alice, 'ferret_context_record', {
      statement: 'Provenance names the producer that stated a thing, not the caller reading it',
      contextKind: ContextKind.FACT,
    });
    const id = (recorded.body['context'] as Record<string, unknown>)['id'] as string;

    const trusted = await call(bob, 'ferret_context_trust', { contextId: id });
    const belief = trusted.body['belief'] as Record<string, unknown>;

    expect(trusted.body['found']).toBe(true);
    expect(belief['supportCount']).toBe(1);

    // The evidence is Alice's, read by Bob. Provenance survived the boundary.
    const support = await handle.execute<{ [column: string]: unknown; producer: string }>(
      sql`SELECT producer FROM ferret.evidence WHERE subject_id = ${id}`,
    );
    expect(support.rows.map((row) => row.producer)).toStrictEqual(['agent.alice/1.0']);
  });

  it('merges a restatement rather than duplicating it across agents', async () => {
    const statement = 'A bounded pass persists the cursor it stopped at';
    const first = await call(alice, 'ferret_context_record', { statement, contextKind: ContextKind.FACT });
    const second = await call(bob, 'ferret_context_record', {
      statement: `${statement}.`,
      contextKind: ContextKind.FACT,
    });

    // One record, two observations. Neither agent's copy; Ferret's.
    expect(second.body['outcome']).toBe('merged');
    expect((second.body['context'] as Record<string, unknown>)['id']).toBe(
      (first.body['context'] as Record<string, unknown>)['id'],
    );

    const id = (first.body['context'] as Record<string, unknown>)['id'] as string;
    const trusted = await call(alice, 'ferret_context_trust', { contextId: id });
    expect((trusted.body['belief'] as Record<string, unknown>)['supportCount']).toBe(2);
  });

  it('carries a lifecycle across the boundary, not just a statement', async () => {
    const proposed = await call(alice, 'ferret_context_record', {
      statement: 'A macOS runner might be reconsidered once the suites drop the container',
      contextKind: ContextKind.NEXT_STEP,
      propose: true,
    });
    const id = (proposed.body['context'] as Record<string, unknown>)['id'] as string;

    // Alice proposed it; to Bob it is a proposal, not something Ferret holds.
    const current = await call(bob, 'ferret_context_find', {});
    expect((current.body['context'] as Record<string, unknown>[]).map((one) => one['id'])).not.toContain(id);

    const proposals = await call(bob, 'ferret_context_find', { states: [LifecycleState.CANDIDATE] });
    const seen = (proposals.body['context'] as Record<string, unknown>[]).find((one) => one['id'] === id);
    expect(seen?.['current']).toBe(false);

    // Alice accepts. Bob now reads it as current, without being told.
    await call(alice, 'ferret_context_lifecycle', { contextId: id, transition: ContextTransition.ACCEPT });
    const after = await call(bob, 'ferret_context_find', {});
    expect((after.body['context'] as Record<string, unknown>[]).map((one) => one['id'])).toContain(id);
  });

  it('lets one agent supersede another, and both sides stay readable', async () => {
    const old = await call(alice, 'ferret_context_record', {
      statement: 'The default ingestion page limit is twenty pages in every bounded pass',
      contextKind: ContextKind.FACT,
    });
    const oldId = (old.body['context'] as Record<string, unknown>)['id'] as string;

    const replacement = await call(bob, 'ferret_context_record', {
      statement: 'The default ingestion page limit is twenty pages in each bounded pass',
      contextKind: ContextKind.FACT,
      supersedes: oldId,
    });

    expect(replacement.body['superseded']).toBe(oldId);

    // Alice reads the record she wrote as replaced, and can reach it.
    const trusted = await call(alice, 'ferret_context_trust', { contextId: oldId });
    const belief = trusted.body['belief'] as Record<string, unknown>;
    expect(belief['current']).toBe(false);
    expect(belief['supersededBy']).toBe((replacement.body['context'] as Record<string, unknown>)['id']);
  });

  it('refuses one agent the curation the other was granted', async () => {
    const recorded = await call(alice, 'ferret_context_record', {
      statement: 'Curation is a privilege granted separately from recording',
      contextKind: ContextKind.PREFERENCE,
    });
    const id = (recorded.body['context'] as Record<string, unknown>)['id'] as string;

    // Bob holds `record` and not `mutate`.
    const refused = await call(bob, 'ferret_context_lifecycle', {
      contextId: id,
      transition: ContextTransition.ARCHIVE,
    });
    expect(refused.isError).toBe(true);

    // Alice may, and Bob sees the result.
    const allowed = await call(alice, 'ferret_context_lifecycle', {
      contextId: id,
      transition: ContextTransition.ARCHIVE,
    });
    expect(allowed.isError).toBe(false);
    const current = await call(bob, 'ferret_context_find', {});
    expect((current.body['context'] as Record<string, unknown>[]).map((one) => one['id'])).not.toContain(id);
  });

  describe("an agent's own working state stays its own", () => {
    const AT = '2026-09-06T11:00:00.000Z';

    beforeAll(async () => {
      await sessions.save(
        createSession({
          sessionId: 'alice-private',
          provider: 'test',
          actorId: ALICE.id,
          startedAt: AT,
        }),
      );
      await sessions.recordMemory(
        createEngineeringMemory({
          sessionId: 'alice-private',
          kind: 'decision',
          statement: 'A working note Alice never offered to anyone',
          origin: 'explicit',
          recordedAt: AT,
        }),
      );
    });

    it('refuses to let one agent publish another agent’s session', async () => {
      // The defect EPIC-132 found in EPIC-129's tool: promotion turns working
      // state into shared organizational knowledge, and done by a non-owner it
      // publishes notes their owner never offered.
      const refused = await call(bob, 'ferret_context_promote', { sessionId: 'alice-private' });

      expect(refused.body['found']).toBe(false);
      expect(refused.body['detail']).toBe('No session you own has that identifier.');
      expect(refused.body['considered']).toBeUndefined();

      // And nothing was published.
      const found = await call(bob, 'ferret_context_find', {});
      const statements = (found.body['context'] as Record<string, unknown>[]).map((one) =>
        String(one['statement']),
      );
      expect(statements.some((one) => one.includes('never offered'))).toBe(false);
    });

    it('says the same thing for an identifier that names nothing', async () => {
      // The refusal does not distinguish the two, so a caller learns nothing
      // about whose sessions exist.
      const missing = await call(bob, 'ferret_context_promote', { sessionId: 'no-such-session' });

      expect(missing.body['found']).toBe(false);
      expect(missing.body['detail']).toBe('No session you own has that identifier.');
    });

    it('lets the owner promote its own session', async () => {
      const promoted = await call(alice, 'ferret_context_promote', { sessionId: 'alice-private' });

      expect(promoted.body['found']).toBe(true);
      expect(promoted.body['created']).toBe(1);

      // And once Alice publishes it, it is shared — which is the point of
      // promotion, and why it has to be hers to make.
      const found = await call(bob, 'ferret_context_find', {});
      const statements = (found.body['context'] as Record<string, unknown>[]).map((one) =>
        String(one['statement']),
      );
      expect(statements.some((one) => one.includes('never offered'))).toBe(true);
    });
  });
});
