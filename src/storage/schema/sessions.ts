import { boolean, check, doublePrecision, integer, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { ferret } from './entities.js';

/**
 * The Session & Agent Memory tables — EPIC-109.
 *
 * The domain (EPIC-039 to EPIC-043) is the authority on what these values mean;
 * these declarations exist so the query layer can type itself, and every column
 * here has a counterpart in migration `0015`. The rationale for the shape lives
 * in that migration, next to the DDL a reviewer actually reads.
 *
 * Indexes are declared in the migration only. Two of them are partial and one
 * is descending, and none survives a round trip through Drizzle's builder
 * unchanged — a declaration here that differed from the DDL would be drift
 * wearing the appearance of agreement. `runs.ts` made the same call.
 */

/** One AI engineering session — EPIC-039. */
export const session = ferret.table(
  'session',
  {
    /** The domain's canonical id, derived from `sessionId`. */
    id: uuid('id').primaryKey(),
    /** The natural key a client knows, and what the child tables reference. */
    sessionId: text('session_id').notNull().unique(),

    provider: text('provider').notNull(),
    /** Distinguishable from the session itself — EPIC-039 AC-2. */
    actorId: text('actor_id').notNull(),

    /** Scope when known; optional and never fabricated — EPIC-039 AC-3. */
    repositoryId: text('repository_id'),
    worktreeId: text('worktree_id'),
    branch: text('branch'),

    /** Not a foreign key — an unresolvable parent ends a lineage walk. */
    parentSessionId: text('parent_session_id'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
    /** `NULL` exactly while the session is active. */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    status: text('status').notNull(),
  },
  (table) => [
    check('session_status_known', sql`${table.status} IN ('active', 'completed', 'abandoned')`),
    check('session_ended_with_status', sql`(${table.endedAt} IS NULL) = (${table.status} = 'active')`),
    check('session_activity_after_start', sql`${table.lastActivityAt} >= ${table.startedAt}`),
  ],
);

export type SessionRow = typeof session.$inferSelect;

/** One captured turn of the transcript — EPIC-040. Append-only evidence. */
export const sessionCapture = ferret.table(
  'session_capture',
  {
    id: uuid('id').primaryKey(),
    sessionId: text('session_id').notNull(),

    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    /** Over the content alone, so a re-read of the same turn is recognisable. */
    contentHash: text('content_hash').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    provider: text('provider').notNull(),
    metadata: jsonb('metadata'),
  },
  (table) => [
    check(
      'session_capture_kind_known',
      sql`${table.kind} IN ('system', 'user', 'assistant', 'tool_call', 'tool_result')`,
    ),
    check('session_capture_sequence_positive', sql`${table.sequence} > 0`),
    unique('session_capture_sequence_unique').on(table.sessionId, table.sequence),
  ],
);

export type SessionCaptureRow = typeof sessionCapture.$inferSelect;

/** Compact resumable state — EPIC-041. Never overwritten. */
export const sessionCheckpoint = ferret.table(
  'session_checkpoint',
  {
    id: uuid('id').primaryKey(),
    sessionId: text('session_id').notNull(),

    provider: text('provider').notNull(),
    checkpointSequence: integer('checkpoint_sequence').notNull(),
    /** The highest captured turn this checkpoint represents — EPIC-041 AC-3. */
    capturedThroughSequence: integer('captured_through_sequence').notNull(),
    checkpointedAt: timestamp('checkpointed_at', { withTimezone: true }).notNull(),
    summary: text('summary').notNull(),
    continuationState: jsonb('continuation_state').notNull(),
    /**
     * Covers the canonicalised instant, not the spelling it arrived with — see
     * `canonicalInstant`. Without that this hash could not be recomputed from
     * the `timestamptz` above.
     */
    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    check('session_checkpoint_sequence_positive', sql`${table.checkpointSequence} > 0`),
    check('session_checkpoint_watermark_nonnegative', sql`${table.capturedThroughSequence} >= 0`),
    unique('session_checkpoint_sequence_unique').on(table.sessionId, table.checkpointSequence),
  ],
);

export type SessionCheckpointRow = typeof sessionCheckpoint.$inferSelect;

/** What a session decided and learned — EPIC-042. */
export const engineeringMemory = ferret.table(
  'engineering_memory',
  {
    /** Derived from session + kind + statement, so re-extraction is idempotent. */
    id: uuid('id').primaryKey(),
    sessionId: text('session_id').notNull(),

    kind: text('kind').notNull(),
    statement: text('statement').notNull(),
    rationale: text('rationale'),
    origin: text('origin').notNull(),
    /** The rule that matched, for an extracted memory. */
    rule: text('rule'),
    confidence: doublePrecision('confidence').notNull(),
    /** `[{ captureId, sequence }, …]` — where the memory came from. */
    derivedFrom: jsonb('derived_from').notNull().default([]),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Credentials removed from the statement and rationale — EPIC-082. */
    redactedSecrets: integer('redacted_secrets').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),

    /** Retained both ways; not foreign keys, so either half can be written first. */
    supersededBy: uuid('superseded_by'),
    supersedes: uuid('supersedes'),

    contentHash: text('content_hash').notNull(),
  },
  (table) => [
    check(
      'engineering_memory_kind_known',
      sql`${table.kind} IN ('decision', 'constraint', 'preference', 'gotcha', 'next-step')`,
    ),
    check('engineering_memory_origin_known', sql`${table.origin} IN ('explicit', 'extracted')`),
    check('engineering_memory_redactions_nonnegative', sql`${table.redactedSecrets} >= 0`),
    check(
      'engineering_memory_extracted_has_evidence',
      sql`${table.origin} <> 'extracted' OR jsonb_array_length(${table.derivedFrom}) > 0`,
    ),
    check(
      'engineering_memory_not_self_superseding',
      sql`${table.supersededBy} IS NULL OR ${table.supersededBy} <> ${table.id}`,
    ),
  ],
);

export type EngineeringMemoryRow = typeof engineeringMemory.$inferSelect;
