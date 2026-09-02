import { sql } from 'drizzle-orm';

import { EntityKind, LifecycleState, RelationshipType } from '../domain/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';

/**
 * Reconciling what Ferret believes exists with what it observed.
 *
 * Everything before EPIC-032 taught Ferret to observe and remember. Nothing
 * taught it to stop believing. Measured against Ferret's own repository:
 * thirteen of three hundred and eighteen indexed files no longer existed, every
 * one of them recorded `active`, every one of them holding an **open**
 * `repository_contains_file` edge — and every one of them with a
 * `commit_modifies_file` edge whose metadata already read `change: deleted`.
 *
 * That is the shape of the problem. The observation was made, stored, and never
 * acted on. So this is a **reconciliation** rather than a delta: it asks the
 * graph what the newest thing anyone said about each file was, and makes the
 * file's lifecycle agree. Processing only the current run's changes would have
 * left those thirteen wrong for ever, because an incremental run reads no
 * commit that mentions them.
 *
 * **Deletion is observed, never inferred.** The rejected design diffed the tree
 * against the graph and tombstoned whatever was missing. It is cheaper and it is
 * wrong: absence from a listing is evidence of deletion only if the listing was
 * complete, and a sweep that ran on a truncated listing would tombstone most of
 * a large repository while looking exactly like a successful run. Building on
 * positive evidence makes the safety property hold by construction.
 */

/** What the graph says should change about one entity's lifecycle. */
export interface LifecycleChange {
  readonly entityId: string;
  /** The path, for logging and for reporting to a person. */
  readonly path: string;
  /** `retire` when the newest observation is a deletion, `reinstate` otherwise. */
  readonly action: 'retire' | 'reinstate';
  /**
   * When the fact changed — the instant of the commit that caused it.
   *
   * Not the instant Ferret found out. A file deleted in January and indexed in
   * August has an interval ending in January, because EPIC-007 keeps valid time
   * and index time apart precisely so that both questions stay answerable.
   */
  readonly at: Date;
}

/**
 * One branch Ferret still believes this repository contains.
 *
 * Refs are reconciled the other way round from files. A file is retired from a
 * *positive observation of deletion* — a commit that says `change: deleted` —
 * because Git records one. Git records nothing when a ref goes, so for refs the
 * complete enumeration **is** the positive observation, which is EPIC-032 §3.4
 * and the reason AC-7 is worded around completeness rather than around an event.
 */
export interface LiveBranch {
  readonly entityId: string;
  /** The ref, for logging and for reporting to a person. */
  readonly ref: string;
}

export class IndexLifecycleStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Files whose recorded lifecycle disagrees with the newest change observed
   * about them.
   *
   * Scoped by the repository entity id, and that scoping is the security
   * boundary: `source_scope` is set by Ferret from the repository it is
   * indexing, never by repository content, so no repository can cause another's
   * entities to be retired. Every value is a bind parameter, attribute names
   * included.
   */
  async pendingChanges(repositoryId: string, limit = 10_000): Promise<readonly LifecycleChange[]> {
    try {
      const rows = await this.#db.execute<{
        entity_id: string;
        path: string | null;
        change: string | null;
        valid_from: Date | string;
        lifecycle: string;
      }>(sql`
        WITH newest AS (
          SELECT DISTINCT ON (r.to_id)
                 r.to_id           AS entity_id,
                 r.metadata->>'change' AS change,
                 r.valid_from      AS valid_from
            FROM ferret.relationship r
            JOIN ferret.entity f ON f.id = r.to_id
           WHERE r.type = ${RelationshipType.COMMIT_MODIFIES_FILE}
             AND f.kind = 'file'
             AND f.source_scope = ${repositoryId}
           -- Newest statement wins. A file deleted and later re-added is alive,
           -- and the ordering is what makes that fall out rather than needing a
           -- rule of its own.
           --
           -- Git commit timestamps have one-second resolution, so a delete and
           -- a re-add can share an instant — routinely, on a machine fast
           -- enough, which is how Linux CI failed this while Windows passed.
           -- Without a tiebreak the winner is whichever row PostgreSQL happened
           -- to return first, so the same repository gave different answers on
           -- different machines.
           --
           -- The tie is broken toward deletion, which is the direction that can
           -- be corrected: the caller holds the file tree at the indexed
           -- revision, and a file it can see there is reinstated. Breaking it
           -- toward presence instead would need absence from the tree to
           -- *condemn* a file in order to be corrected, and inferring deletion
           -- from absence is the one thing this design refuses to do.
           ORDER BY r.to_id,
                    r.valid_from DESC,
                    (r.metadata->>'change' = 'deleted') DESC
        )
        SELECT n.entity_id, n.change, n.valid_from, e.lifecycle, e.attributes->>'path' AS path
          FROM newest n
          JOIN ferret.entity e ON e.id = n.entity_id
         -- An open containment edge counts as disagreement even when the entity
         -- is already tombstoned. Keying only off the entity state let a full
         -- re-index reopen the edge — the commit that *added* the file is a
         -- perfectly good observation, it is simply not the newest one — and the
         -- sweep saw nothing to do because the entity was already marked
         -- deleted. The result was a tombstoned file the repository still
         -- claimed to contain.
         WHERE (n.change = 'deleted'
                AND (e.lifecycle = ${LifecycleState.ACTIVE}
                     OR EXISTS (SELECT 1 FROM ferret.relationship c
                                 WHERE c.to_id = n.entity_id
                                   AND c.from_id = ${repositoryId}
                                   AND c.type = ${RelationshipType.REPOSITORY_CONTAINS_FILE}
                                   AND c.valid_to IS NULL)))
            OR (n.change IS DISTINCT FROM 'deleted' AND e.lifecycle = ${LifecycleState.DELETED})
         ORDER BY n.valid_from
         LIMIT ${limit}
      `);

      return rows.rows.map((row) => ({
        entityId: row.entity_id,
        path: row.path ?? row.entity_id,
        action: row.change === 'deleted' ? ('retire' as const) : ('reinstate' as const),
        at: row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from),
      }));
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.lifecycle.pending');
    }
  }

  /**
   * Records that a file stopped existing, and when.
   *
   * A tombstone, not a delete. Governance §6 forbids discarding source evidence,
   * and "what happened to this file" is exactly the question Ferret exists to
   * answer — erasing the row would erase the answer with it.
   *
   * The entity and its containment edge move together, in one transaction. A
   * file marked deleted whose repository still claims to contain it is a state
   * no query can interpret, and leaving that window open is how a crash turns
   * one wrong answer into two.
   */
  async retire(entityId: string, repositoryId: string, at: Date, now: Date = new Date()): Promise<boolean> {
    return this.#retireContained(entityId, repositoryId, RelationshipType.REPOSITORY_CONTAINS_FILE, at, now);
  }

  /**
   * Branches this repository is still believed to contain.
   *
   * Returned in full rather than diffed in SQL against the observed set. The
   * caller already holds that set, a repository's ref count is small, and an
   * `IN` list built from provider output is a query whose shape depends on
   * repository content.
   *
   * A branch already tombstoned but still holding an **open** containment edge
   * counts as live, for the reason the file query records at length: keying only
   * off the entity state let a re-index reopen the edge while the sweep saw
   * nothing to do.
   */
  async liveBranches(repositoryId: string): Promise<readonly LiveBranch[]> {
    try {
      const rows = await this.#db.execute<{ entity_id: string; ref: string | null }>(sql`
        SELECT e.id AS entity_id, e.attributes->>'ref' AS ref
          FROM ferret.entity e
         WHERE e.kind = ${EntityKind.BRANCH}
           -- Set by Ferret from the repository being indexed, never from
           -- repository content, so no repository can reach another's refs.
           AND e.source_scope = ${repositoryId}
           AND (e.lifecycle <> ${LifecycleState.DELETED}
                OR EXISTS (SELECT 1 FROM ferret.relationship c
                            WHERE c.to_id = e.id
                              AND c.from_id = ${repositoryId}
                              AND c.type = ${RelationshipType.REPOSITORY_CONTAINS_BRANCH}
                              AND c.valid_to IS NULL))
         ORDER BY e.id
      `);
      return rows.rows.map((row) => ({ entityId: row.entity_id, ref: row.ref ?? row.entity_id }));
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.lifecycle.branches');
    }
  }

  /**
   * Records that a branch stopped existing, and when.
   *
   * `at` is the observation instant, not a valid time Ferret knows. Git cannot
   * say when a ref was deleted — the same reason `emitGraph` opens containment
   * at Ferret's observation time rather than inventing one. Governance §6: the
   * distinction is recorded rather than smoothed over.
   */
  async retireBranch(
    entityId: string,
    repositoryId: string,
    at: Date,
    now: Date = new Date(),
  ): Promise<boolean> {
    return this.#retireContained(entityId, repositoryId, RelationshipType.REPOSITORY_CONTAINS_BRANCH, at, now);
  }

  /**
   * The tombstone write, shared by files and refs.
   *
   * One body because the invariant is one invariant: the entity and its
   * containment edge move together, in one transaction, under the same
   * advisory key the relationship store uses. Only the containment type
   * differs, and letting the two drift is how a fix lands on files and misses
   * refs.
   */
  async #retireContained(
    entityId: string,
    repositoryId: string,
    containment: RelationshipType,
    at: Date,
    now: Date,
  ): Promise<boolean> {
    try {
      return await this.#db.transaction(async (tx) => {
        // The same key the relationship store locks on, so a sweep and a
        // concurrent assertion of the same edge serialize rather than racing
        // into one open interval and one closed one.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${repositoryId}:${containment}:${entityId}`}, 0))`,
        );

        const updated = await tx.execute<{ id: string }>(sql`
          UPDATE ferret.entity
             SET lifecycle = ${LifecycleState.DELETED}, last_indexed_at = ${now}
           WHERE id = ${entityId} AND lifecycle <> ${LifecycleState.DELETED}
          RETURNING id
        `);

        // Closed at the deleting commit's instant, and never before the
        // interval opened — an edge that ended before it began is a shape every
        // temporal query would then have to defend against.
        const closed = await tx.execute<{ id: string }>(sql`
          UPDATE ferret.relationship
             SET valid_to = GREATEST(valid_from, ${at}), last_indexed_at = ${now}
           WHERE from_id = ${repositoryId}
             AND to_id = ${entityId}
             AND type = ${containment}
             AND valid_to IS NULL
          RETURNING id
        `);

        // The entity and the edge are retired independently, because they can
        // disagree: a full re-index reopens containment from the commit that
        // added the file without touching an already-tombstoned entity. Either
        // one changing is a change; neither changing means a concurrent sweep
        // got there first, which is not an error and not something to count.
        return updated.rows.length > 0 || closed.rows.length > 0;
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.lifecycle.retire');
    }
  }

  /**
   * Records that a file exists again — a re-add, or a branch that still has
   * what another deleted.
   *
   * **Only the entity's lifecycle.** The containment edge is deliberately left
   * alone: every observation that could revive a file — a tree listing, or a
   * commit that added it — already asserts that edge through EPIC-007's normal
   * path, which opens a *new* interval at the instant of the observation.
   *
   * Reopening the closed interval here instead would be quicker and would
   * quietly assert that the file was present all along, erasing the gap between
   * the deletion and the return. That gap is a fact Ferret observed, and
   * "when was this file missing" is the kind of question the temporal model
   * exists to answer.
   */
  async reinstate(entityId: string, now: Date = new Date()): Promise<boolean> {
    try {
      const updated = await this.#db.execute<{ id: string }>(sql`
        UPDATE ferret.entity
           SET lifecycle = ${LifecycleState.ACTIVE}, last_indexed_at = ${now}
         WHERE id = ${entityId} AND lifecycle = ${LifecycleState.DELETED}
        RETURNING id
      `);
      return updated.rows.length > 0;
    } catch (error) {
      throw classifyDatabaseError(error, 'storage.lifecycle.reinstate');
    }
  }
}
