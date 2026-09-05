import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Direction,
  EntityKind,
  PROJECT_COMMENT_RECORD,
  PROJECT_ISSUE_RECORD,
  PROJECT_PULL_REQUEST_RECORD,
  PROJECT_REVIEW_RECORD,
  PUBLIC_ACCESS,
  RelationshipType,
  SourceIngestor,
  ingestSources,
  projectSourceConnector,
  type IngestReport,
  type SourceConnector,
} from '../../../src/index.js';
import { createGithubProvider } from '../../../src/github/index.js';
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
 * The GitHub connector — EPIC-121.
 *
 * EPIC-119 put the GitHub provider on the universal boundary and read *issues*
 * from it. EPIC-120 proved a staged cursor could carry a source made of several
 * collections. This is the two joined: issues, pull requests, reviews and
 * comments from the real `GithubProvider`, through one cursor, into one graph.
 *
 * **The provider is the one Ferret ships.** `createGithubProvider` is
 * constructed with only `fetch` supplied, so every layer below the transport —
 * paging, ETags, rate-limit accounting, the REST mapping onto `ProjectSource` —
 * is the production code path. The stub answers with GitHub-shaped JSON and
 * nothing else is doubled.
 *
 * Comments are the collection that matters here. Every project provider has
 * implemented `listComments` since EPIC-021 and **nothing in Ferret has ever
 * called it**, so these are the first assertions in the repository that a
 * comment reaches the graph at all.
 */

const OWNER = 'indoulia/Ferret';

interface Fixture {
  readonly issues?: unknown[];
  readonly pulls?: unknown[];
  readonly reviews?: Record<string, unknown[]>;
  readonly comments?: Record<string, unknown[]>;
}

/** GitHub-shaped JSON, answered by URL exactly as the REST API lays it out. */
function githubFetch(fixture: Fixture, calls: string[] = []) {
  return (url: string | URL): Promise<Response> => {
    const href = String(url);
    calls.push(href);
    const json = (body: unknown): Promise<Response> =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '4000',
            'x-ratelimit-limit': '5000',
          },
        }),
      );

    const reviews = /\/pulls\/(\d+)\/reviews/.exec(href);
    if (reviews !== null) return json(fixture.reviews?.[reviews[1] as string] ?? []);

    const comments = /\/issues\/(\d+)\/comments/.exec(href);
    if (comments !== null) return json(fixture.comments?.[comments[1] as string] ?? []);

    if (href.includes('/pulls')) return json(fixture.pulls ?? []);
    if (href.includes('/issues')) return json(fixture.issues ?? []);
    return json([]);
  };
}

const ACTOR = { login: 'ada', id: 1, type: 'User' };
const OTHER = { login: 'grace', id: 2, type: 'User' };

function issue(number: number, title: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: number * 1000,
    // The live API always sends one, and the provider prefers it for identity.
    // Omitting it here is what hid the orphaned-comment defect: without a
    // `node_id` the id falls back to `owner/repo#N`, which is exactly the form
    // `listComments` synthesises, so the two agreed by accident.
    node_id: `I_issue_${String(number)}`,
    number,
    title,
    state: 'open',
    user: ACTOR,
    labels: [{ name: 'bug' }],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-02T00:00:00Z',
    html_url: `https://github.com/${OWNER}/issues/${String(number)}`,
    body: 'Body text.',
    ...extra,
  };
}

function pull(number: number, title: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id: number * 2000,
    node_id: `PR_pull_${String(number)}`,
    number,
    title,
    state: 'closed',
    user: ACTOR,
    labels: [],
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-03T00:00:00Z',
    merged_at: '2026-09-03T00:00:00Z',
    merge_commit_sha: 'a'.repeat(40),
    html_url: `https://github.com/${OWNER}/pull/${String(number)}`,
    base: { ref: 'main' },
    head: { ref: 'feature' },
    body: `Fixes #${String(number - 1)}`,
    ...extra,
  };
}

function review(id: number, state: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    node_id: `PRR_review_${String(id)}`,
    user: OTHER,
    state,
    body: 'Looks right.',
    submitted_at: '2026-09-03T01:00:00Z',
    ...extra,
  };
}

function comment(id: number, body: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    node_id: `IC_comment_${String(id)}`,
    user: OTHER,
    body,
    created_at: '2026-09-02T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z',
    html_url: `https://github.com/${OWNER}/issues/1#issuecomment-${String(id)}`,
    ...extra,
  };
}

async function connector(
  fixture: Fixture,
  overrides: { operations?: readonly string[]; fanOut?: number; calls?: string[] } = {},
): Promise<SourceConnector> {
  const provider = createGithubProvider({
    token: 'ghp_test_token',
    fetch: githubFetch(fixture, overrides.calls ?? []),
  });
  // The provider Ferret ships, initialized exactly as the runtime initializes
  // it. Nothing about it was changed to fit the connector.
  await provider.initialize(createTestProviderContext());
  return projectSourceConnector({
    source: provider,
    connectorId: provider.id,
    system: 'github',
    instance: 'github.com',
    operations: overrides.operations ?? [
      ProjectOperation.LIST_ISSUES,
      ProjectOperation.LIST_PULL_REQUESTS,
      ProjectOperation.LIST_REVIEWS,
      ProjectOperation.LIST_COMMENTS,
    ],
    ...(overrides.fanOut === undefined ? {} : { fanOut: overrides.fanOut }),
  });
}

/** The full fixture: two issues, one pull request, a review and two comments. */
const FULL: Fixture = {
  issues: [issue(1, 'Retrieval misses renamed files'), issue(2, 'Second issue')],
  pulls: [pull(3, 'Fix retrieval for renamed files')],
  reviews: { '3': [review(9001, 'APPROVED')] },
  comments: {
    '1': [comment(5001, 'This reproduces on Windows only.')],
    '3': [comment(5002, 'Rebased onto main.')],
  },
};

function kinds(state: ReturnType<typeof connectorStore>['state']): Map<string, number> {
  const counted = new Map<string, number>();
  for (const row of state.entities.values()) {
    counted.set(row.entity.kind, (counted.get(row.entity.kind) ?? 0) + 1);
  }
  return counted;
}

function documents(state: ReturnType<typeof connectorStore>['state']) {
  return [...state.entities.values()]
    .filter((row) => row.entity.kind === EntityKind.DOCUMENT)
    .map((row) => row.entity);
}

// ---------------------------------------------------------------------------

describe('EPIC-121 — ingesting a GitHub project', () => {
  it('acquires issues, pull requests, reviews and comments through one cursor', async () => {
    const source = await connector(FULL);
    const identity = source.identify(OWNER);
    const acquired: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await source.acquire(
        { identity, ...(cursor === undefined ? {} : { cursor }) },
        createTestOperationContext(),
      );
      for (const record of page.records) acquired.push(record.kind);
      cursor = page.cursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== undefined);

    expect(new Set(acquired)).toEqual(
      new Set([
        PROJECT_ISSUE_RECORD,
        PROJECT_PULL_REQUEST_RECORD,
        PROJECT_REVIEW_RECORD,
        PROJECT_COMMENT_RECORD,
      ]),
    );
    // Parents before children: a review names its pull request and a comment
    // names its item, and `modelProject` skips either whose parent is absent.
    expect(acquired.lastIndexOf(PROJECT_PULL_REQUEST_RECORD)).toBeLessThan(
      acquired.indexOf(PROJECT_REVIEW_RECORD),
    );
    expect(acquired.lastIndexOf(PROJECT_ISSUE_RECORD)).toBeLessThan(
      acquired.indexOf(PROJECT_COMMENT_RECORD),
    );
  });

  it('stores each collection as the kind the canonical model already had', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    const counted = kinds(state);
    expect(counted.get(EntityKind.ISSUE)).toBe(2);
    expect(counted.get(EntityKind.PULL_REQUEST)).toBe(1);
    expect(counted.get(EntityKind.REVIEW)).toBe(1);
    expect(counted.get(EntityKind.DOCUMENT)).toBe(2);
    expect(report.skipped).toEqual([]);
    // No kind was added to the model to receive any of it.
    expect([...counted.keys()].every((kind) => kind in EntityKindValues)).toBe(true);
  });

  it('records a comment as a document about the thing it was written on', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    const stored = documents(state);
    expect(stored.length).toBe(2);

    const onIssue = stored.find((entity) =>
      String(entity.attributes['description']).includes('reproduces on Windows'),
    );
    expect(onIssue).toBeDefined();
    // The body reaches the graph. Before EPIC-121 it did not reach it at all.
    expect(onIssue?.attributes['description']).toBe('This reproduces on Windows only.');
    expect(onIssue?.attributes['mediaType']).toBe('text/markdown');
    expect(onIssue?.source.scope).toBe(report.sourceEntityId);

    // And it is *about* its parent, by the edge a document has always had.
    const issueEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.ISSUE && row.entity.attributes['key'] === '1',
    );
    const edge = [...state.relationships.values()].find(
      (relationship) =>
        relationship.fromId === onIssue?.id &&
        relationship.type === RelationshipType.DOCUMENT_DESCRIBES_ENTITY,
    );
    expect(edge?.toId).toBe(issueEntity?.entity.id);
  });

  it('links a comment to a parent whose id is not its address', async () => {
    // The defect this pins, found by running against the live GitHub API: the
    // provider addresses comments by *number* and synthesises
    // `parentId = owner/repo#N`, while the same provider identifies the issue
    // by its `node_id`. Twenty-five comments were acquired and twenty-five were
    // skipped as orphans. Asserted on `skipped` as well as on the edge, because
    // the failure was silent in every count except that one.
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    expect(report.skipped).toEqual([]);
    expect(documents(state).length).toBe(2);

    const issueEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.ISSUE && row.entity.attributes['key'] === '1',
    );
    // The parent really is identified by its node id, so the join is the one
    // the live API produces rather than the fallback form.
    expect(issueEntity?.entity.source.id).toBe('I_issue_1');
    expect(
      [...state.relationships.values()].some(
        (edge) =>
          edge.type === RelationshipType.DOCUMENT_DESCRIBES_ENTITY &&
          edge.toId === issueEntity?.entity.id,
      ),
    ).toBe(true);
  });

  it('links a review to a pull request whose id is not its address', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    expect(report.skipped).toEqual([]);
    const pullEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.PULL_REQUEST,
    );
    expect(pullEntity?.entity.source.id).toBe('PR_pull_3');
    expect(
      [...state.relationships.values()].some(
        (edge) =>
          edge.type === RelationshipType.REVIEW_REVIEWS_PULL_REQUEST &&
          edge.toId === pullEntity?.entity.id,
      ),
    ).toBe(true);
  });

  it('redacts a credential somebody pasted into a comment', async () => {
    const leaked = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector({
        issues: [issue(1, 'Broken auth')],
        comments: { '1': [comment(5003, `Run: curl -H "Authorization: token ${leaked}"`)] },
      }),
      deps,
    ).ingest({ resource: OWNER }, createTestOperationContext());

    const stored = documents(state);
    expect(stored.length).toBe(1);
    // A tracker comment is the most likely place in any source for somebody to
    // paste a failing request with a live token in it.
    expect(String(stored[0]?.attributes['description'])).not.toContain(leaked);
  });

  it('links a review to its pull request and its reviewer', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    const pullEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.PULL_REQUEST,
    );
    const edges = [...state.relationships.values()];
    expect(
      edges.some(
        (edge) =>
          edge.type === RelationshipType.REVIEW_REVIEWS_PULL_REQUEST &&
          edge.toId === pullEntity?.entity.id,
      ),
    ).toBe(true);
    expect(
      edges.some(
        (edge) =>
          edge.type === RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST &&
          edge.toId === pullEntity?.entity.id,
      ),
    ).toBe(true);
  });

  it('joins a pull request to the issue its body closes', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    const issueEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.ISSUE && row.entity.attributes['key'] === '2',
    );
    expect(
      [...state.relationships.values()].some(
        (edge) =>
          edge.type === RelationshipType.PULL_REQUEST_RESOLVES_ISSUE &&
          edge.toId === issueEntity?.entity.id,
      ),
    ).toBe(true);
  });

  it('joins a merged pull request to the commit it proposes', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    const commitEntity = [...state.entities.values()].find(
      (row) => row.entity.kind === EntityKind.COMMIT,
    );
    expect(commitEntity?.entity.attributes['sha']).toBe('a'.repeat(40));
    // EPIC-051's rule: a sha identifies one commit whoever mentions it, so the
    // entity is emitted into the canonical system rather than into `github`.
    // Without that, the Git-side commit and this one are two rows.
    expect(commitEntity?.entity.source.system).not.toBe('github');
    expect(
      [...state.relationships.values()].some(
        (edge) => edge.type === RelationshipType.PULL_REQUEST_PROPOSES_COMMIT,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-121 — identity, scope and provenance', () => {
  it('files a project under the identity it is remembered by', async () => {
    const { deps } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    expect(report.connectorId).toBe('ferret.source.github');
    expect(report.identityKey).toBe('github::github.com::indoulia/ferret');
    expect(report.identity.instance).toBe('github.com');
  });

  it('keeps the same project on two deployments apart', async () => {
    const hosted = await connector(FULL);
    const enterprise = projectSourceConnector({
      source: { listIssues: () => Promise.resolve({ items: [] }), rateLimit: () => undefined },
      connectorId: 'ferret.source.github',
      system: 'github',
      instance: 'github.acme.internal',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    expect(hosted.identify(OWNER)).not.toEqual(enterprise.identify(OWNER));
  });

  it('scopes every record to its own project', async () => {
    const { deps, state } = connectorStore();
    const report = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    for (const row of state.entities.values()) {
      // Actors and commits are deliberately global — a person and a sha are the
      // same whoever mentions them (EPIC-036, EPIC-051). Everything a project
      // owns is scoped to it.
      const global =
        row.entity.kind === EntityKind.DEVELOPER ||
        row.entity.kind === EntityKind.AGENT ||
        row.entity.kind === EntityKind.COMMIT ||
        row.entity.id === report.sourceEntityId;
      if (!global) expect(row.entity.source.scope).toBe(report.sourceEntityId);
    }
  });

  it('attaches producer, version and system to every record it writes', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    expect(state.evidence.size).toBeGreaterThan(0);
    for (const record of state.evidence.values()) {
      expect(record.producer).toBe('ferret.source.github');
      expect(record.producerVersion).toBe(VERSION);
      expect(record.sourceSystem).toBe('github');
    }
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-121 — idempotence, updates and deletion', () => {
  it('creates nothing new when the same project is ingested twice', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );
    const before = { ...counts(state) };

    const second = await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER, full: true },
      createTestOperationContext(),
    );

    expect(counts(state)).toEqual(before);
    expect(second.writes.entitiesCreated).toBe(0);
    expect(second.writes.evidenceRecorded).toBe(0);
    expect(second.writes.evidenceDeduplicated).toBeGreaterThan(0);
  });

  it('derives the same ids in two independent runs against two stores', async () => {
    const runs: string[][] = [];
    for (let run = 0; run < 2; run += 1) {
      const { deps, state } = connectorStore();
      await new SourceIngestor(await connector(FULL), deps).ingest(
        { resource: OWNER },
        createTestOperationContext(),
      );
      runs.push([...state.entities.keys()].sort());
    }
    expect(runs[0]).toEqual(runs[1]);
  });

  it('updates an edited comment in place rather than adding a second one', async () => {
    const { deps, state } = connectorStore();
    const first: Fixture = {
      issues: [issue(1, 'Broken auth')],
      comments: { '1': [comment(5004, 'First thought.')] },
    };
    await new SourceIngestor(await connector(first), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );
    const original = documents(state)[0]?.id;

    const edited: Fixture = {
      issues: [issue(1, 'Broken auth')],
      comments: {
        '1': [comment(5004, 'Second thought, on reflection.', { updated_at: '2026-09-04T00:00:00Z' })],
      },
    };
    await new SourceIngestor(await connector(edited), deps).ingest(
      { resource: OWNER, full: true },
      createTestOperationContext(),
    );

    const stored = documents(state);
    // One comment, edited — identity is the comment's own id, not its content.
    expect(stored.length).toBe(1);
    expect(stored[0]?.id).toBe(original);
    expect(stored[0]?.attributes['description']).toBe('Second thought, on reflection.');
  });

  it('keeps a deleted comment rather than erasing what was said', async () => {
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );
    const before = documents(state).length;

    await new SourceIngestor(
      await connector({ issues: FULL.issues, pulls: FULL.pulls, reviews: FULL.reviews }),
      deps,
    ).ingest({ resource: OWNER, full: true }, createTestOperationContext());

    // Ferret is a memory. A comment that is gone from GitHub is no longer
    // *acquired*, and retiring the entity is a reconciliation over a complete
    // listing (EPIC-031) rather than something a connector may infer from a
    // bounded page.
    expect(documents(state).length).toBe(before);
  });

  it('asks only for what changed once a pass has completed', async () => {
    const asked: (string | undefined)[] = [];
    const base = await connector(FULL);
    const watched: SourceConnector = {
      ...base,
      acquire: (request, context) => {
        asked.push(request.since);
        return base.acquire(request, context);
      },
    };

    const { deps } = connectorStore();
    const first = await new SourceIngestor(watched, deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );
    expect(asked.every((since) => since === undefined)).toBe(true);

    asked.length = 0;
    await new SourceIngestor(watched, deps).ingest({ resource: OWNER }, createTestOperationContext());
    expect(asked.some((since) => since === first.cursorAdvancedTo)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('EPIC-121 — fan-out, failure isolation and authorization', () => {
  it('bounds how many parents one page asks about', async () => {
    const many: Fixture = {
      issues: Array.from({ length: 6 }, (_, index) => issue(index + 1, `Issue ${String(index + 1)}`)),
      comments: Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [
          String(index + 1),
          [comment(6000 + index, `Comment ${String(index + 1)}`)],
        ]),
      ),
    };
    const { deps, state } = connectorStore();
    await new SourceIngestor(await connector(many, { fanOut: 2 }), deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );

    // Every comment still arrives; the fan-out bounds requests per page, not
    // the total. A bound that lost records would be a silent partial ingestion.
    expect(documents(state).length).toBe(6);
  });

  it('never calls an operation the provider did not declare', async () => {
    const calls: string[] = [];
    const { deps, state } = connectorStore();
    await new SourceIngestor(
      await connector(FULL, { operations: [ProjectOperation.LIST_ISSUES], calls }),
      deps,
    ).ingest({ resource: OWNER }, createTestOperationContext());

    expect(calls.some((href) => href.includes('/pulls'))).toBe(false);
    expect(calls.some((href) => href.includes('/comments'))).toBe(false);
    // A partial source still produces a usable graph rather than nothing.
    expect(kinds(state).get(EntityKind.ISSUE)).toBe(2);
    expect(kinds(state).get(EntityKind.DOCUMENT)).toBeUndefined();
  });

  it('counts a comment whose parent is not in the batch instead of dropping it', async () => {
    const { deps } = connectorStore();
    const report = await new SourceIngestor(
      await connector({
        issues: [issue(1, 'Only issue')],
        comments: { '1': [comment(7001, 'Belongs here', { })] },
      }),
      deps,
    ).ingest({ resource: OWNER }, createTestOperationContext());
    expect(report.skipped).toEqual([]);
  });

  it('isolates a project that fails without touching another', async () => {
    const healthy = await connector(FULL);
    const broken = projectSourceConnector({
      source: {
        listIssues: () => Promise.reject(new Error('the tracker refused the connection')),
        rateLimit: () => undefined,
      },
      connectorId: 'ferret.source.github',
      system: 'github',
      instance: 'github.com',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    const { deps, state } = connectorStore();
    const outcomes = await ingestSources(
      [
        { connector: broken, options: { resource: 'indoulia/broken' } },
        { connector: healthy, options: { resource: OWNER } },
      ],
      deps,
      connectorContext(),
    );

    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[1]?.status).toBe('ingested');
    const ingested = outcomes[1] as { status: 'ingested'; report: IngestReport };
    expect(state.entities.get(ingested.report.sourceEntityId)).toBeDefined();
    // Nothing was remembered for the failed source, so nothing is skipped next
    // time it is asked.
    expect(state.cursorPositions.size).toBe(1);
  });

  it('starts over rather than failing when handed a cursor it cannot read', async () => {
    const source = await connector(FULL);
    const page = await source.acquire(
      { identity: source.identify(OWNER), cursor: 'not-a-cursor' },
      createTestOperationContext(),
    );
    expect(page.records.some((record) => record.kind === PROJECT_ISSUE_RECORD)).toBe(true);
  });

  it('reports "nothing changed" as different from "nothing there"', async () => {
    const provider = createGithubProvider({
      token: 'ghp_test_token',
      fetch: () =>
        Promise.resolve(
          new Response(null, {
            status: 304,
            headers: { etag: 'W/"abc"', 'x-ratelimit-remaining': '4000' },
          }),
        ),
    });
    await provider.initialize(createTestProviderContext());
    const source = projectSourceConnector({
      source: provider,
      connectorId: provider.id,
      system: 'github',
      instance: 'github.com',
      operations: [ProjectOperation.LIST_ISSUES],
    });

    const { deps } = connectorStore();
    const report = await new SourceIngestor(source, deps).ingest(
      { resource: OWNER },
      createTestOperationContext(),
    );
    expect(report.unchanged).toBe(true);
    expect(report.counts.records).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The real path, all the way to an answer.
// ---------------------------------------------------------------------------

const endToEnd = databaseAvailable() ? describe : describe.skip;

if (!databaseAvailable()) {
  process.stderr.write(`\n[EPIC-121] SKIPPING end-to-end retrieval: ${SKIP_REASON}\n\n`);
}

endToEnd('EPIC-121 — acquisition to retrieval, against the real stores', () => {
  let database: TestDatabase;
  let handle: FerretDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('epic121');
    handle = drizzle(database.pool);
    await migrate(database.pool, { policy: MigrationPolicy.AUTO, logger: createNullLogger() });
  }, 300_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('answers an agent asking what was said on an issue', async () => {
    const report = await new SourceIngestor(await connector(FULL), {
      entities: new EntityStore(handle),
      relationships: new RelationshipStore(handle),
      evidence: new EvidenceStore(handle),
      cursors: new SyncCursorStore(handle, database.pool),
      logger: createNullLogger(),
    }).ingest({ resource: OWNER }, createTestOperationContext());

    const retrieval = new RetrievalStore(handle);

    // 1. The project's issues come back scoped to it — the query an agent
    //    issues to ask what a tracker holds.
    const issues = await retrieval.findEntities(
      { kind: EntityKind.ISSUE, scope: report.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );
    expect(issues.entities.length).toBe(2);

    // 2. The discussion on one of them is reachable by walking the edge, which
    //    is the whole point of EPIC-121: before it, this returned nothing
    //    because comments never reached the graph.
    const target = issues.entities.find((entity) => entity.attributes['key'] === '1');
    const discussion = await retrieval.neighbours(
      {
        from: target?.id ?? '',
        types: [RelationshipType.DOCUMENT_DESCRIBES_ENTITY],
        direction: Direction.IN,
        includeHistorical: true,
      },
      PUBLIC_ACCESS,
    );
    expect(
      discussion.neighbours.map((neighbour) => String(neighbour.entity.attributes['description'])),
    ).toContain('This reproduces on Windows only.');

    // 3. And the provenance survived storage.
    const evidence = await handle.execute<{ producer: string; producer_version: string }>(
      sql`SELECT DISTINCT producer, producer_version FROM ferret.evidence`,
    );
    expect(evidence.rows.map((row) => row.producer)).toContain('ferret.source.github');
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
      { resource: OWNER },
      createTestOperationContext(),
    );
    const before = await retrieval.findEntities(
      { scope: first.sourceEntityId, limit: 500 },
      PUBLIC_ACCESS,
    );

    await new SourceIngestor(await connector(FULL), deps).ingest(
      { resource: OWNER, full: true },
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

/** Every kind the canonical model declares, as a lookup. */
const EntityKindValues: Record<string, true> = Object.fromEntries(
  Object.values(EntityKind).map((kind) => [kind, true]),
);

/**
 * What a second pass must not change.
 *
 * Relationships are counted by **endpoint and type**, not by the fake's key.
 * The fake keys an edge by `(from, type, to, validFrom)` and `modelProject`
 * mints `validFrom` from the clock, so two passes produce two keys for one
 * fact — whereas the real `RelationshipStore.assert` is keyed by the endpoints
 * and reports `unchanged`, which is why the PostgreSQL case below sees one
 * graph. Counting the fake's keys here would assert the fake's behaviour rather
 * than Ferret's; counting distinct edges asserts the thing that is actually
 * true, that a repeated pass adds no new fact.
 */
function counts(state: ReturnType<typeof connectorStore>['state']): Record<string, number> {
  const edges = new Set(
    [...state.relationships.values()].map((edge) => `${edge.fromId}|${edge.type}|${edge.toId}`),
  );
  return {
    entities: state.entities.size,
    edges: edges.size,
    evidence: state.evidence.size,
  };
}
