import { check, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { ferret } from './entities.js';

/**
 * A record of every index run that started — EPIC-094 §3.3.
 *
 * Deliberately not `derived_artifact`: that holds one current row per
 * `(kind, scope_id)`, which is right for a watermark and wrong for a history of
 * attempts. A run that failed and the run that succeeded after it are two
 * facts, and the first is the one an operator needs.
 */
export const indexRun = ferret.table(
  'index_run',
  {
    id: uuid('id').primaryKey(),

    /**
     * The repository entity, once one exists.
     *
     * Nullable and not a foreign key: the row is opened *before* the first
     * stage, so on a first index there is no repository entity yet.
     */
    repositoryId: uuid('repository_id'),
    /** What the operator named — available even for a run that got no further. */
    repositoryKey: text('repository_key').notNull(),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** `NULL` means open. An open row whose process is gone is the finding. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** `succeeded` or `failed` once closed; `NULL` while open. */
    outcome: text('outcome'),

    ferretVersion: text('ferret_version').notNull(),
    hostPid: integer('host_pid').notNull(),
    /** EPIC-091's per-invocation id, so rows and log lines line up. */
    invocation: text('invocation'),

    summary: jsonb('summary').notNull().default({}),
  },
  (table) => [
    check('index_run_outcome_known', sql`${table.outcome} IS NULL OR ${table.outcome} IN ('succeeded', 'failed')`),
    check('index_run_closed_together', sql`(${table.finishedAt} IS NULL) = (${table.outcome} IS NULL)`),
    // The two indexes live in migration `0012` only: one is partial and the
    // other is descending, and neither survives a round trip through Drizzle's
    // builder unchanged. A declaration here that differed from the DDL would be
    // drift wearing the appearance of agreement.
  ],
);

export type IndexRunRow = typeof indexRun.$inferSelect;

/** How a run ended. */
export const RunOutcome = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;

export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];
