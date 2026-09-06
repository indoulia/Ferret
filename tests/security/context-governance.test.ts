import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Permission, type Principal } from '../../src/authorization/index.js';
import {
  ContextKind,
  ContextTransition,
  LifecycleState,
  createEngineeringMemory,
  createNullLogger,
  createSession,
} from '../../src/index.js';
import { createToolGuard, registerContextTools, registerSessionTools } from '../../src/mcp/index.js';
import {
  DurableContextStore,
  EvidenceStore,
  RetentionService,
  RetentionTarget,
  SessionStore,
  migrate,
  type FerretDatabase,
} from '../../src/storage/index.js';
import { RecordingLogger } from '../support/recording-logger.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../support/postgres.js';

/**
 * EPIC-133 — durable organizational context, made safe to share.
 *
 * Security tests are mandatory for this Epic, and these are they. Every control
 * asserted here is one Ferret already had — `Permission`, the tool guard, the
 * permission scope on evidence, the entity scope, `RetentionService` — applied
 * to durable context. **No second authorization architecture**, which is the
 * Epic's own boundary.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();
const AT = '2026-09-06T11:00:00.000Z';

function principalOf(id: string, permissions: readonly Permission[]): Principal {
  return { id, class: 'agent', permissions: [...permissions], permittedScopes: [], scope: { include: [], exclude: [] } };
}

const OWNER = principalOf('agent.owner', [Permission.READ, Permission.RECORD, Permission.MUTATE]);
const OTHER = principalOf('agent.other', [Permission.READ, Permission.RECORD]);
const READER = principalOf('agent.reader', [Permission.READ]);

let db: TestDatabase;
let handle: FerretDatabase;
let sessions: SessionStore;

interface Agent {
  readonly client: Client;
  close: () => Promise<void>;
}

const open: Agent[] = [];

async function agentFor(principal: Principal): Promise<Agent> {
  const server = new McpServer({ name: `ferret-${principal.id}`, version: '0.0.0' });
  const guard = createToolGuard({ principal, logger: new RecordingLogger() });
  registerContextTools({
    server,
    guard,
    context: new DurableContextStore(handle),
    sessions,
    actorId: principal.id,
    permittedScopes: principal.permittedScopes,
    producer: `${principal.id}/1.0`,
    producerVersion: '0.0.0',
  });
  registerSessionTools(server, { sessions, principal, logger: new RecordingLogger() });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: principal.id, version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const agent: Agent = { client, close: async () => client.close() };
  open.push(agent);
  return agent;
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
  const body = ((): Record<string, unknown> => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  })();
  return { body, isError: result.isError === true };
}

describeDb(`durable context governance (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  beforeAll(async () => {
    db = await createTestDatabase('context-governance');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    sessions = new SessionStore(handle);
  });

  afterAll(async () => {
    for (const one of open.splice(0)) await one.close();
    await db.drop();
  });

  describe('what a caller may do is decided by what it holds', () => {
    it('refuses a reader the ability to record', async () => {
      const reader = await agentFor(READER);
      const { isError } = await call(reader.client, 'ferret_context_record', {
        statement: 'A reader may not write to the shared record',
        contextKind: ContextKind.FACT,
      });

      expect(isError).toBe(true);
    });

    it('refuses a recorder the ability to retire what others rely on', async () => {
      const owner = await agentFor(OWNER);
      const other = await agentFor(OTHER);
      const recorded = await call(owner.client, 'ferret_context_record', {
        statement: 'Curation is granted separately from recording, deliberately',
        contextKind: ContextKind.CONSTRAINT,
      });
      const id = (recorded.body['context'] as Record<string, unknown>)['id'] as string;

      const { isError } = await call(other.client, 'ferret_context_lifecycle', {
        contextId: id,
        transition: ContextTransition.ARCHIVE,
      });

      // `mutate` is never granted by default.
      expect(isError).toBe(true);
      const still = await call(other.client, 'ferret_context_find', {});
      expect((still.body['context'] as Record<string, unknown>[]).map((one) => one['id'])).toContain(id);
    });
  });

  describe('an agent’s working state is not the shared record', () => {
    beforeAll(async () => {
      await sessions.save(
        createSession({ sessionId: 'owner-session', provider: 'test', actorId: OWNER.id, startedAt: AT }),
      );
      await sessions.recordMemory(
        createEngineeringMemory({
          sessionId: 'owner-session',
          kind: 'gotcha',
          statement: 'A private note nobody offered to the organization',
          origin: 'explicit',
          recordedAt: AT,
        }),
      );
    });

    it('refuses to read another agent’s session', async () => {
      const other = await agentFor(OTHER);
      const recalled = await call(other.client, 'ferret_session_recall', { sessionId: 'owner-session' });
      const shown = await call(other.client, 'ferret_session_show', { sessionId: 'owner-session' });

      expect(recalled.body['found']).toBe(false);
      expect(shown.body['found']).toBe(false);
      // No statement reached the caller.
      expect(JSON.stringify(recalled.body)).not.toContain('private note');
      expect(JSON.stringify(shown.body)).not.toContain('private note');
    });

    it('says the same thing whether the session is absent or another’s', async () => {
      // A message that distinguished them would let a caller enumerate another
      // agent's work by probing identifiers.
      const other = await agentFor(OTHER);
      const missing = await call(other.client, 'ferret_session_recall', { sessionId: 'no-such-session' });
      const forbidden = await call(other.client, 'ferret_session_recall', { sessionId: 'owner-session' });

      expect(missing.body['detail']).toBe(forbidden.body['detail']);
      expect(missing.body['remediation']).toBe(forbidden.body['remediation']);
    });

    it('refuses to publish another agent’s session as shared context', async () => {
      const other = await agentFor(OTHER);
      const refused = await call(other.client, 'ferret_context_promote', { sessionId: 'owner-session' });

      expect(refused.body['found']).toBe(false);
      const found = await call(other.client, 'ferret_context_find', {});
      const statements = (found.body['context'] as Record<string, unknown>[]).map((one) => String(one['statement']));
      expect(statements.some((one) => one.includes('private note'))).toBe(false);
    });

    it('lets the owner read and publish its own', async () => {
      const owner = await agentFor(OWNER);
      const recalled = await call(owner.client, 'ferret_session_recall', { sessionId: 'owner-session' });
      const promoted = await call(owner.client, 'ferret_context_promote', { sessionId: 'owner-session' });

      expect(recalled.body['found']).toBe(true);
      expect(promoted.body['created']).toBe(1);
    });
  });

  describe('protected support is not disclosed by a trust report', () => {
    it('counts only what the caller may see', async () => {
      const owner = await agentFor(OWNER);
      const store = new DurableContextStore(handle);
      const recorded = await store.record({
        statement: 'This statement rests on an observation the caller may not read',
        contextKind: ContextKind.FACT,
        provenance: {
          producer: 'scoped',
          producerVersion: '1.0.0',
          sourceSystem: 'ferret',
          permissionScope: 'team:restricted',
        },
      });
      const id = recorded.context.entity.id;

      const trusted = await call(owner.client, 'ferret_context_trust', { contextId: id });
      const belief = trusted.body['belief'] as Record<string, unknown>;

      // The record is visible; the observation behind it is not counted, and
      // nothing about it is echoed.
      expect(trusted.body['found']).toBe(true);
      expect(belief['supportCount']).toBe(0);
      expect(belief['preferredEvidenceId']).toBeUndefined();
      expect(JSON.stringify(trusted.body)).not.toContain('team:restricted');
    });
  });

  describe('a producer cannot promote its own authority', () => {
    it('records an agent’s statement as asserted, whatever it calls itself', async () => {
      const owner = await agentFor(OWNER);
      const recorded = await call(owner.client, 'ferret_context_record', {
        statement: 'An agent naming itself a parser does not become one',
        contextKind: ContextKind.FACT,
      });
      const id = (recorded.body['context'] as Record<string, unknown>)['id'] as string;

      const rows = await handle.execute<{ [column: string]: unknown; method: string; authority: number; producer: string }>(
        sql`SELECT method, authority, producer FROM ferret.evidence WHERE subject_id = ${id}`,
      );

      expect(rows.rows[0]?.method).toBe('asserted');
      expect(Number(rows.rows[0]?.authority)).toBe(20);
      // And the producer is the composition root's, not anything the call named.
      expect(rows.rows[0]?.producer).toBe(`${OWNER.id}/1.0`);
    });

    it('offers no field a caller could set its own producer or method in', async () => {
      const owner = await agentFor(OWNER);
      const { tools } = await owner.client.listTools();
      const schema = JSON.stringify(tools.find((tool) => tool.name === 'ferret_context_record')?.inputSchema);

      for (const field of ['producer', 'method', 'authority', 'confidence', 'permissionScope']) {
        expect(schema, field).not.toContain(field);
      }
    });
  });

  describe('retention is explicit, and refuses to choose', () => {
    it('reclaims nothing without an age the caller named', async () => {
      const retention = new RetentionService(handle);
      const plan = await retention.prune({ targets: [RetentionTarget.CONTEXT], apply: true });
      const count = plan.counts.find((one) => one.target === RetentionTarget.CONTEXT);

      expect(count?.rows).toBe(0);
      expect(count?.note).toMatch(/age in days is required/);
    });

    it('reclaims archived context and the observations behind it', async () => {
      const store = new DurableContextStore(handle);
      const evidence = new EvidenceStore(handle);
      const recorded = await store.record({
        statement: 'A statement its owner deliberately retired long ago',
        contextKind: ContextKind.PREFERENCE,
        provenance: { producer: 'someone', producerVersion: '1.0.0', sourceSystem: 'ferret' },
      });
      const id = recorded.context.entity.id;
      await store.archive(id, new Date('2020-01-01T00:00:00.000Z'));

      const plan = await new RetentionService(handle).prune({
        targets: [RetentionTarget.CONTEXT],
        archivedOlderThanDays: 30,
        apply: true,
      });

      expect(plan.counts.find((one) => one.target === RetentionTarget.CONTEXT)?.rows).toBe(1);
      expect(await store.get(id)).toBeUndefined();
      // The observation went with its subject rather than being orphaned.
      expect(await evidence.forSubject(id, { permittedScopes: [] })).toStrictEqual([]);
    });

    it('never reclaims what is current, proposed, or superseded', async () => {
      const store = new DurableContextStore(handle);
      const old = new Date('2020-01-01T00:00:00.000Z');
      const by = { producer: 'someone', producerVersion: '1.0.0', sourceSystem: 'ferret' };

      const current = await store.record(
        { statement: 'Still believed, however old it is', contextKind: ContextKind.FACT, provenance: by },
        old,
      );
      const proposal = await store.record(
        {
          statement: 'Proposed long ago and never answered by anyone',
          contextKind: ContextKind.NEXT_STEP,
          provenance: by,
          state: LifecycleState.CANDIDATE,
        },
        old,
      );
      const replaced = await store.record(
        { statement: 'The page limit was once ten pages per pass', contextKind: ContextKind.FACT, provenance: by },
        old,
      );
      await store.record(
        { statement: 'The page limit is twenty pages per pass', contextKind: ContextKind.FACT, provenance: by,
          supersedes: replaced.context.entity.id },
        old,
      );

      await new RetentionService(handle).prune({
        targets: [RetentionTarget.CONTEXT],
        archivedOlderThanDays: 1,
        apply: true,
      });

      // Age is not evidence that something stopped being true; an unanswered
      // proposal is not an abandoned one; and a superseded record is the
      // history of a decision that changed.
      expect(await store.get(current.context.entity.id)).toBeDefined();
      expect(await store.get(proposal.context.entity.id)).toBeDefined();
      expect(await store.get(replaced.context.entity.id)).toBeDefined();
    });

    it('plans without deleting when it is not told to apply', async () => {
      const store = new DurableContextStore(handle);
      const recorded = await store.record({
        statement: 'Planned for reclamation but not reclaimed',
        contextKind: ContextKind.PREFERENCE,
        provenance: { producer: 'someone', producerVersion: '1.0.0', sourceSystem: 'ferret' },
      });
      await store.archive(recorded.context.entity.id, new Date('2020-01-01T00:00:00.000Z'));

      const plan = await new RetentionService(handle).prune({
        targets: [RetentionTarget.CONTEXT],
        archivedOlderThanDays: 30,
      });

      expect(plan.applied).toBe(false);
      expect(plan.counts.find((one) => one.target === RetentionTarget.CONTEXT)?.rows).toBeGreaterThan(0);
      expect(await store.get(recorded.context.entity.id)).toBeDefined();
    });
  });
});
