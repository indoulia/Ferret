import { asc, desc, eq, sql } from 'drizzle-orm';

import {
  SessionStatus,
  type EngineeringMemory,
  type JsonValue,
  type MemoryEvidence,
  type MemoryKind,
  type MemoryOrigin,
  type Session,
  type SessionCapture,
  type SessionCaptureKind,
  type SessionCheckpoint,
  type SessionRecoveryPort,
} from '../domain/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';

import { classifyDatabaseError } from './connection.js';
import type { FerretDatabase } from './entities.js';
import {
  engineeringMemory,
  session,
  sessionCapture,
  sessionCheckpoint,
  type EngineeringMemoryRow,
  type SessionCaptureRow,
  type SessionCheckpointRow,
  type SessionRow,
} from './schema/sessions.js';

/**
 * Where a session's context is kept — EPIC-109.
 *
 * EPIC-039 to EPIC-043 built the Session & Agent Memory domain and every one of
 * them excluded persistence by name; EPIC-041 assigned it to "storage Epics"
 * and none was written. The consequence was that `SessionRecoveryPort` had a
 * single implementation and it was a test double, so a session that ended took
 * its context with it — the failure EPIC-043 exists to prevent.
 *
 * This class is that adapter and nothing more. **The domain is the authority on
 * what these values mean**; the store's whole job is to put them somewhere and
 * give them back unchanged. It derives no ids, computes no hashes and applies
 * no policy, because a second opinion about what a session is would be a second
 * definition of one.
 *
 * **Instants come back canonicalised.** The columns are `timestamptz`, so
 * `…T23:00:00+05:30` is stored and read as `…T17:30:00.000Z` — the same instant,
 * different bytes. This is the round-trip asymmetry EPIC-094 documented on
 * entities and evidence, and the reason a content hash must cover the
 * canonical form of an instant rather than its spelling. `SessionCheckpoint`
 * does that, so a checkpoint read back here still verifies.
 */

/** Rebuilt structurally, not through the domain constructor.
 *
 * `createSession` always produces an *active* session, so it cannot express a
 * completed one, and running it here would silently resurrect every ended
 * session on read. The invariants it would have enforced are enforced by the
 * table's own constraints instead — see migration `0015`.
 */
function toSession(row: SessionRow): Session {
  return Object.freeze({
    id: row.id,
    sessionId: row.sessionId,
    provider: row.provider,
    actorId: row.actorId,
    repositoryId: row.repositoryId ?? undefined,
    worktreeId: row.worktreeId ?? undefined,
    branch: row.branch ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    startedAt: row.startedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
    status: row.status as SessionStatus,
  });
}

function toCapture(row: SessionCaptureRow): SessionCapture {
  return Object.freeze({
    id: row.id,
    sessionId: row.sessionId,
    sequence: row.sequence,
    kind: row.kind as SessionCaptureKind,
    content: row.content,
    contentHash: row.contentHash,
    capturedAt: row.capturedAt.toISOString(),
    provider: row.provider,
    metadata:
      row.metadata === null ? undefined : Object.freeze({ ...(row.metadata as Record<string, unknown>) }),
  });
}

function toCheckpoint(row: SessionCheckpointRow): SessionCheckpoint {
  return Object.freeze({
    id: row.id,
    sessionId: row.sessionId,
    provider: row.provider,
    checkpointSequence: row.checkpointSequence,
    capturedThroughSequence: row.capturedThroughSequence,
    checkpointedAt: row.checkpointedAt.toISOString(),
    summary: row.summary,
    continuationState: Object.freeze({ ...(row.continuationState as Record<string, JsonValue>) }),
    contentHash: row.contentHash,
  });
}

function toMemory(row: EngineeringMemoryRow): EngineeringMemory {
  return Object.freeze({
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as MemoryKind,
    statement: row.statement,
    rationale: row.rationale ?? undefined,
    origin: row.origin as MemoryOrigin,
    rule: row.rule ?? undefined,
    confidence: row.confidence,
    derivedFrom: Object.freeze([...(row.derivedFrom as MemoryEvidence[])]),
    recordedAt: row.recordedAt.toISOString(),
    redactedSecrets: row.redactedSecrets,
    truncated: row.truncated,
    supersededBy: row.supersededBy ?? undefined,
    supersedes: row.supersedes ?? undefined,
    contentHash: row.contentHash,
  });
}

export class SessionStore implements SessionRecoveryPort {
  readonly #db: FerretDatabase;

  constructor(db: FerretDatabase) {
    this.#db = db;
  }

  /**
   * Writes a session, or advances one already recorded.
   *
   * A terminal session is immutable — EPIC-039 AC-6 — so the update applies
   * only while the stored row is still active. Re-writing a terminal session
   * *unchanged* is allowed and does nothing, because an idempotent replay is
   * not an attempt to reopen anything; a write that would actually change one
   * is refused rather than dropped, since silently ignoring it would let a
   * caller believe an ended session had been amended.
   */
  async save(value: Session): Promise<void> {
    try {
      const updated = await this.#db
        .insert(session)
        .values({
          id: value.id,
          sessionId: value.sessionId,
          provider: value.provider,
          actorId: value.actorId,
          repositoryId: value.repositoryId ?? null,
          worktreeId: value.worktreeId ?? null,
          branch: value.branch ?? null,
          parentSessionId: value.parentSessionId ?? null,
          startedAt: new Date(value.startedAt),
          lastActivityAt: new Date(value.lastActivityAt),
          endedAt: value.endedAt === null ? null : new Date(value.endedAt),
          status: value.status,
        })
        .onConflictDoUpdate({
          target: session.id,
          set: {
            lastActivityAt: new Date(value.lastActivityAt),
            endedAt: value.endedAt === null ? null : new Date(value.endedAt),
            status: value.status,
          },
          setWhere: eq(session.status, SessionStatus.ACTIVE),
        })
        .returning({ id: session.id });

      if (updated.length > 0) return;

      // The conflict target matched and the guard refused. Either the caller is
      // replaying a terminal session unchanged, which is fine, or it is trying
      // to amend one, which is the case AC-2 is about.
      const stored = await this.getSession(value.sessionId);
      if (
        stored !== undefined &&
        stored.status === value.status &&
        stored.endedAt === canonical(value.endedAt) &&
        stored.lastActivityAt === canonical(value.lastActivityAt)
      ) {
        return;
      }
      throw new FerretError(
        ErrorCode.LIFECYCLE_INVALID_STATE,
        `Session "${value.sessionId}" has ended and cannot be changed`,
        {
          details: { sessionId: value.sessionId, storedStatus: stored?.status, attemptedStatus: value.status },
          remediation: 'Record a continuation session instead of amending a terminal one.',
        },
      );
    } catch (error) {
      throw error instanceof FerretError ? error : classifyDatabaseError(error, 'sessions.save');
    }
  }

  /** `SessionRecoveryPort` — the session, if it is on record. */
  async getSession(sessionId: string): Promise<Session | undefined> {
    try {
      const rows = await this.#db.select().from(session).where(eq(session.sessionId, sessionId)).limit(1);
      const row = rows[0];
      return row === undefined ? undefined : toSession(row);
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.getSession');
    }
  }

  /**
   * Appends one captured turn.
   *
   * A sequence already taken is rejected by the table, not reconciled here. Two
   * different turns claiming one position is a capture defect, and keeping
   * either version would leave a transcript that cannot be ordered — EPIC-080's
   * idempotent re-ingest is a property of the ingestion layer, not a licence for
   * storage to guess which turn was meant.
   */
  async appendCapture(value: SessionCapture): Promise<void> {
    try {
      await this.#db.insert(sessionCapture).values({
        id: value.id,
        sessionId: value.sessionId,
        sequence: value.sequence,
        kind: value.kind,
        content: value.content,
        contentHash: value.contentHash,
        capturedAt: new Date(value.capturedAt),
        provider: value.provider,
        metadata: value.metadata === undefined ? null : { ...value.metadata },
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.appendCapture');
    }
  }

  /** The transcript, in the order it was captured. */
  async capturesFor(sessionId: string): Promise<readonly SessionCapture[]> {
    try {
      const rows = await this.#db
        .select()
        .from(sessionCapture)
        .where(eq(sessionCapture.sessionId, sessionId))
        .orderBy(asc(sessionCapture.sequence));
      return rows.map(toCapture);
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.capturesFor');
    }
  }

  /** Records a checkpoint. A sequence already used is rejected — EPIC-041 AC-4. */
  async saveCheckpoint(value: SessionCheckpoint): Promise<void> {
    try {
      await this.#db.insert(sessionCheckpoint).values({
        id: value.id,
        sessionId: value.sessionId,
        provider: value.provider,
        checkpointSequence: value.checkpointSequence,
        capturedThroughSequence: value.capturedThroughSequence,
        checkpointedAt: new Date(value.checkpointedAt),
        summary: value.summary,
        continuationState: { ...value.continuationState },
        contentHash: value.contentHash,
      });
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.saveCheckpoint');
    }
  }

  /** `SessionRecoveryPort` — the newest checkpoint, by sequence rather than by clock. */
  async latestCheckpoint(sessionId: string): Promise<SessionCheckpoint | undefined> {
    try {
      const rows = await this.#db
        .select()
        .from(sessionCheckpoint)
        .where(eq(sessionCheckpoint.sessionId, sessionId))
        // Sequence, not `checkpointed_at`: the sequence is what EPIC-041 makes
        // monotonic, and two checkpoints can share a timestamp.
        .orderBy(desc(sessionCheckpoint.checkpointSequence))
        .limit(1);
      const row = rows[0];
      return row === undefined ? undefined : toCheckpoint(row);
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.latestCheckpoint');
    }
  }

  /**
   * Records a memory, or updates the one it repeats.
   *
   * The id is derived from session, kind and statement precisely so that
   * re-extracting the same captures produces the same row — EPIC-042 says an
   * incremental capture that re-reads earlier turns must not duplicate every
   * memory it already recorded. Upserting is what makes that true in storage.
   */
  async recordMemory(value: EngineeringMemory): Promise<void> {
    const row = {
      id: value.id,
      sessionId: value.sessionId,
      kind: value.kind,
      statement: value.statement,
      rationale: value.rationale ?? null,
      origin: value.origin,
      rule: value.rule ?? null,
      confidence: value.confidence,
      derivedFrom: value.derivedFrom.map((evidence) => ({ ...evidence })),
      recordedAt: new Date(value.recordedAt),
      redactedSecrets: value.redactedSecrets,
      truncated: value.truncated,
      supersededBy: value.supersededBy ?? null,
      supersedes: value.supersedes ?? null,
      contentHash: value.contentHash,
    };
    try {
      await this.#db
        .insert(engineeringMemory)
        .values(row)
        .onConflictDoUpdate({
          target: engineeringMemory.id,
          set: {
            rationale: row.rationale,
            origin: row.origin,
            rule: row.rule,
            confidence: row.confidence,
            derivedFrom: row.derivedFrom,
            recordedAt: row.recordedAt,
            redactedSecrets: row.redactedSecrets,
            truncated: row.truncated,
            supersededBy: row.supersededBy,
            supersedes: row.supersedes,
            contentHash: row.contentHash,
          },
        });
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.recordMemory');
    }
  }

  /**
   * `SessionRecoveryPort` — every memory this session recorded.
   *
   * Superseded memories are returned too. Which of them a bundle keeps is
   * `recoverSession`'s decision and it is already made there, from
   * `includeSuperseded`; filtering here would take that choice away and make
   * "why did we change our mind" unanswerable.
   */
  async memoriesFor(sessionId: string): Promise<readonly EngineeringMemory[]> {
    try {
      const rows = await this.#db
        .select()
        .from(engineeringMemory)
        .where(eq(engineeringMemory.sessionId, sessionId))
        .orderBy(desc(engineeringMemory.recordedAt), asc(engineeringMemory.id));
      return rows.map(toMemory);
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.memoriesFor');
    }
  }

  /** How many sessions are on record — for reporting that the store is working. */
  async count(): Promise<number> {
    try {
      const rows = await this.#db.execute<{ [column: string]: unknown; n: string }>(
        sql`SELECT count(*)::text AS n FROM ferret.session`,
      );
      return Number(rows.rows[0]?.n ?? '0');
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.count');
    }
  }

  /** Sessions an actor ran, newest first. */
  async sessionsFor(actorId: string, limit = 50): Promise<readonly Session[]> {
    try {
      const rows = await this.#db
        .select()
        .from(session)
        .where(eq(session.actorId, actorId))
        .orderBy(desc(session.startedAt))
        .limit(limit);
      return rows.map(toSession);
    } catch (error) {
      throw classifyDatabaseError(error, 'sessions.sessionsFor');
    }
  }
}

/** The spelling an instant comes back with, so a replay can be compared to it. */
function canonical(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
