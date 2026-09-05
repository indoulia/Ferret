import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Direction,
  EntityKind,
  PUBLIC_ACCESS,
  RelationshipType,
  SourceIngestor,
  ingestSources,
  isSourceConnector,
  sourceIdentityKey,
  type IngestReport,
  type SourceConnector,
} from '../../../src/index.js';
import type { ConfluenceProvider } from '../../../src/confluence/index.js';
import {
  CONFLUENCE_PAGE_RECORD,
  CONFLUENCE_PROVIDER_ID,
  CONFLUENCE_SOURCE_SYSTEM,
  createConfluenceProvider,
  findPageReferences,
  PageReferenceKind,
} from '../../../src/confluence/index.js';
import { Capability } from '../../../src/providers/capabilities.js';
import { ProviderRegistry } from '../../../src/providers/registry.js';
import {
  EntityStore,
  EvidenceStore,
  MigrationPolicy,
  RelationshipStore,
  RetrievalStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createTestOperationContext, createTestProviderContext } from '../../../src/providers/sdk/testing.js';
import { createNullLogger } from '../../../src/logging/index.js';
import { VERSION } from '../../../src/version.js';
import { connectorContext, connectorStore } from '../../support/connector-store.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * The Confluence connector — EPIC-123.
 *
 * **The first provider to declare `source.connector`.** EPIC-119 wrote that
 * contract for a source that is neither a Git checkout nor a tracker, and every
 * implementation until now has been an *adapter* over a contract that already
 * existed — so the boundary had been proven convenient and never proven
 * necessary. A wiki page is neither a branch nor an issue. This suite is where
 * that claim is tested rather than asserted.
 *
 * The wire shapes are the ones a live Confluence Cloud instance actually sends,
 * checked against one before these fixtures were written: v2 under
 * `/wiki/api/v2`, cursor paging through a relative `_links.next`, a first-class
 * `version` object, a direct `parentId`, and Zulu instants.
 */

const BASE = 'https://acme.atlassian.net';
const SPACE = 'DEV';
const SPACE_ID = '4685825';

interface Fixture {
  /** Pages, in the order the API would return them, one array per page of results. */
  readonly pages?: readonly (readonly unknown[])[];
  /** Space lookups answer this. An empty array is "no such space". */
  readonly spaces?: readonly unknown[];
  readonly calls?: string[];
  readonly failWith?: number;
}

/** Confluence-shaped JSON, answered by path exactly as the v2 API lays it out. */
function confluenceFetch(fixture: Fixture) {
  let served = 0;
  return (url: string): Promise<{ status: number; headers: { get(name: string): string | null }; text: () => Promise<string> }> => {
    fixture.calls?.push(url);
    const respond = (status: number, value: unknown) =>
      Promise.resolve({
        status,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(value)),
      });

    if (fixture.failWith !== undefined) return respond(fixture.failWith, { errors: [{ title: 'nope' }] });

    if (url.includes('/spaces?') || url.endsWith('/spaces')) {
      return respond(200, {
        results: fixture.spaces ?? [{ id: SPACE_ID, key: SPACE }],
      });
    }

    const batch = fixture.pages?.[served] ?? [];
    const more = served + 1 < (fixture.pages?.length ?? 0);
    served += 1;
    return respond(200, {
      results: batch,
      _links: more
        ? { next: `/wiki/api/v2/spaces/${SPACE_ID}/pages?limit=250&cursor=CURSOR${String(served)}` }
        : {},
    });
  };
}

function page(
  id: string,
  title: string,
  extra: { parentId?: string | null; body?: string; version?: number; status?: string } = {},
): unknown {
  return {
    id,
    status: extra.status ?? 'current',
    title,
    spaceId: SPACE_ID,
    authorId: 'acc-1',
    createdAt: '2024-02-27T09:58:28.972Z',
    version: {
      number: extra.version ?? 1,
      message: '',
      minorEdit: false,
      authorId: 'acc-1',
      createdAt: '2026-01-07T06:47:06.741Z',
    },
    ...(extra.body === undefined ? {} : { body: { storage: { value: extra.body, representation: 'storage' } } }),
    parentId: extra.parentId === undefined ? null : extra.parentId,
    parentType: 'page',
    _links: { webui: `/spaces/${SPACE}/pages/${id}/${title.replace(/\s+/g, '+')}` },
  };
}

async function provider(fixture: Fixture): Promise<ConfluenceProvider> {
  const instance = createConfluenceProvider({
    baseUrl: BASE,
    email: 'ada@example.com',
    token: 'atlassian_test_token',
    fetch: confluenceFetch(fixture),
  });
  await instance.initialize(createTestProviderContext());
  return instance;
}

async function connector(fixture: Fixture): Promise<SourceConnector> {
  return (await provider(fixture)).connector;
}

/** A parent with two children, one of which links to the other. */
const TREE: Fixture = {
  pages: [
    [
      page('100', 'Architecture'),
      page('101', 'Retrieval', {
        parentId: '100',
        body: '<p>See <a href="/wiki/spaces/DEV/pages/102/Indexing">Indexing</a>.</p>',
      }),
      page('102', 'Indexing', { parentId: '100', body: '<p>Nothing links from here.</p>' }),
    ],
  ],
};

function documents(state: ReturnType<typeof connectorStore>['state']) {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === EntityKind.DOCUMENT)
    .map((row) => row.entity);
}

function edges(state: ReturnType<typeof connectorStore>['state'], type: string) {
  return [...state.relationships.values()].filter((edge) => edge.type === type);
}

function titled(state: ReturnType<typeof connectorStore>['state'], title: string) {
  return documents(state).find((entity) => entity.attributes['title'] === title);
}

// ---------------------------------------------------------------------------

describe('EPIC-123 — the first provider to declare source.connector', () => {
  it('declares the capability and the three verbs', async () => {
    const instance = await provider(TREE);
    const declaration = instance.capabilities[0];
    expect(declaration?.capability).toBe(Capability.SOURCE_CONNECTOR);
    expect(declaration?.operations).toStrictEqual(['identify', 'acquire', 'normalize']);
    expect(declaration?.systems).toStrictEqual([CONFLUENCE_SOURCE_SYSTEM]);
  });

  it('is selectable from the registry by that capability', async () => {
    const registry = new ProviderRegistry();
    registry.register(await provider(TREE));
    expect(registry.forCapability(Capability.SOURCE_CONNECTOR)?.id).toBe(CONFLUENCE_PROVIDER_ID);
  });

  it('exposes a connector, and is deliberately not one itself', async () => {
    const instance = await provider(TREE);
    // Both `Provider` and `SourceConnector` declare `contractVersion`, meaning
    // the provider platform's version and the connector contract's. A class
    // implementing both has one field for two facts — which compiles today
    // because both are 1, and is wrong the moment either moves.
    expect(isSourceConnector(instance.connector)).toBe(true);
    expect(isSourceConnector(instance)).toBe(false);
  });

  it('has no method that writes', async () => {
    const instance = await provider(TREE);
    const methods = new Set<string>();
    for (
      let proto: object | null = Object.getPrototypeOf(instance) as object | null;
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) methods.add(name);
    }
    for (const forbidden of ['post', 'put', 'patch', 'delete', 'create', 'publish']) {
      expect(methods.has(forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-123 — pages, identity and provenance', () => {
  it('ingests a space as documents scoped to it', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );

    expect(report.identityKey).toBe('confluence::acme.atlassian.net::dev');
    expect(report.identityKey).toBe(sourceIdentityKey(report.identity));
    expect(report.skipped).toEqual([]);
    expect(documents(state).length).toBe(3);
    for (const entity of documents(state)) {
      expect(entity.source.scope).toBe(report.sourceEntityId);
    }
  });

  it('resolves identity without a request, so unreachable and unknown stay apart', async () => {
    const calls: string[] = [];
    const instance = await provider({ ...TREE, calls });
    const identity = instance.connector.identify(SPACE);

    // `identify` is pure and total by contract — the cursor is keyed by its
    // answer. A version that looked the space up could not tell a space that
    // does not exist from one the network could not reach.
    expect(calls).toEqual([]);
    expect(identity).toEqual({
      system: CONFLUENCE_SOURCE_SYSTEM,
      instance: 'acme.atlassian.net',
      resource: SPACE,
    });
  });

  it('names the deployment by host, never by the configured URL', async () => {
    // A base URL read from configuration carries a credential more often than
    // anyone expects, and `instance` is stored, logged and shown.
    const instance = createConfluenceProvider({
      baseUrl: 'https://ada:sekret@acme.atlassian.net/wiki',
      fetch: confluenceFetch(TREE),
    });
    await instance.initialize(createTestProviderContext());
    const identity = instance.connector.identify(SPACE);
    expect(identity.instance).toBe('acme.atlassian.net');
    expect(JSON.stringify(identity)).not.toContain('sekret');
  });

  it('attaches producer, version and system to every record it writes', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );

    expect(state.evidence.size).toBeGreaterThan(0);
    for (const record of state.evidence.values()) {
      expect(record.producer).toBe(CONFLUENCE_PROVIDER_ID);
      expect(record.producerVersion).toBe(VERSION);
      expect(record.sourceSystem).toBe(CONFLUENCE_SOURCE_SYSTEM);
    }
  });

  it('keeps the same page title in two spaces apart', async () => {
    const { deps, state } = connectorStore();
    const shared: Fixture = { pages: [[page('200', 'Overview')]] };
    const first = await new SourceIngestor(await connector(shared), deps).ingest(
      { resource: 'DEV' },
      createTestOperationContext(),
    );
    const second = await new SourceIngestor(
      await connector({ pages: [[page('300', 'Overview')]] }),
      deps,
    ).ingest({ resource: 'OPS' }, createTestOperationContext());

    expect(first.sourceEntityId).not.toBe(second.sourceEntityId);
    expect(documents(state).length).toBe(2);
  });

  it('redacts a credential somebody pasted into a page', async () => {
    const leaked = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ pages: [[page('400', 'Runbook', { body: `<p>Use ${leaked}</p>` })]] }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    // A wiki page is where people paste terminal sessions.
    expect(String(documents(state)[0]?.attributes['description'])).not.toContain(leaked);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-123 — hierarchy, links and versions', () => {
  it('records a page under its parent', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );

    const parent = titled(state, 'Architecture');
    const child = titled(state, 'Retrieval');
    const contains = edges(state, RelationshipType.DOCUMENT_CONTAINS_DOCUMENT);
    expect(contains.length).toBe(2);
    expect(contains.some((edge) => edge.fromId === parent?.id && edge.toId === child?.id)).toBe(true);
  });

  it('keeps containment and reference as different questions', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );

    const retrieval = titled(state, 'Retrieval');
    const indexing = titled(state, 'Indexing');
    // `Retrieval` links to `Indexing` and does not contain it; `Architecture`
    // contains both and links to neither. One edge with a flag would make
    // "what is under this page" and "what mentions it" the same query.
    const links = edges(state, RelationshipType.DOCUMENT_LINKS_DOCUMENT);
    expect(links.length).toBe(1);
    expect(links[0]?.fromId).toBe(retrieval?.id);
    expect(links[0]?.toId).toBe(indexing?.id);
    expect(
      edges(state, RelationshipType.DOCUMENT_CONTAINS_DOCUMENT).some(
        (edge) => edge.fromId === retrieval?.id,
      ),
    ).toBe(false);
  });

  it('follows a link written as a storage-format macro', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({
        pages: [
          [
            page('500', 'Guide', {
              body: '<ac:link><ri:page ri:content-title="Reference" ri:space-key="DEV"/></ac:link>',
            }),
            page('501', 'Reference'),
          ],
        ],
      }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    // Storage format names a page by *title*, not by id — the other half of
    // what a body can say, and the reason `PageReferenceKind` has two members.
    const links = edges(state, RelationshipType.DOCUMENT_LINKS_DOCUMENT);
    expect(links.length).toBe(1);
    expect(links[0]?.toId).toBe(titled(state, 'Reference')?.id);
    expect(links[0]?.metadata?.['by']).toBe(PageReferenceKind.TITLE);
  });

  it('does not invent a page from a title it never read', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({
        pages: [
          [page('600', 'Alone', { body: '<ac:link><ri:page ri:content-title="Absent"/></ac:link>' })],
        ],
      }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    // A title is unique within a space and not beyond it, so minting an entity
    // from one would invent an identity the source never issued. An id may be
    // stubbed; a title may not.
    expect(documents(state).length).toBe(1);
    expect(edges(state, RelationshipType.DOCUMENT_LINKS_DOCUMENT).length).toBe(0);
  });

  it('stubs a parent this pass did not read, without inventing its content', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ pages: [[page('700', 'Orphan', { parentId: '999' })]] }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    const stub = documents(state).find((entity) => entity.source.id === '999');
    expect(stub).toBeDefined();
    expect(stub?.attributes['title']).toBeUndefined();
    expect(edges(state, RelationshipType.DOCUMENT_CONTAINS_DOCUMENT).length).toBe(1);
  });

  it('records a page version, and treats a new version as the same page', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ pages: [[page('800', 'Living', { body: '<p>first</p>', version: 17 })]] }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    const before = documents(state)[0];
    expect(before?.unknownFields['version']).toBe(17);

    await new SourceIngestor(
      await connector({ pages: [[page('800', 'Living', { body: '<p>second</p>', version: 18 })]] }),
      deps,
    ).ingest({ resource: SPACE, full: true }, createTestOperationContext());

    // One page whose content changed, not two pages. Identity is the page id,
    // which survives an edit and a rename.
    expect(documents(state).length).toBe(1);
    expect(documents(state)[0]?.id).toBe(before?.id);
    expect(documents(state)[0]?.unknownFields['version']).toBe(18);
    expect(String(documents(state)[0]?.attributes['description'])).toContain('second');
  });

  it('finds both kinds of reference in a body, and neither twice', () => {
    const found = findPageReferences(
      '<a href="/wiki/spaces/DEV/pages/12345/A">A</a>' +
        '<a href="/wiki/spaces/DEV/pages/12345/A">again</a>' +
        '<a href="/pages/999">short</a>' +
        '<ac:link><ri:page ri:content-title="Tom &amp; Jerry" ri:space-key="OPS"/></ac:link>',
    );
    expect(found).toEqual([
      { kind: PageReferenceKind.ID, target: '12345', space: 'DEV' },
      { kind: PageReferenceKind.ID, target: '999' },
      { kind: PageReferenceKind.TITLE, target: 'Tom & Jerry', space: 'OPS' },
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-123 — paging, idempotence and failure', () => {
  it('follows the cursor Confluence issues, across pages', async () => {
    const paged: Fixture = {
      pages: [[page('900', 'One')], [page('901', 'Two')], [page('902', 'Three')]],
    };
    const calls: string[] = [];
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector({ ...paged, calls }), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );

    expect(report.counts.pages).toBe(3);
    expect(documents(state).length).toBe(3);
    expect(report.truncated).toBe(false);
    // v2 reports paging as a relative URL rather than a token, so the token has
    // to come back out of its query string.
    expect(calls.some((url) => url.includes('cursor=CURSOR1'))).toBe(true);
  });

  it('resolves the space once and carries its id in the cursor', async () => {
    const calls: string[] = [];
    const { deps } = connectorStore();
    await new SourceIngestor(
      await connector({ pages: [[page('910', 'A')], [page('911', 'B')]], calls }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    // People name a space by key and the API pages it by numeric id, so one
    // lookup stands between them. Repeating it per page would be a request per
    // page for an answer that cannot change mid-pass.
    expect(calls.filter((url) => url.includes('/spaces?')).length).toBe(1);
  });

  it('creates nothing new when the same space is ingested twice', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );
    const before = counts(state);

    const second = await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE, full: true },
      createTestOperationContext(),
    );

    expect(counts(state)).toEqual(before);
    expect(second.writes.entitiesCreated).toBe(0);
    expect(second.writes.evidenceRecorded).toBe(0);
  });

  it('derives the same ids in two independent runs against two stores', async () => {
    const runs: string[][] = [];
    for (let run = 0; run < 2; run += 1) {
      const { deps, state } = connectorStore();
      await new SourceIngestor(await connector(TREE), deps).ingest(
        { resource: SPACE },
        createTestOperationContext(),
      );
      runs.push([...state.entities.keys()].sort());
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it('skips a page it cannot identify without failing the space', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(
      await connector({
        pages: [[{ status: 'current', title: 'No id at all' }, page('950', 'Fine')]],
      }),
      deps,
    ).ingest({ resource: SPACE }, createTestOperationContext());

    // EPIC-072 §8.9's rule at this layer: one malformed record must not fail a
    // source, and must not vanish silently either.
    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0]?.reason).toContain('no id');
    expect(documents(state).length).toBe(1);
  });

  it('says plainly when a space key names nothing', async () => {
    const { deps } = connectorStore();
    await expect(
      new SourceIngestor(await connector({ spaces: [] }), deps).ingest(
        { resource: 'NOPE' },
        createTestOperationContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_SOURCE_UNAVAILABLE' });
  });

  it('isolates a space that fails without touching another', async () => {
    const { deps, state } = connectorStore();
    const outcomes = await ingestSources(
      [
        { connector: await connector({ failWith: 500 }), options: { resource: 'BROKEN' } },
        { connector: await connector(TREE), options: { resource: SPACE } },
      ],
      deps,
      connectorContext(),
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[1]?.status).toBe('ingested');
    const ingested = outcomes[1] as { status: 'ingested'; report: IngestReport };
    expect(state.entities.get(ingested.report.sourceEntityId)).toBeDefined();
    expect(state.cursorPositions.size).toBe(1);
  });

  it('refuses a credential problem as unauthorized rather than as absence', async () => {
    const { deps } = connectorStore();
    await expect(
      new SourceIngestor(await connector({ failWith: 401 }), deps).ingest(
        { resource: SPACE },
        createTestOperationContext(),
      ),
    ).rejects.toMatchObject({ code: 'E_SOURCE_UNAUTHORIZED' });
  });

  it('starts over rather than failing when handed a cursor it cannot read', async () => {
    const source = await connector(TREE);
    const acquired = await source.acquire(
      { identity: source.identify(SPACE), cursor: 'not-a-cursor' },
      createTestOperationContext(),
    );
    expect(acquired.records.some((record) => record.kind === CONFLUENCE_PAGE_RECORD)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The real path, all the way to an answer.
// ---------------------------------------------------------------------------

const endToEnd = databaseAvailable() ? describe : describe.skip;

if (!databaseAvailable()) {
  process.stderr.write(`\n[EPIC-123] SKIPPING end-to-end retrieval: ${SKIP_REASON}\n\n`);
}

endToEnd('EPIC-123 — acquisition to retrieval, against the real stores', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('epic123');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('answers an agent asking what is under a page and what links to it', async () => {
    const report = await new SourceIngestor(await connector(TREE), {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    }).ingest({ resource: SPACE }, createTestOperationContext());

    const retrieval = new RetrievalStore(handle);
    const stored = await retrieval.findEntities(
      { kind: EntityKind.DOCUMENT, scope: report.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );
    expect(stored.entities.length).toBe(3);

    // 1. What is under this page — the hierarchy edge.
    const parent = stored.entities.find((entity) => entity.attributes['title'] === 'Architecture');
    const children = await retrieval.neighbours(
      {
        from: parent?.id ?? '',
        types: [RelationshipType.DOCUMENT_CONTAINS_DOCUMENT],
        direction: Direction.OUT,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(
      children.neighbours.map((neighbour) => String(neighbour.entity.attributes['title'])).sort(),
    ).toEqual(['Indexing', 'Retrieval']);

    // 2. What links to this page — the reference edge, walked the other way.
    const indexing = stored.entities.find((entity) => entity.attributes['title'] === 'Indexing');
    const inbound = await retrieval.neighbours(
      {
        from: indexing?.id ?? '',
        types: [RelationshipType.DOCUMENT_LINKS_DOCUMENT],
        direction: Direction.IN,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(
      inbound.neighbours.map((neighbour) => String(neighbour.entity.attributes['title'])),
    ).toEqual(['Retrieval']);

    // 3. Provenance survived storage.
    const evidence = await handle.execute<{ producer: string; producer_version: string }>(
      sql`SELECT DISTINCT producer, producer_version FROM ferret.evidence`,
    );
    expect(evidence.rows.map((row) => row.producer)).toContain(CONFLUENCE_PROVIDER_ID);
    expect(evidence.rows.map((row) => row.producer_version)).toContain(VERSION);
  }, 300_000);

  it('writes one graph however many times the space is ingested', async () => {
    const deps = {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    };
    const retrieval = new RetrievalStore(handle);

    const first = await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE },
      createTestOperationContext(),
    );
    const before = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    await new SourceIngestor(await connector(TREE), deps).ingest(
      { resource: SPACE, full: true },
      createTestOperationContext(),
    );
    const after = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    expect(after.entities.map((entity) => entity.id).sort()).toEqual(
      before.entities.map((entity) => entity.id).sort(),
    );
  }, 300_000);
});

// ---------------------------------------------------------------------------

/** What a second pass must not change. See the GitHub suite for why edges count this way. */
function counts(state: ReturnType<typeof connectorStore>['state']): Record<string, number> {
  const distinct = new Set(
    [...state.relationships.values()].map((edge) => `${edge.fromId}|${edge.type}|${edge.toId}`),
  );
  return { entities: state.entities.size, edges: distinct.size, evidence: state.evidence.size };
}
