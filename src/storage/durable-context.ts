import { and, eq, sql } from 'drizzle-orm';

import {
  CONTEXT_CONCERNS_ENTITY,
  CONTEXT_CONTRADICTS_CONTEXT,
  CONTEXT_RELATES_TO_CONTEXT,
  DURABLE_CONTEXT_KIND,
  MAX_CANDIDATES,
  MergeVerdict,
  NEAR_DUPLICATE_SIMILARITY,
  classifyPair,
  contradicts,
  createDurableContext,
  durableContextOf,
  registerDurableContextKind,
  type ContextKind,
  type DurableContext,
  type DurableContextInput,
} from '../context/durable.js';
import {
  EvidenceMethod,
  LifecycleState,
  RelationshipType,
  authorityFor,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import { EntityStore, UpsertOutcome, recomputeEntityHash, type FerretDatabase } from './entities.js';
import { EvidenceStore } from './evidence.js';
import { RelationshipStore } from './relationships.js';
import { relaxedTsQuery } from './retrieval.js';
import { entity } from './schema/entities.js';

/**
 * Durable context, merged on the way in — EPIC-126.
 *
 * Merge by identity, record provenance as evidence, relate near-duplicates
 * without merging them, keep both sides of a contradiction. What it does not do
 * is judge whether a statement deserves to be durable — that is EPIC-129.
 */

/** Ferret's own producer name for context it was told rather than observed. */
export const DURABLE_CONTEXT_PRODUCER = 'ferret.context';

export interface ContextProvenance {
  /** What produced this statement — an agent, a person, a tool. */
  readonly producer: string;
  readonly producerVersion: string;
  /** The system it came through. Ferret's own surface is `ferret`. */
  readonly sourceSystem: string;
  /** Defaults to `asserted` — what a client telling Ferret something is. */
  readonly method?: EvidenceMethod;
  readonly sourceId?: string | undefined;
  readonly sourceUrl?: string | undefined;
  readonly confidence?: number | undefined;
  /** When the statement was true at its source. */
  readonly observedAt?: string | undefined;
  /** Who may see the supporting observation — EPIC-008's opaque token. */
  readonly permissionScope?: string | undefined;
  /** Evidence this rests on, for a derived statement. */
  readonly derivedFrom?: readonly string[] | undefined;
}

export interface RecordContextInput extends DurableContextInput {
  readonly provenance: ContextProvenance;
  /** A durable context id this statement replaces, when a producer says so. */
  readonly supersedes?: string | undefined;
}

/** A near-duplicate the merger related this record to, and why. */
export interface RelatedContext {
  readonly id: string;
  readonly similarity: number;
  /** True when the two disagree about the same subject. */
  readonly contradiction: boolean;
}

export interface RecordedContext {
  readonly context: DurableContext;
  /** `merged` when the statement was already on record. */
  readonly outcome: 'created' | 'merged';
  readonly evidenceId: string;
  readonly related: readonly RelatedContext[];
  /** The record this write superseded, when one was named. */
  readonly superseded: string | undefined;
}

export interface ContextQuery {
  readonly scope?: string | undefined;
  readonly contextKind?: ContextKind | undefined;
  readonly subjectId?: string | undefined;
  /** Off by default: history is never deleted, it is asked for. */
  readonly includeSuperseded?: boolean;
  readonly limit?: number;
}

/** How many records one `current` read returns before it stops. */
export const MAX_CONTEXT_PAGE = 200;

export class DurableContextStore {
  readonly #db: FerretDatabase;
  readonly #entities: EntityStore;
  readonly #evidence: EvidenceStore;
  readonly #relationships: RelationshipStore;

  constructor(db: FerretDatabase) {
    // Composing the store registers the kind, as `SymbolStore` does for symbols.
    registerDurableContextKind();
    this.#db = db;
    this.#entities = new EntityStore(db);
    this.#evidence = new EvidenceStore(db);
    this.#relationships = new RelationshipStore(db);
  }

  /**
   * Record, then provenance, then relationships — so a concurrent reader sees a
   * record with less support than it will have, never support with no record.
   */
  async record(input: RecordContextInput, now: Date = new Date()): Promise<RecordedContext> {
    const built = createDurableContext(input);
    const method = input.provenance.method ?? EvidenceMethod.ASSERTED;

    const upserted = await this.#entities.upsert(
      {
        kind: built.entity.kind,
        source: { ...built.entity.source },
        attributes: { ...built.entity.attributes },
      },
      now,
      // The first wording is canonical. Rewriting it on every restatement would
      // churn the content hash; the variant is kept on the evidence anyway.
      { ifAbsent: true },
    );

    const context = durableContextOf(upserted.entity);

    const support = await this.#evidence.record(
      {
        subjectId: context.entity.id,
        // The writer's wording. The record holds what Ferret settled on.
        statement: built.statement,
        method,
        producer: input.provenance.producer,
        producerVersion: input.provenance.producerVersion,
        sourceSystem: input.provenance.sourceSystem,
        authority: authorityFor(method),
        // Support, not replacement. `single` would mark a second agent's
        // agreement as having replaced the first's, erasing corroboration.
        cardinality: 'collection',
        ...(input.provenance.sourceId === undefined ? {} : { sourceId: input.provenance.sourceId }),
        ...(input.provenance.sourceUrl === undefined ? {} : { sourceUrl: input.provenance.sourceUrl }),
        ...(input.provenance.confidence === undefined ? {} : { confidence: input.provenance.confidence }),
        ...(input.provenance.observedAt === undefined ? {} : { observedAt: input.provenance.observedAt }),
        ...(input.provenance.permissionScope === undefined
          ? {}
          : { permissionScope: input.provenance.permissionScope }),
        ...(input.provenance.derivedFrom === undefined ? {} : { derivedFrom: [...input.provenance.derivedFrom] }),
      },
      now,
    );

    if (context.subjectId !== undefined) {
      await this.#relationships.assert(
        {
          fromId: context.entity.id,
          type: CONTEXT_CONCERNS_ENTITY,
          toId: context.subjectId,
          fromKind: DURABLE_CONTEXT_KIND,
          sourceSystem: input.provenance.sourceSystem,
        },
        now,
      );
    }

    const related = await this.#relate(context, input.provenance.sourceSystem, now);

    let superseded: string | undefined;
    if (input.supersedes !== undefined) {
      await this.supersede(input.supersedes, context.entity.id, input.provenance.sourceSystem, now);
      superseded = input.supersedes;
    }

    return {
      context,
      outcome: upserted.outcome === UpsertOutcome.CREATED ? 'created' : 'merged',
      evidenceId: support.evidence.id,
      related,
      superseded,
    };
  }

  /**
   * One bounded query per write, capped at {@link MAX_CANDIDATES}: nothing here
   * is proportional to the size of the knowledge base.
   */
  async #relate(
    context: DurableContext,
    sourceSystem: string,
    now: Date,
  ): Promise<readonly RelatedContext[]> {
    const candidates = await this.candidates(context);
    const related: RelatedContext[] = [];

    for (const candidate of candidates) {
      const verdict = classifyPair(context, candidate);
      if (verdict.verdict !== MergeVerdict.NEAR) continue;
      const contradiction = contradicts(context, candidate);
      const type = contradiction ? CONTEXT_CONTRADICTS_CONTEXT : CONTEXT_RELATES_TO_CONTEXT;

      await this.#relationships.assert(
        {
          fromId: context.entity.id,
          type,
          toId: candidate.entity.id,
          fromKind: DURABLE_CONTEXT_KIND,
          toKind: DURABLE_CONTEXT_KIND,
          sourceSystem,
          // The score that produced the edge, so it need not be recomputed.
          metadata: { similarity: verdict.similarity },
        },
        now,
      );
      related.push({ id: candidate.entity.id, similarity: verdict.similarity, contradiction });
    }

    return related;
  }

  /**
   * Blocked on scope and kind, superseded records excluded.
   *
   * **Any term, not every term.** `websearch_to_tsquery` builds a conjunction,
   * so an AND query can never retrieve the near-duplicate that differs in
   * exactly the word that matters — "the page limit is twenty" against
   * "...fifty", 0.82 similar, matched nothing. `classifyPair` makes the precise
   * decision; this query only has to reach the candidate.
   */
  async candidates(context: DurableContext, limit = MAX_CANDIDATES): Promise<readonly DurableContext[]> {
    if (context.normalized.length === 0) return [];
    try {
      const rows = await this.#db.execute<{ id: string }>(sql`
        SELECT e.id
          FROM ferret.entity e, ${relaxedTsQuery(context.normalized)} AS q(query)
         WHERE e.kind = ${DURABLE_CONTEXT_KIND}
           AND e.lifecycle = ${LifecycleState.ACTIVE}
           AND e.id <> ${context.entity.id}
           AND ${scopeMatches(context.scope)}
           AND e.attributes->>'contextKind' = ${context.contextKind}
           AND e.search_vector @@ q.query
         ORDER BY ts_rank(e.search_vector, q.query) DESC, e.id
         LIMIT ${limit}
      `);

      const found: DurableContext[] = [];
      for (const row of rows.rows) {
        const stored = await this.#entities.get(row.id);
        if (stored !== undefined) found.push(durableContextOf(stored));
      }
      return found;
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.context.candidates');
    }
  }

  async get(id: string): Promise<DurableContext | undefined> {
    const stored = await this.#entities.get(id);
    if (stored === undefined || stored.kind !== DURABLE_CONTEXT_KIND) return undefined;
    return durableContextOf(stored);
  }

  /** Superseded records excluded by default, newest first. */
  async current(query: ContextQuery = {}): Promise<readonly DurableContext[]> {
    const limit = Math.min(query.limit ?? MAX_CONTEXT_PAGE, MAX_CONTEXT_PAGE);
    try {
      const conditions = [eq(entity.kind, DURABLE_CONTEXT_KIND)];
      if (query.includeSuperseded !== true) {
        conditions.push(eq(entity.lifecycle, LifecycleState.ACTIVE));
      }
      if (query.scope !== undefined) conditions.push(eq(entity.sourceScope, query.scope));
      if (query.contextKind !== undefined) {
        conditions.push(sql`${entity.attributes}->>'contextKind' = ${query.contextKind}`);
      }
      if (query.subjectId !== undefined) {
        conditions.push(sql`${entity.attributes}->>'subjectId' = ${query.subjectId}`);
      }

      const rows = await this.#db
        .select({ id: entity.id })
        .from(entity)
        .where(and(...conditions))
        .orderBy(sql`${entity.lastIndexedAt} DESC, ${entity.id}`)
        .limit(limit);

      const found: DurableContext[] = [];
      for (const row of rows) {
        const stored = await this.#entities.get(row.id);
        if (stored !== undefined) found.push(durableContextOf(stored));
      }
      return found;
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.context.current');
    }
  }

  /**
   * The replaced record keeps every observation that supported it, so "why did
   * we change our mind" stays answerable.
   *
   * @throws {FerretError} `E_ENTITY_NOT_FOUND` when either id is not durable
   * context, `E_USAGE` when a record is asked to supersede itself.
   */
  async supersede(
    supersededId: string,
    replacementId: string,
    sourceSystem: string,
    now: Date = new Date(),
  ): Promise<void> {
    if (supersededId === replacementId) {
      throw new FerretError(ErrorCode.USAGE, 'A durable context record cannot supersede itself', {
        details: { contextId: supersededId },
        remediation: 'Name the record this statement replaces, not the record being written.',
      });
    }
    for (const id of [supersededId, replacementId]) {
      if ((await this.get(id)) === undefined) {
        throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `No durable context with id ${id}`, {
          details: { contextId: id },
          remediation: 'Record the statement before naming it in a supersession.',
        });
      }
    }

    try {
      await this.#db.transaction(async (tx) => {
        // Issue #118 — the hash covers `lifecycle`, so recompute it.
        const hash = await recomputeEntityHash(tx, supersededId, LifecycleState.SUPERSEDED);
        await tx.execute(sql`
          UPDATE ferret.entity
             SET lifecycle = ${LifecycleState.SUPERSEDED},
                 last_indexed_at = ${now}
                 ${hash === undefined ? sql`` : sql`, content_hash = ${hash}`}
           WHERE id = ${supersededId} AND lifecycle <> ${LifecycleState.SUPERSEDED}
        `);
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.context.supersede');
    }

    await this.#relationships.assert(
      {
        fromId: replacementId,
        type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
        toId: supersededId,
        fromKind: DURABLE_CONTEXT_KIND,
        toKind: DURABLE_CONTEXT_KIND,
        sourceSystem,
      },
      now,
    );
  }

  /** Context records the merger related this one to. */
  async relatedTo(id: string): Promise<readonly RelatedContext[]> {
    const edges = [
      ...(await this.#relationships.neighbours(id, { type: CONTEXT_RELATES_TO_CONTEXT })),
      ...(await this.#relationships.neighbours(id, { type: CONTEXT_CONTRADICTS_CONTEXT })),
    ];
    const seen = new Map<string, RelatedContext>();
    for (const edge of edges) {
      const other = edge.fromId === id ? edge.toId : edge.fromId;
      const score = edge.metadata['similarity'];
      seen.set(other, {
        id: other,
        similarity: typeof score === 'number' ? score : NEAR_DUPLICATE_SIMILARITY,
        contradiction: edge.type === CONTEXT_CONTRADICTS_CONTEXT,
      });
    }
    return [...seen.values()];
  }

  async count(query: ContextQuery = {}): Promise<number> {
    const conditions = [eq(entity.kind, DURABLE_CONTEXT_KIND)];
    if (query.includeSuperseded !== true) {
      conditions.push(eq(entity.lifecycle, LifecycleState.ACTIVE));
    }
    if (query.scope !== undefined) conditions.push(eq(entity.sourceScope, query.scope));
    const rows = await this.#db
      .select({ count: sql<string>`count(*)::text` })
      .from(entity)
      .where(and(...conditions));
    return Number(rows[0]?.count ?? '0');
  }
}

/** Scope is part of identity, so a candidate search never leaves it. */
function scopeMatches(scope: string | undefined) {
  return scope === undefined ? sql`e.source_scope IS NULL` : sql`e.source_scope = ${scope}`;
}
