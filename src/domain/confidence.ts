import { Completeness } from './evidence.js';

/**
 * How sure Ferret is, and how much of the source it read — EPIC-046.
 *
 * Ten records across nine Epics point here, and every one describes the same
 * defect: `confidence` is stored, read by two orderings as the tiebreak under
 * authority, and **never written** — so both fall straight through it to
 * recency. `completeness` is worse: it defaults to `unknown` on every record
 * ever written, while the signals that would set it are computed and discarded.
 *
 * **Confidence is not derived from `method`.** That is the central decision and
 * the obvious implementation is the wrong one: EPIC-045's authority table is
 * already method → rank, so a confidence keyed on the same input would say the
 * same thing twice on a different scale — and `authority.ts` records what a
 * number like that becomes. Confidence comes from the *specific rule* that
 * produced a statement, which is a distinction already load-bearing here:
 * `SAME_ADDRESS` and `SAME_NAME_AND_LOCAL_PART` are both `inferred` and are
 * 0.95 and 0.5 apart.
 */

/**
 * The scale, named.
 *
 * Every value is one a validated Epic already chose — EPIC-009's link rules and
 * EPIC-042's memory origins, each documented as "stated once so the ordering is
 * one decision". This names them and gives them one home; it changes none of
 * them, because changing one would be re-deciding another Epic from outside.
 *
 * Named rather than left as decimals so the next producer picks a *meaning*
 * rather than a number, which is the failure mode a bare 0..1 field invites.
 */
export const Confidence = {
  /** The source states it outright. `.mailmap`, a declared field. */
  CERTAIN: 1,
  /** As close to certain as a derivation gets. A normalized address match. */
  STRONG: 0.95,
  /** A reliable signal with a known failure mode. */
  PROBABLE: 0.8,
  /** A real signal that is genuinely fallible. */
  PLAUSIBLE: 0.6,
  /**
   * As likely wrong as right, and the floor.
   *
   * Nothing below is offered: a producer that believes a statement is probably
   * false should not be emitting it as evidence at all.
   */
  EVEN: 0.5,
} as const;

export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export const CONFIDENCE_BANDS: readonly Confidence[] = Object.freeze(Object.values(Confidence));

/**
 * True when nobody assessed this, as opposed to assessing it as false.
 *
 * `0` says "believed false"; `undefined` says "not assessed". EPIC-008 kept them
 * distinct and Governance §6 forbids collapsing them, so every read of the field
 * goes through this rather than through a truthiness test — `if (confidence)` is
 * the bug this function exists to make hard to write.
 */
export function isUnassessedConfidence(confidence: number | undefined): boolean {
  return confidence === undefined;
}

/**
 * The confidence a conclusion inherits from what it rests on — EPIC-046 §8.3.
 *
 * A chain is as strong as its weakest link, so the minimum: no constant, nothing
 * to tune. **Any unassessed input makes the conclusion unassessed**, because "no
 * more certain than the weakest" cannot be evaluated when the weakest is
 * unknown, and taking the minimum of the known ones would state a bound Ferret
 * cannot support. The conservative answer, deliberately.
 *
 * An empty chain is unassessed rather than certain — a conclusion resting on
 * nothing recorded is not a conclusion Ferret can vouch for.
 */
export function derivedConfidence(inputs: readonly (number | undefined)[]): number | undefined {
  if (inputs.length === 0) return undefined;
  let weakest = Number.POSITIVE_INFINITY;
  for (const input of inputs) {
    if (input === undefined) return undefined;
    if (input < weakest) weakest = input;
  }
  return weakest;
}

/**
 * What a read reported about how much of the source it took — EPIC-046 §8.4.
 *
 * `omitted` is a content read that returned a reason for keeping no text —
 * binary, over the size bound, undecodable, a failed secret scan. `enumerated`
 * is the completeness flag a listing carries, the one EPIC-032 AC-7's safety
 * property rests on.
 *
 * **An absent signal leaves `unknown`, never `partial`.** Reporting evidence
 * partial because nobody said otherwise is the failure EPIC-094 recorded — "584
 * of 585 indexed scopes were built by a different Ferret" on a completely
 * healthy index, after which an operator stops reading the output.
 */
export function completenessOf(signals: {
  readonly omittedReason?: string | undefined;
  readonly enumerated?: boolean | undefined;
}): Completeness {
  // Presence of the key, not truthiness of the value. A content read that
  // reported `omittedReason: undefined` kept the text and *is* complete; a
  // caller that passed no `omittedReason` key at all reported nothing, and
  // nothing is `unknown`. Collapsing the two would turn every silent caller into
  // a claim of completeness.
  const read = 'omittedReason' in signals;
  const enumerated = 'enumerated' in signals;
  if (!read && !enumerated) return Completeness.UNKNOWN;

  if (read && signals.omittedReason !== undefined) return Completeness.PARTIAL;
  if (enumerated && signals.enumerated === false) return Completeness.PARTIAL;
  // An `enumerated: undefined` is a caller that named the signal and had no
  // answer, which is not the same as having a complete one.
  if (enumerated && signals.enumerated === undefined) return read ? Completeness.COMPLETE : Completeness.UNKNOWN;
  return Completeness.COMPLETE;
}
