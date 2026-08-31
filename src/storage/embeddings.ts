import { sql } from 'drizzle-orm';

import {
  assertUsable,
  type EmbeddingModel,
  type EmbeddingSource,
  type ProviderOperationContext,
} from '../providers/index.js';
import { HitSource, boundedLimit, type SearchHit } from '../retrieval/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';

/**
 * Vector storage and nearest-neighbour query.
 *
 * GOTCHA: vectors from two models are not comparable — the distance between
 * them is arithmetic with no meaning, and it looks exactly like a real
 * distance. Every query filters by model id and version.
 */

export interface StoredEmbedding {
  readonly subjectId: string;
  readonly subjectKind: 'entity' | 'evidence';
  /** The exact text that was embedded, hashed. Without it a vector is unreproducible. */
  readonly sourceContentHash: string;
  readonly vector: readonly number[];
}

/** Finite-checked, so only digits and signs reach the literal. A provider is
 * external code, often a network response. */
function toVectorLiteral(vector: readonly number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new RangeError('A vector containing a value that is not finite cannot be stored.');
    }
  }
  return `[${vector.join(',')}]`;
}

export class EmbeddingStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /** Re-embedding replaces: an embedding is a derived artefact, not an
   * observation with a validity period, so two per pair is a duplicate. */
  async record(
    model: EmbeddingModel,
    embeddings: readonly StoredEmbedding[],
    now: Date = new Date(),
  ): Promise<number> {
    if (embeddings.length === 0) return 0;

    for (const embedding of embeddings) {
      if (embedding.vector.length !== model.dimensions) {
        throw new RangeError(
          `A vector for ${embedding.subjectId} has ${String(embedding.vector.length)} dimensions, ` +
            `but ${model.id} declares ${String(model.dimensions)}.`,
        );
      }
    }

    try {

      let written = 0;
      for (const embedding of embeddings) {
        await this.#db.execute(sql`
          INSERT INTO ferret.embedding (
            id, subject_id, subject_kind, model_id, model_version, dimensions, metric,
            vector, source_content_hash, created_at, last_indexed_at
          ) VALUES (
            gen_random_uuid(), ${embedding.subjectId}, ${embedding.subjectKind},
            ${model.id}, ${model.version}, ${model.dimensions}, ${model.metric},
            ${toVectorLiteral(embedding.vector)}::vector, ${embedding.sourceContentHash},
            ${now}, ${now}
          )
          ON CONFLICT (subject_id, model_id, model_version) DO UPDATE SET
            vector = EXCLUDED.vector,
            dimensions = EXCLUDED.dimensions,
            metric = EXCLUDED.metric,
            source_content_hash = EXCLUDED.source_content_hash,
            last_indexed_at = EXCLUDED.last_indexed_at
        `);
        written += 1;
      }
      return written;
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.embedding.record');
    }
  }

  /**
   * `<=>` is cosine distance: 0 identical, 2 opposite.
   *
   * No vector index exists — one must be built per dimension, and the dimension
   * is unknown until a provider declares it. Sequential scan is slower and
   * never wrong; a guessed dimension would index nothing.
   */
  async nearest(
    model: EmbeddingModel,
    vector: readonly number[],
    options: { limit?: number; maxDistance?: number } = {},
  ): Promise<readonly SearchHit[]> {
    if (vector.length !== model.dimensions) {
      throw new RangeError(
        `The query vector has ${String(vector.length)} dimensions, but ${model.id} declares ` +
          `${String(model.dimensions)}. A distance between them would be meaningless.`,
      );
    }

    const limit = boundedLimit(options.limit);
    // Above 1 the vectors point away from each other. Returning those ranked
    // implies a relevance the model never found.
    const maxDistance = options.maxDistance ?? 1;
    const literal = toVectorLiteral(vector);

    try {
      const rows = await this.#db.execute<{
        [column: string]: unknown;
        subject_id: string;
        subject_kind: string;
        distance: number;
      }>(sql`
        SELECT em.subject_id, em.subject_kind, (em.vector <=> ${literal}::vector) AS distance
          FROM ferret.embedding em
         WHERE em.model_id = ${model.id}
           AND em.model_version = ${model.version}
           AND (em.vector <=> ${literal}::vector) <= ${maxDistance}
         ORDER BY distance
         LIMIT ${limit}
      `);

      if (rows.rows.length === 0) return [];


      const ids = rows.rows.map((row) => row.subject_id);
      const entities = await this.#db.execute<{ [column: string]: unknown; id: string }>(sql`
        SELECT id, kind, canonical_key, schema_version, source_system, source_id, source_url,
               source_scope, lifecycle, attributes, unknown_fields, source_observed_at, content_hash
          FROM ferret.entity
         WHERE id = ANY(${sql.raw('ARRAY[')}${sql.join(ids.map((id) => sql`${id}`), sql`, `)}${sql.raw(']::uuid[]')})
      `);

      const byId = new Map(entities.rows.map((row) => [row.id, row]));

      const hits: SearchHit[] = [];
      for (const row of rows.rows) {
        const entity = byId.get(row.subject_id);
        // Stale row; EPIC-032 owns removing it.
        if (entity === undefined) continue;
        hits.push({
          source: HitSource.ENTITY,
          entity: toEntity(entity),
          evidence: undefined,
          // Inverted so higher is better. Comparable within this result set only.
          score: 1 - Number(row.distance) / 2,
          highlight: undefined,
        });
      }
      return hits;
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.embedding.nearest');
    }
  }

  /** How many vectors exist for a model, for reporting coverage. */
  async count(model?: Pick<EmbeddingModel, 'id' | 'version'>): Promise<number> {
    const rows = await this.#db.execute<{ [column: string]: unknown; n: string }>(
      model === undefined
        ? sql`SELECT count(*)::text AS n FROM ferret.embedding`
        : sql`SELECT count(*)::text AS n FROM ferret.embedding
                WHERE model_id = ${model.id} AND model_version = ${model.version}`,
    );
    return Number(rows.rows[0]?.n ?? '0');
  }

  /** Keeping stale vectors is safe only while every future caller remembers
   * the model filter, which is not a safety property. */
  async forget(model: Pick<EmbeddingModel, 'id' | 'version'>): Promise<number> {
    const rows = await this.#db.execute<{ [column: string]: unknown; id: string }>(sql`
      DELETE FROM ferret.embedding
       WHERE model_id = ${model.id} AND model_version = ${model.version}
      RETURNING id
    `);
    return rows.rows.length;
  }
}

/** Raw rows bypass Drizzle's column parsers; mapped by hand for that reason. */
function toEntity(row: Record<string, unknown>): SearchHit['entity'] {
  return Object.freeze({
    id: row['id'] as string,
    kind: row['kind'] as string,
    canonicalKey: row['canonical_key'] as string,
    schemaVersion: row['schema_version'] as number,
    source: Object.freeze({
      system: row['source_system'] as string,
      id: row['source_id'] as string,
      ...(row['source_url'] === null ? {} : { url: row['source_url'] as string }),
      ...(row['source_scope'] === null ? {} : { scope: row['source_scope'] as string }),
    }),
    lifecycle: row['lifecycle'] as string,
    attributes: Object.freeze(row['attributes'] as Record<string, unknown>),
    unknownFields: Object.freeze(row['unknown_fields'] as Record<string, unknown>),
    externalIds: Object.freeze([]),
    sourceObservedAt: undefined,
    contentHash: row['content_hash'] as string,
  }) as SearchHit['entity'];
}

/**
 * The planner's semantic strategy.
 *
 * Reports unavailability rather than emptiness: "nobody looked" and "nothing
 * matched" are different answers, and only one of them is a finding.
 */
export class SemanticRetrieval {
  readonly #store: EmbeddingStore;
  readonly #source: EmbeddingSource | undefined;
  readonly #context: ProviderOperationContext;
  readonly #maxDistance: number | undefined;

  constructor(options: {
    store: EmbeddingStore;
    /** Absent when no embedding provider is registered, which is the default. */
    source?: EmbeddingSource | undefined;
    context: ProviderOperationContext;
    maxDistance?: number;
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#context = options.context;
    this.#maxDistance = options.maxDistance;
  }

  async unavailableReason(): Promise<string | undefined> {
    if (this.#source === undefined) {
      return (
        'No embedding provider is registered. Ferret ships none by design — semantic ' +
        'retrieval is optional augmentation, not the basis of retrieval (TECHNOLOGY-DECISIONS §6).'
      );
    }

    let model;
    try {
      model = await this.#source.describeModel(this.#context);
    } catch (error) {
      return `The embedding provider could not describe its model: ${
        error instanceof Error ? error.message : 'unknown failure'
      }`;
    }

    // Not broken — never run over this index. Saying so points at the fix.
    const stored = await this.#store.count(model);
    if (stored === 0) {
      return `No content has been embedded with ${model.id}@${model.version} yet.`;
    }

    return undefined;
  }

  async nearest(question: string, limit: number): Promise<readonly SearchHit[] | undefined> {
    if (this.#source === undefined) return undefined;

    const model = await this.#source.describeModel(this.#context);
    const request = { texts: [question], purpose: 'query' as const };
    const result = await this.#source.embed(request, this.#context);
    // Checked before it reaches a query: a misaligned index is far harder to
    // diagnose later.
    assertUsable(request, result);

    if (result.model.id !== model.id || result.model.version !== model.version) {
      throw new RangeError(
        `The provider described ${model.id}@${model.version} but embedded with ` +
          `${result.model.id}@${result.model.version}. Comparing across models is meaningless.`,
      );
    }

    const vector = result.vectors[0];
    if (vector === undefined) return undefined;

    return this.#store.nearest(model, vector, {
      limit,
      ...(this.#maxDistance === undefined ? {} : { maxDistance: this.#maxDistance }),
    });
  }
}
