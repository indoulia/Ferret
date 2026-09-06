import {
  LifecycleState,
  effectiveAuthority,
  preferredEvidence,
  type CanonicalEntity,
  type CanonicalEvidence,
} from '../domain/index.js';
import { containUntrusted, type ContentSafety } from '../security/index.js';

import { durableContextOf, DURABLE_CONTEXT_KIND, type ContextKind } from './durable.js';

/**
 * What Ferret currently holds that bears on a task — EPIC-131.
 *
 * Assembly's job, and the Epic states the separation it must not blur: **the
 * merger keeps the knowledge base clean; assembly constructs the context for
 * the task at hand.** Nothing here merges, relates or decides anything. It
 * consumes what retrieval returned — including the restatements EPIC-130
 * already folded — and arranges it.
 *
 * **Why a section of its own rather than another ranked item.** A decision
 * sitting seventh in a list of files is not task-ready. An agent about to act
 * needs to know what constrains it before it needs to know which file matched,
 * and burying the constraint among the records is how it gets skipped. The
 * source records are still there, unchanged, in `items`.
 */

/** The most standing context one pack carries, before budget is considered. */
export const MAX_STANDING_CONTEXT = 10;

/**
 * The order the kinds are presented in.
 *
 * Not a relevance weight and not tuned: it is an ordering by **what acting
 * against one costs**. Breaking a constraint is worse than contradicting a
 * decision, which is worse than being ignorant of a fact. A next step is last
 * because it describes work rather than bounds it.
 */
const KIND_ORDER: readonly ContextKind[] = Object.freeze([
  'constraint',
  'decision',
  'gotcha',
  'preference',
  'fact',
  'next-step',
]);

export interface StandingContext {
  readonly id: string;
  /** The statement, contained — it is producer-supplied text reaching a model. */
  readonly statement: string;
  readonly contextKind: ContextKind;
  readonly state: LifecycleState;
  /** True only for `active`. Everything else is history or a proposal. */
  readonly current: boolean;
  /** How many observations visible to this caller support it. */
  readonly supportCount: number;
  /** The strongest supporting authority, or absent when nothing decides. */
  readonly authority: number | undefined;
  /** Support exists and nothing in it decides between the observations. */
  readonly undecided: boolean;
  /**
   * Restatements retrieval folded into this one — EPIC-130.
   *
   * Carried rather than dropped so a package that collapsed four records into
   * one says so, and a reader who needs the others can ask.
   */
  readonly restates: readonly string[];
  readonly estimatedTokens: number;
}

/** A retrieval hit, as much of one as assembly needs. */
export interface StandingCandidate {
  readonly entity: CanonicalEntity;
  readonly subsumed: readonly string[];
  /** Observations behind it, already narrowed to what the caller may see. */
  readonly evidence: readonly CanonicalEvidence[];
}

/** True when a hit is durable context rather than a source record. */
export function isStandingContext(entity: CanonicalEntity): boolean {
  return entity.kind === DURABLE_CONTEXT_KIND;
}

/**
 * Builds one standing entry from a hit and what supports it.
 *
 * The trust fields are read from the evidence through `preferredEvidence`, the
 * same function EPIC-127's `trust` uses — so a package and a trust report
 * cannot disagree about what Ferret believes. Neither recomputes the other.
 */
export function standingContextOf(
  candidate: StandingCandidate,
  estimate: (value: unknown) => number,
  safety: ContentSafety,
): StandingContext {
  const held = durableContextOf(candidate.entity);
  const preferred = preferredEvidence(candidate.evidence);
  // `containUntrusted` is typed `unknown` because it walks arbitrary values; a
  // string in is a string out, and the pack's own shape needs to say so.
  const statement = String(containUntrusted(held.statement, safety));

  const entry = {
    id: held.entity.id,
    statement,
    contextKind: held.contextKind,
    state: held.entity.lifecycle,
    current: held.entity.lifecycle === LifecycleState.ACTIVE,
    supportCount: candidate.evidence.length,
    ...(preferred === undefined ? {} : { authority: preferred.authority }),
    // Support exists and nothing separates it. Not the same as no support, and
    // a reader that cannot tell them apart reads silence as agreement.
    undecided: candidate.evidence.length > 1 && preferred === undefined,
    restates: Object.freeze([...candidate.subsumed]),
  };

  return Object.freeze({
    ...entry,
    authority: preferred?.authority,
    estimatedTokens: estimate(entry),
  });
}

/**
 * Orders standing context for a reader.
 *
 * Current before historical, then by what acting against it costs, then by the
 * strength of what supports it. Relevance is deliberately **not** a key here:
 * retrieval already decided which of these belong to the question, and
 * re-ranking them by score would put a well-worded fact above a constraint.
 */
export function orderStanding(entries: readonly StandingContext[]): readonly StandingContext[] {
  const rank = (kind: ContextKind): number => {
    const at = KIND_ORDER.indexOf(kind);
    // An unrecognised kind sorts after the ones with a stated cost rather than
    // before them: nobody has said what acting against it costs.
    return at === -1 ? KIND_ORDER.length : at;
  };

  return [...entries].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const byKind = rank(a.contextKind) - rank(b.contextKind);
    if (byKind !== 0) return byKind;
    const byAuthority = effectiveAuthority(b.authority ?? 0) - effectiveAuthority(a.authority ?? 0);
    if (byAuthority !== 0) return byAuthority;
    if (a.supportCount !== b.supportCount) return b.supportCount - a.supportCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
