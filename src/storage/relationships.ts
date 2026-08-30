import { and, eq, isNull, or, sql } from 'drizzle-orm';

import {
  createRelationship,
  relationshipTypeDefinition,
  type CanonicalRelationship,
  type RelationshipInput,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { relationship, type RelationshipRow } from './schema/relationships.js';

/**
 * Persisting relationships.
 *
 * Three problems this layer exists to solve, each named directly by EPIC-007's
 * test requirements and each covered against a real PostgreSQL:
 *
 * - **Duplicate events.** A provider replaying its history must not multiply
 *   relationships. Identity includes `validFrom`, so re-observing the same fact
 *   conflicts on a unique index rather than inserting again.
 * - **Out-of-order events.** Synchronization does not guarantee order, and a
 *   late-arriving *older* observation must not overwrite newer knowledge. Every
 *   mutation here is guarded by a comparison against what is already stored.
 * - **Concurrent updates.** Two providers can assert about the same entity at
 *   once. Exclusive types close and open inside one transaction, so an entity
 *   cannot end up with two open relationships of a type that permits one.
 */

/**
 * Serializes writers that contend for the same exclusive relationship.
 *
 * Found by test. Under PostgreSQL's default READ COMMITTED isolation, eight
 * concurrent assertions each read a snapshot in which no *other* relationship
 * was open, so none of them closed the others and all eight ended up open —
 * write skew, and a branch that appeared to point at eight commits at once.
 *
 * A transaction-scoped advisory lock keyed on `(fromId, type)` serializes
 * exactly the writers that conflict and nothing else: two providers asserting
 * about different branches never wait on each other. It is released on commit or
 * rollback without any unlock call, so a failed transaction cannot strand it.
 *
 * `pg_advisory_xact_lock(bigint)` uses a **separate lock space** from the
 * two-argument form EPIC-002's migrator takes, so the two cannot collide.
 *
 * The alternative — a partial unique index on `(from_id, type) WHERE valid_to IS
 * NULL` — was rejected: the index would be table-wide, and would wrongly forbid
 * a commit from having several open `commit_modifies_file` relationships.
 */
async function lockExclusive(tx: FerretDatabase, fromId: string, type: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${fromId}:${type}`}, 0))`);
}

export const AssertOutcome = {
  /** A new relationship interval was opened. */
  OPENED: 'opened',
  /** The same assertion already existed, unchanged. */
  UNCHANGED: 'unchanged',
  /** The assertion existed and its metadata or end changed. */
  UPDATED: 'updated',
  /** Discarded: an older observation than what is already known. */
  STALE: 'stale',
} as const;

export type AssertOutcome = (typeof AssertOutcome)[keyof typeof AssertOutcome];

export interface AssertResult {
  readonly relationship: CanonicalRelationship;
  readonly outcome: AssertOutcome;
  /** Relationships closed to make room, when the type is exclusive. */
  readonly closed: readonly string[];
}

export interface TraversalOptions {
  /** Restrict to one relationship type. */
  readonly type?: string;
  /**
   * Evaluate at an instant. Defaults to now.
   *
   * This is what makes history usable: asking for neighbours *as of* a date
   * answers what was true then, rather than what is true now.
   */
  readonly at?: Date;
  /** Include relationships that have been closed. */
  readonly includeHistorical?: boolean;
  readonly limit?: number;
}

function toCanonical(row: RelationshipRow): CanonicalRelationship {
  return Object.freeze({
    id: row.id,
    fromId: row.fromId,
    type: row.type,
    toId: row.toId,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo === null ? null : row.validTo.toISOString(),
    metadata: Object.freeze(row.metadata as Record<string, unknown>),
    sourceSystem: row.sourceSystem,
    sourceId: row.sourceId ?? undefined,
    contentHash: row.contentHash,
  });
}

export class RelationshipStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Records that a relationship is true from an instant.
   *
   * For an **exclusive** type — a branch points at one commit, a worktree holds
   * one branch — any other open relationship of that type from the same entity
   * is closed at the new `validFrom`. That is what turns a stream of
   * observations into a history: without it, a branch that had pointed at five
   * commits would appear to point at all five at once.
   */
  async assert(input: RelationshipInput, now: Date = new Date()): Promise<AssertResult> {
    const canonical = createRelationship(input, now);
    const definition = relationshipTypeDefinition(canonical.type);
    if (definition === undefined) {
      throw new FerretError(ErrorCode.RELATIONSHIP_INVALID, `Unknown relationship type "${canonical.type}"`, {
        details: { type: canonical.type },
      });
    }

    try {
      return await this.#db.transaction(async (tx) => {
        // Taken before the read, not after: the point is to make the
        // read-decide-write sequence atomic against other writers, and a lock
        // acquired afterwards would protect nothing.
        if (definition.exclusiveFrom) await lockExclusive(tx, canonical.fromId, canonical.type);

        const [existing] = await tx.select().from(relationship).where(eq(relationship.id, canonical.id)).limit(1);

        if (existing !== undefined && existing.contentHash === canonical.contentHash) {
          // A replayed event. Record that Ferret saw it again — staleness is
          // measured from that — but change nothing else.
          await tx.update(relationship).set({ lastIndexedAt: now }).where(eq(relationship.id, canonical.id));
          return { relationship: toCanonical(existing), outcome: AssertOutcome.UNCHANGED, closed: [] };
        }

        const closed: string[] = [];
        let effectiveValidTo = canonical.validTo;
        if (definition.exclusiveFrom) {
          const reconciled = await this.#reconcileExclusive(tx, canonical, now);
          closed.push(...reconciled.closed);
          effectiveValidTo = reconciled.validTo;
        }

        const [row] = await tx
          .insert(relationship)
          .values({
            id: canonical.id,
            fromId: canonical.fromId,
            type: canonical.type,
            toId: canonical.toId,
            validFrom: new Date(canonical.validFrom),
            validTo: effectiveValidTo === null ? null : new Date(effectiveValidTo),
            metadata: canonical.metadata,
            sourceSystem: canonical.sourceSystem,
            sourceId: canonical.sourceId ?? null,
            firstIndexedAt: now,
            lastIndexedAt: now,
            contentHash: canonical.contentHash,
          })
          .onConflictDoUpdate({
            target: relationship.id,
            set: {
              validTo: effectiveValidTo === null ? null : new Date(effectiveValidTo),
              metadata: canonical.metadata,
              sourceSystem: canonical.sourceSystem,
              sourceId: canonical.sourceId ?? null,
              lastIndexedAt: now,
              contentHash: canonical.contentHash,
              // `first_indexed_at` and `valid_from` are not updated: the first
              // is a historical fact about Ferret, the second is part of the
              // identity that was matched.
            },
          })
          .returning();

        if (row === undefined) {
          throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'Relationship upsert returned no row', {
            details: { relationshipId: canonical.id },
          });
        }

        return {
          relationship: toCanonical(row),
          outcome: existing === undefined ? AssertOutcome.OPENED : AssertOutcome.UPDATED,
          closed,
        };
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.relationship.assert');
    }
  }

  /**
   * Makes the timeline for one exclusive `(entity, type)` consistent.
   *
   * An exclusive type permits one open relationship at a time, and events do
   * not arrive in order, so "close whatever is open" is not enough. Two rules
   * together produce a non-overlapping timeline whatever order assertions
   * arrive in:
   *
   * 1. **Truncate whatever covered this instant.** Any interval that started at
   *    or before the new one and had not yet ended by then is closed at the new
   *    start. That includes already-closed intervals, not just open ones —
   *    inserting Jan 5 between an existing Jan 3–Jan 8 would otherwise leave two
   *    intervals covering the same days.
   * 2. **Bound this interval by its successor.** If a later interval is already
   *    known, the new one ends where that begins. This is what lets a
   *    late-arriving *older* observation be recorded as history rather than
   *    either being dropped or wrongly becoming current.
   *
   * The net invariant is that exactly one interval is open — the one with the
   * greatest start — and none overlap. Governance §15 forbids silently
   * discarding conflicting evidence, so nothing is dropped: an out-of-order
   * event is inserted in its rightful place in the history.
   */
  async #reconcileExclusive(
    tx: FerretDatabase,
    canonical: CanonicalRelationship,
    now: Date,
  ): Promise<{ closed: string[]; validTo: string | null }> {
    const validFrom = new Date(canonical.validFrom);

    const overlapping = and(
      eq(relationship.fromId, canonical.fromId),
      eq(relationship.type, canonical.type),
      sql`${relationship.id} <> ${canonical.id}`,
      sql`${relationship.validFrom} <= ${validFrom}`,
      sql`(${relationship.validTo} IS NULL OR ${relationship.validTo} > ${validFrom})`,
    );

    const covering = await tx.select().from(relationship).where(overlapping);
    if (covering.length > 0) {
      await tx.update(relationship).set({ validTo: validFrom, lastIndexedAt: now }).where(overlapping);
    }

    const [successor] = await tx
      .select({ validFrom: relationship.validFrom })
      .from(relationship)
      .where(
        and(
          eq(relationship.fromId, canonical.fromId),
          eq(relationship.type, canonical.type),
          sql`${relationship.id} <> ${canonical.id}`,
          sql`${relationship.validFrom} > ${validFrom}`,
        ),
      )
      .orderBy(relationship.validFrom)
      .limit(1);

    // The caller's own end still wins when it is earlier: a source that says a
    // relationship ended is more specific than an inference from the next one.
    const bound = successor?.validFrom.toISOString() ?? null;
    const validTo =
      bound === null
        ? canonical.validTo
        : canonical.validTo === null
          ? bound
          : new Date(canonical.validTo) < new Date(bound)
            ? canonical.validTo
            : bound;

    return { closed: covering.map((row) => row.id), validTo };
  }

  /**
   * Records that a relationship stopped being true.
   *
   * A tombstone, not a delete: the row keeps its interval so "when did this stop
   * being true" remains answerable. Governance §6 forbids discarding source
   * evidence, and a relationship that simply vanished would be
   * indistinguishable from one that was never observed.
   */
  async retire(
    fromId: string,
    type: string,
    toId: string,
    at: Date = new Date(),
    now: Date = new Date(),
  ): Promise<CanonicalRelationship | undefined> {
    try {
      const [open] = await this.#db
        .select()
        .from(relationship)
        .where(
          and(
            eq(relationship.fromId, fromId),
            eq(relationship.type, type),
            eq(relationship.toId, toId),
            isNull(relationship.validTo),
          ),
        )
        .orderBy(sql`${relationship.validFrom} DESC`)
        .limit(1);

      if (open === undefined) return undefined;

      // An event claiming the relationship ended before it began is
      // out-of-order or wrong. Discard it rather than record an impossible
      // interval that every temporal query would then have to defend against.
      if (at < open.validFrom) return toCanonical(open);

      const [row] = await this.#db
        .update(relationship)
        .set({ validTo: at, lastIndexedAt: now })
        .where(eq(relationship.id, open.id))
        .returning();

      return row === undefined ? undefined : toCanonical(row);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.relationship.retire');
    }
  }

  async get(id: string): Promise<CanonicalRelationship | undefined> {
    const [row] = await this.#db.select().from(relationship).where(eq(relationship.id, id)).limit(1);
    return row === undefined ? undefined : toCanonical(row);
  }

  /** Relationships leaving an entity. */
  async outgoing(fromId: string, options: TraversalOptions = {}): Promise<CanonicalRelationship[]> {
    return this.#traverse(eq(relationship.fromId, fromId), options);
  }

  /** Relationships arriving at an entity. */
  async incoming(toId: string, options: TraversalOptions = {}): Promise<CanonicalRelationship[]> {
    return this.#traverse(eq(relationship.toId, toId), options);
  }

  /** Relationships in either direction. */
  async neighbours(entityId: string, options: TraversalOptions = {}): Promise<CanonicalRelationship[]> {
    return this.#traverse(
      or(eq(relationship.fromId, entityId), eq(relationship.toId, entityId)) ?? sql`true`,
      options,
    );
  }

  /** Every assertion ever made about one edge, oldest first. */
  async history(fromId: string, type: string, toId: string): Promise<CanonicalRelationship[]> {
    const rows = await this.#db
      .select()
      .from(relationship)
      .where(and(eq(relationship.fromId, fromId), eq(relationship.type, type), eq(relationship.toId, toId)))
      .orderBy(relationship.validFrom);
    return rows.map(toCanonical);
  }

  async #traverse(
    predicate: ReturnType<typeof eq>,
    options: TraversalOptions,
  ): Promise<CanonicalRelationship[]> {
    const filters = [predicate];
    if (options.type !== undefined) filters.push(eq(relationship.type, options.type));

    if (options.includeHistorical !== true) {
      const at = options.at ?? new Date();
      // Half-open interval: a relationship that ended at T was not true *at* T.
      // Without that, closing one interval and opening another at the same
      // instant would make both true simultaneously.
      filters.push(sql`${relationship.validFrom} <= ${at}`);
      filters.push(sql`(${relationship.validTo} IS NULL OR ${relationship.validTo} > ${at})`);
    }

    try {
      const rows = await this.#db
        .select()
        .from(relationship)
        .where(and(...filters))
        .orderBy(sql`${relationship.validFrom} DESC`)
        .limit(options.limit ?? 200);
      return rows.map(toCanonical);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.relationship.traverse');
    }
  }

  async count(type?: string): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<string>`count(*)::text` })
      .from(relationship)
      .where(type === undefined ? undefined : eq(relationship.type, type));
    return Number(rows[0]?.count ?? '0');
  }
}
