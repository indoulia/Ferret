import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  integer,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The canonical model, as PostgreSQL sees it.
 *
 * **One table for every kind, not one table per kind.** Sixteen tables would
 * mean sixteen places to add a column for provenance, sixteen joins for a
 * cross-kind query, and a DDL migration every time a provider needed a kind the
 * core did not ship — which EPIC-006 AC-4 forbids. Kind-specific *validation*
 * still happens, in `src/domain/attributes.ts`, before anything reaches here:
 * the schema is open, the writes are not.
 *
 * Where a later Epic proves a query needs typed columns, it can add a table
 * keyed by `entity.id` without disturbing this one. That is a deliberate order:
 * generalise first, specialise where measurement demands it (Governance §17).
 */

export const ferret = pgSchema('ferret');

export const entity = ferret.table(
  'entity',
  {
    /**
     * Derived from `canonical_key`, never generated. Re-ingesting the same
     * object yields the same id, which is what makes indexing idempotent
     * (EPIC-006 AC-2).
     *
     * PostgreSQL's native `uuid` rather than text: 16 bytes instead of 37, and
     * the server rejects a malformed id rather than storing it.
     */
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    /** The identity the id was derived from. Unique by definition. */
    canonicalKey: text('canonical_key').notNull(),
    /** Version of the entity envelope. EPIC-010 owns compatibility. */
    schemaVersion: integer('schema_version').notNull(),

    sourceSystem: text('source_system').notNull(),
    sourceId: text('source_id').notNull(),
    sourceUrl: text('source_url'),
    sourceScope: text('source_scope'),

    /** `deleted` is a tombstone: the row is retained, not removed. */
    lifecycle: text('lifecycle').notNull(),

    /** Canonical fields, validated against the schema for `kind`. */
    attributes: jsonb('attributes').notNull().default(sql`'{}'::jsonb`),
    /**
     * Everything else the source returned.
     *
     * Retained verbatim and never validated. EPIC-006 AC-5 requires unsupported
     * source fields to survive without corrupting the canonical model; keeping
     * them in their own column satisfies both halves at once, and means a
     * provider gaining a field later can promote it without re-fetching.
     */
    unknownFields: jsonb('unknown_fields').notNull().default(sql`'{}'::jsonb`),

    /** When the *source* says the object last changed. */
    sourceObservedAt: timestamp('source_observed_at', { withTimezone: true }),
    /** When Ferret first and last observed it. Distinct from source time. */
    firstIndexedAt: timestamp('first_indexed_at', { withTimezone: true }).notNull().defaultNow(),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Fingerprint of the canonical content.
     *
     * Ingestion compares it to decide whether anything changed, so re-indexing
     * an unchanged repository touches `last_indexed_at` and nothing else.
     */
    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    uniqueIndex('entity_canonical_key_idx').on(table.canonicalKey),
    index('entity_kind_idx').on(table.kind),
    index('entity_source_idx').on(table.sourceSystem, table.sourceId),
    index('entity_lifecycle_idx').on(table.lifecycle),
    // Scope joins: EPIC-032's reconciliation, and "every file in this repository".
    index('entity_scope_idx').on(table.sourceScope, table.kind),
    index('entity_last_indexed_idx').on(table.lastIndexedAt),
  ],
);

/**
 * Identifiers other systems use for the same entity.
 *
 * A separate table rather than a JSON array because these are looked *up*:
 * "which entity does GitHub node id X refer to" is a question EPIC-051 and every
 * synchronization Epic asks constantly, and an array would make it a scan.
 */
export const entityExternalId = ferret.table(
  'entity_external_id',
  {
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    system: text('system').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entityId, table.system, table.externalId] }),
    index('entity_external_lookup_idx').on(table.system, table.externalId),
  ],
);

export type EntityRow = typeof entity.$inferSelect;
export type NewEntityRow = typeof entity.$inferInsert;
export type EntityExternalIdRow = typeof entityExternalId.$inferSelect;
