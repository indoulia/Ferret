import type { Pool, PoolClient } from 'pg';

import { redact } from '../errors/index.js';

/**
 * Answering the operator's next question — EPIC-095.
 *
 * Governance §13 asks that a corrupt or stale index be recoverable *without
 * requiring the user to become a database administrator*. Ferret's own
 * remediation for a held migration lock read:
 *
 * > "If none is running, inspect pg_locks for a stale session holding the
 * > advisory lock."
 *
 * That is the instruction §13 exists to prevent, in Ferret's own error text —
 * and it is avoidable, because PostgreSQL can be asked who holds the lock. This
 * module asks.
 *
 * **Every query here is read-only, and every failure is swallowed.**
 * `ferret doctor` is what an operator runs when things are broken; a diagnostic
 * that throws in that state is worse than one that admits it could not tell.
 */

/** Who is holding the migration lock, as far as this connection can see. */
export interface LockHolder {
  readonly pid: number;
  /** How long the session has held it, in seconds, as PostgreSQL reports. */
  readonly heldForSeconds: number | undefined;
  readonly state: string | undefined;
  readonly application: string | undefined;
  /**
   * What the holder is running, redacted.
   *
   * Another session's SQL can contain a literal credential, and this string is
   * one an operator pastes into a ticket. It goes through the same redactor as
   * every other value leaving the process (EPIC-091 §11).
   */
  readonly query: string | undefined;
}

/**
 * The session holding the migration advisory lock, if it can be identified.
 *
 * `undefined` means *could not tell*, never *nobody* — §8. A non-superuser sees
 * limited columns for other sessions in `pg_stat_activity`, so the quality of
 * this answer depends on the role Ferret connects as, and claiming a pid that
 * was not read would be worse than saying nothing.
 */
export async function findLockHolder(
  client: Pool | PoolClient,
  lockClass: number,
  lockObject: number,
): Promise<LockHolder | undefined> {
  try {
    const { rows } = await client.query<{
      pid: number;
      held_for: string | null;
      state: string | null;
      application_name: string | null;
      query: string | null;
    }>(
      `SELECT a.pid,
              EXTRACT(EPOCH FROM (now() - a.state_change))::text AS held_for,
              a.state,
              a.application_name,
              a.query
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.classid = $1
          AND l.objid = $2
          AND l.granted
          -- Scoped to this database, and the omission was a real defect.
          -- The lock view is cluster-wide while an advisory lock is
          -- per-database, so without this clause Ferret would name a session
          -- holding the same lock id in some *other* database on the same
          -- server and tell an operator to go and end it. Found by the full
          -- test suite: two suites against two databases took the same advisory
          -- lock, and each saw the other's holder.
          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND a.pid <> pg_backend_pid()
        LIMIT 1`,
      [lockClass, lockObject],
    );

    const row = rows[0];
    if (row === undefined) return undefined;
    const heldFor = row.held_for === null ? undefined : Number(row.held_for);
    return {
      pid: row.pid,
      heldForSeconds: heldFor === undefined || Number.isNaN(heldFor) ? undefined : Math.round(heldFor),
      state: row.state ?? undefined,
      application: row.application_name ?? undefined,
      // Redacted — see the field's own note.
      query: row.query === null ? undefined : String(redact(row.query)),
    };
  } catch {
    // Reading `pg_stat_activity` can be refused outright by a restricted role.
    // A diagnosis that cannot be made is reported as absent, not as nobody.
    return undefined;
  }
}

/**
 * The lock holder as a sentence, or `undefined` when there is nothing to say.
 *
 * Names a session and an action, never a catalogue — §8. "Another Ferret is
 * migrating, wait" and "a session has been idle in transaction for two hours"
 * call for completely different responses, and the state is what distinguishes
 * them.
 */
export function describeLockHolder(holder: LockHolder | undefined): string | undefined {
  if (holder === undefined) return undefined;
  const held = holder.heldForSeconds === undefined ? '' : ` for ${String(holder.heldForSeconds)}s`;
  const state = holder.state === undefined ? '' : `, ${holder.state}`;
  const application = holder.application === undefined || holder.application === '' ? '' : ` (${holder.application})`;
  return `process ${String(holder.pid)}${application} has held it${held}${state}`;
}

/**
 * What to do about a holder, in terms of a decision rather than a query.
 *
 * The three cases an operator actually faces, distinguished by the one field
 * that separates them.
 */
export function remediationForHolder(holder: LockHolder | undefined): string {
  if (holder === undefined) {
    return (
      'Ferret could not identify the holder — the database role may not be permitted to see other sessions. ' +
      'Wait and retry; if this persists with no other Ferret running, restart the database session that is stuck.'
    );
  }
  if (holder.state === 'idle in transaction') {
    return (
      `Process ${String(holder.pid)} is idle inside an open transaction, so it is holding the lock without doing work. ` +
      'That is a stuck client rather than a slow migration: end that process, then run `ferret init` again.'
    );
  }
  return (
    `Another Ferret is migrating as process ${String(holder.pid)}. Wait for it to finish and run \`ferret init\` again. ` +
    'If that process is gone, ending its database session releases the lock.'
  );
}

/** What Ferret holds, for `ferret doctor` — EPIC-095 §3.2. */
export interface IndexInventory {
  readonly entities: readonly { readonly kind: string; readonly count: number }[];
  readonly evidence: number;
  readonly relationships: number;
  readonly contentBlobs: number;
  readonly contentBytes: number;
  readonly lastRun:
    | {
        readonly repository: string;
        readonly outcome: string;
        readonly finishedAt: string;
        readonly ageSeconds: number;
      }
    | undefined;
}

/**
 * Counts what Ferret knows.
 *
 * `undefined` when it cannot be read — no database, or a schema older than the
 * tables asked about. Absent, never zero: "nothing indexed" and "could not ask"
 * are different facts, and confusing them is the defect EPIC-094 found in the
 * health probe.
 */
export async function readInventory(pool: Pool): Promise<IndexInventory | undefined> {
  try {
    const kinds = await pool.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM ferret.entity GROUP BY kind ORDER BY count(*) DESC`,
    );
    const totals = await pool.query<{ evidence: string; relationships: string }>(
      `SELECT (SELECT count(*)::text FROM ferret.evidence) AS evidence,
              (SELECT count(*)::text FROM ferret.relationship) AS relationships`,
    );

    return {
      entities: kinds.rows.map((row) => ({ kind: row.kind, count: Number(row.n) })),
      evidence: Number(totals.rows[0]?.evidence ?? '0'),
      relationships: Number(totals.rows[0]?.relationships ?? '0'),
      ...(await readContent(pool)),
      lastRun: await readLastRun(pool),
    };
  } catch {
    return undefined;
  }
}

/** Content storage, separately: an older schema has no `content_blob`. */
async function readContent(pool: Pool): Promise<{ contentBlobs: number; contentBytes: number }> {
  try {
    const { rows } = await pool.query<{ blobs: string; bytes: string }>(
      `SELECT count(*)::text AS blobs, coalesce(sum(octet_length(text_content)), 0)::text AS bytes
         FROM ferret.content_blob`,
    );
    return { contentBlobs: Number(rows[0]?.blobs ?? '0'), contentBytes: Number(rows[0]?.bytes ?? '0') };
  } catch {
    return { contentBlobs: 0, contentBytes: 0 };
  }
}

/**
 * The last run that finished — EPIC-095 §3.2, over EPIC-094's journal.
 *
 * That journal has recorded every index attempt since EPIC-094 and has been
 * read by exactly one caller: the integrity sweep, looking for runs that never
 * closed. This is the other half — what *did* happen, and when.
 */
async function readLastRun(pool: Pool): Promise<IndexInventory['lastRun']> {
  try {
    const { rows } = await pool.query<{
      repository_key: string;
      outcome: string;
      finished_at: Date;
      age: string;
    }>(
      `SELECT repository_key, outcome, finished_at,
              EXTRACT(EPOCH FROM (now() - finished_at))::text AS age
         FROM ferret.index_run
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC
        LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      repository: row.repository_key,
      outcome: row.outcome,
      finishedAt: row.finished_at.toISOString(),
      ageSeconds: Math.round(Number(row.age)),
    };
  } catch {
    return undefined;
  }
}
