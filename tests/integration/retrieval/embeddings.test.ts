import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { drizzle } from 'drizzle-orm/node-postgres';

import { createNullLogger, type EmbeddingModel, type EmbeddingSource } from '../../../src/index.js';
import {
  EmbeddingStore,
  EntityStore,
  MigrationPolicy,
  SemanticRetrieval,
  migrate,
  type FerretDatabase,
} from '../../../src/storage/index.js';
import { assertUsable } from '../../../src/providers/index.js';
import { createTestOperationContext } from '../../../src/providers/sdk/testing.js';
import {
  SKIP_REASON,
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '../../support/postgres.js';

/**
 * EPIC-054 against real pgvector.
 *
 * **The provider below is not semantic, and nothing here claims it is.** It maps
 * text to a fixed vector by lookup, which is enough to prove the *plumbing* —
 * that vectors are stored, retrieved in distance order, bounded, kept apart by
 * model, and rejected when malformed — and proves nothing whatever about
 * relevance. Ferret ships no embedding provider by decision
 * (`TECHNOLOGY-DECISIONS.md` §6), and a hash-based stand-in that looked like one
 * would make semantic search appear to work while returning noise.
 *
 * Any evidence drawn from these tests has to say the same thing.
 */

const runnable = databaseAvailable();
const describeVectors = runnable ? describe : describe.skip;

if (!runnable) {
  process.stderr.write(`\n[EPIC-054] SKIPPING vector storage: ${SKIP_REASON}.\n\n`);
}

const MODEL: EmbeddingModel = {
  id: 'test.fixed',
  version: '1',
  dimensions: 3,
  metric: 'cosine',
};

/** Vectors chosen by hand so the distances between them are obvious. */
const VECTORS: Record<string, readonly number[]> = {
  north: [1, 0, 0],
  nearNorth: [0.99, 0.14, 0],
  east: [0, 1, 0],
  south: [-1, 0, 0],
};

class FixedProvider implements EmbeddingSource {
  failNext = false;
  wrongCount = false;

  describeModel(): Promise<EmbeddingModel> {
    return Promise.resolve(MODEL);
  }

  embed(request: { texts: readonly string[] }): Promise<{
    model: EmbeddingModel;
    vectors: readonly (readonly number[])[];
  }> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('the embedding service is unreachable'));
    }
    const vectors = request.texts.map((text) => VECTORS[text] ?? [0, 0, 1]);
    return Promise.resolve({
      model: MODEL,
      vectors: this.wrongCount ? vectors.slice(1) : vectors,
    });
  }
}

let database: TestDatabase;
let handle: FerretDatabase;
let store: EmbeddingStore;
let entities: EntityStore;

beforeAll(async () => {
  if (!runnable) return;
  database = await createTestDatabase('epic054');

  // pgvector is optional by EPIC-002's decision, and the migration skips the
  // embedding table when the extension is absent. Creating it here is what makes
  // this suite about vectors rather than about privileges.
  //
  // A failure is loud rather than a silent skip: the documented test environment
  // is `pgvector/pgvector:pg17`, so not having it means the environment is wrong,
  // and a suite that quietly passed would report success for a build in which
  // none of this ran.
  await database.pool.query('CREATE EXTENSION IF NOT EXISTS vector');

  handle = drizzle(database.pool);
  await migrate(database.pool, { logger: createNullLogger(), policy: MigrationPolicy.AUTO });
  store = new EmbeddingStore(handle);
  entities = new EntityStore(handle);
}, 120_000);

afterAll(async () => {
  if (!runnable) return;
  await database.drop();
});

/** An indexed entity to hang a vector on. */
async function subject(name: string): Promise<string> {
  const result = await entities.upsert({
    kind: 'file',
    source: { system: 'git', id: `vectors/${name}.txt` },
    attributes: { path: `vectors/${name}.txt` },
  });
  return result.entity.id;
}

describeVectors('storing and querying vectors', () => {
  it('returns neighbours in distance order', async () => {
    const north = await subject('north');
    const nearNorth = await subject('near-north');
    const east = await subject('east');

    await store.record(MODEL, [
      { subjectId: north, subjectKind: 'entity', sourceContentHash: 'h1', vector: VECTORS['north']! },
      { subjectId: nearNorth, subjectKind: 'entity', sourceContentHash: 'h2', vector: VECTORS['nearNorth']! },
      { subjectId: east, subjectKind: 'entity', sourceContentHash: 'h3', vector: VECTORS['east']! },
    ]);

    const hits = await store.nearest(MODEL, VECTORS['north']!, { limit: 3 });
    expect(hits.map((h) => h.entity.id)).toStrictEqual([north, nearNorth, east]);
    // Higher is better, matching every other score Ferret returns.
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
  });

  it('excludes vectors beyond the distance bound', async () => {
    const south = await subject('south');
    await store.record(MODEL, [
      { subjectId: south, subjectKind: 'entity', sourceContentHash: 'h4', vector: VECTORS['south']! },
    ]);

    // Cosine distance above 1 means the vectors point away from each other.
    // Returning those is returning things the model considered unrelated, and
    // they would arrive ranked, implying a relevance never found.
    const hits = await store.nearest(MODEL, VECTORS['north']!, { limit: 10, maxDistance: 1 });
    expect(hits.map((h) => h.entity.id)).not.toContain(south);

    const unbounded = await store.nearest(MODEL, VECTORS['north']!, { limit: 10, maxDistance: 2 });
    expect(unbounded.map((h) => h.entity.id)).toContain(south);
  });

  it('replaces rather than accumulating when a subject is re-embedded', async () => {
    // An embedding is a derived artefact of one text under one model, not an
    // observation with a validity period. Two of them for the same pair is a
    // duplicate; without this a nightly run multiplies the table by the number
    // of nights.
    const id = await subject('replaced');
    const before = await store.count(MODEL);

    await store.record(MODEL, [
      { subjectId: id, subjectKind: 'entity', sourceContentHash: 'v1', vector: [1, 0, 0] },
    ]);
    await store.record(MODEL, [
      { subjectId: id, subjectKind: 'entity', sourceContentHash: 'v2', vector: [0, 1, 0] },
    ]);

    expect(await store.count(MODEL)).toBe(before + 1);
  });

  it('never compares vectors from different models', async () => {
    // The distance between vectors from two models is arithmetic without
    // meaning, and it looks exactly like a real distance: small, orderable,
    // plausible.
    const other: EmbeddingModel = { ...MODEL, id: 'test.other', version: '1' };
    const id = await subject('other-model');
    await store.record(other, [
      { subjectId: id, subjectKind: 'entity', sourceContentHash: 'h5', vector: [1, 0, 0] },
    ]);

    const hits = await store.nearest(MODEL, [1, 0, 0], { limit: 50 });
    expect(hits.map((h) => h.entity.id)).not.toContain(id);

    const own = await store.nearest(other, [1, 0, 0], { limit: 50 });
    expect(own.map((h) => h.entity.id)).toContain(id);
  });

  it('refuses a vector of the wrong dimension, at both ends', async () => {
    const id = await subject('wrong-dimension');

    await expect(
      store.record(MODEL, [
        { subjectId: id, subjectKind: 'entity', sourceContentHash: 'h', vector: [1, 0] },
      ]),
    ).rejects.toThrow(/dimensions/);

    await expect(store.nearest(MODEL, [1, 0])).rejects.toThrow(/meaningless/);
  });

  it('refuses a vector containing a value that is not finite', async () => {
    // One NaN makes every distance involving the vector NaN, and NaN sorts
    // unpredictably — it would not merely be wrong, it would quietly disorder
    // results it appears in.
    const id = await subject('not-finite');
    await expect(
      store.record(MODEL, [
        { subjectId: id, subjectKind: 'entity', sourceContentHash: 'h', vector: [1, Number.NaN, 0] },
      ]),
    ).rejects.toThrow(/finite/);
  });

  it('forgets a model that is no longer in use', async () => {
    const retired: EmbeddingModel = { ...MODEL, id: 'test.retired' };
    const id = await subject('retired');
    await store.record(retired, [
      { subjectId: id, subjectKind: 'entity', sourceContentHash: 'h', vector: [1, 0, 0] },
    ]);

    expect(await store.forget(retired)).toBe(1);
    expect(await store.count(retired)).toBe(0);
  });
});

describeVectors('the semantic strategy', () => {
  const context = createTestOperationContext();

  it('reports unavailability rather than emptiness when no provider exists', async () => {
    const semantic = new SemanticRetrieval({ store, context });

    const reason = await semantic.unavailableReason();
    expect(reason).toContain('No embedding provider is registered');
    // `undefined`, not `[]`. An empty array says "nothing is similar", which is
    // an answer; this is "nobody looked", which is not.
    expect(await semantic.nearest('anything', 5)).toBeUndefined();
  });

  it('reports a provider whose model has embedded nothing yet', async () => {
    const empty = new EmbeddingStore(handle);
    const unusedModel: EmbeddingSource = {
      describeModel: () => Promise.resolve({ ...MODEL, id: 'test.unused' }),
      embed: () => Promise.resolve({ model: MODEL, vectors: [[1, 0, 0]] }),
    };

    const semantic = new SemanticRetrieval({ store: empty, source: unusedModel, context });
    // Not broken — never run over this index. Saying so points at the fix
    // rather than leaving a caller to conclude the repository holds nothing.
    expect(await semantic.unavailableReason()).toContain('has been embedded');
  });

  it('answers through the provider when one is registered', async () => {
    const provider = new FixedProvider();
    const semantic = new SemanticRetrieval({ store, source: provider, context });

    expect(await semantic.unavailableReason()).toBeUndefined();

    const hits = await semantic.nearest('north', 3);
    expect(hits).toBeDefined();
    expect(hits!.length).toBeGreaterThan(0);
    // Proves the plumbing — that a question reaches the provider, its vector
    // reaches the store, and entities come back in distance order. It proves
    // nothing about relevance: this provider has no notion of meaning.
    expect(hits![0]!.entity.attributes['path']).toBe('vectors/north.txt');
  });

  it('does not swallow a provider failure', async () => {
    const provider = new FixedProvider();
    provider.failNext = true;
    const semantic = new SemanticRetrieval({ store, source: provider, context });

    // The planner turns this into a recorded skip. The strategy's job is to be
    // honest about it, not to decide what happens next.
    await expect(semantic.nearest('north', 3)).rejects.toThrow(/unreachable/);
  });
});

describe('checking what a provider returned', () => {
  it('refuses a response with the wrong number of vectors', () => {
    // Worse than a wrong length: it misaligns vectors with their subjects, and
    // every subsequent answer is confidently about the wrong thing.
    expect(() =>
      assertUsable(
        { texts: ['a', 'b'], purpose: 'document' },
        { model: MODEL, vectors: [[1, 0, 0]] },
      ),
    ).toThrow(/wrong subjects/);
  });

  it('refuses a vector that disagrees with the declared dimensions', () => {
    expect(() =>
      assertUsable({ texts: ['a'], purpose: 'document' }, { model: MODEL, vectors: [[1, 0]] }),
    ).toThrow(/dimensions/);
  });

  it('refuses a vector containing a value that is not finite', () => {
    expect(() =>
      assertUsable(
        { texts: ['a'], purpose: 'document' },
        { model: MODEL, vectors: [[1, Number.POSITIVE_INFINITY, 0]] },
      ),
    ).toThrow(/finite/);
  });

  it('accepts a well-formed response', () => {
    expect(() =>
      assertUsable({ texts: ['a'], purpose: 'query' }, { model: MODEL, vectors: [[1, 0, 0]] }),
    ).not.toThrow();
  });
});
