import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Direction,
  EntityKind,
  PROJECT_COMMENT_RECORD,
  PROJECT_ISSUE_RECORD,
  PUBLIC_ACCESS,
  RelationshipType,
  SourceIngestor,
  ingestSources,
  projectSourceConnector,
  type IngestReport,
  type SourceConnector,
} from '../../../src/index.js';
import { JIRA_PROVIDER_ID, JIRA_SOURCE_SYSTEM, createJiraProvider } from '../../../src/jira/index.js';
import { ProjectOperation } from '../../../src/providers/contracts/source-project.js';
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
 * The Jira connector — EPIC-122.
 *
 * The same connector EPIC-121 widened, pointed at a tracker shaped nothing like
 * GitHub. That is the test: Jira **keys** its issues where GitHub numbers them,
 * identifies them by a numeric id that survives a move between projects,
 * declares no pull requests and no reviews at all, and has typed links between
 * issues that GitHub has no concept of.
 *
 * **The provider is the one Ferret ships.** `createJiraProvider` is constructed
 * with only `fetch` supplied, so the JQL construction, `startAt` paging and the
 * REST mapping onto `ProjectSource` are all production code.
 *
 * Two things here could not have been found from the GitHub suite. A Jira issue
 * is addressed by `FER-12` and identified by `10042`, so a connector reaching
 * for its comments with an id gets `E_USAGE` from a method that demands a key.
 * And a tracker that declares two operations of four must not spend the
 * ingestor's page budget arriving at the two it will never run.
 */

const BASE = 'https://acme.atlassian.net';
const PROJECT = 'FER';

interface Fixture {
  readonly issues?: unknown[];
  readonly comments?: Record<string, unknown[]>;
  /** Paths the fixture was asked for, so an undeclared call is observable. */
  readonly calls?: string[];
}

/** Jira-shaped JSON, answered by path exactly as the REST API lays it out. */
function jiraFetch(fixture: Fixture) {
  return (url: string): Promise<{ status: number; headers: Record<string, string>; text: () => Promise<string> }> => {
    fixture.calls?.push(url);
    const body = (value: unknown) =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: () => Promise.resolve(JSON.stringify(value)),
      });

    const comments = /\/issue\/([^/]+)\/comment/.exec(url);
    if (comments !== null) {
      const key = decodeURIComponent(comments[1] as string);
      const items = fixture.comments?.[key] ?? [];
      return body({ comments: items, total: items.length, startAt: 0 });
    }

    const issues = fixture.issues ?? [];
    return body({ issues, total: issues.length, startAt: 0 });
  };
}

const REPORTER = { accountId: 'acc-1', displayName: 'Ada Lovelace', emailAddress: 'ada@example.com' };
const OTHER = { accountId: 'acc-2', displayName: 'Grace Hopper', emailAddress: 'grace@example.com' };

/**
 * One Jira issue.
 *
 * `id` and `key` differ deliberately and that is the whole point: Jira
 * identifies by the numeric id and a person addresses it by the key.
 */
function issue(
  number: number,
  summary: string,
  extra: {
    links?: unknown[];
    status?: string;
    type?: string;
    priority?: string;
    created?: string;
    updated?: string;
  } = {},
): unknown {
  return {
    id: String(10_000 + number),
    key: `${PROJECT}-${String(number)}`,
    self: `${BASE}/rest/api/3/issue/${String(10_000 + number)}`,
    fields: {
      summary,
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body text.' }] }] },
      status: { name: extra.status ?? 'In Progress', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: extra.type ?? 'Bug' },
      priority: { name: extra.priority ?? 'High' },
      labels: ['backend'],
      // The shape a real Jira Cloud instance sends: a numeric offset with no
      // colon, and commonly a negative one. Confirmed against a live instance —
      // 50 issues, every date `NNNN-NN-NNTNN:NN:NN.NNN-NNNN`.
      created: extra.created ?? '2026-09-01T00:00:00.000-0500',
      updated: extra.updated ?? '2026-09-02T00:00:00.000-0500',
      reporter: REPORTER,
      assignee: OTHER,
      ...(extra.links === undefined ? {} : { issuelinks: extra.links }),
    },
  };
}

/** A link as Jira reports it on the issue that carries it. */
function link(name: string, direction: 'outward' | 'inward', targetNumber: number): unknown {
  const other = { id: String(10_000 + targetNumber), key: `${PROJECT}-${String(targetNumber)}` };
  return {
    type: { name, inward: `is ${name.toLowerCase()} by`, outward: name.toLowerCase() },
    ...(direction === 'outward' ? { outwardIssue: other } : { inwardIssue: other }),
  };
}

function comment(id: number, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: String(id),
    self: `${BASE}/rest/api/3/comment/${String(id)}`,
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    author: OTHER,
    created: '2026-09-02T10:00:00.000+0000',
    updated: '2026-09-02T10:00:00.000+0000',
    ...extra,
  };
}

async function connector(
  fixture: Fixture,
  overrides: { operations?: readonly string[]; fanOut?: number } = {},
): Promise<SourceConnector> {
  const provider = createJiraProvider({
    baseUrl: BASE,
    email: 'ada@example.com',
    token: 'jira_test_token',
    fetch: jiraFetch(fixture) as never,
  });
  await provider.initialize(createTestProviderContext());
  return projectSourceConnector({
    source: provider,
    connectorId: provider.id,
    system: JIRA_SOURCE_SYSTEM,
    instance: 'acme.atlassian.net',
    // What the Jira provider actually declares: two of the four operations.
    operations: overrides.operations ?? [ProjectOperation.LIST_ISSUES, ProjectOperation.LIST_COMMENTS],
    ...(overrides.fanOut === undefined ? {} : { fanOut: overrides.fanOut }),
  });
}

/** Two issues, linked, one of them discussed. */
const FULL: Fixture = {
  issues: [
    issue(1, 'Retrieval misses renamed files', { links: [link('Blocks', 'outward', 2)] }),
    issue(2, 'Rename detection is incomplete', { links: [link('Blocks', 'inward', 1)], type: 'Story', priority: 'Medium' }),
  ],
  comments: {
    'FER-1': [comment(5001, 'This reproduces on Windows only.')],
    'FER-2': [comment(5002, 'Blocked until FER-1 lands.')],
  },
};

function issues(state: ReturnType<typeof connectorStore>['state']) {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === EntityKind.ISSUE)
    .map((row) => row.entity);
}

function documents(state: ReturnType<typeof connectorStore>['state']) {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === EntityKind.DOCUMENT)
    .map((row) => row.entity);
}

function links(state: ReturnType<typeof connectorStore>['state']) {
  return [...state.relationships.values()].filter(
    (edge) => edge.type === RelationshipType.ISSUE_LINKS_ISSUE,
  );
}

// ---------------------------------------------------------------------------

describe('EPIC-122 — ingesting a Jira project', () => {
  it('ingests issues and their comments through the same connector', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    expect(report.connectorId).toBe(JIRA_PROVIDER_ID);
    expect(report.identityKey).toBe('jira::acme.atlassian.net::fer');
    expect(report.skipped).toEqual([]);
    expect(issues(state).length).toBe(2);
    expect(documents(state).length).toBe(2);
  });

  it('addresses an issue by its key, not by the id it is identified by', async () => {
    // The defect this pins. `toIssue` identifies a Jira issue by its numeric id
    // — deliberately, because that survives a move between projects — while
    // `listComments` validates its argument against an issue-key pattern and
    // throws `E_USAGE` on anything else. A connector that addressed the parent
    // by id would fail the whole source on the comment stage.
    const calls: string[] = [];
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector({ ...FULL, calls }), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    expect(calls.some((url) => url.includes('/issue/FER-1/comment'))).toBe(true);
    expect(calls.some((url) => url.includes('/issue/10001/comment'))).toBe(false);
    expect(documents(state).length).toBe(2);
  });

  it('links a comment to a parent identified by id and addressed by key', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    const first = issues(state).find((entity) => entity.attributes['key'] === 'FER-1');
    // Identified by the numeric id, exactly as the provider intends.
    expect(first?.source.id).toBe('10001');

    const attached = [...state.relationships.values()].filter(
      (edge) =>
        edge.type === RelationshipType.DOCUMENT_DESCRIBES_ENTITY && edge.toId === first?.id,
    );
    expect(attached.length).toBe(1);
  });

  it('keeps the status the tracker actually reported beside the comparable one', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ issues: [issue(1, 'In flight', { status: 'In Review' })] }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    const entity = issues(state)[0];
    // EPIC-021 §8.1's rule: the vendor's own word survives beside Ferret's
    // reading, because "In Review" is a fact and the comparable reading is a
    // judgement. `ProjectItemState` has three values by contract — open,
    // closed, merged — so Jira's `indeterminate` category reads as `open`, and
    // everything that distinguishes it is in `sourceState`.
    expect(entity?.attributes['sourceState']).toBe('In Review');
    expect(entity?.attributes['state']).toBe('open');
  });

  it('accepts the instant format a real Jira instance actually sends', async () => {
    // **Jira ingestion had never worked end to end before this.** Jira reports
    // `2026-09-01T00:00:00.000-0500` — a numeric offset with no colon — which
    // `z.iso.datetime({ offset: true })` rejects, so `createEntity` refused
    // every issue and `modelProject` did the right thing with a record it
    // cannot model: skipped it and counted it. A whole board arrived as a skip
    // count. EPIC-071's suite never saw it because it asserts the provider's
    // output and never carries that output across the seam into the model.
    //
    // Both signs and a `Z` are covered, because a real instance sends whichever
    // its timezone implies.
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(
      await connector({
        issues: [
          issue(1, 'Negative offset'),
          issue(2, 'Positive offset', { created: '2026-09-01T00:00:00.000+0530', updated: '2026-09-02T00:00:00.000+0530' }),
          issue(3, 'Zulu', { created: '2026-09-01T00:00:00.000Z', updated: '2026-09-02T00:00:00.000Z' }),
        ],
      }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    expect(report.skipped).toEqual([]);
    expect(issues(state).length).toBe(3);
    for (const entity of issues(state)) {
      expect(String(entity.attributes['createdAt'])).toMatch(/^2026-09-01T/);
    }
  });

  it('drops an instant it cannot read rather than storing a wrong one', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(
      await connector({ issues: [issue(1, 'Undatable', { created: 'not a date', updated: 'not a date' })] }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    // EPIC-020's rule for Git's dates, applied here: absent is honest, and a
    // wrong instant in a field every consumer reads as one is not. The issue
    // still arrives — one unreadable field must not cost the record.
    expect(report.skipped).toEqual([]);
    expect(issues(state).length).toBe(1);
    expect(issues(state)[0]?.attributes['createdAt']).toBeUndefined();
  });

  it('stores the issue type and priority the provider had been discarding', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ issues: [issue(1, 'Typed', { type: 'Story', priority: 'Low' })] }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    // `issueAttributes` has declared both since EPIC-006 and the Jira provider
    // has requested both on every search since EPIC-071 — and `toIssue` threw
    // them away for want of a contract field to carry them.
    const entity = issues(state)[0];
    expect(entity?.attributes['issueType']).toBe('Story');
    expect(entity?.attributes['priority']).toBe('Low');
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-122 — links between issues', () => {
  it('records a typed link as a walkable edge carrying the vendor’s own word', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    const edges = links(state);
    expect(edges.length).toBeGreaterThan(0);
    expect(edges[0]?.metadata?.['linkType']).toBe('Blocks');
  });

  it('normalises direction so both sides of one link are one edge', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    // Jira reports `FER-1 blocks FER-2` on *both* issues — outward on FER-1 and
    // inward on FER-2. Modelling each as stated would give two edges facing
    // each other for one fact.
    const distinct = new Set(links(state).map((edge) => `${edge.fromId}|${edge.toId}`));
    expect(distinct.size).toBe(1);

    const one = issues(state).find((entity) => entity.attributes['key'] === 'FER-1');
    const two = issues(state).find((entity) => entity.attributes['key'] === 'FER-2');
    const edge = links(state)[0];
    // And it points the way the vendor's outward reading says.
    expect(edge?.fromId).toBe(one?.id);
    expect(edge?.toId).toBe(two?.id);
  });

  it('links to an issue this pass never read, without inventing its content', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ issues: [issue(1, 'Only one', { links: [link('Duplicates', 'outward', 99)] })] }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    const stub = issues(state).find((entity) => entity.attributes['key'] === 'FER-99');
    expect(stub).toBeDefined();
    // A stub carries the key and nothing else: an id that resolves to nothing
    // *yet* is still the correct id, and inventing a title would be worse.
    expect(stub?.attributes['title']).toBeUndefined();
    expect(links(state).length).toBe(1);
  });

  it('carries a link type Ferret has never heard of', async () => {
    // The evidence for making `ISSUE_LINKS_ISSUE` generic rather than
    // enumerating link types. A live Jira instance was sampled — 50 issues,
    // 144 links — and it used **fourteen** distinct types, most of them
    // configured for that instance: `Design Spec`, `Polaris work item link`,
    // `Implement`, `Explored`, `Satisfies`, `Problem/Incident`, `Defect`
    // alongside the familiar `Blocks`, `Duplicate` and `Related`. Any fixed
    // enumeration Ferret wrote would have dropped three quarters of them.
    const exotic = ['Design Spec', 'Polaris work item link', 'Satisfies', 'Problem/Incident'];
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(
      await connector({
        issues: [
          issue(1, 'Many links', {
            links: exotic.map((name, index) => link(name, 'outward', 10 + index)),
          }),
        ],
      }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    expect(report.skipped).toEqual([]);
    expect(links(state).length).toBe(exotic.length);
    // Each carries the vendor's own word, unmapped and unabbreviated.
    expect(new Set(links(state).map((edge) => edge.metadata?.['linkType']))).toEqual(
      new Set(exotic),
    );
  });

  it('records why it believes a link exists', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    const evidence = [...state.evidence.values()].filter((row) => row.field === 'links');
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0]?.producer).toBe(JIRA_PROVIDER_ID);
  });

  it('drops a link that names no issue rather than emitting a dangling edge', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({
        issues: [
          issue(1, 'Malformed links', {
            // No type name, and no linked issue: two shapes that carry no fact.
            links: [{ outwardIssue: { id: '10002', key: 'FER-2' } }, { type: { name: 'Blocks' } }],
          }),
        ],
      }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    expect(links(state).length).toBe(0);
    // And the issue itself still arrived: one malformed field must not cost a
    // record — EPIC-072 §8.9.
    expect(issues(state).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-122 — a tracker that declares two operations of four', () => {
  it('does not spend a page arriving at a stage it will never run', async () => {
    const source = await connector(FULL);
    const identity = source.identify(PROJECT);
    const kinds: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await source.acquire(
        { identity, ...(cursor === undefined ? {} : { cursor }) },
        createTestOperationContext(),
      );
      for (const record of page.records) kinds.push(record.kind);
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== undefined);

    // Issues, then comments. `pulls` and `reviews` are declared by neither the
    // provider nor this tracker's idea of the world, and stepping over them
    // costs nothing: two pages, not four.
    expect(pages).toBe(2);
    expect(new Set(kinds)).toEqual(new Set([PROJECT_ISSUE_RECORD, PROJECT_COMMENT_RECORD]));
  });

  it('still reaches the comments under a page limit that would have truncated', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      // Two pages is exactly enough now. Before the fix the pass spent one page
      // on `pulls` and one on `reviews` and truncated before it acquired a
      // single comment.
      { resource: PROJECT, pageLimit: 2 },
      createTestOperationContext(),
    );

    expect(report.truncated).toBe(false);
    expect(documents(state).length).toBe(2);
    expect(report.cursorAdvancedTo).toBeDefined();
  });

  it('never calls an operation the provider did not declare', async () => {
    const calls: string[] = [];
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({ ...FULL, calls }, { operations: [ProjectOperation.LIST_ISSUES] }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    expect(calls.some((url) => url.includes('/comment'))).toBe(false);
    expect(issues(state).length).toBe(2);
    expect(documents(state).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-122 — identity, provenance, idempotence and isolation', () => {
  it('keeps two Jira tenants sharing a project key apart', async () => {
    const acme = await connector(FULL);
    const other = projectSourceConnector({
      source: { listIssues: () => Promise.resolve({ items: [] }), rateLimit: () => undefined },
      connectorId: JIRA_PROVIDER_ID,
      system: JIRA_SOURCE_SYSTEM,
      instance: 'other.atlassian.net',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    // The reason `instance` is required rather than defaulted: two companies
    // both have a `FER` board and they are not the same source.
    expect(acme.identify(PROJECT)).not.toEqual(other.identify(PROJECT));
  });

  it('attaches producer, version and system to every record it writes', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );

    expect(state.evidence.size).toBeGreaterThan(0);
    for (const record of state.evidence.values()) {
      expect(record.producer).toBe(JIRA_PROVIDER_ID);
      expect(record.producerVersion).toBe(VERSION);
      expect(record.sourceSystem).toBe(JIRA_SOURCE_SYSTEM);
    }
  });

  it('scopes every issue to its own project', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );
    for (const entity of issues(state)) {
      expect(entity.source.scope).toBe(report.sourceEntityId);
    }
  });

  it('creates nothing new when the same project is ingested twice', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );
    const before = counts(state);

    const second = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT, full: true },
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
      await new SourceIngestor(await connector(FULL), deps).ingest(
        { resource: PROJECT },
        createTestOperationContext(),
      );
      runs.push([...state.entities.keys()].sort());
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it('updates an edited comment in place rather than adding a second', async () => {
    const { deps, state } = connectorStore();
    const first: Fixture = {
      issues: [issue(1, 'Discussed')],
      comments: { 'FER-1': [comment(5001, 'First thought.')] },
    };
    await new SourceIngestor(await connector(first), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );
    const original = documents(state)[0]?.id;

    await new SourceIngestor(
      await connector({
        issues: [issue(1, 'Discussed')],
        comments: { 'FER-1': [comment(5001, 'Second thought.', { updated: '2026-09-04T00:00:00.000+0000' })] },
      }),
      deps,
    ).ingest({ resource: PROJECT, full: true }, createTestOperationContext());

    expect(documents(state).length).toBe(1);
    expect(documents(state)[0]?.id).toBe(original);
    expect(documents(state)[0]?.attributes['description']).toBe('Second thought.');
  });

  it('isolates a project that fails without touching another', async () => {
    const healthy = await connector(FULL);
    const broken = projectSourceConnector({
      source: {
        listIssues: () => Promise.reject(new Error('the tracker refused the connection')),
        rateLimit: () => undefined,
      },
      connectorId: JIRA_PROVIDER_ID,
      system: JIRA_SOURCE_SYSTEM,
      instance: 'acme.atlassian.net',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    const { deps, state } = connectorStore();
    const outcomes = await ingestSources(
      [
        { connector: broken, options: { resource: 'BROKEN' } },
        { connector: healthy, options: { resource: PROJECT } },
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

  it('redacts a credential somebody pasted into a Jira comment', async () => {
    const leaked = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({
        issues: [issue(1, 'Broken auth')],
        comments: { 'FER-1': [comment(5003, `Run: curl -H "Authorization: token ${leaked}"`)] },
      }),
      deps,
    ).ingest({ resource: PROJECT }, createTestOperationContext());

    expect(String(documents(state)[0]?.attributes['description'])).not.toContain(leaked);
  });
});

// ---------------------------------------------------------------------------
// The real path, all the way to an answer.
// ---------------------------------------------------------------------------

const endToEnd = databaseAvailable() ? describe : describe.skip;

if (!databaseAvailable()) {
  process.stderr.write(`\n[EPIC-122] SKIPPING end-to-end retrieval: ${SKIP_REASON}\n\n`);
}

endToEnd('EPIC-122 — acquisition to retrieval, against the real stores', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('epic122');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('answers an agent asking what blocks an issue, and what was said on it', async () => {
    const report = await new SourceIngestor(await connector(FULL), {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    }).ingest({ resource: PROJECT }, createTestOperationContext());

    const retrieval = new RetrievalStore(handle);

    const stored = await retrieval.findEntities(
      { kind: EntityKind.ISSUE, scope: report.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );
    expect(stored.entities.length).toBe(2);

    const blocked = stored.entities.find((entity) => entity.attributes['key'] === 'FER-2');
    // 1. What blocks this — the edge EPIC-122 added, walked as an agent would.
    const blockers = await retrieval.neighbours(
      {
        from: blocked?.id ?? '',
        types: [RelationshipType.ISSUE_LINKS_ISSUE],
        direction: Direction.IN,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(
      blockers.neighbours.map((neighbour) => String(neighbour.entity.attributes['key'])),
    ).toContain('FER-1');

    // 2. And the discussion on it.
    const discussion = await retrieval.neighbours(
      {
        from: blocked?.id ?? '',
        types: [RelationshipType.DOCUMENT_DESCRIBES_ENTITY],
        direction: Direction.IN,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(
      discussion.neighbours.map((neighbour) => String(neighbour.entity.attributes['description'])),
    ).toContain('Blocked until FER-1 lands.');

    // 3. Provenance survived storage.
    const evidence = await handle.execute<{ producer: string; producer_version: string }>(
      sql`SELECT DISTINCT producer, producer_version FROM ferret.evidence`,
    );
    expect(evidence.rows.map((row) => row.producer)).toContain(JIRA_PROVIDER_ID);
    expect(evidence.rows.map((row) => row.producer_version)).toContain(VERSION);
  }, 300_000);

  it('writes one graph however many times the project is ingested', async () => {
    const deps = {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    };
    const retrieval = new RetrievalStore(handle);

    const first = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT },
      createTestOperationContext(),
    );
    const before = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: PROJECT, full: true },
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

/** What a second pass must not change. See the GitHub suite for why edges are counted this way. */
function counts(state: ReturnType<typeof connectorStore>['state']): Record<string, number> {
  const edges = new Set(
    [...state.relationships.values()].map((edge) => `${edge.fromId}|${edge.type}|${edge.toId}`),
  );
  return { entities: state.entities.size, edges: edges.size, evidence: state.evidence.size };
}
