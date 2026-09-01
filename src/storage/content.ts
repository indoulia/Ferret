import { sql } from 'drizzle-orm';

import { redactSecrets } from '../security/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { contentBlob } from './schema/content.js';

/**
 * Deduplicated content storage — EPIC-087.
 *
 * EPIC-108 reads every file's bytes, derives structure, parses, indexes symbols
 * and then discards the bytes; its §4 reserved persisting them for this Epic.
 * The cost of the discard is measured rather than asserted: EPIC-098's harness
 * scores `text-authentication` 0.00 on every metric, because `authenticate`
 * appears in `login.ts`'s body and in no path, and Ferret indexes only what a
 * file is *called*.
 *
 * Keyed by content hash and nothing else. The same bytes at two paths, in two
 * revisions or in two clones are one row, and the row outlives every file
 * version that referenced it — collection is EPIC-088's, deliberately.
 */

/** Why a row carries no text. Never `NULL` alone — EPIC-087 §8.6. */
export const OMITTED_REASONS = {
  /** EPIC-030 classified the content as binary. Its bytes are not stored. */
  BINARY: 'binary',
  /** Longer than {@link MAX_STORED_TEXT_BYTES}. */
  OVER_SIZE_BOUND: 'over-size-bound',
  /** Not decodable as UTF-8. Transcoding is out of scope; this is the record of that. */
  UNDECODABLE: 'undecodable',
  /** EPIC-082 could not scan it for credentials, so it is not stored. */
  SECRET_SCAN_FAILED: 'secret-scan-failed',
} as const;

export type OmittedReason = (typeof OMITTED_REASONS)[keyof typeof OMITTED_REASONS];

/**
 * The largest body stored as searchable text.
 *
 * Below EPIC-082's 1 MB scan ceiling on purpose, so `redactSecrets`'s
 * fail-closed path is unreachable for anything this store accepts — a file that
 * would be dropped unscanned is refused for its size first, which is the
 * honest reason.
 *
 * A separate, smaller bound than EPIC-108's `maxBytes`, because they answer
 * different questions: parsing a large file is useful, and putting it in a GIN
 * index is a cost with no matching answer.
 */
export const MAX_STORED_TEXT_BYTES = 512 * 1024;

export interface StoreContentInput {
  readonly contentHash: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string | undefined;
  readonly encoding?: string | undefined;
  /** EPIC-030's verdict. A binary file is recorded, never decoded. */
  readonly binary?: boolean | undefined;
}

export interface StoredContent {
  readonly contentHash: string;
  /** True when this exact content was already on record and nothing was written. */
  readonly deduplicated: boolean;
  /** Absent when the body was stored. */
  readonly omittedReason: OmittedReason | undefined;
  /** Redaction kinds and counts — never the values. Empty when nothing fired. */
  readonly redacted: Readonly<Record<string, number>>;
}

export interface ContentBody {
  readonly contentHash: string;
  readonly byteSize: number;
  readonly mediaType: string | undefined;
  readonly encoding: string | undefined;
  readonly text: string | undefined;
  readonly omittedReason: OmittedReason | undefined;
}

export interface ContentStats {
  readonly blobs: number;
  readonly withText: number;
  readonly textBytes: number;
}

/**
 * What {@link ContentStore.store} decided before it touched the database.
 *
 * Exported and pure so the decision is testable without PostgreSQL, and so the
 * reason a body is missing is derived in exactly one place.
 */
export function classifyContent(input: StoreContentInput): {
  text: string | undefined;
  omittedReason: OmittedReason | undefined;
  redacted: Readonly<Record<string, number>>;
} {
  const none: Readonly<Record<string, number>> = {};
  if (input.binary === true) {
    return { text: undefined, omittedReason: OMITTED_REASONS.BINARY, redacted: none };
  }
  if (input.bytes.byteLength > MAX_STORED_TEXT_BYTES) {
    return { text: undefined, omittedReason: OMITTED_REASONS.OVER_SIZE_BOUND, redacted: none };
  }

  let decoded: string;
  try {
    // `fatal` is the whole point: the default replaces undecodable sequences
    // with U+FFFD, which would store a body that silently differs from the file
    // and index lexemes the repository does not contain.
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return { text: undefined, omittedReason: OMITTED_REASONS.UNDECODABLE, redacted: none };
  }

  // EPIC-087 §8.2 — before the insert, never on the way out. A credential that
  // reaches the table is in the index, in every backup and in every headline,
  // and a read-time control is one a new caller can forget to apply.
  const redaction = redactSecrets(decoded);
  if (redaction.found['unscannable'] !== undefined) {
    return { text: undefined, omittedReason: OMITTED_REASONS.SECRET_SCAN_FAILED, redacted: redaction.found };
  }
  return { text: redaction.text, omittedReason: undefined, redacted: redaction.found };
}

export class ContentStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Record one file's content, once.
   *
   * Idempotent by hash: a second call for content already on record writes
   * nothing and reports `deduplicated`. `ON CONFLICT DO NOTHING` rather than a
   * read-then-write, so two indexers racing on the same blob cannot both decide
   * it is absent.
   */
  async store(input: StoreContentInput): Promise<StoredContent> {
    const decision = classifyContent(input);
    try {
      const inserted = await this.#db
        .insert(contentBlob)
        .values({
          contentHash: input.contentHash,
          byteSize: input.bytes.byteLength,
          mediaType: input.mediaType ?? null,
          encoding: input.encoding ?? null,
          textContent: decision.text ?? null,
          omittedReason: decision.omittedReason ?? null,
        })
        .onConflictDoNothing({ target: contentBlob.contentHash })
        .returning({ contentHash: contentBlob.contentHash });

      return {
        contentHash: input.contentHash,
        deduplicated: inserted.length === 0,
        omittedReason: decision.omittedReason,
        redacted: decision.redacted,
      };
    } catch (error) {
      throw classifyDatabaseError(error, 'content.store');
    }
  }

  /**
   * The body Ferret holds for a hash, if it holds one.
   *
   * No permission parameter, and that is deliberate rather than an omission:
   * this is the internal read, used by a consumer that already has the hash from
   * an entity it was allowed to see. The *retrieval* path never reaches content
   * this way — it joins through `entity` and filters there (EPIC-087 §8.3).
   */
  async read(contentHash: string): Promise<ContentBody | undefined> {
    try {
      const rows = await this.#db
        .select()
        .from(contentBlob)
        .where(sql`${contentBlob.contentHash} = ${contentHash}`)
        .limit(1);
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        contentHash: row.contentHash,
        byteSize: row.byteSize,
        mediaType: row.mediaType ?? undefined,
        encoding: row.encoding ?? undefined,
        text: row.textContent ?? undefined,
        omittedReason: (row.omittedReason ?? undefined) as OmittedReason | undefined,
      };
    } catch (error) {
      throw classifyDatabaseError(error, 'content.read');
    }
  }

  /** What the store holds, for `ferret status` — EPIC-087 §12. */
  async stats(): Promise<ContentStats> {
    try {
      const rows = await this.#db.execute<{
        [column: string]: unknown;
        blobs: string;
        with_text: string;
        text_bytes: string;
      }>(sql`
        SELECT count(*)::text AS blobs,
               count(text_content)::text AS with_text,
               coalesce(sum(octet_length(text_content)), 0)::text AS text_bytes
          FROM ferret.content_blob`);
      const row = rows.rows[0];
      return {
        blobs: Number(row?.blobs ?? '0'),
        withText: Number(row?.with_text ?? '0'),
        textBytes: Number(row?.text_bytes ?? '0'),
      };
    } catch (error) {
      throw classifyDatabaseError(error, 'content.stats');
    }
  }
}
