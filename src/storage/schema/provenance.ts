import { integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { ferret } from './entities.js';

/**
 * What this installation was restored from — EPIC-090 D2, migration 0014.
 *
 * Append-only. A restored index that could not name its source was
 * indistinguishable from one that had indexed the same repositories itself,
 * which is what F-45 reported; and the source identity cannot simply be written
 * into `ferret.instance`, because two installations answering to one identity is
 * the worse failure. So the target keeps its own identity and this records where
 * its rows came from.
 *
 * Declared here rather than exempted as raw-SQL-only: `ferret.instance` is
 * exempt because the migrator reads it before the query layer exists, and that
 * reason does not apply to this table — `import.ts` writes it through Drizzle
 * like any other.
 */
export const instanceRestore = ferret.table(
  'instance_restore',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),

    /**
     * This installation's own identity at the moment of the restore.
     *
     * Recorded rather than joined, so the history stays readable even if
     * `ferret.instance` were ever re-provisioned.
     */
    instanceId: uuid('instance_id').notNull(),

    /**
     * The identity of the installation that wrote the document.
     *
     * Nullable and meaningfully so: a document written before the manifest
     * carried a source identity cannot supply one, and recording that is better
     * than recording a guess.
     */
    sourceInstanceId: uuid('source_instance_id'),

    sourceFerretVersion: text('source_ferret_version').notNull(),
    sourceExportedAt: timestamp('source_exported_at', { withTimezone: true }).notNull(),

    /** The trailer's digest — identifies the exact document that was imported. */
    documentDigest: text('document_digest').notNull(),

    rowsWritten: integer('rows_written').notNull(),
    restoredAt: timestamp('restored_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The one index lives in migration `0014` only: it is descending, which does
  // not survive a round trip through Drizzle's builder unchanged, and a
  // declaration that differed from the DDL would be drift wearing the
  // appearance of agreement. `runs.ts` takes the same position for the same
  // reason.
  () => [],
);

export type InstanceRestoreRow = typeof instanceRestore.$inferSelect;
