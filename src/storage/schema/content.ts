import { check, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { ferret } from './entities.js';

/**
 * Content, stored once per distinct hash — EPIC-087.
 *
 * The one table in Ferret keyed by something that is not an identity. Two files
 * with the same bytes are one row here and two entities everywhere else, which
 * is the whole point: EPIC-108 reads every file's bytes on every run and
 * discards them, and a table keyed by path or by entity would store the same
 * body once per path that carries it.
 *
 * `search_vector` is declared in migration `0011` rather than here — Drizzle has
 * no representation for a generated `tsvector` column, and the expression is the
 * substantive part. Migration `0007` made the same call for the same reason.
 */
export const contentBlob = ferret.table(
  'content_blob',
  {
    /** EPIC-022/023's hash, as `file_version.attributes->>'contentHash'` spells it. */
    contentHash: text('content_hash').primaryKey(),

    byteSize: integer('byte_size').notNull(),
    mediaType: text('media_type'),
    encoding: text('encoding'),

    /** The body after EPIC-082 redaction, or `NULL` with a reason beside it. */
    textContent: text('text_content'),
    omittedReason: text('omitted_reason'),

    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('content_blob_text_xor_reason', sql`(${table.textContent} IS NULL) <> (${table.omittedReason} IS NULL)`),
    check(
      'content_blob_reason_known',
      sql`${table.omittedReason} IS NULL OR ${table.omittedReason} IN ('binary', 'over-size-bound', 'undecodable', 'secret-scan-failed')`,
    ),
    check('content_blob_size_non_negative', sql`${table.byteSize} >= 0`),
  ],
);

export type ContentBlobRow = typeof contentBlob.$inferSelect;
