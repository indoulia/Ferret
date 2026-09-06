import {
  MemoryOrigin,
  LifecycleState,
  type EngineeringMemory,
  type Session,
} from '../domain/index.js';

import { isContextKind, type ContextKind } from './durable.js';
import type { DurableContextPort, StoreContextRequest } from './durable-port.js';

/**
 * Promoting what a session learned into durable context — EPIC-129.
 *
 * The Epic's principle is already written down in `memory-extraction.ts`, which
 * decided it for EPIC-042: *"A missed memory costs a re-derivation; a fabricated
 * one costs the credibility of the whole store."* So this is not a new judgment
 * layer. It is the missing link between two halves that already exist —
 * memories, keyed on the **session** that recorded them, and durable context,
 * keyed on the **statement**.
 *
 * **A transcript is never promoted.** Captures are not an input here; only
 * memories are, and a memory is already the high-precision extract. The dump
 * the Epic forbids is the thing this function cannot reach.
 *
 * **How sure the session was decides what the context becomes.** An *explicit*
 * memory is a client that called `ferret_session_remember` knowing it was
 * recording a decision, so it becomes current context. An *extracted* one is a
 * marker that matched a line, so it becomes a **candidate** — EPIC-127's state
 * for something stated in full and not yet believed. Automatic extraction can
 * therefore never silently become current context, which is the property that
 * makes promoting extraction safe at all.
 */

/** Why a memory was not promoted. */
export const PromotionRefusal = {
  /** A later memory replaced it. Promoting it would revive a retracted belief. */
  SUPERSEDED: 'superseded',
  /**
   * Its kind has no durable context counterpart.
   *
   * Unreachable while `MEMORY_CONTEXT_KINDS` type-checks, and reported rather
   * than thrown because a kind that arrived from an older row is data Ferret
   * does not understand, not a reason to fail a whole promotion.
   */
  UNKNOWN_KIND: 'unknown-kind',
} as const;

export type PromotionRefusal = (typeof PromotionRefusal)[keyof typeof PromotionRefusal];

export interface PromotionPlan {
  readonly memoryId: string;
  readonly statement: string;
  readonly contextKind: ContextKind;
  readonly scope: string | undefined;
  readonly state: typeof LifecycleState.ACTIVE | typeof LifecycleState.CANDIDATE;
  readonly confidence: number;
}

export interface RefusedPromotion {
  readonly memoryId: string;
  readonly refusal: PromotionRefusal;
}

/** What Ferret records as having produced a promoted statement. */
export const PROMOTION_PRODUCER = 'ferret.context.promotion';

/** The system a promoted statement is attributed to. */
export const PROMOTION_SOURCE_SYSTEM = 'ferret.session';

/**
 * What one memory should become, or why it should not become anything.
 *
 * Pure, so the rule is testable without a session store or a database, and so
 * the decision is one function rather than one per caller.
 */
export function planPromotion(
  memory: EngineeringMemory,
  session: Pick<Session, 'repositoryId'>,
): PromotionPlan | RefusedPromotion {
  if (memory.supersededBy !== undefined) {
    return { memoryId: memory.id, refusal: PromotionRefusal.SUPERSEDED };
  }
  if (!isContextKind(memory.kind)) {
    return { memoryId: memory.id, refusal: PromotionRefusal.UNKNOWN_KIND };
  }

  return {
    memoryId: memory.id,
    statement: memory.statement,
    contextKind: memory.kind,
    scope: session.repositoryId,
    state:
      memory.origin === MemoryOrigin.EXPLICIT ? LifecycleState.ACTIVE : LifecycleState.CANDIDATE,
    confidence: memory.confidence,
  };
}

export function isRefusal(one: PromotionPlan | RefusedPromotion): one is RefusedPromotion {
  return 'refusal' in one;
}

/** What a promotion did, per memory and in total. */
export interface PromotionReport {
  readonly sessionId: string;
  /** Memories considered. Captures are never among them. */
  readonly considered: number;
  /** Statements Ferret did not already hold. */
  readonly created: number;
  /** Statements that merged onto a record already held. */
  readonly merged: number;
  /** Of the above, how many are proposals rather than current context. */
  readonly proposed: number;
  readonly refused: readonly RefusedPromotion[];
  readonly contextIds: readonly string[];
}

/**
 * Promotes a session's memories into durable context.
 *
 * Through the port, so this never learns that PostgreSQL exists and a second
 * surface reuses it unchanged. The order is the memories' own; nothing is
 * reordered, batched or deduplicated here, because merging is a property of the
 * identifier and doing it twice would be doing it worse.
 */
export async function promoteMemories(
  context: DurableContextPort,
  session: Pick<Session, 'sessionId' | 'repositoryId' | 'provider'>,
  memories: readonly EngineeringMemory[],
  producerVersion: string,
): Promise<PromotionReport> {
  let created = 0;
  let merged = 0;
  let proposed = 0;
  const refused: RefusedPromotion[] = [];
  const contextIds: string[] = [];

  for (const memory of memories) {
    const plan = planPromotion(memory, session);
    if (isRefusal(plan)) {
      refused.push(plan);
      continue;
    }

    const request: StoreContextRequest = {
      statement: plan.statement,
      contextKind: plan.contextKind,
      ...(plan.scope === undefined ? {} : { scope: plan.scope }),
      state: plan.state,
      provenance: {
        producer: PROMOTION_PRODUCER,
        producerVersion,
        // The session it came from, so "why does Ferret believe this" reaches
        // the work that produced it rather than stopping at Ferret's own name.
        sourceSystem: PROMOTION_SOURCE_SYSTEM,
        sourceId: session.sessionId,
        observedAt: memory.recordedAt,
        // The memory's own confidence, which is what separates a statement the
        // session made outright from one a marker matched — `ORIGIN_CONFIDENCE`
        // puts them 0.35 apart. Dropping it here was the defect dogfooding
        // found: the plan computed a number nothing carried, which is the exact
        // failure EPIC-046 was raised for.
        confidence: plan.confidence,
      },
    };

    const stored = await context.record(request);
    if (stored.outcome === 'created') created += 1;
    else merged += 1;
    if (plan.state === LifecycleState.CANDIDATE) proposed += 1;
    contextIds.push(stored.context.entity.id);
  }

  return {
    sessionId: session.sessionId,
    considered: memories.length,
    created,
    merged,
    proposed,
    refused,
    contextIds,
  };
}
