import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  Permission,
  PrincipalClass,
  type Principal,
} from '../../../src/authorization/index.js';
import {
  CONTENT_NOTICE,
  PUBLIC_ACCESS,
  createNullLogger,
  type AccessContext,
  type CanonicalEntity,
  type RetrievalPort,
} from '../../../src/index.js';
import { createMcpServer } from '../../../src/mcp/index.js';

/**
 * What `initialize` tells a client, through the real protocol — EPIC-138.
 *
 * §14 measured the routing sentence and rejected it, so what is asserted is its
 * absence, through a running server rather than off the source literal. AC-12
 * across principals, permissions and store contents; AC-3/AC-4 that the tool
 * surface never moved.
 */

/** The sentence §14 measured and rejected. Asserted absent, as bytes. */
const REJECTED_GUIDANCE =
  'For a task-shaped engineering question, check the durable context an ' +
  'earlier session recorded before exploring source, and use its verdict: ' +
  '`verified` says what was observed still matches the indexed code, ' +
  'while `stale`, `unknown` and `unanchored` each mean verify against ' +
  'source before relying on it. ';

const SNAPSHOT = fileURLToPath(new URL('../../fixtures/mcp/knowledge-tools.json', import.meta.url));

const ENTITY: CanonicalEntity = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'commit',
  canonicalKey: 'key-1',
  schemaVersion: 1,
  source: Object.freeze({ system: 'git', id: 'source-1' }),
  lifecycle: 'active',
  attributes: Object.freeze({ sha: 'abc123' }),
  unknownFields: Object.freeze({}),
  externalIds: Object.freeze([]),
  sourceObservedAt: undefined,
  contentHash: 'hash-1',
});

/** Two stores, so AC-12 can vary contents: one holding an entity, one holding nothing. */
function retrievalOf(entities: readonly CanonicalEntity[]): RetrievalPort {
  const empty = { total: entities.length, withheld: { permission: 0, scope: 0 } };
  return {
    findEntities: () => Promise.resolve({ entities, ...empty } as never),
    getEntity: (id) => Promise.resolve(entities.find((one) => one.id === id)),
    neighbours: () => Promise.resolve({ neighbours: [], ...empty } as never),
    traverse: () => Promise.resolve({ paths: [], ...empty } as never),
    search: () => Promise.resolve({ results: [], ...empty } as never),
  };
}

function principalOf(id: string, permissions: readonly Permission[], principalClass: PrincipalClass): Principal {
  return { id, class: principalClass, permissions, permittedScopes: [], scope: { include: [], exclude: [] } };
}

const clients: Client[] = [];

/** A connected client for one composition. */
async function connect(dependencies: {
  readonly retrieval?: RetrievalPort;
  readonly principal?: Principal;
  readonly access?: AccessContext;
}): Promise<Client> {
  const server = createMcpServer({
    retrieval: dependencies.retrieval ?? retrievalOf([ENTITY]),
    logger: createNullLogger(),
    ...(dependencies.principal === undefined ? {} : { principal: dependencies.principal }),
    ...(dependencies.access === undefined ? {} : { access: dependencies.access }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'instructions-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  clients.push(client);
  return client;
}

afterAll(async () => {
  await Promise.all(clients.map((one) => one.close()));
});

describe('the instructions a real MCP client receives', () => {
  it('does not carry the rejected routing guidance — AC-1', async () => {
    const client = await connect({});
    expect(client.getInstructions()).not.toContain(REJECTED_GUIDANCE.trim());
  });

  it('keeps the content notice present, unmodified and last — AC-2', async () => {
    const instructions = (await connect({})).getInstructions() ?? '';
    expect(instructions).toContain(CONTENT_NOTICE);
    expect(instructions.endsWith(CONTENT_NOTICE)).toBe(true);
  });

  it('is the same string for every principal, permission set and store state — AC-12', async () => {
    const compositions = [
      {},
      { principal: principalOf('reader', [Permission.READ], PrincipalClass.AI_CLIENT) },
      { principal: principalOf('operator', [...PERMISSIONS], PrincipalClass.OPERATOR) },
      { principal: principalOf('nobody', [], PrincipalClass.AUTOMATION) },
      { access: { ...PUBLIC_ACCESS, permittedScopes: ['secret'] } as AccessContext },
      { retrieval: retrievalOf([]) },
    ];
    const seen = await Promise.all(compositions.map(async (one) => (await connect(one)).getInstructions()));
    expect(new Set(seen).size).toBe(1);
  });
});

describe('the tool surface EPIC-138 did not touch', () => {
  it('matches the tool list captured before the change — AC-3', async () => {
    const { tools } = await (await connect({})).listTools();
    const captured = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(tools))).toStrictEqual(captured);
  });

  it('introduces no permission and no principal class — AC-4', () => {
    expect([...PERMISSIONS].sort()).toStrictEqual([
      'config.read',
      'config.write',
      'index',
      'mutate',
      'provider.admin',
      'read',
      'record',
    ]);
    expect(Object.values(PrincipalClass).sort()).toStrictEqual(['agent', 'automation', 'operator']);
  });
});
