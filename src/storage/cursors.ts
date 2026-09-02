import { and, eq } from 'drizzle-orm';
import type { Pool } from 'pg';

import { VERSION } from '../version.js';

import { CompatibilityService } from './compatibility.js';
import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { derivedArtifact } from './schema/derived.js';

/**
 * Where each source got to — EPIC-075.
 *
 * Ferret already resumed: `RepositoryIndexer` read a watermark before a run and
 * wrote one after, and that mechanism is correct. Three things were wrong with
 * it as *the* answer. It was Git-shaped — the stored position is a commit
 * timestamp, and nothing else resumes that way. It was private to the indexer,
 * so no second source could use it and nothing outside could read one. And
 * nobody could see it, which is why `synchronization` reported a hard-coded
 * `unknown` and `Checkpoints/EPIC-004.md:94` named this Epic as its
 * replacement.
 *
 * **This is a generalisation, not a second mechanism.** It reads and writes the
 * *same* `derived_artifact` rows the indexer already used — same kind, same
 * scope, same metadata, same version gate — so there is one place a cursor
 * lives. A parallel `sync-cursor` kind that nothing wrote would have been
 * speculative generality wearing the shape of an abstraction.
 *
 * **The position is opaque to the core.** A commit timestamp, a page token and
 * an event id are all just *the thing this provider needs to carry on*. A core
 * that understood any of them would have to change when the next source
 * arrives, which Governance §4 exists to prevent. What the core does know is
 * *when* a cursor advanced — a fact about Ferret rather than about the source,
 * and the one "how far behind" is measured from.
 */

/**
 * The artefact kind a cursor is stored under.
 *
 * Deliberately the kind EPIC-031 already writes. Changing it would orphan every
 * watermark in every existing installation and silently trigger a full re-read
 * — a migration disguised as a refactor.
 */
export const CURSOR_ARTIFACT_KIND = 'index';

export interface SyncCursor {
  /** The scope the cursor belongs to — a repository and revision, for Git. */
  readonly scopeId: string;
  /** Which producer wrote it, so a caller can tell whose cursor this is. */
  readonly producer: string;
  /**
   * Whatever the provider needs to resume. Never interpreted here.
   *
   * For Git this is `{ lastCommitAt, indexedAt }`, which is what EPIC-031 has
   * always stored. The core reads no field of it.
   */
  readonly position: Readonly<Record<string, unknown>>;
  /** When Ferret last advanced this cursor. */
  readonly advancedAt: Date;
}

/** A cursor, plus how long ago it moved. For the health surface. */
export interface SyncCursorStatus {
  readonly scopeId: string;
  readonly producer: string;
  readonly advancedAt: Date;
  readonly ageSeconds: number;
}

export class SyncCursorStore {
  readonly #db: FerretDatabase;
  readonly #artifacts: CompatibilityService;

  constructor(db: FerretDatabase, pool: Pool) {
    this.#db = db;
    this.#artifacts = new CompatibilityService(db, pool);
  }

  /**
   * Where this scope got to, or `undefined` when it should start from the
   * beginning.
   *
   * A cursor written by a different producer version is **not** returned —
   * EPIC-031's rule, moved here from inline in the indexer so it is applied in
   * one place rather than remembered per caller. A different build may read or
   * model the source differently, and resuming from its position would leave a
   * gap nothing fills; falling back to a full read is the safe direction.
   */
  async read(scopeId: string): Promise<SyncCursor | undefined> {
    try {
      const artifact = await this.#artifacts.getArtifact(CURSOR_ARTIFACT_KIND, scopeId);
      if (artifact === undefined) return undefined;
      if (artifact.producerVersion !== VERSION) return undefined;

      return {
        scopeId,
        producer: artifact.producer,
        position: artifact.metadata,
        // `builtAt` is an ISO string on the artefact and a `Date` on the row —
        // EPIC-010 serialises it at its boundary. Normalised here so a caller
        // never has to know which side it came from.
        advancedAt: new Date(artifact.builtAt),
      };
    } catch (error) {
      throw classifyDatabaseError(error, 'cursors.read');
    }
  }

  /**
   * Records that this scope has been read up to `position`.
   *
   * An explicit call, never a side effect of reading — EPIC-031's rule that "a
   * run that failed halfway must be repeated, not resumed from a position it
   * never reached". A separate verb is what stops a cursor advancing partway
   * through a run that has not finished.
   */
  async advance(
    producer: string,
    scopeId: string,
    position: Readonly<Record<string, unknown>>,
    now: Date = new Date(),
  ): Promise<void> {
    try {
      await this.#artifacts.recordArtifact(
        {
          kind: CURSOR_ARTIFACT_KIND,
          scopeId,
          producer,
          producerVersion: VERSION,
          metadata: { ...position },
        },
        now,
      );
    } catch (error) {
      throw classifyDatabaseError(error, 'cursors.advance');
    }
  }

  /**
   * Every current cursor, with how long ago it advanced — AC-4.
   *
   * For the health surface, and it returns **no position**: a position is
   * provider data that can name a branch or a URL, and the question this
   * answers is "how far behind", which needs only the age. The rule EPIC-094
   * §11 set for findings, applied here.
   *
   * Version-gated like `read`, so a cursor this build would not resume from is
   * not reported as current progress either.
   */
  async list(now: Date = new Date()): Promise<readonly SyncCursorStatus[]> {
    try {
      const rows = await this.#db
        .select({
          scopeId: derivedArtifact.scopeId,
          producer: derivedArtifact.producer,
          builtAt: derivedArtifact.builtAt,
        })
        .from(derivedArtifact)
        .where(and(eq(derivedArtifact.kind, CURSOR_ARTIFACT_KIND), eq(derivedArtifact.producerVersion, VERSION)));

      return rows.map((row) => ({
        scopeId: row.scopeId ?? '',
        producer: row.producer,
        advancedAt: row.builtAt,
        ageSeconds: Math.max(0, Math.round((now.getTime() - row.builtAt.getTime()) / 1000)),
      }));
    } catch (error) {
      throw classifyDatabaseError(error, 'cursors.list');
    }
  }
}
