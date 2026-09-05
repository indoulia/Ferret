import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INGEST_PAGE_LIMIT,
  INGEST_PRODUCER,
  SOURCE_CONNECTOR_CONTRACT_VERSION,
  SourceIngestor,
  ingestSources,
  isSourceConnector,
  projectSourceConnector,
  sourceIdentityKey,
  type AcquiredRecord,
  type AcquisitionPage,
  type AcquisitionRequest,
  type IngestDependencies,
  type NormalizationContext,
  type SourceConnector,
  type SourceContribution,
} from '../../src/index.js';
import { EntityKind, createEntity, evidenceKey, relationshipKey } from '../../src/domain/index.js';
import type { CanonicalEntity, EntityInput, EvidenceInput, RelationshipInput } from '../../src/domain/index.js';
import { ErrorCode, FerretError } from '../../src/errors/index.js';
import type { EntityWriter, EvidenceWriter, RelationshipWriter, SyncCursors } from '../../src/indexing/index.js';
import { createNullLogger } from '../../src/logging/index.js';
import { createGithubProvider } from '../../src/github/index.js';
import { createTestProviderContext } from '../../src/providers/sdk/testing.js';
import { Capability } from '../../src/providers/index.js';
import { ProjectItemState, ProjectOperation } from '../../src/providers/contracts/source-project.js';
import type { ProjectIssue, ProjectPage, ProjectQuery, ProjectRateLimit, ProjectSource } from '../../src/providers/contracts/source-project.js';
import { VERSION } from '../../src/version.js';

/**
 * EPIC-119 — the universal source connector contract, and the one path it
 * reaches.
 *
 * The contract's whole claim is that a source of *any* shape can be ingested
 * without a bespoke ingestion architecture, and that identity, metadata and
 * provenance survive the trip. Each of those is asserted here against a store
 * fake that behaves like the real one in the two ways that matter: it derives
 * the canonical id from the input exactly as EPIC-006 does, and it deduplicates
 * on content hash, so "wrote the same row twice" is observable rather than
 * assumed.
 *
 * The suite is deliberately not all fixtures. `real GitHub provider` runs the
 * provider Ferret actually ships through the connector, so the contract is
 * proven against a concrete source rather than against a double written to fit
 * it.
 */

// ---------------------------------------------------------------------------
// A store fake that stores.
// ---------------------------------------------------------------------------

interface Store {
  readonly entities: Map<string, { entity: CanonicalEntity; writes: number }>;
  readonly relationships: Map<string, RelationshipInput>;
  readonly evidence: Map<string, EvidenceInput>;
  readonly order: string[];
  readonly cursorPositions: Map<string, Record<string, unknown>>;
  readonly cursorProducers: Map<string, string>;
}

/**
 * Writers over one shared store.
 *
 * `upsert` derives the id and the content hash through `createEntity` — the
 * same function the real store uses — so idempotence is measured rather than
 * declared: a second write of the same input hits the same key with the same
 * hash and reports `unchanged`.
 */
function store(): { deps: IngestDependencies; state: Store } {
  const state: Store = {
    entities: new Map(),
    relationships: new Map(),
    evidence: new Map(),
    order: [],
    cursorPositions: new Map(),
    cursorProducers: new Map(),
  };

  const entities: EntityWriter = {
    upsert: (input: EntityInput, _now, options) => {
      state.order.push('entity');
      const derived = createEntity(input);
      const existing = state.entities.get(derived.id);
      if (existing === undefined) {
        state.entities.set(derived.id, { entity: derived, writes: 1 });
        return Promise.resolve({ entity: derived, outcome: 'created' });
      }
      // `ifAbsent` is the placeholder rule: a stub emitted so an edge has an
      // endpoint must leave a record an earlier pass read in full exactly as
      // it is (issue #48).
      if (options?.ifAbsent === true) {
        return Promise.resolve({ entity: existing.entity, outcome: 'unchanged' });
      }
      if (existing.entity.contentHash === derived.contentHash) {
        return Promise.resolve({ entity: existing.entity, outcome: 'unchanged' });
      }
      state.entities.set(derived.id, { entity: derived, writes: existing.writes + 1 });
      return Promise.resolve({ entity: derived, outcome: 'updated' });
    },
  };

  const relationships: RelationshipWriter = {
    assert: (input: RelationshipInput) => {
      state.order.push('relationship');
      state.relationships.set(relationshipKey(input.fromId, input.type, input.toId, input.validFrom ?? ''), input);
      return Promise.resolve({ relationship: {} as never, outcome: 'opened' });
    },
  };

  const evidence: EvidenceWriter = {
    record: (input: EvidenceInput) => {
      state.order.push('evidence');
      const key = evidenceKey({
        subjectId: input.subjectId,
        field: input.field,
        statement: input.statement,
        method: input.method,
        producer: input.producer,
        producerVersion: input.producerVersion,
        sourceSystem: input.sourceSystem,
        sourceId: input.sourceId,
        locator: input.locator,
      });
      const deduplicated = state.evidence.has(key);
      if (!deduplicated) state.evidence.set(key, input);
      return Promise.resolve({ evidence: {} as never, deduplicated });
    },
  };

  const cursors: SyncCursors = {
    read: (scopeId) => {
      const position = state.cursorPositions.get(scopeId);
      return Promise.resolve(position === undefined ? undefined : { position });
    },
    advance: (producer, scopeId, position) => {
      state.cursorProducers.set(scopeId, producer);
      state.cursorPositions.set(scopeId, { ...position });
      return Promise.resolve();
    },
  };

  return { deps: { entities, relationships, evidence, cursors, logger: createNullLogger() }, state };
}

function context(): { logger: ReturnType<typeof createNullLogger>; signal: AbortSignal } {
  return { logger: createNullLogger(), signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// A connector for a source Ferret has never heard of.
// ---------------------------------------------------------------------------

interface WikiPage {
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly editedAt: string;
}

interface FixtureScript {
  readonly pages: readonly (readonly WikiPage[])[];
  /** Cursors returned per page, so a multi-page enumeration can be scripted. */
  readonly cursors?: readonly (string | undefined)[];
  readonly unchanged?: boolean;
  readonly failOnPage?: number;
}

/**
 * A wiki, which is neither a Git checkout nor a tracker.
 *
 * The point of the fixture is that it implements *neither* existing source
 * contract. If a wiki can be ingested through this boundary with no change to
 * the ingestor, the boundary is where EPIC-119 claims it is.
 */
class WikiConnector implements SourceConnector {
  readonly connectorId = 'fixture.source.wiki';
  readonly contractVersion = SOURCE_CONNECTOR_CONTRACT_VERSION;
  readonly system = 'wiki';
  readonly systemOfRecord = true;
  readonly asked: AcquisitionRequest[] = [];
  #page = 0;

  constructor(
    private readonly script: FixtureScript,
    private readonly instance = 'wiki.example.com',
  ) {}

  identify(resource: string) {
    return { system: this.system, instance: this.instance, resource: resource.trim() };
  }

  acquire(request: AcquisitionRequest): Promise<AcquisitionPage> {
    this.asked.push(request);
    const index = this.#page++;
    if (this.script.failOnPage === index) {
      return Promise.reject(
        new FerretError(ErrorCode.SOURCE_UNAVAILABLE, 'The wiki refused the connection'),
      );
    }
    if (this.script.unchanged === true) return Promise.resolve({ records: [], unchanged: true });
    const pages = this.script.pages[index] ?? [];
    const cursor = this.script.cursors?.[index];
    return Promise.resolve({
      records: pages.map(toWikiRecord),
      ...(cursor === undefined ? {} : { cursor }),
      checkpoint: { lastPage: index },
    });
  }

  normalize(records: readonly AcquiredRecord[], context: NormalizationContext): SourceContribution {
    const entities: CanonicalEntity[] = [];
    const relationships = [];
    const evidence = [];
    const skipped = [];

    for (const record of records) {
      const page = record.payload as WikiPage;
      if (page.title.trim() === '') {
        // One malformed record must not fail a source — EPIC-072 §8.9's rule,
        // restated at this layer because it is the layer a connector sees.
        skipped.push({ id: record.id, kind: record.kind, reason: 'no-title' });
        continue;
      }
      const document = context.emitter.entity({
        kind: EntityKind.DOCUMENT,
        source: { id: record.id, ...(record.metadata.url === undefined ? {} : { url: record.metadata.url }) },
        attributes: {
          title: page.title,
          location: page.slug,
          ...(record.metadata.updatedAt === undefined ? {} : { modifiedAt: record.metadata.updatedAt }),
        },
      });
      entities.push(document);
      relationships.push(
        context.emitter.relationship({
          fromId: document.id,
          type: 'document_describes_entity',
          toId: context.sourceEntityId,
          sourceId: record.id,
        }),
      );
      evidence.push(context.emitter.about(document, 'title', page.title));
    }

    return { entities, relationships, evidence, skipped };
  }
}

function toWikiRecord(page: WikiPage): AcquiredRecord {
  return {
    id: page.slug,
    kind: 'page',
    payload: page,
    metadata: {
      title: page.title,
      url: `https://wiki.example.com/${page.slug}`,
      updatedAt: page.editedAt,
      version: page.editedAt,
      labels: ['wiki'],
    },
  };
}

function wikiPage(slug: string, title = `Page ${slug}`): WikiPage {
  return { slug, title, body: 'Body text.', editedAt: '2026-09-01T00:00:00.000Z' };
}

function ingestor(connector: SourceConnector, deps: IngestDependencies): SourceIngestor {
  return new SourceIngestor(connector, deps);
}

// ---------------------------------------------------------------------------

describe('connector contract', () => {
  it('recognises a connector by its three verbs', () => {
    expect(isSourceConnector(new WikiConnector({ pages: [] }))).toBe(true);
  });

  it('does not mistake an existing source contract for a connector', () => {
    // A `ProjectSource` is a source and is not a connector. If this passed, the
    // adapter in `project-connector.ts` would be unnecessary — and the two
    // contracts would in fact be one, which they are not.
    const source: ProjectSource = {
      listIssues: () => Promise.resolve({ items: [] }),
      rateLimit: () => undefined,
    };
    expect(isSourceConnector(source)).toBe(false);
  });

  it('is a declared capability at a stated version', () => {
    expect(Capability.SOURCE_CONNECTOR).toBe('source.connector');
    expect(SOURCE_CONNECTOR_CONTRACT_VERSION).toBe(1);
  });

  it('exposes acquisition and normalization and nothing that decides', () => {
    // The boundary criterion as an assertion: a connector is transport and
    // mapping. Anything named `plan`, `decide`, `act` or `execute` would be a
    // connector reasoning, which EPIC-119 forbids outright.
    const connector = new WikiConnector({ pages: [] });
    const verbs = ['identify', 'acquire', 'normalize'];
    for (const verb of verbs) expect(typeof (connector as never)[verb]).toBe('function');
    for (const forbidden of ['plan', 'decide', 'act', 'execute', 'reason', 'orchestrate']) {
      expect((connector as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });
});

describe('source identity', () => {
  it('derives the same key for the same source, every time', () => {
    const identity = { system: 'wiki', instance: 'wiki.example.com', resource: 'handbook' };
    expect(sourceIdentityKey(identity)).toBe(sourceIdentityKey({ ...identity }));
  });

  it('ignores the case a user typed', () => {
    expect(sourceIdentityKey({ system: 'GitHub', instance: 'GitHub.com', resource: 'Indoulia/Ferret' })).toBe(
      sourceIdentityKey({ system: 'github', instance: 'github.com', resource: 'indoulia/ferret' }),
    );
  });

  it('keeps the same resource on two deployments apart', () => {
    // The defect a two-part identity would have: `PROJ` at one company and
    // `PROJ` at another are not one board.
    expect(sourceIdentityKey({ system: 'jira', instance: 'a.atlassian.net', resource: 'PROJ' })).not.toBe(
      sourceIdentityKey({ system: 'jira', instance: 'b.atlassian.net', resource: 'PROJ' }),
    );
  });

  it('survives ingestion onto distinguishable source entities', async () => {
    const { deps, state } = store();
    const one = new WikiConnector({ pages: [[wikiPage('a')]] }, 'one.example.com');
    const two = new WikiConnector({ pages: [[wikiPage('a')]] }, 'two.example.com');

    const first = await ingestor(one, deps).ingest({ resource: 'handbook' }, context());
    const second = await ingestor(two, deps).ingest({ resource: 'handbook' }, context());

    expect(first.identityKey).not.toBe(second.identityKey);
    expect(first.sourceEntityId).not.toBe(second.sourceEntityId);
    expect(state.entities.get(first.sourceEntityId)?.entity.source.id).toBe(first.identityKey);
    expect(state.entities.get(second.sourceEntityId)?.entity.source.id).toBe(second.identityKey);
  });
});

describe('extraction and normalization', () => {
  it('turns records the core has never seen into canonical entities', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('onboarding'), wikiPage('release')]] });

    const report = await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    expect(report.counts.records).toBe(2);
    const documents = [...state.entities.values()].filter((row) => row.entity.kind === EntityKind.DOCUMENT);
    expect(documents.map((row) => row.entity.source.id).sort()).toStrictEqual(['onboarding', 'release']);
    expect(state.relationships.size).toBe(2);
    expect(state.evidence.size).toBe(2);
  });

  it('writes entities, then relationships, then evidence', () => {
    // Not a preference: the relationship and evidence tables have foreign keys,
    // so the reverse order fails on a source ingested for the first time.
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('a')]] });
    return ingestor(connector, deps)
      .ingest({ resource: 'handbook' }, context())
      .then(() => {
        const first = state.order.indexOf('relationship');
        const evidence = state.order.indexOf('evidence');
        expect(state.order[0]).toBe('entity');
        expect(first).toBeLessThan(evidence);
        expect(state.order.lastIndexOf('entity')).toBeLessThan(first);
      });
  });

  it('skips a record it cannot map without failing the source', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({
      pages: [[wikiPage('good'), { slug: 'bad', title: '  ', body: '', editedAt: '2026-09-01T00:00:00.000Z' }]],
    });

    const report = await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    expect(report.skipped).toStrictEqual([{ id: 'bad', kind: 'page', reason: 'no-title' }]);
    expect([...state.entities.values()].filter((row) => row.entity.kind === EntityKind.DOCUMENT)).toHaveLength(1);
  });
});

describe('metadata', () => {
  it('survives ingestion onto the stored entity', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('onboarding', 'Onboarding')]] });

    await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    const document = [...state.entities.values()].find((row) => row.entity.kind === EntityKind.DOCUMENT);
    expect(document?.entity.attributes['title']).toBe('Onboarding');
    expect(document?.entity.attributes['location']).toBe('onboarding');
    expect(document?.entity.attributes['modifiedAt']).toBe('2026-09-01T00:00:00.000Z');
    expect(document?.entity.source.url).toBe('https://wiki.example.com/onboarding');
  });
});

describe('provenance', () => {
  it('attaches producer, version and system to every record, by construction', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('a')]] });

    await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    // The connector never passed a producer. The emitter did, which is the
    // whole mechanism: forgetting it is not possible from inside `normalize`.
    for (const record of state.evidence.values()) {
      expect(record.producer).toBe('fixture.source.wiki');
      expect(record.producerVersion).toBe(VERSION);
      expect(record.sourceSystem).toBe('wiki');
    }
    for (const row of state.entities.values()) {
      expect(row.entity.source.system).toBe('wiki');
    }
  });

  it('is retrievable afterwards, keyed by the source record it came from', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('onboarding', 'Onboarding')]] });

    const report = await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    const document = [...state.entities.values()].find((row) => row.entity.kind === EntityKind.DOCUMENT);
    const about = [...state.evidence.values()].find((record) => record.subjectId === document?.entity.id);
    expect(about?.statement).toBe('Onboarding');
    expect(about?.sourceId).toBe('onboarding');
    expect(about?.sourceUrl).toBe('https://wiki.example.com/onboarding');
    // The chain end to end: evidence → entity → source instance.
    expect(report.identityKey).toBe('wiki::wiki.example.com::handbook');
  });
});

describe('idempotence and determinism', () => {
  it('writes one row for the same record acquired twice in one pass', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({ pages: [[wikiPage('a'), wikiPage('a')]] });

    const report = await ingestor(connector, deps).ingest({ resource: 'handbook' }, context());

    expect(report.counts.records).toBe(2);
    expect([...state.entities.values()].filter((row) => row.entity.kind === EntityKind.DOCUMENT)).toHaveLength(1);
  });

  it('creates nothing new when the same source is ingested again', async () => {
    const { deps, state } = store();
    const first = await ingestor(new WikiConnector({ pages: [[wikiPage('a'), wikiPage('b')]] }), deps).ingest(
      { resource: 'handbook', full: true },
      context(),
    );
    const before = new Map([...state.entities].map(([id, row]) => [id, row.entity.contentHash]));

    const second = await ingestor(new WikiConnector({ pages: [[wikiPage('a'), wikiPage('b')]] }), deps).ingest(
      { resource: 'handbook', full: true },
      context(),
    );

    expect(first.writes.entitiesCreated).toBeGreaterThan(0);
    expect(second.writes.entitiesCreated).toBe(0);
    expect(second.writes.entitiesUpdated).toBe(0);
    expect(second.writes.evidenceRecorded).toBe(0);
    expect(second.writes.evidenceDeduplicated).toBe(2);
    expect(new Map([...state.entities].map(([id, row]) => [id, row.entity.contentHash]))).toStrictEqual(before);
  });

  it('derives the same ids in two independent runs against two stores', async () => {
    const runs = await Promise.all(
      [store(), store()].map(async ({ deps, state }) => {
        await ingestor(new WikiConnector({ pages: [[wikiPage('a'), wikiPage('b')]] }), deps).ingest(
          { resource: 'handbook' },
          context(),
        );
        return [...state.entities.keys()].sort();
      }),
    );

    expect(runs[0]).toStrictEqual(runs[1]);
    expect(runs[0]?.length).toBeGreaterThan(0);
  });
});

describe('change detection', () => {
  it('asks only for what changed once a pass has completed', async () => {
    const { deps, state } = store();
    const first = new WikiConnector({ pages: [[wikiPage('a')]] });
    const report = await ingestor(first, deps).ingest({ resource: 'handbook' }, context());
    expect(report.cursorAdvancedTo).toBeDefined();
    expect(state.cursorProducers.get(report.identityKey)).toBe(INGEST_PRODUCER);

    const second = new WikiConnector({ pages: [[wikiPage('a')]] });
    const next = await ingestor(second, deps).ingest({ resource: 'handbook' }, context());

    expect(next.since).toBe(report.cursorAdvancedTo);
    expect(second.asked[0]?.since).toBe(report.cursorAdvancedTo);
  });

  it('keeps the connector checkpoint across passes, untouched', async () => {
    const { deps, state } = store();
    const report = await ingestor(new WikiConnector({ pages: [[wikiPage('a')]] }), deps).ingest(
      { resource: 'handbook' },
      context(),
    );
    expect(state.cursorPositions.get(report.identityKey)?.['checkpoint']).toStrictEqual({ lastPage: 0 });
  });

  it('does not advance a cursor for a pass that stopped short', async () => {
    const { deps, state } = store();
    const connector = new WikiConnector({
      pages: [[wikiPage('a')], [wikiPage('b')], [wikiPage('c')]],
      cursors: ['p2', 'p3', 'p4'],
    });

    const report = await ingestor(connector, deps).ingest({ resource: 'handbook', pageLimit: 2 }, context());

    expect(report.truncated).toBe(true);
    expect(report.cursorAdvancedTo).toBeUndefined();
    expect(state.cursorPositions.has(report.identityKey)).toBe(false);
  });

  it('reports "nothing changed" as different from "nothing there"', async () => {
    const { deps } = store();
    const report = await ingestor(new WikiConnector({ pages: [], unchanged: true }), deps).ingest(
      { resource: 'handbook' },
      context(),
    );

    expect(report.unchanged).toBe(true);
    expect(report.counts.records).toBe(0);
    expect(report.cursorAdvancedTo).toBeDefined();
  });

  it('writes nothing on a dry run, and remembers nothing either', async () => {
    const { deps, state } = store();
    const report = await ingestor(new WikiConnector({ pages: [[wikiPage('a')]] }), deps).ingest(
      { resource: 'handbook', dryRun: true },
      context(),
    );

    expect(report.dryRun).toBe(true);
    expect(state.entities.size).toBe(0);
    expect(report.cursorAdvancedTo).toBeUndefined();
  });

  it('bounds an unbounded enumeration by default', () => {
    expect(DEFAULT_INGEST_PAGE_LIMIT).toBe(20);
  });
});

describe('failure isolation', () => {
  it('does not corrupt another source when one fails', async () => {
    const { deps, state } = store();
    const healthy = new WikiConnector({ pages: [[wikiPage('kept')]] }, 'good.example.com');
    const broken = new WikiConnector({ pages: [[wikiPage('lost')]], failOnPage: 0 }, 'bad.example.com');

    const outcomes = await ingestSources(
      [
        { connector: healthy, options: { resource: 'handbook' } },
        { connector: broken, options: { resource: 'handbook' } },
        { connector: new WikiConnector({ pages: [[wikiPage('later')]] }, 'third.example.com'), options: { resource: 'handbook' } },
      ],
      deps,
      context(),
    );

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(['ingested', 'failed', 'ingested']);
    const failure = outcomes[1];
    expect(failure?.status === 'failed' ? failure.code : undefined).toBe(ErrorCode.SOURCE_UNAVAILABLE);

    // The healthy sources' records are intact, and the third one ran at all —
    // a failure that stopped the pass would have left it unread.
    const documents = [...state.entities.values()]
      .filter((row) => row.entity.kind === EntityKind.DOCUMENT)
      .map((row) => row.entity.source.id)
      .sort();
    expect(documents).toStrictEqual(['kept', 'later']);
  });

  it("leaves a failed source's cursor where it was, so nothing is skipped", async () => {
    const { deps, state } = store();
    const broken = new WikiConnector({ pages: [[wikiPage('a')]], failOnPage: 0 });

    await ingestSources([{ connector: broken, options: { resource: 'handbook' } }], deps, context());

    expect(state.cursorPositions.size).toBe(0);
  });

  it('does not swallow cancellation', async () => {
    const { deps } = store();
    const controller = new AbortController();
    controller.abort();

    await expect(
      ingestSources(
        [{ connector: new WikiConnector({ pages: [[wikiPage('a')]] }), options: { resource: 'handbook' } }],
        deps,
        { logger: createNullLogger(), signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('refuses an unnamed source rather than guessing at one', async () => {
    const { deps } = store();
    await expect(
      ingestor(new WikiConnector({ pages: [] }), deps).ingest({ resource: '   ' }, context()),
    ).rejects.toMatchObject({ code: ErrorCode.USAGE });
  });
});

// ---------------------------------------------------------------------------
// A concrete source: the GitHub provider Ferret ships, unchanged.
// ---------------------------------------------------------------------------

const ISSUE_JSON = [
  {
    id: 1,
    node_id: 'I_kw1',
    number: 7,
    title: 'Retrieval misses renamed files',
    body: 'Steps to reproduce.',
    state: 'open',
    html_url: 'https://github.com/indoulia/Ferret/issues/7',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    user: { id: 4, node_id: 'U_kw4', login: 'ada' },
    labels: [{ name: 'bug' }],
  },
];

async function githubConnector(): Promise<SourceConnector> {
  const provider = createGithubProvider({
    token: 'ghp_test_token',
    fetch: (url: string | URL) => {
      const href = String(url);
      const body = href.includes('/issues') ? ISSUE_JSON : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });
  // The provider Ferret ships, initialized exactly as the runtime initializes
  // it. Nothing about it was changed to fit the connector; the adapter is the
  // whole adaptation.
  await provider.initialize(createTestProviderContext());
  return projectSourceConnector({
    source: provider,
    connectorId: provider.id,
    system: 'github',
    instance: 'github.com',
    operations: [ProjectOperation.LIST_ISSUES],
  });
}

describe('a real source implements the contract', () => {
  it('ingests through the connector with no change to the provider', async () => {
    const { deps, state } = store();
    const connector = await githubConnector();

    const report = await ingestor(connector, deps).ingest({ resource: 'indoulia/Ferret' }, context());

    expect(report.connectorId).toBe('ferret.source.github');
    expect(report.identityKey).toBe('github::github.com::indoulia/ferret');
    expect(report.counts.records).toBe(1);

    const issue = [...state.entities.values()].find((row) => row.entity.kind === EntityKind.ISSUE);
    expect(issue?.entity.attributes['title']).toBe('Retrieval misses renamed files');
  });

  it("carries the provider's provenance onto what it stores", async () => {
    const { deps, state } = store();
    await ingestor(await githubConnector(), deps).ingest({ resource: 'indoulia/Ferret' }, context());

    const records = [...state.evidence.values()];
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.producer).toBe('ferret.source.github');
      expect(record.sourceSystem).toBe('github');
      expect(record.producerVersion).toBe(VERSION);
    }
  });

  it('is idempotent against the same tracker state', async () => {
    const { deps } = store();
    await ingestor(await githubConnector(), deps).ingest({ resource: 'indoulia/Ferret', full: true }, context());
    const again = await ingestor(await githubConnector(), deps).ingest(
      { resource: 'indoulia/Ferret', full: true },
      context(),
    );

    expect(again.writes.entitiesCreated).toBe(0);
    expect(again.writes.entitiesUpdated).toBe(0);
  });

  it('never calls an operation the provider did not declare', async () => {
    const { deps, state } = store();
    const asked: ProjectQuery[] = [];
    const source: ProjectSource = {
      listIssues: (query: ProjectQuery): Promise<ProjectPage<ProjectIssue>> => {
        asked.push(query);
        return Promise.resolve({ items: [] });
      },
      rateLimit: (): ProjectRateLimit | undefined => undefined,
    };
    const connector = projectSourceConnector({
      source,
      connectorId: 'ferret.source.jira',
      system: 'jira',
      instance: 'acme.atlassian.net',
      operations: [],
    });

    const report = await ingestor(connector, deps).ingest({ resource: 'FER' }, context());

    expect(asked).toStrictEqual([]);
    expect(report.counts.records).toBe(0);
    // The source entity is still written: "this source has nothing right now"
    // and "this source is unknown" are different facts.
    expect(state.entities.has(report.sourceEntityId)).toBe(true);
  });

  it("maps the tracker's own issue lifecycle through, unaltered", async () => {
    const { deps, state } = store();
    const source: ProjectSource = {
      listIssues: (): Promise<ProjectPage<ProjectIssue>> =>
        Promise.resolve({
          items: [
            {
              id: 'FER-12',
              key: 'FER-12',
              title: 'Connector contract',
              state: 'In Review',
              lifecycle: ProjectItemState.OPEN,
              labels: [],
            },
          ],
        }),
      rateLimit: (): ProjectRateLimit | undefined => undefined,
    };
    const connector = projectSourceConnector({
      source,
      connectorId: 'ferret.source.jira',
      system: 'jira',
      instance: 'acme.atlassian.net',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    await ingestor(connector, deps).ingest({ resource: 'FER' }, context());

    const issue = [...state.entities.values()].find((row) => row.entity.kind === EntityKind.ISSUE);
    // The vendor's own word survives; Ferret's comparable reading sits beside
    // it rather than replacing it — EPIC-021 §8.1, unchanged by the connector.
    expect(issue?.entity.attributes['sourceState']).toBe('In Review');
    expect(issue?.entity.attributes['state']).toBe(ProjectItemState.OPEN);
    expect(issue?.entity.source.id).toBe('FER-12');
  });
});

// ---------------------------------------------------------------------------

describe('boundary', () => {
  const SRC = resolve(fileURLToPath(new URL('../../src', import.meta.url)));

  function sources(): string[] {
    return [
      'connectors/ingest.ts',
      'connectors/write.ts',
      'connectors/project-connector.ts',
      'connectors/index.ts',
      'providers/contracts/source-connector.ts',
    ].map((file) => readFileSync(resolve(SRC, file), 'utf8'));
  }

  it('introduces no model call, no scheduler and no orchestration', () => {
    // EPIC-119's scope boundary as a test rather than a promise. Every term
    // here names something the Epic explicitly does not implement, and the
    // cheapest way for one to arrive is a helpful addition nobody reviews.
    const forbidden = [
      'setInterval',
      'setTimeout',
      'cron',
      'webhook',
      'anthropic',
      'openai',
      'completion(',
      'prompt(',
    ];
    for (const source of sources()) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const term of forbidden) expect(code.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });

  it('names no concrete provider from the contract itself', () => {
    const contract = readFileSync(resolve(SRC, 'providers/contracts/source-connector.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    for (const vendor of ['github', 'jira', 'confluence', 'bitbucket', 'jenkins']) {
      expect(contract.toLowerCase()).not.toContain(vendor);
    }
  });

  it('reaches storage only through the ports the core already defines', () => {
    const ingest = readFileSync(resolve(SRC, 'connectors/ingest.ts'), 'utf8');
    const write = readFileSync(resolve(SRC, 'connectors/write.ts'), 'utf8');
    for (const source of [ingest, write]) {
      expect(source).not.toContain("from '../storage/");
      expect(source).toContain("from '../indexing/ports.js'");
    }
    expect(dirname(resolve(SRC, 'connectors/ingest.ts'))).toContain('connectors');
  });
});
