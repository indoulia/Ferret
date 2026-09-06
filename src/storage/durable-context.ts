import { and, eq, inArray, sql } from 'drizzle-orm';

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
  EvidenceState,
  LifecycleState,
  RelationshipType,
  authorityFor,
  preferredEvidence,
  type CanonicalEvidence,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import { EntityStore, UpsertOutcome, recomputeEntityHash, type FerretDatabase } from './entities.js';
import { EvidenceStore, type ScopedRead } from './evidence.js';
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
  /**
   * `candidate` to propose rather than assert — EPIC-127.
   *
   * Only ever applies to the *first* write of a statement: `EntityStore.upsert`
   * never changes a stored row's lifecycle, so a later restatement adds support
   * to a candidate without quietly promoting it. Promotion is {@link accept},
   * which is a decision somebody makes rather than a side effect of writing.
   */
  readonly state?: typeof LifecycleState.ACTIVE | typeof LifecycleState.CANDIDATE;
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
  /**
   * Which lifecycle states to return — EPIC-127. Defaults to current only.
   *
   * Replaces EPIC-126's `includeSuperseded`, which could say "current" and
   * "everything" and nothing else. With candidates and archived records in the
   * model a boolean cannot express what a caller means, and two ways to ask one
   * question is one too many.
   */
  readonly states?: readonly LifecycleState[] | undefined;
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
        lifecycle: input.state ?? LifecycleState.ACTIVE,
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

  /** Current context by default, newest first. */
  async current(query: ContextQuery = {}): Promise<readonly DurableContext[]> {
    const limit = Math.min(query.limit ?? MAX_CONTEXT_PAGE, MAX_CONTEXT_PAGE);
    try {
      const conditions = [eq(entity.kind, DURABLE_CONTEXT_KIND), statesIn(query.states)];
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

    await this.#transition(supersededId, LifecycleState.SUPERSEDED, 'supersede', now);

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

  /**
   * Promotes a proposal to current context — EPIC-127.
   *
   * @throws {FerretError} `E_USAGE` when the record is not a candidate.
   * Accepting something already current is a caller that has lost track of what
   * it is doing, and reporting it is more useful than absorbing it.
   */
  async accept(contextId: string, now: Date = new Date()): Promise<DurableContext> {
    return this.#move(contextId, [LifecycleState.CANDIDATE], LifecycleState.ACTIVE, 'accept', now);
  }

  /**
   * Retires a record from current context with nothing replacing it.
   *
   * Reversible by {@link reinstate}, and it touches no evidence: the record
   * keeps every observation that ever supported it, which is what stops this
   * being a delete under another name.
   */
  async archive(contextId: string, now: Date = new Date()): Promise<DurableContext> {
    return this.#move(
      contextId,
      [LifecycleState.ACTIVE, LifecycleState.CANDIDATE],
      LifecycleState.ARCHIVED,
      'archive',
      now,
    );
  }

  /** Returns an archived record to current context. */
  async reinstate(contextId: string, now: Date = new Date()): Promise<DurableContext> {
    return this.#move(contextId, [LifecycleState.ARCHIVED], LifecycleState.ACTIVE, 'reinstate', now);
  }

  /**
   * Which record a caller should believe about this statement, and why — the
   * question EPIC-127 is accepted on.
   *
   * Everything here is read: the state, the evidence and the edges the merger
   * already recorded. Nothing is computed that `preferredEvidence` does not
   * already decide, and when it declines to decide so does this — `undecided`
   * is a real answer, and an arbitrary pick is indistinguishable from a
   * considered one by the time it reaches a reader.
   *
   * `permittedScopes` is required rather than defaulted, for the reason
   * EPIC-083 gives: a read that can forget to say who is asking will.
   */
  async trust(contextId: string, read: ScopedRead & { readonly permittedScopes: readonly string[] }): Promise<ContextTrust | undefined> {
    const held = await this.get(contextId);
    if (held === undefined) return undefined;

    const support = await this.#evidence.forSubject(contextId, {
      permittedScopes: read.permittedScopes,
      state: EvidenceState.CURRENT,
    });
    const preferred = preferredEvidence(support);
    const related = await this.relatedTo(contextId);

    const superseding = await this.#relationships.incoming(contextId, {
      type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
    });
    const superseded = await this.#relationships.outgoing(contextId, {
      type: RelationshipType.ENTITY_SUPERSEDES_ENTITY,
    });

    return {
      contextId,
      state: held.entity.lifecycle,
      current: held.entity.lifecycle === LifecycleState.ACTIVE,
      supportCount: support.length,
      preferredEvidenceId: preferred?.id,
      authority: preferred?.authority,
      confidence: preferred?.confidence,
      observedAt: preferred?.observedAt,
      method: preferred?.method,
      // Support exists and nothing distinguishes it. Not the same as no support
      // at all, and a caller that cannot tell them apart will read silence as
      // agreement.
      undecided: support.length > 1 && preferred === undefined,
      contradictedBy: related.filter((one) => one.contradiction).map((one) => one.id),
      supersededBy: superseding[0]?.fromId,
      supersedes: superseded.map((edge) => edge.toId),
      reason: trustReason(held.entity.lifecycle, support.length, preferred, related),
    };
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

  /**
   * Moves a record between lifecycle states, refusing a move that is not one.
   *
   * The refusal is the point: a state machine that accepts every transition is
   * a column, not a lifecycle.
   */
  async #move(
    contextId: string,
    from: readonly LifecycleState[],
    to: LifecycleState,
    operation: string,
    now: Date,
  ): Promise<DurableContext> {
    const held = await this.get(contextId);
    if (held === undefined) {
      throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `No durable context with id ${contextId}`, {
        details: { contextId },
        remediation: 'Record the statement before changing its lifecycle.',
      });
    }
    if (!from.includes(held.entity.lifecycle)) {
      throw new FerretError(
        ErrorCode.USAGE,
        `Durable context ${contextId} is ${held.entity.lifecycle} and cannot be ${to}`,
        {
          details: { contextId, state: held.entity.lifecycle, target: to, permitted: [...from] },
          remediation: `Only a record in ${from.join(' or ')} may become ${to}.`,
        },
      );
    }

    await this.#transition(contextId, to, operation, now);
    const moved = await this.get(contextId);
    if (moved === undefined) {
      throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, `Durable context ${contextId} vanished mid-transition`, {
        details: { contextId },
      });
    }
    return moved;
  }

  /**
   * The lifecycle write, shared by every transition.
   *
   * **Evidence is never touched.** A transition is Ferret's reading of a
   * statement, not an observation of one, and rewriting the observations would
   * destroy the record of why the statement was believed in the first place.
   */
  async #transition(contextId: string, to: LifecycleState, operation: string, now: Date): Promise<void> {
    try {
      await this.#db.transaction(async (tx) => {
        // Issue #118 — the hash covers `lifecycle`, so recompute it.
        const hash = await recomputeEntityHash(tx, contextId, to);
        await tx.execute(sql`
          UPDATE ferret.entity
             SET lifecycle = ${to},
                 last_indexed_at = ${now}
                 ${hash === undefined ? sql`` : sql`, content_hash = ${hash}`}
           WHERE id = ${contextId} AND lifecycle <> ${to}
        `);
      });
    } catch (error) {
      throw classifyDatabaseError(error, `storage.context.${operation}`);
    }
  }

  async count(query: ContextQuery = {}): Promise<number> {
    const conditions = [eq(entity.kind, DURABLE_CONTEXT_KIND), statesIn(query.states)];
    if (query.scope !== undefined) conditions.push(eq(entity.sourceScope, query.scope));
    const rows = await this.#db
      .select({ count: sql<string>`count(*)::text` })
      .from(entity)
      .where(and(...conditions));
    return Number(rows[0]?.count ?? '0');
  }
}

/** What Ferret currently believes about one statement, and on what — EPIC-127. */
export interface ContextTrust {
  readonly contextId: string;
  readonly state: LifecycleState;
  /** True only for `active`. Everything else is history or a proposal. */
  readonly current: boolean;
  readonly supportCount: number;
  readonly preferredEvidenceId: string | undefined;
  readonly authority: number | undefined;
  readonly confidence: number | undefined;
  readonly observedAt: string | undefined;
  readonly method: string | undefined;
  /** Support exists and nothing in it decides. Not the same as no support. */
  readonly undecided: boolean;
  readonly contradictedBy: readonly string[];
  readonly supersededBy: string | undefined;
  readonly supersedes: readonly string[];
  /** One sentence a person can read. Never built from indexed text. */
  readonly reason: string;
}

/**
 * Why a record stands where it does, in a sentence.
 *
 * Assembled from the lifecycle state and counts only — never from a statement.
 * `mcp/server.ts` makes the same rule structural for tool output: nothing
 * Ferret writes has a hole for indexed content to be interpolated into.
 */
function trustReason(
  state: LifecycleState,
  supportCount: number,
  preferred: CanonicalEvidence | undefined,
  related: readonly RelatedContext[],
): string {
  const contradictions = related.filter((one) => one.contradiction).length;

  switch (state) {
    case LifecycleState.CANDIDATE:
      return 'proposed and not yet accepted, so it is not current context';
    case LifecycleState.ARCHIVED:
      return 'retired from current context, with nothing recorded as replacing it';
    case LifecycleState.SUPERSEDED:
      return 'replaced by a later statement, which is the answer instead';
    case LifecycleState.DELETED:
      return 'removed at its source and retained only as history';
    case LifecycleState.ACTIVE:
      break;
    default:
      return `held under an unrecognised lifecycle ${JSON.stringify(state)}`;
  }

  if (supportCount === 0) return 'current, but nothing visible to this caller supports it';
  if (preferred === undefined) {
    return contradictions > 0
      ? `current, contradicted by ${String(contradictions)} other record(s), and nothing in the evidence decides between them`
      : 'current, but nothing in the evidence distinguishes the observations behind it';
  }

  const strength = `${String(supportCount)} observation(s), strongest by ${preferred.method}`;
  return contradictions > 0
    ? `current on ${strength}, and contradicted by ${String(contradictions)} other record(s)`
    : `current on ${strength}`;
}

/**
 * The lifecycle filter a read applies.
 *
 * An explicitly empty list means *every* state, so a caller can ask for the
 * whole record rather than having to enumerate a vocabulary that may grow.
 * Omitting it means current only, which is the default the acceptance criterion
 * asks for: retrieval must not hand back what is no longer believed.
 */
function statesIn(states: readonly LifecycleState[] | undefined) {
  if (states === undefined) return eq(entity.lifecycle, LifecycleState.ACTIVE);
  if (states.length === 0) return sql`true`;
  return inArray(entity.lifecycle, [...states]);
}

/** Scope is part of identity, so a candidate search never leaves it. */
function scopeMatches(scope: string | undefined) {
  return scope === undefined ? sql`e.source_scope IS NULL` : sql`e.source_scope = ${scope}`;
}
