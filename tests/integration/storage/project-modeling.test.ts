import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EntityKind,
  RelationshipType,
  canonicalId,
  canonicalKey,
  createNullLogger,
} from '../../../src/index.js';
import { modelProject } from '../../../src/project/index.js';
import { Emitter } from '../../../src/providers/sdk/emit.js';
import { ProjectItemState } from '../../../src/providers/contracts/source-project.js';
import {
  EntityStore,
  EvidenceStore,
  RelationshipStore,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../../support/postgres.js';
import type {
  CanonicalEntity,
  CanonicalEvidence,
  CanonicalRelationship,
} from '../../../src/index.js';
import type { ProjectPullRequest, ProjectReview } from '../../../src/providers/contracts/source-project.js';

/**
 * EPIC-072 AC-18, against the database rather than against the domain.
 *
 * `createRelationship` validates endpoint kinds and the unit suite asserts
 * that. What a unit test cannot assert is that the rows survive PostgreSQL's
 * own constraints — "the domain accepted it" has never been the same claim as
 * "it stored".
 */

const describeDb = databaseAvailable() ? describe : describe.skip;
const logger = createNullLogger();

/**
 * A canonical record, as its store's input.
 *
 * The indexer does this conversion too, privately. Repeating it here rather
 * than exporting the indexer's helper is deliberate: this test is asserting
 * that the *records* store, and borrowing the production converter would let a
 * defect in the converter hide the thing under test.
 */
function entityInput(entity: CanonicalEntity) {
  return {
    kind: entity.kind,
    source: { ...entity.source },
    lifecycle: entity.lifecycle,
    attributes: { ...entity.attributes },
    unknownFields: { ...entity.unknownFields },
    externalIds: entity.externalIds.map((one) => ({ ...one })),
    ...(entity.sourceObservedAt === undefined ? {} : { sourceObservedAt: entity.sourceObservedAt }),
  };
}

function relationshipInput(edge: CanonicalRelationship) {
  return {
    fromId: edge.fromId,
    type: edge.type,
    toId: edge.toId,
    validFrom: edge.validFrom,
    ...(edge.validTo === null || edge.validTo === undefined ? {} : { validTo: edge.validTo }),
    metadata: { ...edge.metadata },
    sourceSystem: edge.sourceSystem,
    ...(edge.sourceId === undefined ? {} : { sourceId: edge.sourceId }),
  };
}

function evidenceInput(record: CanonicalEvidence) {
  return {
    subjectId: record.subjectId,
    ...(record.field === undefined ? {} : { field: record.field }),
    statement: record.statement,
    method: record.method,
    producer: record.producer,
    producerVersion: record.producerVersion,
    sourceSystem: record.sourceSystem,
    ...(record.sourceId === undefined ? {} : { sourceId: record.sourceId }),
    ...(record.sourceUrl === undefined ? {} : { sourceUrl: record.sourceUrl }),
    ...(record.locator === undefined ? {} : { locator: { ...record.locator } }),
    ...(record.sourceContentHash === undefined
      ? {}
      : { sourceContentHash: record.sourceContentHash }),
    ...(record.derivedFrom.length === 0 ? {} : { derivedFrom: [...record.derivedFrom] }),
  };
}

function emitter(): Emitter {
  return new Emitter({
    sourceSystem: 'github',
    producer: 'ferret.source.github',
    producerVersion: '1.0.0',
    systemOfRecord: true,
  });
}

describeDb('project modelling, stored — EPIC-072 AC-18', () => {
  let db: TestDatabase;
  let handle: FerretDatabase;
  let entities: EntityStore;
  let relationships: RelationshipStore;
  let evidence: EvidenceStore;

  beforeAll(async () => {
    db = await createTestDatabase('project-modeling');
    await migrate(db.pool, { logger });
    handle = drizzle(db.pool);
    entities = new EntityStore(handle);
    relationships = new RelationshipStore(handle);
    evidence = new EvidenceStore(handle);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  });

  const repositoryId = canonicalId(
    canonicalKey({ kind: EntityKind.REPOSITORY, sourceSystem: 'github', sourceId: 'o/r' }),
  );

  const pull: ProjectPullRequest = {
    id: 'PR_stored',
    number: 12,
    title: 'Fix the symlink refusal',
    body: 'Fixes #7',
    state: 'closed',
    lifecycle: ProjectItemState.MERGED,
    mergeCommit: 'b'.repeat(40),
    mergedAt: '2026-02-01T00:00:00.000Z',
    targetBranch: 'main',
    author: { identity: 'U_stored', login: 'octocat' },
    labels: [],
  };

  const review: ProjectReview = {
    id: 'R_stored',
    pullRequestId: 'PR_stored',
    state: 'APPROVED',
    approved: true,
    reviewer: { identity: 'U_reviewer', login: 'ada' },
  };

  it('stores every record it produced, and the graph is whole', async () => {
    const result = modelProject(
      { repositoryId, project: 'o/r', pullRequests: [pull], reviews: [review] },
      emitter(),
    );
    expect(result.skipped).toStrictEqual([]);

    // Placeholders with `ifAbsent`, exactly as the indexer does: a stub emitted
    // only so an edge has an endpoint must not overwrite a record an earlier
    // run read in full. Without the stubs at all, this insert is a `23503` —
    // which is how §8.10 was found.
    const placeholders = new Set(result.placeholderEntityIds);
    for (const entity of result.entities) {
      await entities.upsert(
        entityInput(entity),
        undefined,
        placeholders.has(entity.id) ? { ifAbsent: true } : {},
      );
    }
    for (const edge of result.relationships) await relationships.assert(relationshipInput(edge));
    for (const record of result.evidence) await evidence.record(evidenceInput(record));

    const pullEntity = result.entities.find((one) => one.kind === EntityKind.PULL_REQUEST);
    const stored = await entities.get(pullEntity?.id ?? '');
    expect(stored?.attributes['number']).toBe('12');
    expect(stored?.attributes['state']).toBe('merged');

    // Every edge the pull request participates in, read back from the database
    // rather than from the modelling result.
    const neighbours = await relationships.neighbours(pullEntity?.id ?? '');
    expect([...new Set(neighbours.map((edge) => edge.type))].sort()).toStrictEqual(
      [
        RelationshipType.PULL_REQUEST_PROPOSES_COMMIT,
        RelationshipType.PULL_REQUEST_RESOLVES_ISSUE,
        RelationshipType.PULL_REQUEST_TARGETS_BRANCH,
        RelationshipType.REVIEW_REVIEWS_PULL_REQUEST,
        RelationshipType.DEVELOPER_REVIEWED_PULL_REQUEST,
      ].sort(),
    );
  }, 60_000);

  it('stores a release, its commits and a deployment — EPIC-073 AC-15', async () => {
    const { modelReleases } = await import('../../../src/project/index.js');
    const parents = new Map<string, readonly string[]>([
      ['e'.repeat(40), []],
      ['f'.repeat(40), ['e'.repeat(40)]],
    ]);
    const result = modelReleases(
      {
        repositoryId,
        releases: [
          { id: 'RE_v1', tag: 'v1.0.0', publishedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'RE_v2', tag: 'v2.0.0', publishedAt: '2026-02-01T00:00:00.000Z' },
        ],
        deployments: [
          { id: 'DE_1', ref: 'v2.0.0', environment: 'production', createdAt: '2026-02-02T00:00:00.000Z' },
        ],
        deploymentStatuses: [
          {
            id: 'DS_1',
            deploymentId: 'DE_1',
            state: 'success',
            lifecycle: 'succeeded',
            createdAt: '2026-02-02T00:10:00.000Z',
          },
        ],
        tagCommits: new Map([
          ['v1.0.0', 'e'.repeat(40)],
          ['v2.0.0', 'f'.repeat(40)],
        ]),
        commitParents: parents,
      },
      emitter(),
    );
    expect(result.skipped).toStrictEqual([]);

    const placeholders = new Set(result.placeholderEntityIds);
    for (const entity of result.entities) {
      await entities.upsert(
        entityInput(entity),
        undefined,
        placeholders.has(entity.id) ? { ifAbsent: true } : {},
      );
    }
    for (const edge of result.relationships) await relationships.assert(relationshipInput(edge));
    for (const record of result.evidence) await evidence.record(evidenceInput(record));

    const deployment = result.entities.find((one) => one.kind === EntityKind.DEPLOYMENT);
    const stored = await entities.get(deployment?.id ?? '');
    expect(stored?.attributes['state']).toBe('succeeded');
    expect(stored?.attributes['environment']).toBe('production');

    const neighbours = await relationships.neighbours(deployment?.id ?? '');
    expect(neighbours.map((edge) => edge.type)).toContain(
      RelationshipType.DEPLOYMENT_DEPLOYS_RELEASE,
    );

    const second = result.entities.find(
      (one) => one.kind === EntityKind.RELEASE && one.attributes['tag'] === 'v2.0.0',
    );
    const includes = await relationships.neighbours(second?.id ?? '');
    expect(includes.filter((edge) => edge.type === RelationshipType.RELEASE_INCLUDES_COMMIT)).toHaveLength(1);
  }, 60_000);

  it('is idempotent: a second pass writes no new entity', async () => {
    // EPIC-080's property over this Epic's records. Ids are content-derived —
    // §8.1 — so a second pass must land on the same rows.
    const again = modelProject(
      { repositoryId, project: 'o/r', pullRequests: [pull], reviews: [review] },
      emitter(),
    );

    const placeholders = new Set(again.placeholderEntityIds);
    const outcomes: string[] = [];
    for (const entity of again.entities) {
      const result = await entities.upsert(
        entityInput(entity),
        undefined,
        placeholders.has(entity.id) ? { ifAbsent: true } : {},
      );
      outcomes.push(result.outcome);
    }
    // Nothing created: every id already existed from the first pass.
    expect(outcomes.filter((outcome) => outcome === 'created')).toStrictEqual([]);
  }, 60_000);
});
