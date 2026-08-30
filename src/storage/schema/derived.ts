import { index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ferret } from './entities.js';

/**
 * Derived artefacts and what produced them.
 *
 * EPIC-010 AC-5: a derived index must be able to identify the schema, parser or
 * model version that produced it. Governance §21 says why — an index built by
 * `pdf@6.3.289` is not interchangeable with one the current parser would build,
 * and serving results from the old one means serving results nobody could
 * reproduce.
 *
 * Deliberately generic. Ferret has no indexes yet; EPIC-031 will add one,
 * EPIC-054 embeddings, EPIC-060 answer packs. Each is a *derived artefact* with
 * a producer, a version and a scope, and each needs the same question answered:
 * "was this built by something we still trust?" One table answers it for all of
 * them, so the check does not have to be reinvented three times — and
 * reinventing it is how one of the three ends up without it.
 */

export const derivedArtifact = ferret.table(
  'derived_artifact',
  {
    id: uuid('id').primaryKey(),

    /** What kind of artefact: `index`, `embedding`, `summary`, `answer-pack`. */
    kind: text('kind').notNull(),
    /**
     * What the artefact covers — an entity, a repository, or the whole
     * installation for a global index. `NULL` means installation-wide.
     */
    scopeId: uuid('scope_id'),

    /** What built it, and at which version. Both matter for staleness. */
    producer: text('producer').notNull(),
    producerVersion: text('producer_version').notNull(),
    /** The canonical schema version in force when it was built. */
    schemaVersion: integer('schema_version').notNull(),

    /**
     * Hash of the source content it was derived from.
     *
     * Distinguishes "the producer changed" from "the source changed". Both make
     * an artefact stale, and they call for the same action but for different
     * reasons — and an operator asking *why* everything is rebuilding deserves
     * the real answer.
     */
    sourceContentHash: text('source_content_hash'),

    /** Anything the producer wants to record about how it built this. */
    metadata: jsonb('metadata').notNull().default({}),

    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
    /** When Ferret last confirmed the artefact is still valid. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),
    /** `valid`, `stale`, or `rebuilding`. */
    state: text('state').notNull(),
  },
  (table) => [
    // One current artefact per (kind, scope). Rebuilding replaces rather than
    // accumulating, or a stale artefact could still be selected.
    uniqueIndex('derived_artifact_scope_idx').on(table.kind, table.scopeId),
    // "What did this producer version build" — the sweep a producer upgrade runs.
    index('derived_artifact_producer_idx').on(table.producer, table.producerVersion),
    index('derived_artifact_state_idx').on(table.state),
  ],
);

export type DerivedArtifactRow = typeof derivedArtifact.$inferSelect;
export type NewDerivedArtifactRow = typeof derivedArtifact.$inferInsert;
