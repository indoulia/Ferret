import { readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';

import { EvidenceState } from '../domain/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { contentBlob } from './schema/content.js';
import { entity } from './schema/entities.js';
import { evidence } from './schema/evidence.js';

/**
 * Deletion — EPIC-088, and the only place Ferret does it.
 *
 * Seven Epics defer here; EPIC-006 §D-009 says why it may happen nowhere else:
 * "what happened to this file, when was it deleted, what did it contain — are
 * precisely the questions Ferret indexes history to answer."
 *
 * Every target passes one rule (§8.3): it answers no question. A tombstone
 * fails that rule and has no flag — §8.4.
 */

/** What a prune can reclaim. Each is named by its own flag. */
export const RetentionTarget = {
  /** Content no `file_version` references — EPIC-087's deliberate outliving. */
  BLOBS: 'blobs',
  /** Rotated audit journals above the kept count — EPIC-085's orphans. */
  JOURNALS: 'journals',
  /** `superseded` evidence past an age the caller names, in no live chain. */
  EVIDENCE: 'evidence',
} as const;

export type RetentionTarget = (typeof RetentionTarget)[keyof typeof RetentionTarget];

export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  RetentionTarget.BLOBS,
  RetentionTarget.JOURNALS,
  RetentionTarget.EVIDENCE,
];

/** One target's share of the plan. `bytes` is undefined when unmeasurable. */
export interface RetentionCount {
  readonly target: RetentionTarget;
  readonly rows: number;
  readonly bytes?: number | undefined;
  /** Present when the target could not be counted or deleted — §8.5. */
  readonly failure?: string | undefined;
  /** Why a target reclaimed nothing it might otherwise have. */
  readonly note?: string | undefined;
}

export interface RetentionPlan {
  readonly counts: readonly RetentionCount[];
  /** True when rows were actually deleted; false for a plan alone — §8.2. */
  readonly applied: boolean;
}

export interface RetentionRequest {
  readonly targets: readonly RetentionTarget[];
  /** False plans and deletes nothing. §8.1 — the default. */
  readonly apply?: boolean | undefined;
  /**
   * Minimum age of superseded evidence, in days. Required for
   * {@link RetentionTarget.EVIDENCE}: §8.3 refuses to invent one, because "how
   * long is the history worth keeping" is the caller's judgement.
   */
  readonly supersededOlderThanDays?: number | undefined;
  /** Where the audit journals live, for {@link RetentionTarget.JOURNALS}. */
  readonly journalPath?: string | undefined;
  /** Rotated copies to keep. Matches EPIC-085's writer default. */
  readonly journalKeep?: number | undefined;
}

export const DEFAULT_JOURNAL_KEEP = 5;

function failureOf(target: RetentionTarget, error: unknown): RetentionCount {
  return {
    target,
    rows: 0,
    failure: classifyDatabaseError(error, `retention.${target}`).message,
  };
}

/**
 * Plans and, when asked, performs deletion.
 *
 * One transaction per target (§8.5), so a failure on blobs does not roll back
 * an evidence sweep that succeeded.
 */
export class RetentionService {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  async prune(request: RetentionRequest): Promise<RetentionPlan> {
    const apply = request.apply === true;
    const counts: RetentionCount[] = [];

    for (const target of RETENTION_TARGETS) {
      if (!request.targets.includes(target)) continue;
      counts.push(await this.#target(target, request, apply));
    }

    return { counts, applied: apply };
  }

  async #target(
    target: RetentionTarget,
    request: RetentionRequest,
    apply: boolean,
  ): Promise<RetentionCount> {
    try {
      if (target === RetentionTarget.BLOBS) return await this.#blobs(apply);
      if (target === RetentionTarget.JOURNALS) return journals(request, apply);
      return await this.#evidence(request, apply);
    } catch (error) {
      return failureOf(target, error);
    }
  }

  /**
   * Blobs no `file_version` carries the hash of.
   *
   * EPIC-087 is explicit that a blob "outlives the last file version that
   * referenced it, deliberately: that is what makes it deduplicated storage
   * rather than a cache", so this is reclamation after the fact and never
   * eviction while a reference exists.
   *
   * The anti-join runs on `entity_file_version_content_hash_idx`, which
   * EPIC-087 already created for the read path.
   */
  async #blobs(apply: boolean): Promise<RetentionCount> {
    const unreferenced = this.#db
      .select({ one: sql`1` })
      .from(entity)
      .where(
        and(
          eq(entity.kind, 'file_version'),
          sql`${entity.attributes}->>'contentHash' = ${contentBlob.contentHash}`,
        ),
      );

    const rows = await this.#db
      .select({ contentHash: contentBlob.contentHash, byteSize: contentBlob.byteSize })
      .from(contentBlob)
      .where(notExists(unreferenced));

    const bytes = rows.reduce((total, row) => total + row.byteSize, 0);
    if (!apply || rows.length === 0) {
      return { target: RetentionTarget.BLOBS, rows: rows.length, bytes };
    }

    // Re-checked inside the transaction rather than deleting the hashes just
    // listed: a concurrent index run may have written a `file_version` for one
    // of them between the count and the delete, and deleting by list would
    // remove content a live row now points at.
    const deleted = await this.#db.transaction(async (tx) =>
      tx
        .delete(contentBlob)
        .where(
          and(
            inArray(
              contentBlob.contentHash,
              rows.map((row) => row.contentHash),
            ),
            notExists(unreferenced),
          ),
        )
        .returning({ byteSize: contentBlob.byteSize }),
    );

    return {
      target: RetentionTarget.BLOBS,
      rows: deleted.length,
      bytes: deleted.reduce((total, row) => total + row.byteSize, 0),
    };
  }

  /**
   * Superseded evidence past the caller's age, and in no live derivation chain.
   *
   * Two guards, not one. `state = 'superseded'` means EPIC-047 recorded a
   * replacement carrying the current answer — but `evidence_derivation`
   * cascades on delete, so a superseded record that a **current** record was
   * derived from still answers "where did this conclusion come from", and
   * deleting it would erase that edge silently. EPIC-046's `derivedFrom` chain
   * is the thing §8.3 protects here.
   */
  async #evidence(request: RetentionRequest, apply: boolean): Promise<RetentionCount> {
    const days = request.supersededOlderThanDays;
    if (days === undefined || !Number.isFinite(days) || days < 0) {
      return {
        target: RetentionTarget.EVIDENCE,
        rows: 0,
        note: 'An age in days is required; EPIC-088 §8.3 refuses to choose one.',
      };
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Raw, because the guard is a correlated sub-select against `evidence`
    // itself: the candidate row is the *source* of a derivation whose derived
    // row must not be current. Two aliases of one table is the part a builder
    // makes harder to read than SQL does.
    const eligible = sql`
      SELECT candidate.id AS id
        FROM ferret.evidence AS candidate
       WHERE candidate.state = ${EvidenceState.SUPERSEDED}
         AND candidate.recorded_at < ${cutoff}
         AND NOT EXISTS (
               SELECT 1
                 FROM ferret.evidence_derivation AS edge
                 JOIN ferret.evidence AS derived ON derived.id = edge.evidence_id
                WHERE edge.source_evidence_id = candidate.id
                  AND derived.state IN (${EvidenceState.CURRENT}, ${EvidenceState.CONFLICTING})
             )
    `;
    const found = await this.#db.execute<{ [column: string]: unknown; id: string }>(eligible);
    const rows = found.rows;

    if (!apply || rows.length === 0) {
      return { target: RetentionTarget.EVIDENCE, rows: rows.length };
    }

    const deleted = await this.#db.transaction(async (tx) =>
      tx
        .delete(evidence)
        .where(
          and(
            inArray(
              evidence.id,
              rows.map((row) => row.id),
            ),
            eq(evidence.state, EvidenceState.SUPERSEDED),
          ),
        )
        .returning({ id: evidence.id }),
    );

    return { target: RetentionTarget.EVIDENCE, rows: deleted.length };
  }
}

/**
 * Rotated journals above the kept count.
 *
 * EPIC-085's writer removes exactly `keepFiles + 1` on each rotation, which
 * bounds growth at a *fixed* setting and orphans everything above it when the
 * setting drops: an install that kept ten copies and now keeps two never
 * touches `.4` again. Those are the files this deletes.
 *
 * A filesystem target, so it runs outside the database transaction and is
 * reported alongside the rest — the reason §8.5 is per target.
 */
function journals(request: RetentionRequest, apply: boolean): RetentionCount {
  const path = request.journalPath;
  if (path === undefined) {
    return {
      target: RetentionTarget.JOURNALS,
      rows: 0,
      note: 'No journal path was given, so there is nothing to examine.',
    };
  }

  const keep = request.journalKeep ?? DEFAULT_JOURNAL_KEEP;
  const name = basename(path);
  const directory = dirname(path);

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // An install that has never written an event has no directory, which is
    // nothing to reclaim rather than a failure.
    return { target: RetentionTarget.JOURNALS, rows: 0, bytes: 0 };
  }

  const orphans: { readonly file: string; readonly bytes: number }[] = [];
  for (const file of entries) {
    // `audit-events.ndjson.7` — the live journal itself has no suffix and is
    // never a candidate.
    const suffix = file.startsWith(`${name}.`) ? file.slice(name.length + 1) : undefined;
    if (suffix === undefined || !/^\d+$/.test(suffix)) continue;
    if (Number(suffix) <= keep) continue;
    try {
      orphans.push({ file, bytes: statSync(join(directory, file)).size });
    } catch {
      continue;
    }
  }

  const bytes = orphans.reduce((total, one) => total + one.bytes, 0);
  if (!apply) return { target: RetentionTarget.JOURNALS, rows: orphans.length, bytes };

  let removed = 0;
  let reclaimed = 0;
  for (const orphan of orphans) {
    try {
      rmSync(join(directory, orphan.file), { force: true });
      removed += 1;
      reclaimed += orphan.bytes;
    } catch {
      // Best-effort, as EPIC-085's own rotation is: a file that cannot be
      // removed is reported as not removed rather than failing the target.
    }
  }

  return {
    target: RetentionTarget.JOURNALS,
    rows: removed,
    bytes: reclaimed,
    ...(removed === orphans.length ? {} : { failure: 'Some rotated journals could not be removed.' }),
  };
}

/** True when the plan would delete something. Used by the CLI's confirmation. */
export function planReclaims(plan: RetentionPlan): boolean {
  return plan.counts.some((count) => count.rows > 0);
}
