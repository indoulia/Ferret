import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityKind, RelationshipType, canonicalKey, createNullLogger } from '../../../src/index.js';
import { ProjectSynchronizer } from '../../../src/project/index.js';
import { ProjectItemState, ProjectOperation } from '../../../src/providers/contracts/source-project.js';
import type {
  ProjectIssue,
  ProjectPage,
  ProjectPullRequest,
  ProjectQuery,
  ProjectRateLimit,
  ProjectReview,
  ProjectSource,
} from '../../../src/providers/contracts/source-project.js';
import {
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  SyncCursorStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { SKIP_REASON, createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';

/**
 * EPIC-113, against the database rather than against fakes.
 *
 * `project-sync.test.ts` under `tests/unit` asserts what the pass *decides*.
 * What a unit test cannot assert is that a synchronized graph survives
 * PostgreSQL's own constraints — the foreign key a relationship's endpoint
 * needs, the uniqueness a re-run meets, and the supersession D-113.3 relies on,
 * none of which the domain enforces.
 *
 * The tracker is a fake and the stores are real. That is the correct division:
 * the GitHub and Jira clients are exhaustively covered by their own suites, and
 * a live tracker in a test is a flake with a rate limit attached.
 */

const describeDb = databaseAvailable() ? describe : describe.skip;

const OPERATIONS = [
  ProjectOperation.LIST_ISSUES,
  ProjectOperation.LIST_PULL_REQUESTS,
  ProjectOperation.LIST_REVIEWS,
];

/** A tracker whose answers a test rewrites between passes. */
class ScriptedSource implements ProjectSource {
  issues: ProjectIssue[] = [];
  pulls: ProjectPullRequest[] = [];
  reviews: ProjectReview[] = [];
  readonly asked: ProjectQuery[] = [];

  listIssues(query: ProjectQuery): Promise<ProjectPage<ProjectIssue>> {
    this.asked.push(query);
    return Promise.resolve({ items: this.issues });
  }

  listPullRequests(query: ProjectQuery): Promise<ProjectPage<ProjectPullRequest>> {
    this.asked.push(query);
    return Promise.resolve({ items: this.pulls });
  }

  listReviews(): Promise<ProjectPage<ProjectReview>> {
    return Promise.resolve({ items: this.reviews });
  }

  rateLimit(): ProjectRateLimit | undefined {
    return undefined;
  }
}

describeDb(`ferret sync, stored (${databaseAvailable() ? 'real PostgreSQL' : SKIP_REASON})`, () => {
  let db: TestDatabase;
  let handle: FerretDatabase;
  let source: ScriptedSource;
  let synchronizer: ProjectSynchronizer;
  let entities: EntityStore;
  let evidence: EvidenceStore;
  let relationships: RelationshipStore;

  const context = { logger: createNullLogger(), signal: new AbortController().signal };

  beforeAll(async () => {
    db = await createTestDatabase('project-sync');
    await migrate(db.pool, { logger: createNullLogger() });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    evidence = new EvidenceStore(handle);
    relationships = new RelationshipStore(handle);
    source = new ScriptedSource();
    synchronizer = new ProjectSynchronizer({
      source,
      providerId: 'ferret.source.github',
      sourceSystem: 'github',
      operations: OPERATIONS,
      entities,
      relationships,
      evidence,
      cursors: new SyncCursorStore(handle, db.pool),
    });
  }, 180_000);

  afterAll(async () => {
    await db?.drop();
  });

  const project = 'o/sync';

  /**
   * The identity a record was stored under.
   *
   * Derived rather than remembered, and scoped to the repository the pass
   * scopes to: a project record's identity is *within* its repository — §8.1 —
   * so a key without the scope names nothing.
   */
  const keyFor = (kind: string, sourceId: string): string =>
    canonicalKey({
      kind,
      sourceSystem: 'github',
      scope: synchronizer.repositoryIdFor(project),
      sourceId,
    });

  it('stores the whole graph a pass produced — AC-8', async () => {
    source.issues = [
      {
        id: 'I_1',
        number: 1,
        title: 'The symlink refusal is too broad',
        state: 'open',
        lifecycle: ProjectItemState.OPEN,
        author: { identity: 'U_a', login: 'octocat' },
        labels: ['bug'],
      },
    ];
    source.pulls = [
      {
        id: 'PR_1',
        number: 9,
        title: 'Narrow the symlink refusal',
        body: 'Fixes #1',
        state: 'open',
        lifecycle: ProjectItemState.OPEN,
        targetBranch: 'main',
        author: { identity: 'U_b', login: 'ada' },
        labels: [],
      },
    ];
    source.reviews = [
      { id: 'RV_1', pullRequestId: 'PR_1', state: 'APPROVED', approved: true, reviewer: { identity: 'U_c' } },
    ];

    const report = await synchronizer.sync({ project }, context);

    expect(report.skipped).toStrictEqual([]);
    expect(report.counts).toStrictEqual({ issues: 1, pullRequests: 1, reviews: 1 });
    expect(report.writes.entitiesCreated).toBeGreaterThan(0);

    // The repository the records were scoped to exists, which is what the
    // relationship foreign key needs and what a modelling pass with no
    // placeholder writer produces a `23503` for.
    const repository = await entities.get(report.repositoryId);
    expect(repository?.kind).toBe(EntityKind.REPOSITORY);

    // Read back from the database rather than from the report: the claim is
    // that the rows are there, not that the pass counted them.
    const stored = await entities.getByCanonicalKey(keyFor(EntityKind.ISSUE, 'I_1'));
    expect(stored?.attributes['title']).toBe('The symlink refusal is too broad');

    // The graph is whole, asserted from the pull request: it is the record that
    // participates in every edge kind this pass can produce.
    //
    // The issue it resolves is a *different* entity from the tracker's `I_1`,
    // and deliberately: a body says "Fixes #1", which names a number in a
    // project rather than the provider's stable id, so EPIC-072 emits the
    // reference as its own placeholder and EPIC-051 reconciles the two. A test
    // that asserted one edge from the pull request to `I_1` would be asserting
    // a resolution this Epic does not perform.
    const pullEntity = await entities.getByCanonicalKey(keyFor(EntityKind.PULL_REQUEST, 'PR_1'));
    const neighbours = await relationships.neighbours(pullEntity?.id ?? '');
    expect([...new Set(neighbours.map((edge) => edge.type))].sort()).toStrictEqual(
      [
        RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST,
        RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
        RelationshipType.PULL_REQUEST_TARGETS_BRANCH,
        RelationshipType.REVIEW_REVIEWS_PULL_REQUEST,
      ].sort(),
    );
  }, 60_000);

  it('advances a cursor a later pass reads back — AC-2', async () => {
    const cursors = new SyncCursorStore(handle, db.pool);
    const repositoryId = synchronizer.repositoryIdFor(project);

    const stored = await cursors.read(repositoryId);
    expect(stored?.producer).toBe('ferret.sync');
    expect(typeof stored?.position['syncedAt']).toBe('string');

    source.asked.length = 0;
    await synchronizer.sync({ project }, context);
    expect(source.asked[0]?.since).toBe(stored?.position['syncedAt']);
  }, 60_000);

  it('writes one row for the same input twice — EPIC-080, AC-9', async () => {
    const before = await count(db, 'entity');
    const report = await synchronizer.sync({ project, full: true }, context);
    const after = await count(db, 'entity');

    expect(after).toBe(before);
    expect(report.writes.entitiesCreated).toBe(0);
    // Every observation was already on record, so nothing new was written and
    // the deduplication is reported rather than looking like a fresh insert.
    expect(report.writes.evidenceRecorded).toBe(0);
    expect(report.writes.evidenceDeduplicated).toBeGreaterThan(0);
  }, 60_000);

  it('supersedes a remote edit without losing what it replaced — D-113.3, AC-10', async () => {
    const issueId = (await entities.getByCanonicalKey(keyFor(EntityKind.ISSUE, 'I_1')))?.id;
    expect(issueId).toBeDefined();

    const before = await evidence.forSubjectWithState(issueId ?? '');
    const openReading = before.find((one) => one.evidence.field === 'attributes.state');
    expect(openReading?.state).toBe('current');
    expect(openReading?.evidence.statement).toBe('open');

    // The tracker's own edit: the issue was closed. A *different* input for the
    // same remote object, which is exactly the case EPIC-080's idempotence does
    // not cover.
    source.issues = [{ ...(source.issues[0] as ProjectIssue), state: 'closed', lifecycle: ProjectItemState.CLOSED }];

    const report = await synchronizer.sync({ project, full: true }, context);
    expect(report.writes.evidenceRecorded).toBeGreaterThan(0);

    const after = await evidence.forSubjectWithState(issueId ?? '');
    const readings = after.filter((one) => one.evidence.field === 'attributes.state');

    // Both readings are still there. The old one is `superseded` and points at
    // the new one, so "what did this ticket say when we decided X" stays
    // answerable — which is the whole reason D-113.3 chose this model.
    expect(readings.map((one) => one.evidence.statement).sort()).toStrictEqual(['closed', 'open']);
    const previous = readings.find((one) => one.evidence.statement === 'open');
    const current = readings.find((one) => one.evidence.statement === 'closed');
    expect(previous?.state).toBe('superseded');
    expect(previous?.supersededBy).toBe(current?.evidence.id);
    expect(current?.state).toBe('current');

    // And the entity itself carries the new state, because an upsert of changed
    // attributes is an update rather than a second row.
    const updated = await entities.get(issueId ?? '');
    expect(updated?.attributes['state']).toBe('closed');
  }, 60_000);

  it('leaves a record the tracker did not return alone — D-113.3', async () => {
    const pullId = (await entities.getByCanonicalKey(keyFor(EntityKind.PULL_REQUEST, 'PR_1')))?.id;
    const before = await entities.get(pullId ?? '');
    expect(before).toBeDefined();

    // A pass that reads only issues must not retire, tombstone or rewrite the
    // pull request it did not look at. EPIC-032's rule — deletion is observed,
    // never inferred — applied to a narrowed sync.
    source.pulls = [];
    await synchronizer.sync({ project, full: true, withPullRequests: false }, context);

    const after = await entities.get(pullId ?? '');
    expect(after?.lifecycle).toBe(before?.lifecycle);
    expect(after?.attributes['title']).toBe(before?.attributes['title']);
  }, 60_000);
});

async function count(db: TestDatabase, table: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ferret.${table}`);
  return Number(rows[0]?.n ?? '0');
}
