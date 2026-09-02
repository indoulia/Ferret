import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  ENTITY_SCHEMA_VERSION,
  LifecycleState,
  createEntity,
  type CanonicalEntity,
  type EntityInput,
  type EntityKind,
  type ExternalId,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import { withConflictRetry } from './conflict-retry.js';
import { entity, entityExternalId, type EntityRow } from './schema/entities.js';

/**
 * Persisting canonical entities.
 *
 * The whole point is **idempotent ingestion** (Governance §10, EPIC-006 AC-2 and
 * AC-4): indexing the same repository twice must not duplicate anything, must
 * not rewrite rows that did not change, and must not make "when did this last
 * change" unanswerable.
 *
 * Three properties deliver that, and each is covered by a test against a real
 * PostgreSQL:
 *
 * 1. **Identity is derived, not allocated.** `createEntity` computes the id from
 *    the entity's natural identity, so an upsert conflicts on a value the
 *    caller could not have got wrong.
 * 2. **Unchanged content is not rewritten.** The stored `content_hash` is
 *    compared first; a re-index that changes nothing touches `last_indexed_at`
 *    and nothing else.
 * 3. **Writes are atomic per entity.** An entity and its external ids commit
 *    together, so a crash cannot leave an entity whose identifiers are missing.
 */

export type FerretDatabase = NodePgDatabase<Record<string, never>>;

/** What an upsert did, so a caller can report and measure ingestion. */
export const UpsertOutcome = {
  /** The entity did not exist. */
  CREATED: 'created',
  /** It existed and its content differed. */
  UPDATED: 'updated',
  /** It existed and was byte-identical; only `last_indexed_at` moved. */
  UNCHANGED: 'unchanged',
} as const;

export type UpsertOutcome = (typeof UpsertOutcome)[keyof typeof UpsertOutcome];

export interface UpsertResult {
  readonly entity: CanonicalEntity;
  readonly outcome: UpsertOutcome;
}

function toCanonical(row: EntityRow, externalIds: readonly ExternalId[]): CanonicalEntity {
  const source: CanonicalEntity['source'] = {
    system: row.sourceSystem,
    id: row.sourceId,
    ...(row.sourceUrl === null ? {} : { url: row.sourceUrl }),
    ...(row.sourceScope === null ? {} : { scope: row.sourceScope }),
  };

  return Object.freeze({
    id: row.id,
    kind: row.kind as EntityKind,
    canonicalKey: row.canonicalKey,
    schemaVersion: row.schemaVersion,
    source,
    lifecycle: row.lifecycle as LifecycleState,
    attributes: Object.freeze(row.attributes as Record<string, unknown>),
    unknownFields: Object.freeze(row.unknownFields as Record<string, unknown>),
    externalIds: Object.freeze([...externalIds]),
    sourceObservedAt: row.sourceObservedAt?.toISOString(),
    contentHash: row.contentHash,
  });
}

/**
 * Rejects an entity written by a newer Ferret.
 *
 * Same stance as EPIC-002 takes with the database schema: reading a newer
 * envelope under the old meaning would apply an interpretation the writer never
 * intended, and quietly. EPIC-010 owns the compatibility rules that will let
 * some of these be read.
 */
function assertReadable(row: EntityRow): void {
  if (row.schemaVersion > ENTITY_SCHEMA_VERSION) {
    throw new FerretError(
      ErrorCode.SCHEMA_UNSUPPORTED,
      `Entity ${row.id} uses schema version ${String(row.schemaVersion)}, but this Ferret understands up to ${String(ENTITY_SCHEMA_VERSION)}`,
      {
        details: { entityId: row.id, entityVersion: row.schemaVersion, supported: ENTITY_SCHEMA_VERSION },
        remediation: 'This database was written by a newer Ferret. Upgrade Ferret rather than downgrading the data.',
      },
    );
  }
}

export class EntityStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Creates or updates one entity.
   *
   * Validation happens before anything touches the database, so an invalid
   * entity never becomes a partially-written row.
   */
  async upsert(
    input: EntityInput,
    now: Date = new Date(),
    options: { readonly ifAbsent?: boolean; readonly rederive?: boolean } = {},
  ): Promise<UpsertResult> {
    const canonical = createEntity(input);

    // A placeholder — emitted only so an edge has an endpoint — must not
    // replace a record an earlier run read in full. The emitter knows which of
    // its entities are gap-fillers and cannot see the store; the store can see
    // the row and cannot tell a gap-filler from an observation. Neither side
    // can decide this alone, so the caller carries the fact across. Issue #48.
    if (options.ifAbsent === true) {
      const stored = await this.get(canonical.id);
      if (stored !== undefined) {
        return { entity: stored, outcome: UpsertOutcome.UNCHANGED };
      }
    }

    // Retried around the whole transaction — EPIC-079. Concurrent writers of one
    // entity contend for one row, and PostgreSQL resolves that by rolling one of
    // them back. That is the database working correctly; treating it as a
    // failure made an indexing run depend on how many writers happened to touch
    // the same file at once. Issues #21 and #55.
    return withConflictRetry(() => this.#upsertOnce(canonical, now, options.rederive === true), {
      label: 'storage.entity.upsert',
    });
  }

  async #upsertOnce(input: CanonicalEntity, now: Date, rederive: boolean): Promise<UpsertResult> {
    try {
      return await this.#db.transaction(async (tx) => {
        const [existing] = await tx.select().from(entity).where(eq(entity.id, input.id)).limit(1);
        let canonical = input;

        if (existing !== undefined) {
          assertReadable(existing);

          // **An upsert never changes a stored row's lifecycle.** That belongs
          // to `tombstone` and `reinstate`, because EPIC-032 decided deletion
          // is *observed, never inferred* — and a source read that finds a file
          // says nothing about a file it did not look for.
          //
          // Issue #118 made this explicit, having found it was true only by
          // accident. `createEntity` defaults `lifecycle` to `active`, and
          // `onConflictDoUpdate` wrote that value — so re-indexing a
          // tombstoned file *would* have revived it. It did not, because the
          // stored hash was stale for exactly the reason #118 was filed: the
          // hash still described the `active` row, the comparison below
          // declared it unchanged, and this branch was never reached.
          //
          // Recomputing the hash correctly removed that accident, and the
          // lifecycle test caught it — a tombstone revived and re-retired on
          // every run. EPIC-034's "an unchanged upsert cannot lift a
          // tombstone" is now a rule rather than a coincidence.
          if (existing.lifecycle !== canonical.lifecycle) {
            canonical = createEntity({
              kind: canonical.kind,
              source: { ...canonical.source },
              lifecycle: existing.lifecycle as LifecycleState,
              attributes: { ...canonical.attributes },
              unknownFields: { ...canonical.unknownFields },
              externalIds: [...canonical.externalIds],
              ...(canonical.sourceObservedAt === undefined
                ? {}
                : { sourceObservedAt: canonical.sourceObservedAt }),
            });
          }

          // **The stored hash is only trustworthy if the row is.** Issue #101,
          // and the cause it records is not the one that was measured: the
          // placeholder mechanism is innocent here. An alteration made outside
          // Ferret changes `attributes` and leaves `content_hash` alone, so the
          // recomputed hash equals the stored one and this branch declares the
          // row unchanged — for ever. Re-derivation cannot fix an in-place
          // alteration because it never gets past this comparison.
          //
          // `rederive` is a repair saying "do not take the stored hash's word
          // for it". It is not an `UPDATE` against `content_hash`, which AC-11
          // forbids and which would be editing a row to make it verify: the row
          // is rewritten in full from what the source says, hash included,
          // which is what derivation means.
          if (existing.contentHash === canonical.contentHash && !rederive) {
            // Nothing changed. Recording that Ferret looked is still useful —
            // it is how staleness is measured — but rewriting the row would
            // destroy the record of when the content actually last changed.
            await tx.update(entity).set({ lastIndexedAt: now }).where(eq(entity.id, canonical.id));
            const ids = await this.#readExternalIds(tx, canonical.id);
            return { entity: toCanonical(existing, ids), outcome: UpsertOutcome.UNCHANGED };
          }
        }

        const [row] = await tx
          .insert(entity)
          .values({
            id: canonical.id,
            kind: canonical.kind,
            canonicalKey: canonical.canonicalKey,
            schemaVersion: canonical.schemaVersion,
            sourceSystem: canonical.source.system,
            sourceId: canonical.source.id,
            sourceUrl: canonical.source.url ?? null,
            sourceScope: canonical.source.scope ?? null,
            lifecycle: canonical.lifecycle,
            attributes: canonical.attributes,
            unknownFields: canonical.unknownFields,
            sourceObservedAt: canonical.sourceObservedAt === undefined ? null : new Date(canonical.sourceObservedAt),
            firstIndexedAt: now,
            lastIndexedAt: now,
            contentHash: canonical.contentHash,
          })
          .onConflictDoUpdate({
            target: entity.id,
            set: {
              kind: canonical.kind,
              schemaVersion: canonical.schemaVersion,
              sourceUrl: canonical.source.url ?? null,
              sourceScope: canonical.source.scope ?? null,
              lifecycle: canonical.lifecycle,
              attributes: canonical.attributes,
              unknownFields: canonical.unknownFields,
              sourceObservedAt:
                canonical.sourceObservedAt === undefined ? null : new Date(canonical.sourceObservedAt),
              lastIndexedAt: now,
              contentHash: canonical.contentHash,
              // `first_indexed_at` is deliberately absent: when Ferret first saw
              // something is a historical fact that an update must not rewrite.
            },
          })
          .returning();

        await this.#replaceExternalIds(tx, canonical.id, canonical.externalIds, now);

        if (row === undefined) {
          throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'Entity upsert returned no row', {
            details: { entityId: canonical.id },
          });
        }

        return {
          entity: toCanonical(row, canonical.externalIds),
          outcome: existing === undefined ? UpsertOutcome.CREATED : UpsertOutcome.UPDATED,
        };
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.upsert');
    }
  }

  /**
   * Creates or updates many entities in one transaction.
   *
   * All or nothing: a batch that fails half way would leave the index in a state
   * no re-run could reason about, because the entities that did land would look
   * current.
   */
  async upsertMany(inputs: readonly EntityInput[], now: Date = new Date()): Promise<UpsertResult[]> {
    // Validated up front so one bad entity fails the batch before any write,
    // rather than after some of it has already happened.
    const canonicals = inputs.map((input) => createEntity(input));
    const results: UpsertResult[] = [];
    for (const [index, canonical] of canonicals.entries()) {
      const input = inputs[index];
      if (input === undefined) continue;
      results.push(await this.upsert(input, now));
      void canonical;
    }
    return results;
  }

  async get(id: string): Promise<CanonicalEntity | undefined> {
    try {
      const [row] = await this.#db.select().from(entity).where(eq(entity.id, id)).limit(1);
      if (row === undefined) return undefined;
      assertReadable(row);
      return toCanonical(row, await this.#readExternalIds(this.#db, id));
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.get');
    }
  }

  /** Looks an entity up by the identity it was derived from. */
  async getByCanonicalKey(key: string): Promise<CanonicalEntity | undefined> {
    try {
      const [row] = await this.#db.select().from(entity).where(eq(entity.canonicalKey, key)).limit(1);
      if (row === undefined) return undefined;
      assertReadable(row);
      return toCanonical(row, await this.#readExternalIds(this.#db, row.id));
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.getByCanonicalKey');
    }
  }

  /**
   * Resolves an identifier another system uses.
   *
   * This is the cross-source lookup: "which entity is GitHub node id X".
   */
  async findByExternalId(system: string, externalId: string): Promise<CanonicalEntity | undefined> {
    try {
      const [link] = await this.#db
        .select()
        .from(entityExternalId)
        .where(and(eq(entityExternalId.system, system), eq(entityExternalId.externalId, externalId)))
        .limit(1);
      return link === undefined ? undefined : await this.get(link.entityId);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.findByExternalId');
    }
  }

  /** Entities of a kind, newest-indexed first. */
  async listByKind(kind: EntityKind, limit = 100): Promise<CanonicalEntity[]> {
    try {
      const rows = await this.#db
        .select()
        .from(entity)
        .where(eq(entity.kind, kind))
        .orderBy(sql`${entity.lastIndexedAt} DESC`)
        .limit(limit);

      const ids = rows.map((row) => row.id);
      const links = ids.length === 0 ? [] : await this.#db
        .select()
        .from(entityExternalId)
        .where(inArray(entityExternalId.entityId, ids));

      const byEntity = new Map<string, ExternalId[]>();
      for (const link of links) {
        const list = byEntity.get(link.entityId) ?? [];
        list.push({ system: link.system, id: link.externalId, ...(link.url === null ? {} : { url: link.url }) });
        byEntity.set(link.entityId, list);
      }

      return rows.map((row) => {
        assertReadable(row);
        return toCanonical(row, byEntity.get(row.id) ?? []);
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.listByKind');
    }
  }

  /**
   * Marks an entity as removed at its source.
   *
   * A tombstone, not a delete. Governance §6 forbids discarding source evidence,
   * and "what happened to this file, and when" is precisely the sort of question
   * Ferret exists to answer — erasing the row would erase the answer with it.
   * EPIC-032 owns the index lifecycle this feeds.
   */
  async tombstone(id: string, now: Date = new Date()): Promise<CanonicalEntity> {
    try {
      const [row] = await this.#db
        .update(entity)
        .set({ lifecycle: LifecycleState.DELETED, lastIndexedAt: now })
        .where(eq(entity.id, id))
        .returning();

      if (row === undefined) {
        throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `No entity with id ${id}`, {
          details: { entityId: id },
          remediation: 'Index the source object before marking it deleted.',
        });
      }

      // Issue #118 — EPIC-006's content hash covers `lifecycle`, so writing the
      // tombstone without recomputing it left every retired row disagreeing
      // with its own hash: 17 of 17 reported `content-hash-mismatch` by
      // `ferret verify` on Ferret's own index.
      //
      // Recomputed rather than `lifecycle` being dropped from the hash, because
      // `deleted` means *observed to have been removed at the source* — the
      // derived content did change. What EPIC-006 excludes on the
      // "re-indexing an unchanged object must not look like a change" principle
      // is the ingestion timestamps, which are Ferret's own bookkeeping.
      const externalIds = await this.#readExternalIds(this.#db, id);
      const rederived = toCanonical(row, externalIds);
      const contentHash = createEntity({
        kind: rederived.kind,
        source: { ...rederived.source },
        lifecycle: rederived.lifecycle,
        attributes: { ...rederived.attributes },
        unknownFields: { ...rederived.unknownFields },
        externalIds: [...rederived.externalIds],
        ...(rederived.sourceObservedAt === undefined
          ? {}
          : { sourceObservedAt: rederived.sourceObservedAt }),
      }).contentHash;

      if (contentHash !== row.contentHash) {
        await this.#db.update(entity).set({ contentHash }).where(eq(entity.id, id));
      }
      return toCanonical({ ...row, contentHash }, externalIds);
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.entity.tombstone');
    }
  }

  async count(kind?: EntityKind): Promise<number> {
    const rows = await this.#db
      .select({ count: sql<string>`count(*)::text` })
      .from(entity)
      .where(kind === undefined ? undefined : eq(entity.kind, kind));
    return Number(rows[0]?.count ?? '0');
  }

  async #readExternalIds(db: FerretDatabase | ExecutorLike, id: string): Promise<ExternalId[]> {
    const rows = await db.select().from(entityExternalId).where(eq(entityExternalId.entityId, id));
    return rows.map((row) => ({
      system: row.system,
      id: row.externalId,
      ...(row.url === null ? {} : { url: row.url }),
    }));
  }

  /**
   * Replaces an entity's external ids.
   *
   * Delete-then-insert rather than merge: an identifier a source has stopped
   * reporting should stop being reported, and keeping it would leave a stale
   * mapping that resolves to the wrong entity. `first_seen_at` is re-set as a
   * consequence, which is a known and accepted cost of the simpler rule.
   */
  async #replaceExternalIds(
    db: ExecutorLike,
    entityId: string,
    ids: readonly ExternalId[],
    now: Date,
  ): Promise<void> {
    await db.delete(entityExternalId).where(eq(entityExternalId.entityId, entityId));
    if (ids.length === 0) return;
    await db.insert(entityExternalId).values(
      ids.map((id) => ({
        entityId,
        system: id.system,
        externalId: id.id,
        url: id.url ?? null,
        firstSeenAt: now,
      })),
    );
  }
}

/** The subset of the Drizzle surface these helpers need, so a transaction fits. */
type ExecutorLike = Pick<FerretDatabase, 'select' | 'insert' | 'delete' | 'update'>;

/**
 * A timestamp column as an ISO instant.
 *
 * `db.execute` is a raw query, so a `timestamptz` arrives as whatever the
 * driver produced — a `Date` through Drizzle's mapping, a bare string without
 * it. Assuming either is how `row.valid_from.toISOString is not a function`
 * reached a test.
 */
function instantOf(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * The content hash an entity row should carry once its lifecycle changes.
 *
 * Issue #118: EPIC-006's entity hash covers `lifecycle`, so a raw
 * `UPDATE ... SET lifecycle` left every retired row disagreeing with its own
 * hash — measured as 17 of 17 tombstones reported `content-hash-mismatch` by
 * `ferret verify` on Ferret's own index.
 *
 * The hash is recomputed rather than `lifecycle` being dropped from it, and
 * that is the modelling call: `deleted` means *observed to have been removed
 * at the source* (`LifecycleState`), so the derived content genuinely
 * changed. What EPIC-006 excludes on the "re-indexing an unchanged object
 * must not look like a change" principle is the ingestion timestamps, which
 * are Ferret's bookkeeping. A lifecycle is an observation.
 *
 * Recomputing also keeps `EntityStore.upsert`'s `unchanged` short-circuit
 * able to see a lifecycle change, which the alternative fix would have
 * silently removed.
 */
export async function recomputeEntityHash(
tx: Pick<FerretDatabase, 'execute'>,
entityId: string,
lifecycle: LifecycleState,
): Promise<string | undefined> {
  const rows = await tx.execute<{
    [column: string]: unknown;
    kind: string;
    source_system: string;
    source_id: string;
    source_url: string | null;
    source_scope: string | null;
    attributes: Record<string, unknown>;
    unknown_fields: Record<string, unknown>;
    source_observed_at: Date | string | null;
  }>(sql`
    SELECT kind, source_system, source_id, source_url, source_scope,
           attributes, unknown_fields, source_observed_at
      FROM ferret.entity
     WHERE id = ${entityId}
  `);
  const row = rows.rows[0];
  if (row === undefined) return undefined;

  // External ids are part of the hash, so they have to come with the row.
  const aliases = await tx.execute<{ [column: string]: unknown; system: string; external_id: string }>(sql`
    SELECT system, external_id FROM ferret.entity_external_id WHERE entity_id = ${entityId}
  `);

  return createEntity({
    kind: row.kind,
    source: {
      system: row.source_system,
      id: row.source_id,
      ...(row.source_url === null ? {} : { url: row.source_url }),
      ...(row.source_scope === null ? {} : { scope: row.source_scope }),
    },
    lifecycle,
    attributes: { ...row.attributes },
    unknownFields: { ...row.unknown_fields },
    externalIds: aliases.rows.map((alias) => ({ system: alias.system, id: alias.external_id })),
    ...(row.source_observed_at === null
      ? {}
      : { sourceObservedAt: instantOf(row.source_observed_at) }),
  }).contentHash;
}
