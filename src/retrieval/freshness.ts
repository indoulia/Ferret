import { LifecycleState, type CanonicalEntity } from '../domain/index.js';

/**
 * Whether what a hit says still holds — EPIC-057.
 *
 * Governance §11 asks retrieval to be "evidence-aware, permission-aware,
 * **freshness-aware**, and explainable". Three were delivered; nothing in the
 * read path consulted `lifecycle` at all, so a search could answer "where is
 * the retry policy" with a file EPIC-032 tombstoned six months ago, ranked
 * above the live one, because its text matched slightly better.
 *
 * Pure, and core. It reads two fields that are already on every hit and
 * produces an ordering — never a filter. A deleted file that matches is still
 * an answer to "what used to be here"; it is just not the answer while
 * something live matches too.
 */

/**
 * How much standing each lifecycle state gives a hit. Lower is better.
 *
 * Spaced by tens so a rank can be inserted later without renumbering — the
 * reason `SourceAuthority` is spaced by twenties and EPIC-062's `BELIEVABILITY`
 * by tens. Ordered by what the state says about whether the thing still exists,
 * and two of those orderings are decisions rather than obvious:
 *
 * - **`unknown` sits between, not last.** "Ferret has a reference to it but has
 *   not observed it directly" is unassessed, not disbelieved. Ranking it below a
 *   thing known to be deleted would manufacture a claim, which Governance §6
 *   forbids — the identical argument EPIC-045 made for `UNKNOWN` authority.
 * - **`superseded` is worse than `deleted`.** A superseded entity's replacement
 *   is retrievable, so returning the old one is wrong in a way that returning a
 *   deleted one — where there is nothing else to return — is not.
 */
const STANDING: Readonly<Record<string, number | undefined>> = Object.freeze({
  [LifecycleState.ACTIVE]: 0,
  [LifecycleState.UNKNOWN]: 20,
  [LifecycleState.DELETED]: 40,
  [LifecycleState.SUPERSEDED]: 50,
});

/** The rank an unrecognised or absent lifecycle carries. */
const UNASSESSED_STANDING = 20;

/** The rank a thing observed to exist carries — the only one that moves nothing. */
export const LIVE_STANDING = 0;

/**
 * The standing band for an entity.
 *
 * An unrecognised value is unassessed rather than an error. Entities come from
 * providers, and a ranking that throws on an unexpected lifecycle takes the
 * whole answer with it.
 */
export function standing(entity: CanonicalEntity): number {
  return STANDING[entity.lifecycle] ?? UNASSESSED_STANDING;
}

/**
 * Why a hit ranks where its standing put it, for a person to read.
 *
 * Generated from the lifecycle and nothing else — never from source text — so
 * it cannot carry content across a permission boundary the way a highlight
 * could (EPIC-057 §11).
 */
export function describeStanding(entity: CanonicalEntity): string | undefined {
  switch (entity.lifecycle) {
    case LifecycleState.ACTIVE:
      return undefined;
    case LifecycleState.DELETED:
      return 'ranked below live results: the source reports this as removed';
    case LifecycleState.SUPERSEDED:
      return 'ranked below live results: this was replaced, and its replacement is the answer instead';
    case LifecycleState.UNKNOWN:
      return 'ranked below live results: Ferret has a reference to this but has not observed it';
    default:
      return `ranked below live results: unrecognised lifecycle ${JSON.stringify(entity.lifecycle)}`;
  }
}

/**
 * Recency as an ordering key, newest first.
 *
 * `sourceObservedAt` is when the *source* says the object last changed, which is
 * the only freshness fact on the canonical envelope; `last_indexed_at` is a
 * better signal for a source Ferret has stopped being able to reach, and
 * exposing it is a change to EPIC-006's envelope that EPIC-057 §16 raises rather
 * than takes.
 *
 * A missing timestamp sorts last without being called old: it never *precedes* a
 * hit that has one, and two hits that both lack one fall through to identity.
 * This is the last key before identity, so no scale is needed — which is the
 * whole of EPIC-057 §8.2's argument against a decay curve.
 */
export function recencyKey(entity: CanonicalEntity): string {
  return entity.sourceObservedAt ?? '';
}
