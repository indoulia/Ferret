import { sql } from 'drizzle-orm';
import { index, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { entity, ferret } from './entities.js';

/**
 * Relationships, as PostgreSQL sees them.
 *
 * A plain table with an index on each direction — deliberately **not** a graph
 * database. Governance §14 requires additional infrastructure to be justified by
 * measured requirements, and EPIC-005 introduced none. The traversals Ferret
 * needs are shallow and typed ("which release contains this commit"), not
 * arbitrary-depth path finding, and PostgreSQL answers those from an index.
 * EPIC-050 revisits this with measurements if traversal proves otherwise.
 *
 * The temporal columns are the substance. `valid_from`/`valid_to` say when the
 * fact was true; `first_indexed_at`/`last_indexed_at` say when Ferret learned
 * and last confirmed it. Collapsing those into one timestamp would make
 * "what did this look like last Tuesday" indistinguishable from "what did
 * Ferret believe last Tuesday", and they are different questions.
 */

export const relationship = ferret.table(
  'relationship',
  {
    /** Derived from (from, type, to, valid_from) — see `relationshipKey`. */
    id: uuid('id').primaryKey(),

    fromId: uuid('from_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    toId: uuid('to_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),

    /** When the relationship became true in the world. */
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    /** When it stopped being true. `NULL` means it still is. */
    validTo: timestamp('valid_to', { withTimezone: true }),

    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    /** Which system observed it, so a relationship stays source-traceable. */
    sourceSystem: text('source_system').notNull(),
    sourceId: text('source_id'),

    firstIndexedAt: timestamp('first_indexed_at', { withTimezone: true }).notNull().defaultNow(),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }).notNull().defaultNow(),
    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    // One assertion per (endpoints, type, start). Re-observing the same fact
    // conflicts here rather than inserting a duplicate, which is what makes
    // ingestion idempotent even when a provider replays events.
    uniqueIndex('relationship_assertion_idx').on(table.fromId, table.type, table.toId, table.validFrom),
    // Both directions are indexed because both are traversed: "what does this
    // contain" and "what contains this" are equally common questions.
    index('relationship_from_idx').on(table.fromId, table.type),
    index('relationship_to_idx').on(table.toId, table.type),
    index('relationship_type_idx').on(table.type),
    // Finding the currently-open relationship of a type is the hottest lookup
    // in ingestion: it is what an exclusive type has to close before opening a
    // new one. A partial index keeps it to the rows that can match.
    index('relationship_open_idx')
      .on(table.fromId, table.type)
      .where(sql`${table.validTo} IS NULL`),
    index('relationship_valid_from_idx').on(table.validFrom),
  ],
);

export type RelationshipRow = typeof relationship.$inferSelect;
export type NewRelationshipRow = typeof relationship.$inferInsert;
