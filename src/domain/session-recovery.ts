import { ErrorCode, FerretError } from '../errors/index.js';

import { MemoryKind, type EngineeringMemory } from './engineering-memory.js';
import { continueSession, type Session } from './session.js';
import type { SessionCheckpoint } from './session-checkpoint.js';

/**
 * Picking up where a session stopped — EPIC-043.
 *
 * The Epic the whole Session & Agent Memory domain exists for. EPIC-039 models
 * a session, EPIC-040 captures it, EPIC-041 checkpoints it, EPIC-042 extracts
 * what it decided — and none of it was reachable. A session that ended still
 * took its context with it.
 *
 * Governance §17 rules out the obvious implementation: recovery must
 * reconstruct useful context *without replaying an entire transcript*, and the
 * registry adds "without consuming the original session's full token budget".
 * So the answer is not the transcript, and it is not a summary generated on
 * demand — it is the material that was already distilled while the work was
 * happening.
 */

export interface SessionRecoveryPort {
  getSession(sessionId: string): Promise<Session | undefined>;
  /** Newest first. */
  latestCheckpoint(sessionId: string): Promise<SessionCheckpoint | undefined>;
  memoriesFor(sessionId: string): Promise<readonly EngineeringMemory[]>;
}

/**
 * Kind priority, because the tail is what gets cut.
 *
 * A caller fitting a bundle into a budget truncates from the end, so the order
 * has to mean something. What is *unfinished* matters most to the session
 * picking up; what must hold comes next; a preference is the first thing anyone
 * can afford to lose.
 */
export const RECOVERY_KIND_ORDER: readonly MemoryKind[] = Object.freeze([
  MemoryKind.NEXT_STEP,
  MemoryKind.CONSTRAINT,
  MemoryKind.DECISION,
  MemoryKind.GOTCHA,
  MemoryKind.PREFERENCE,
]);

/** Memories in a bundle, before omissions are recorded. */
export const DEFAULT_MEMORY_LIMIT = 60;

/** Ancestor sessions followed. A cycle or a long chain must not loop. */
export const MAX_LINEAGE_DEPTH = 10;

/** A memory in a bundle, with the session it came from. */
export interface RecoveredMemory {
  readonly memory: EngineeringMemory;
  /** The session that recorded it — the recovered one, or an ancestor. */
  readonly sessionId: string;
  /** 0 for the recovered session, 1 for its parent, and so on. */
  readonly generation: number;
}

/** Something the bundle did not include, and why. */
export interface RecoveryOmission {
  readonly reason: 'memory-limit' | 'lineage-limit' | 'superseded';
  readonly count: number;
  readonly detail: string;
}

export interface RecoveryBundle {
  readonly sessionId: string;
  /** Sessions drawn from, nearest first. */
  readonly lineage: readonly string[];
  /** The latest checkpoint of the recovered session, when it has one. */
  readonly checkpoint: SessionCheckpoint | undefined;
  readonly memories: readonly RecoveredMemory[];
  readonly omissions: readonly RecoveryOmission[];
  /**
   * True when there was nothing recorded to recover.
   *
   * A real outcome — a session that crashed before its first checkpoint — and
   * reported as such rather than as something that looks like context.
   */
  readonly empty: boolean;
  /** Why the bundle is empty, when it is. */
  readonly reason: string | undefined;
}

export interface RecoverOptions {
  readonly memoryLimit?: number;
  readonly maxLineageDepth?: number;
  /** Include memories a later decision replaced. Off by default. */
  readonly includeSuperseded?: boolean;
}

function priorityOf(kind: MemoryKind): number {
  const index = RECOVERY_KIND_ORDER.indexOf(kind);
  return index === -1 ? RECOVERY_KIND_ORDER.length : index;
}

/**
 * Assembles what a later session needs from an earlier one.
 *
 * Every field comes from something already recorded. Nothing is inferred and
 * nothing is paraphrased — a recovery that invents context is worse than no
 * recovery, because the next session acts on it.
 */
export async function recoverSession(
  sessionId: string,
  port: SessionRecoveryPort,
  options: RecoverOptions = {},
): Promise<RecoveryBundle> {
  if (sessionId.length === 0) {
    throw new FerretError(ErrorCode.USAGE, 'Recovery needs a session id', {
      details: {},
      remediation: 'Pass the id of the session to recover.',
    });
  }
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const maxDepth = options.maxLineageDepth ?? MAX_LINEAGE_DEPTH;

  const lineage: string[] = [];
  const collected: RecoveredMemory[] = [];
  const omissions: RecoveryOmission[] = [];
  let supersededDropped = 0;

  // Walked with a seen-set rather than a depth counter alone: a session whose
  // parent is itself is a corrupt record, not an impossible one, and a bounded
  // loop that still loops is not a bound.
  const seen = new Set<string>();
  let current: string | undefined = sessionId;
  let generation = 0;
  let truncatedLineage = false;

  while (current !== undefined && !seen.has(current)) {
    if (generation >= maxDepth) {
      truncatedLineage = true;
      break;
    }
    seen.add(current);
    lineage.push(current);

    const memories = await port.memoriesFor(current);
    for (const memory of memories) {
      if (memory.supersededBy !== undefined && options.includeSuperseded !== true) {
        supersededDropped += 1;
        continue;
      }
      collected.push({ memory, sessionId: current, generation });
    }

    const session: Session | undefined = await port.getSession(current);
    current = session?.parentSessionId;
    generation += 1;
  }

  const checkpoint = await port.latestCheckpoint(sessionId);

  // Nearest generation first, then by usefulness, then newest — so a caller
  // that truncates loses the oldest, least important thing.
  const ordered = [...collected].sort(
    (a, b) =>
      a.generation - b.generation ||
      priorityOf(a.memory.kind) - priorityOf(b.memory.kind) ||
      b.memory.recordedAt.localeCompare(a.memory.recordedAt) ||
      a.memory.id.localeCompare(b.memory.id),
  );

  const memories = ordered.slice(0, memoryLimit);
  if (ordered.length > memories.length) {
    omissions.push({
      reason: 'memory-limit',
      count: ordered.length - memories.length,
      detail: `${String(ordered.length - memories.length)} further memories were not included; the bundle holds ${String(memoryLimit)}.`,
    });
  }
  if (supersededDropped > 0) {
    omissions.push({
      reason: 'superseded',
      count: supersededDropped,
      detail: `${String(supersededDropped)} memories were replaced by later ones. Pass includeSuperseded to see them.`,
    });
  }
  if (truncatedLineage) {
    omissions.push({
      reason: 'lineage-limit',
      count: 1,
      detail: `The session chain is longer than ${String(maxDepth)} generations; older sessions were not read.`,
    });
  }

  const empty = checkpoint === undefined && memories.length === 0;
  return {
    sessionId,
    lineage,
    checkpoint,
    memories,
    omissions,
    empty,
    reason: empty
      ? 'The session recorded no checkpoint and no memory, so there is nothing to recover.'
      : undefined,
  };
}

export interface ResumeResult {
  readonly bundle: RecoveryBundle;
  /** The new session, linked to the one it resumes. */
  readonly session: Session;
}

/**
 * Recovers a session and creates the continuation that resumes it.
 *
 * The link is a recorded fact through EPIC-039's `continueSession`, so "where
 * did this work come from" is answerable. Nothing is persisted here — a caller
 * that wants to store the continuation does so itself, which keeps recovery
 * safe to run speculatively.
 */
export async function resumeSession(
  previousSessionId: string,
  newSessionId: string,
  port: SessionRecoveryPort,
  startedAt: Date,
  options: RecoverOptions = {},
): Promise<ResumeResult> {
  const previous = await port.getSession(previousSessionId);
  if (previous === undefined) {
    throw new FerretError(ErrorCode.ENTITY_NOT_FOUND, `Session "${previousSessionId}" is not on record`, {
      details: { sessionId: previousSessionId },
      remediation: 'Check the session id, or start a new session instead of resuming.',
    });
  }
  const bundle = await recoverSession(previousSessionId, port, options);
  return { bundle, session: continueSession(previous, newSessionId, startedAt) };
}
