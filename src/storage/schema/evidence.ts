import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { entity, ferret } from './entities.js';

/**
 * Evidence, as PostgreSQL sees it.
 *
 * The table is **append-only in content**. `state`, `superseded_by` and
 * `last_checked_at` are Ferret's own interpretation and may change; everything
 * else is written once and covered by `integrity_hash`. That split is the point:
 * Governance §6 forbids silently rewriting source evidence, and a schema where
 * the observation and the opinion about it share a mutability rule cannot
 * enforce that.
 */

export const evidence = ferret.table(
  'evidence',
  {
    /** Derived from the observation's identity — see `evidenceKey`. */
    id: uuid('id').primaryKey(),

    /** The entity this is evidence about. */
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => entity.id, { onDelete: 'cascade' }),
    /** Which fact within the subject. `NULL` means the entity as a whole. */
    field: text('field'),
    /**
     * What was observed or concluded.
     *
     * `jsonb` rather than text: a statement can be a string, a number, a list of
     * authors or a structured extraction, and forcing it through text would make
     * comparing two statements a string-formatting question.
     */
    statement: jsonb('statement').notNull(),

    method: text('method').notNull(),
    producer: text('producer').notNull(),
    /** Governance §21 — reproducibility needs the version, not just the name. */
    producerVersion: text('producer_version').notNull(),

    sourceSystem: text('source_system').notNull(),
    sourceId: text('source_id'),
    sourceUrl: text('source_url'),
    /** Where in the source: a line range, a page, a cell, a byte offset. */
    locator: jsonb('locator'),
    /** Hash of the source content read, which is what makes staleness visible. */
    sourceContentHash: text('source_content_hash'),

    /** `NULL` is unknown, which is not the same as zero. */
    confidence: doublePrecision('confidence'),
    completeness: text('completeness').notNull(),
    authority: integer('authority').notNull().default(0),

    /** When the source says the fact was true. */
    observedAt: timestamp('observed_at', { withTimezone: true }),
    /** When Ferret recorded it. Immutable. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    /** When Ferret last confirmed the record still applies. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull().defaultNow(),

    /** Ferret's interpretation. Mutable; excluded from the integrity hash. */
    state: text('state').notNull(),
    /** The record that replaced this one, when one did. */
    supersededBy: uuid('superseded_by'),

    /** Who may see this. EPIC-058 and EPIC-083 enforce it. */
    permissionScope: text('permission_scope'),

    /** Covers the immutable half only, so a superseded record still verifies. */
    integrityHash: text('integrity_hash').notNull(),
    /** True when a credential-shaped value was masked before storage. */
    redacted: boolean('redacted').notNull().default(false),
  },
  (table) => [
    // "What is the evidence for this fact" — the query every traceable answer
    // and every conflict check performs.
    index('evidence_subject_idx').on(table.subjectId, table.field),
    index('evidence_state_idx').on(table.state),
    index('evidence_source_idx').on(table.sourceSystem, table.sourceId),
    // "Which evidence did this parser version produce" — what a re-extraction
    // after a parser upgrade needs (Governance §21).
    index('evidence_producer_idx').on(table.producer, table.producerVersion),
    index('evidence_permission_idx').on(table.permissionScope),
  ],
);

/**
 * The provenance chain, as edges.
 *
 * A join table rather than an array column because it is traversed in **both**
 * directions: "what supports this conclusion" and "what did this observation go
 * on to support". The second is what a re-extraction needs — when a parser is
 * found to be wrong, everything downstream of its output has to be found.
 */
export const evidenceDerivation = ferret.table(
  'evidence_derivation',
  {
    /** The derived record. */
    evidenceId: uuid('evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade' }),
    /** A record it was derived from. */
    sourceEvidenceId: uuid('source_evidence_id')
      .notNull()
      .references(() => evidence.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.evidenceId, table.sourceEvidenceId] }),
    index('evidence_derivation_source_idx').on(table.sourceEvidenceId),
  ],
);

export type EvidenceRow = typeof evidence.$inferSelect;
export type NewEvidenceRow = typeof evidence.$inferInsert;
export type EvidenceDerivationRow = typeof evidenceDerivation.$inferSelect;
