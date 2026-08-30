import { sql } from 'drizzle-orm';
import { doublePrecision, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { entity, ferret } from './entities.js';
import { evidence } from './evidence.js';

/**
 * Identity aliases, with history.
 *
 * A separate table from `entity_external_id`, and the distinction is real rather
 * than organisational: **an actor's identity is contested and evolves; a
 * commit's node id does not.**
 *
 * `entity_external_id` maps any entity to identifiers other systems use for it —
 * a commit's GitHub node id, a file's Jira attachment id. Those mappings are
 * facts, they do not need adjudicating, and EPIC-006 replaces them wholesale on
 * re-ingestion because a stale one is simply wrong.
 *
 * An actor alias is different. "These two email addresses are the same person"
 * is a *judgement*, it can be wrong, it can be contested by another provider,
 * and it can stop being true when an address is reassigned. So it needs
 * evidence, confidence, temporal validity and collision detection — none of
 * which belong on the general-purpose mapping, and all of which EPIC-009
 * requires.
 */

export const identityAlias = ferret.table(
  'identity_alias',
  {
    /** Derived from (system, externalId, actorId, validFrom). */
    id: uuid('id').primaryKey(),

    system: text('system').notNull(),
    externalId: text('external_id').notNull(),

    actorId: uuid('actor_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    /** `developer` or `agent`. Never merged across the two. */
    actorClass: text('actor_class').notNull(),

    /**
     * What supports the mapping.
     *
     * Nullable because a provider may state an identity directly — a GitHub
     * login *is* that account — where there is nothing to infer. It is
     * reconciliation, not assertion, that must be auditable.
     */
    evidenceId: uuid('evidence_id').references(() => evidence.id, { onDelete: 'set null' }),
    /** `NULL` is unknown, which is not the same as zero. */
    confidence: doublePrecision('confidence'),

    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    /** `NULL` means the mapping still holds. */
    validTo: timestamp('valid_to', { withTimezone: true }),

    firstIndexedAt: timestamp('first_indexed_at', { withTimezone: true }).notNull().defaultNow(),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * At most one *current* actor per external identity.
     *
     * A database-level backstop, not the primary mechanism: `IdentityStore`
     * detects a collision and reports it, because AC-5 requires collisions to be
     * detected rather than merged, and a constraint violation is a worse way to
     * learn about a judgement call. The index exists so that a code path which
     * forgets to check cannot corrupt the mapping anyway.
     */
    uniqueIndex('identity_alias_current_idx')
      .on(table.system, table.externalId)
      .where(sql`${table.validTo} IS NULL`),
    // "Who is this external identity" — the lookup every ingestion performs.
    index('identity_alias_lookup_idx').on(table.system, table.externalId),
    // "What is this actor known as" — the lookup reconciliation performs.
    index('identity_alias_actor_idx').on(table.actorId),
    index('identity_alias_class_idx').on(table.actorClass),
  ],
);

export type IdentityAliasRow = typeof identityAlias.$inferSelect;
export type NewIdentityAliasRow = typeof identityAlias.$inferInsert;
