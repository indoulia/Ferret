import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Permission, type Principal } from '../../../src/authorization/index.js';
import {
  createEngineeringMemory,
  createSession,
  createSessionCheckpoint,
  supersede,
  type EngineeringMemory,
  type Session,
  type SessionCheckpoint,
} from '../../../src/domain/index.js';
import { registerSessionTools, type SessionAccess } from '../../../src/mcp/index.js';
import { RecordingLogger } from '../../support/recording-logger.js';

/**
 * Session recall over MCP — EPIC-111, through the real protocol.
 *
 * EPIC-109 made a session's context durable and EPIC-110 gave an operator a
 * command for it. Neither reached the caller the domain exists for: an AI
 * client is usually a process with no shell and no `ferret` on its path, so
 * `ferret session recall` was exactly as unreachable to it as `ferret status
 * --json` was before EPIC-070.
 *
 * **No database here, deliberately.** The tools answer through
 * `SessionRecoveryPort`, which is what lets them be tested against a fake — and
 * what `boundaries.test.ts` enforces. EPIC-109 already proved the store
 * satisfies that port against real PostgreSQL; proving it twice would test the
 * store rather than the surface.
 */

const GRANTED: Principal = {
  id: 'test.session',
  class: 'agent',
  permissions: [Permission.READ],
  permittedScopes: [],
  scope: { include: [], exclude: [] },
};

const NO_READ: Principal = { ...GRANTED, id: 'test.blind', permissions: [Permission.INDEX] };

const START = '2026-09-05T09:00:00.000Z';

function sessionOf(sessionId: string, parentSessionId?: string): Session {
  return createSession({
    sessionId,
    provider: 'claude-code',
    actorId: GRANTED.id,
    startedAt: START,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
  });
}

function memoryOf(sessionId: string, kind: 'decision' | 'gotcha' | 'next-step' | 'constraint' | 'preference', statement: string): EngineeringMemory {
  return createEngineeringMemory({ sessionId, kind, statement, origin: 'explicit', recordedAt: START });
}

function checkpointOf(sessionId: string): SessionCheckpoint {
  return createSessionCheckpoint({
    sessionId,
    provider: 'claude-code',
    checkpointSequence: 1,
    capturedThroughSequence: 9,
    checkpointedAt: START,
    summary: 'halfway through EPIC-111',
    continuationState: { next: 'register the tools' },
  });
}

/** An in-memory port. What the composition root passes is `SessionStore`. */
function accessOf(parts: {
  sessions?: readonly Session[];
  checkpoints?: Readonly<Record<string, SessionCheckpoint>>;
  memories?: Readonly<Record<string, readonly EngineeringMemory[]>>;
}): SessionAccess {
  const sessions = parts.sessions ?? [];
  return {
    getSession: (sessionId) => Promise.resolve(sessions.find((one) => one.sessionId === sessionId)),
    latestCheckpoint: (sessionId) => Promise.resolve(parts.checkpoints?.[sessionId]),
    memoriesFor: (sessionId) => Promise.resolve(parts.memories?.[sessionId] ?? []),
    sessionsFor: (actorId, limit) =>
      Promise.resolve(sessions.filter((one) => one.actorId === actorId).slice(0, limit)),
  };
}

interface Harness {
  readonly client: Client;
  close: () => Promise<void>;
}

const open: Harness[] = [];

async function harness(sessions: SessionAccess, principal: Principal = GRANTED): Promise<Harness> {
  const server = new McpServer({ name: 'ferret-session-test', version: '0.0.0' });
  registerSessionTools(server, { sessions, principal, logger: new RecordingLogger() });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'session-client', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const created: Harness = { client, close: async () => client.close() };
  open.push(created);
  return created;
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
  return {
    body: JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>,
    isError: result.isError === true,
  };
}

afterEach(async () => {
  for (const one of open.splice(0)) await one.close();
});

describe('the tools are offered — AC-1', () => {
  it('registers the three recall tools, and every one is read-only', async () => {
    const { client } = await harness(accessOf({}));
    const { tools } = await client.listTools();
    const recall = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();

    // EPIC-111's surface, still read-only. EPIC-117 adds four writing tools
    // beside it rather than changing any of these — asserted below.
    expect(recall).toStrictEqual([
      'ferret_session_list',
      'ferret_session_recall',
      'ferret_session_show',
    ]);
  });
});

describe('recall reaches a client — AC-2', () => {
  it('returns the checkpoint and the memories, flattened', async () => {
    const { client } = await harness(
      accessOf({
        sessions: [sessionOf('s-1')],
        checkpoints: { 's-1': checkpointOf('s-1') },
        memories: {
          's-1': [
            memoryOf('s-1', 'preference', 'terse comments'),
            memoryOf('s-1', 'next-step', 'register the tools'),
            memoryOf('s-1', 'constraint', 'no weakened tests'),
          ],
        },
      }),
    );

    const { body } = await call(client, 'ferret_session_recall', { sessionId: 's-1' });
    const checkpoint = body['checkpoint'] as { summary: string; continuationState: unknown };
    const memories = body['memories'] as { kind: string; statement: string; generation: number }[];

    expect(body['found']).toBe(true);
    expect(body['empty']).toBe(false);
    expect(checkpoint.summary).toBe('halfway through EPIC-111');
    expect(checkpoint.continuationState).toEqual({ next: 'register the tools' });
    // EPIC-043's priority order, over the protocol.
    expect(memories.map((memory) => memory.kind)).toEqual(['next-step', 'constraint', 'preference']);
    // Flattened — a client should not have to unwrap a recovery envelope.
    expect(memories[0]?.statement).toBe('register the tools');
    expect(memories[0]?.generation).toBe(0);
  });

  it('follows a lineage and says which session each memory came from', async () => {
    const { client } = await harness(
      accessOf({
        sessions: [sessionOf('child', 'parent'), sessionOf('parent')],
        memories: { parent: [memoryOf('parent', 'decision', 'decided upstream')] },
      }),
    );

    const { body } = await call(client, 'ferret_session_recall', { sessionId: 'child' });
    const memories = body['memories'] as { fromSessionId: string; generation: number }[];

    expect(body['lineage']).toEqual(['child', 'parent']);
    expect(memories[0]?.fromSessionId).toBe('parent');
    expect(memories[0]?.generation).toBe(1);
  });

  it('reports what it left out rather than dropping it — AC-3', async () => {
    const { client } = await harness(
      accessOf({
        sessions: [sessionOf('s-2')],
        memories: {
          's-2': [
            memoryOf('s-2', 'gotcha', 'one'),
            memoryOf('s-2', 'gotcha', 'two'),
            memoryOf('s-2', 'gotcha', 'three'),
          ],
        },
      }),
    );

    const { body } = await call(client, 'ferret_session_recall', { sessionId: 's-2', limit: 1 });
    const omissions = body['omissions'] as { reason: string; count: number }[];

    expect((body['memories'] as unknown[]).length).toBe(1);
    expect(omissions.find((omission) => omission.reason === 'memory-limit')?.count).toBe(2);
  });

  it('drops superseded memories by default and can be asked for them', async () => {
    const first = memoryOf('s-3', 'decision', 'the first answer');
    const second = memoryOf('s-3', 'decision', 'the answer we kept');
    const { original, replacement } = supersede(first, second);
    const access = accessOf({ sessions: [sessionOf('s-3')], memories: { 's-3': [original, replacement] } });

    const withheld = await call((await harness(access)).client, 'ferret_session_recall', { sessionId: 's-3' });
    expect((withheld.body['memories'] as unknown[]).length).toBe(1);
    expect((withheld.body['omissions'] as { reason: string }[]).some((one) => one.reason === 'superseded')).toBe(true);

    const included = await call((await harness(access)).client, 'ferret_session_recall', {
      sessionId: 's-3',
      includeSuperseded: true,
    });
    expect((included.body['memories'] as unknown[]).length).toBe(2);
  });

  it('distinguishes a session that decided nothing from one that does not exist — AC-4', async () => {
    const { client } = await harness(accessOf({ sessions: [sessionOf('quiet')] }));

    const quiet = await call(client, 'ferret_session_recall', { sessionId: 'quiet' });
    expect(quiet.body['found']).toBe(true);
    expect(quiet.body['empty']).toBe(true);
    expect(String(quiet.body['reason'])).toContain('nothing to recover');

    // The distinction matters: a client that cannot tell these apart will ask
    // the user to repeat context that was never lost.
    const missing = await call(client, 'ferret_session_recall', { sessionId: 'no-such-session' });
    expect(missing.body['found']).toBe(false);
    expect(String(missing.body['remediation'])).toContain('ferret_session_list');
  });
});

describe('list and show — AC-5', () => {
  it('lists the calling principal’s sessions by default', async () => {
    const { client } = await harness(accessOf({ sessions: [sessionOf('a'), sessionOf('b')] }));
    const { body } = await call(client, 'ferret_session_list');

    expect(body['actorId']).toBe(GRANTED.id);
    expect(body['count']).toBe(2);
  });

  it('says an actor has none rather than returning a bare empty list', async () => {
    const { client } = await harness(accessOf({ sessions: [] }));
    const { body } = await call(client, 'ferret_session_list');

    expect(body['count']).toBe(0);
    expect(String(body['notice'])).toContain('No sessions are recorded');
  });

  it('offers no way to list another actor’s sessions — EPIC-133', async () => {
    // Listing another agent's sessions disclosed how much work it had done and
    // when, and handed over the identifiers every other session read takes.
    // The field is removed rather than defaulted: a parameter that is ignored
    // is a parameter someone will believe.
    const { client } = await harness(accessOf({ sessions: [sessionOf('a')] }));
    const { tools } = await client.listTools();
    const schema = JSON.stringify(tools.find((tool) => tool.name === 'ferret_session_list')?.inputSchema);

    expect(schema).not.toContain('actorId');

    const refused = (await client.callTool({
      name: 'ferret_session_list',
      arguments: { actorId: 'someone-else' },
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
  });

  it('shows one session with its checkpoint and every memory, superseded included', async () => {
    const first = memoryOf('s-4', 'decision', 'replaced');
    const second = memoryOf('s-4', 'decision', 'kept');
    const { original, replacement } = supersede(first, second);
    const { client } = await harness(
      accessOf({
        sessions: [sessionOf('s-4')],
        checkpoints: { 's-4': checkpointOf('s-4') },
        memories: { 's-4': [original, replacement] },
      }),
    );

    const { body } = await call(client, 'ferret_session_show', { sessionId: 's-4' });
    const memories = body['memories'] as { statement: string; supersededBy?: string }[];

    expect(body['found']).toBe(true);
    // Unlike recall, `show` reports what the session holds — both halves.
    expect(memories).toHaveLength(2);
    expect(memories.find((memory) => memory.statement === 'replaced')?.supersededBy).toBe(replacement.id);
  });

  it('reports a missing session rather than an empty one', async () => {
    const { client } = await harness(accessOf({}));
    const { body } = await call(client, 'ferret_session_show', { sessionId: 'nope' });

    expect(body['found']).toBe(false);
  });
});

describe('the guards apply — AC-6', () => {
  it('refuses a principal without read', async () => {
    const { client } = await harness(accessOf({ sessions: [sessionOf('s-5')] }), NO_READ);

    for (const name of ['ferret_session_recall', 'ferret_session_list', 'ferret_session_show']) {
      const result = await call(client, name, name === 'ferret_session_list' ? {} : { sessionId: 's-5' });
      expect(result.isError, name).toBe(true);
    }
  });

  it('rejects an unknown argument rather than ignoring it', async () => {
    const { client } = await harness(accessOf({ sessions: [sessionOf('s-6')] }));

    // A silently ignored argument is how a client believes it asked for
    // something it did not get. Reported as a tool error rather than a
    // rejection, which is how the SDK surfaces a schema failure.
    const result = (await client.callTool({
      name: 'ferret_session_recall',
      arguments: { sessionId: 's-6', depth: 3 },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('depth');
  });

  it('rejects a limit outside the bounds the schema declares', async () => {
    const { client } = await harness(accessOf({ sessions: [sessionOf('s-7')] }));

    const result = (await client.callTool({
      name: 'ferret_session_recall',
      arguments: { sessionId: 's-7', limit: 0 },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('limit');
  });
});

/**
 * EPIC-117 — recording over MCP.
 *
 * The write half, against the same in-memory port the read half uses. The three
 * decisions are asserted one at a time, because each one is a property somebody
 * could reasonably have implemented the other way:
 *
 * - **D-117.1** the server mints the identity, and the schema offers no way to
 *   supply one;
 * - **D-117.2** closing the transport does not end a session;
 * - **D-117.3** every writing tool needs `RECORD`, and `INDEX` is not enough.
 */

const RECORDER: Principal = {
  ...GRANTED,
  id: 'test.recorder',
  permissions: [Permission.READ, Permission.RECORD],
};

/** A port that remembers what it was asked to write. */
function writableAccess(): SessionAccess & {
  readonly written: Session[];
  readonly checkpoints: SessionCheckpoint[];
  readonly memories: EngineeringMemory[];
} {
  const written: Session[] = [];
  const checkpoints: SessionCheckpoint[] = [];
  const memories: EngineeringMemory[] = [];
  const current = (sessionId: string): Session | undefined =>
    [...written].reverse().find((one) => one.sessionId === sessionId);

  return {
    written,
    checkpoints,
    memories,
    getSession: (sessionId) => Promise.resolve(current(sessionId)),
    latestCheckpoint: (sessionId) =>
      Promise.resolve(
        [...checkpoints].reverse().find((one) => one.sessionId === sessionId),
      ),
    memoriesFor: (sessionId) =>
      Promise.resolve(memories.filter((one) => one.sessionId === sessionId)),
    sessionsFor: (actorId, limit) =>
      Promise.resolve(written.filter((one) => one.actorId === actorId).slice(0, limit)),
    save: (value) => {
      written.push(value);
      return Promise.resolve();
    },
    saveCheckpoint: (value) => {
      checkpoints.push(value);
      return Promise.resolve();
    },
    recordMemory: (value) => {
      memories.push(value);
      return Promise.resolve();
    },
  };
}

describe('the recording tools are offered — EPIC-117 AC-1', () => {
  it('registers all seven, and annotates the four that write', async () => {
    const { client } = await harness(writableAccess(), RECORDER);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect([...byName.keys()].sort()).toStrictEqual([
      'ferret_session_checkpoint',
      'ferret_session_end',
      'ferret_session_list',
      'ferret_session_recall',
      'ferret_session_remember',
      'ferret_session_show',
      'ferret_session_start',
    ]);

    // Additive, not destructive — MCP's own distinction, and the reason a
    // client is asked not to prompt per remembered sentence.
    for (const name of [
      'ferret_session_start',
      'ferret_session_remember',
      'ferret_session_checkpoint',
      'ferret_session_end',
    ]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
  });

  it('offers no way for a client to choose a session identifier — D-117.1', async () => {
    const { client } = await harness(writableAccess(), RECORDER);
    const { tools } = await client.listTools();
    const start = tools.find((tool) => tool.name === 'ferret_session_start');
    const properties = Object.keys(
      (start?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    );

    // The absence is the assertion. A field a client could fill would make
    // session ids a shared namespace whatever the handler then did with it.
    expect(properties).not.toContain('sessionId');
    expect(properties).not.toContain('id');
    expect(properties.sort()).toStrictEqual([
      'branch',
      'parentSessionId',
      'provider',
      'repositoryId',
      'worktreeId',
    ]);
  });
});

describe('the server owns the identity — EPIC-117 AC-2, D-117.1', () => {
  it('mints an identifier and returns it', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);

    const { body } = await call(client, 'ferret_session_start', { branch: 'feat/x' });

    expect(body['sessionId']).toMatch(/^[0-9a-f-]{36}$/);
    expect(access.written).toHaveLength(1);
    expect(access.written[0]?.sessionId).toBe(body['sessionId']);
    // The actor is the principal, never something the client asserted.
    expect(access.written[0]?.actorId).toBe(RECORDER.id);
    expect(access.written[0]?.branch).toBe('feat/x');
  });

  it('mints a different identifier every time', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);

    const first = await call(client, 'ferret_session_start');
    const second = await call(client, 'ferret_session_start');

    expect(first.body['sessionId']).not.toBe(second.body['sessionId']);
  });

  it('refuses a field the schema does not declare', async () => {
    const { client } = await harness(writableAccess(), RECORDER);

    const result = (await client.callTool({
      name: 'ferret_session_start',
      arguments: { sessionId: 'chosen-by-the-client' },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('a session records what it decided — EPIC-117 AC-3', () => {
  it('records a memory, a checkpoint, and reads them back', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);
    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;

    const remembered = await call(client, 'ferret_session_remember', {
      sessionId,
      kind: 'decision',
      statement: 'the server mints the session id',
      rationale: 'a client-supplied id would be a shared namespace',
    });
    expect(remembered.body['statement']).toBe('the server mints the session id');
    expect(remembered.body['redactedSecrets']).toBe(0);

    const checkpointed = await call(client, 'ferret_session_checkpoint', {
      sessionId,
      summary: 'decided the identity question',
      continuationState: { next: 'the lifetime question' },
    });
    expect(checkpointed.body['sequence']).toBe(1);

    const again = await call(client, 'ferret_session_checkpoint', {
      sessionId,
      summary: 'decided the lifetime question too',
    });
    // Numbered by Ferret, not by the caller — EPIC-041's monotonic progression,
    // which a client cannot be asked to track.
    expect(again.body['sequence']).toBe(2);

    const recalled = await call(client, 'ferret_session_recall', { sessionId });
    expect((recalled.body['memories'] as { statement: string }[])[0]?.statement).toBe(
      'the server mints the session id',
    );
  });

  it('removes a credential a client pasted into a statement — EPIC-112', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);
    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;

    const { body } = await call(client, 'ferret_session_remember', {
      sessionId,
      kind: 'gotcha',
      statement: 'the deploy needs AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY set',
    });

    expect(body['statement']).not.toContain('wJalrXUtnFEMIK7MDENGbPxRfiCY');
    expect(body['redactedSecrets']).toBe(1);
  });

  it('refuses to record against a session that is not on record', async () => {
    const { client } = await harness(writableAccess(), RECORDER);

    const result = (await client.callTool({
      name: 'ferret_session_remember',
      arguments: { sessionId: 'never-opened', kind: 'decision', statement: 'x' },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('never-opened');
  });
});

describe('a closed transport is not an ended session — EPIC-117 AC-4, D-117.2', () => {
  it('leaves a session active when the connection closes', async () => {
    const access = writableAccess();
    const first = await harness(access, RECORDER);
    const sessionId = (await call(first.client, 'ferret_session_start')).body['sessionId'] as string;

    await first.close();

    // The whole decision, in one assertion: an editor restarting is not a user
    // finishing their work, and nothing on the transport path may decide it is.
    const still = await access.getSession(sessionId);
    expect(still?.status).toBe('active');
    expect(still?.endedAt).toBeNull();

    // And a new connection continues the same session rather than fragmenting it.
    const second = await harness(access, RECORDER);
    const shown = await call(second.client, 'ferret_session_show', { sessionId });
    expect((shown.body['session'] as { status: string }).status).toBe('active');
  });

  it('ends only when an explicit call says so', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);
    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;

    const { body } = await call(client, 'ferret_session_end', { sessionId });

    expect(body['status']).toBe('completed');
    expect(body['endedAt']).toEqual(expect.any(String));
    expect((await access.getSession(sessionId))?.status).toBe('completed');
  });

  it('records an abandoned session as abandoned', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);
    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;

    const { body } = await call(client, 'ferret_session_end', { sessionId, abandoned: true });
    expect(body['status']).toBe('abandoned');
  });

  it('refuses to end a session twice rather than silently re-ending it', async () => {
    const access = writableAccess();
    const { client } = await harness(access, RECORDER);
    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;
    await call(client, 'ferret_session_end', { sessionId });

    const result = (await client.callTool({
      name: 'ferret_session_end',
      arguments: { sessionId },
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
  });
});

describe('recording needs its own permission — EPIC-117 AC-5, D-117.3', () => {
  it('refuses every writing tool to a principal holding only READ', async () => {
    const access = writableAccess();
    const { client } = await harness(access, GRANTED);

    for (const [name, args] of [
      ['ferret_session_start', {}],
      ['ferret_session_remember', { sessionId: 's', kind: 'decision', statement: 'x' }],
      ['ferret_session_checkpoint', { sessionId: 's', summary: 'x' }],
      ['ferret_session_end', { sessionId: 's' }],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as {
        content: { text: string }[];
        isError?: boolean;
      };
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain('record');
    }
    expect(access.written).toStrictEqual([]);
  });

  it('is not satisfied by INDEX — the overload D-117.3 refused', async () => {
    const access = writableAccess();
    const { client } = await harness(access, {
      ...GRANTED,
      id: 'test.indexer',
      permissions: [Permission.READ, Permission.INDEX],
    });

    const result = (await client.callTool({
      name: 'ferret_session_start',
      arguments: {},
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(access.written).toStrictEqual([]);
  });

  it('still requires READ to recall what was recorded', async () => {
    const access = writableAccess();
    const { client } = await harness(access, {
      ...GRANTED,
      id: 'test.writer-only',
      permissions: [Permission.RECORD],
    });

    const sessionId = (await call(client, 'ferret_session_start')).body['sessionId'] as string;
    const result = (await client.callTool({
      name: 'ferret_session_recall',
      arguments: { sessionId },
    })) as { content: { text: string }[]; isError?: boolean };

    // The grant is narrow in both directions: recording confers no reading.
    expect(result.isError).toBe(true);
  });
});

describe('a server with no writer says so — EPIC-117 AC-6', () => {
  it('reports that recording is unavailable rather than throwing a TypeError', async () => {
    const { client } = await harness(accessOf({}), RECORDER);

    const result = (await client.callTool({
      name: 'ferret_session_start',
      arguments: {},
    })) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('cannot open a session');
  });
});
