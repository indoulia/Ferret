import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { VERSION } from '../version.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import { RunOutcome, indexRun, type IndexRunRow } from './schema/runs.js';

/**
 * The run journal — EPIC-094 §3.3.
 *
 * One row per attempt, opened before the first stage writes anything and closed
 * after the last one succeeds. Everything this store does is a consequence of
 * that ordering: an open row is an attempt whose outcome is unknown, and an open
 * row whose process is gone is a partially applied run.
 *
 * **Failure to journal never fails a run.** Governance §20 asks for
 * inspectability, not for a new way to abort an index. `start` returning
 * `undefined` is a run that will not be recorded, and the indexer carries on —
 * the alternative is an installation that cannot index because it cannot write
 * a diagnostic.
 */

export interface StartedRun {
  readonly id: string;
  readonly startedAt: Date;
}

export interface UnfinishedRun {
  readonly id: string;
  readonly repositoryKey: string;
  readonly repositoryId: string | undefined;
  readonly startedAt: Date;
  readonly ferretVersion: string;
  readonly hostPid: number;
}

function toUnfinished(row: IndexRunRow): UnfinishedRun {
  return {
    id: row.id,
    repositoryKey: row.repositoryKey,
    repositoryId: row.repositoryId ?? undefined,
    startedAt: row.startedAt,
    ferretVersion: row.ferretVersion,
    hostPid: row.hostPid,
  };
}

export class IndexRunStore {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /** Records that a run is starting. Returns `undefined` if it could not be recorded. */
  async start(input: {
    repositoryKey: string;
    repositoryId?: string | undefined;
    invocation?: string | undefined;
  }): Promise<StartedRun | undefined> {
    const id = randomUUID();
    const startedAt = new Date();
    try {
      await this.#db.insert(indexRun).values({
        id,
        repositoryKey: input.repositoryKey,
        repositoryId: input.repositoryId ?? null,
        startedAt,
        ferretVersion: VERSION,
        hostPid: process.pid,
        invocation: input.invocation ?? null,
      });
      return { id, startedAt };
    } catch {
      // Swallowed deliberately — see the header. A run that cannot be journalled
      // is still a run worth performing.
      return undefined;
    }
  }

  /** Closes a run. A run closed twice keeps its first outcome. */
  async finish(
    id: string,
    outcome: RunOutcome,
    summary: Record<string, unknown> = {},
    repositoryId?: string,
  ): Promise<void> {
    try {
      await this.#db
        .update(indexRun)
        .set({
          finishedAt: new Date(),
          outcome,
          summary,
          ...(repositoryId === undefined ? {} : { repositoryId }),
        })
        // Only while open: a second `finish` must not rewrite how a run ended,
        // for the same reason evidence is append-only.
        .where(and(eq(indexRun.id, id), isNull(indexRun.finishedAt)));
    } catch {
      // As above.
    }
  }

  /**
   * Runs that started and never recorded finishing — AC-6.
   *
   * `olderThan` exists so a run happening *right now* is not reported as a
   * casualty. There is no way to ask the database whether a process is alive, so
   * age is the only available evidence, and it is stated as such rather than
   * dressed up as certainty: this reports runs that have been open longer than
   * any plausible run, not runs that are known to be dead.
   */
  async unfinished(olderThan: Date): Promise<readonly UnfinishedRun[]> {
    try {
      const rows = await this.#db
        .select()
        .from(indexRun)
        .where(and(isNull(indexRun.finishedAt), sql`${indexRun.startedAt} < ${olderThan}`))
        .orderBy(indexRun.startedAt)
        .limit(100);
      return rows.map(toUnfinished);
    } catch (error) {
      throw classifyDatabaseError(error, 'runs.unfinished');
    }
  }

  /** How many runs are on record, for reporting that the journal is working. */
  async count(): Promise<number> {
    try {
      const rows = await this.#db.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.index_run`,
      );
      return Number(rows.rows[0]?.n ?? '0');
    } catch (error) {
      throw classifyDatabaseError(error, 'runs.count');
    }
  }
}

export { RunOutcome };
