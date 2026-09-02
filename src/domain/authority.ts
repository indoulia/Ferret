import { EvidenceMethod, type CanonicalEvidence } from './evidence.js';
import { stableStringify } from './identity.js';

/**
 * Which source wins when two disagree — EPIC-045.
 *
 * `authority` has been on every evidence record since EPIC-008, and
 * `preferredEvidence` has ranked by it first. Nothing ever set it: the schema
 * defaults it to `0`, so every source in Ferret was equally authoritative and
 * the ranking silently fell through to confidence. A stale README saying one
 * thing and the code saying another were resolved by whichever happened to
 * carry a confidence number.
 *
 * This is the policy that makes "considered authoritative" in Governance §18
 * mean something.
 */

/**
 * The scale.
 *
 * Coarse and named, spaced by twenties so a later rank can be inserted without
 * renumbering what is already stored. A continuous score invites tuning, and a
 * tuned authority number is indistinguishable from a fudge by the time it
 * reaches an answer.
 */
export const SourceAuthority = {
  /**
   * The system of record for this fact.
   *
   * Jira is authoritative about a Jira issue's status; Git is authoritative
   * about what a commit contains. Nothing is authoritative about everything.
   */
  SYSTEM_OF_RECORD: 100,
  /** Read directly from the source. */
  OBSERVED: 80,
  /** Extracted from source content by a parser. */
  PARSED: 60,
  /** Worked out by Ferret from other evidence. */
  DERIVED: 40,
  /** Stated by a person, an operator or a model. Unverified. */
  ASSERTED: 20,
  /**
   * Nobody has decided.
   *
   * Deliberately *not* the lowest rank in meaning, even though it is the lowest
   * number: it says "unassessed", where `ASSERTED` says "assessed, and weak".
   * {@link isUnknownAuthority} is how a caller tells them apart, because
   * ranking an unassessed source below a known-weak one is a claim and
   * Governance §6 forbids manufacturing it.
   */
  UNKNOWN: 0,
} as const;

export type SourceAuthority = (typeof SourceAuthority)[keyof typeof SourceAuthority];

export const SOURCE_AUTHORITIES: readonly SourceAuthority[] = Object.freeze(
  Object.values(SourceAuthority),
);

/** True when nobody has assessed this source, as opposed to assessed it as weak. */
export function isUnknownAuthority(authority: number): boolean {
  return authority === SourceAuthority.UNKNOWN;
}

/**
 * The default rank for each way evidence can be obtained.
 *
 * Authority is a property of *how*, not *who*: something read directly outranks
 * something parsed, which outranks something worked out, which outranks
 * something a model produced. A provider cannot change that by asserting
 * loudly.
 */
export const AUTHORITY_BY_METHOD: Readonly<Record<EvidenceMethod, SourceAuthority>> = Object.freeze({
  [EvidenceMethod.OBSERVED]: SourceAuthority.OBSERVED,
  [EvidenceMethod.PARSED]: SourceAuthority.PARSED,
  [EvidenceMethod.INFERRED]: SourceAuthority.DERIVED,
  [EvidenceMethod.AGGREGATED]: SourceAuthority.DERIVED,
  // A model's output is never conflated with an observation, which is what
  // EPIC-008 said when it separated the methods; this is the same rule
  // expressed as a rank.
  [EvidenceMethod.GENERATED]: SourceAuthority.ASSERTED,
  [EvidenceMethod.ASSERTED]: SourceAuthority.ASSERTED,
});

/**
 * Methods a source system may claim to be the system of record for.
 *
 * Only what Ferret *saw*. A provider may say "I own this fact" about something
 * it read; it may not promote a guess, an inference or a model's output to
 * authoritative by declaring itself important.
 */
const PROMOTABLE: ReadonlySet<string> = new Set([EvidenceMethod.OBSERVED, EvidenceMethod.PARSED]);

export interface AuthorityOptions {
  /**
   * The provider claims to be the system of record for this fact.
   *
   * Keyed on the *provider*, which is registered, trusted code — never on
   * anything a repository says about itself. Governance §12: repository content
   * is data, not policy.
   */
  readonly systemOfRecord?: boolean;
}

/**
 * The authority rank evidence obtained this way should carry.
 *
 * An unrecognised method is `UNKNOWN` rather than the lowest known rank: a
 * method Ferret does not have a policy for has not been assessed, and saying so
 * is the honest answer.
 */
export function authorityFor(method: string, options: AuthorityOptions = {}): number {
  const base = AUTHORITY_BY_METHOD[method as EvidenceMethod];
  if (base === undefined) return SourceAuthority.UNKNOWN;
  if (options.systemOfRecord === true && PROMOTABLE.has(method)) {
    return SourceAuthority.SYSTEM_OF_RECORD;
  }
  return base;
}

/**
 * Where an unassessed authority ranks — EPIC-057.
 *
 * {@link isUnknownAuthority} exists precisely because `UNKNOWN` is the lowest
 * *number* and not the lowest *meaning*. Sorting it as zero ranks every source
 * Ferret has not yet classified below a model's unverified claim, which is a
 * claim nobody made.
 *
 * Moved here from `context/evidence-selection.ts`, where EPIC-062 first needed
 * it. Two orderings deriving the same rank separately is one definition too
 * many — Governance §5, and the reason EPIC-057 §8.4 shares it rather than
 * repeating it.
 */
export const UNASSESSED_AUTHORITY = (SourceAuthority.ASSERTED + SourceAuthority.DERIVED) / 2;

/**
 * The rank to *order* by, which is not always the rank stored.
 *
 * Every comparison over `authority` goes through this. A raw `b.authority -
 * a.authority` is the defect EPIC-057 §8.4 found in `preferredEvidence`: it
 * agreed with this file's documented intent everywhere except where it mattered.
 */
export function effectiveAuthority(authority: number): number {
  return isUnknownAuthority(authority) ? UNASSESSED_AUTHORITY : authority;
}

/**
 * Picks the record a caller should believe, without discarding the others.
 *
 * The later of two statements from the **same** source system about the **same**
 * field wins outright; otherwise higher authority wins, then higher confidence,
 * then the more recent observation. Returns `undefined` when the input is empty
 * or when nothing distinguishes the candidates — an honest "cannot say" rather
 * than an arbitrary pick, because an arbitrary pick is indistinguishable from a
 * considered one once it reaches an answer.
 *
 * Moved here from `evidence.ts` by EPIC-057 §8.4: it was there because evidence
 * is what it takes, and it belongs here because authority is what it decides
 * with.
 */
export function preferredEvidence(evidence: readonly CanonicalEvidence[]): CanonicalEvidence | undefined {
  if (evidence.length === 0) return undefined;
  if (evidence.length === 1) return evidence[0];

  // EPIC-057 §8.4. One source speaking twice is not two sources disagreeing.
  //
  // EPIC-045 recorded the defect this closes: "a highly authoritative stale
  // record still beats a fresh weak one". The sharp case is one system's own
  // January observation of a field outranking its own September observation of
  // it, because authority was consulted first and both carried the same rank.
  //
  // Narrow on purpose, and not conflict resolution (EPIC-047): two *different*
  // systems disagreeing still tie on authority and still surface as a conflict.
  // A source restating a fact is that source's current position, and treating
  // its own older statement as a rival is a modelling error, not a policy.
  const superseded = supersededIds(evidence);
  const live = evidence.filter((record) => !superseded.has(record.id));
  const candidates = live.length === 0 ? evidence : live;
  if (candidates.length === 1) return candidates[0];

  const ranked = [...candidates].sort((a, b) => {
    // Through `effectiveAuthority`, so `UNKNOWN` orders as unassessed rather
    // than as the weakest rank. This function used to subtract the raw numbers,
    // which disagreed with the intent recorded on `SourceAuthority.UNKNOWN`
    // above — EPIC-057 §8.4 records it as a defect found.
    const authorityA = effectiveAuthority(a.authority);
    const authorityB = effectiveAuthority(b.authority);
    if (authorityA !== authorityB) return authorityB - authorityA;
    const confidenceA = a.confidence ?? -1;
    const confidenceB = b.confidence ?? -1;
    if (confidenceA !== confidenceB) return confidenceB - confidenceA;
    const observedA = a.observedAt ?? '';
    const observedB = b.observedAt ?? '';
    return observedA < observedB ? 1 : observedA > observedB ? -1 : 0;
  });

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (best === undefined || runnerUp === undefined) return best;

  const indistinguishable =
    effectiveAuthority(best.authority) === effectiveAuthority(runnerUp.authority) &&
    (best.confidence ?? -1) === (runnerUp.confidence ?? -1) &&
    (best.observedAt ?? '') === (runnerUp.observedAt ?? '') &&
    stableStringify(best.statement) !== stableStringify(runnerUp.statement);

  return indistinguishable ? undefined : best;
}

/**
 * Records another statement from the same source about the same field replaced.
 *
 * Keyed on `sourceSystem` and `field` together, which is as fine-grained as the
 * model can say: EPIC-045 recorded that `systemOfRecord` is per provider and not
 * per field, so a rule keyed any tighter would claim a distinction the data does
 * not carry.
 *
 * A record with no `observedAt` supersedes nothing and is superseded by nothing —
 * an absent timestamp is unknown, not old, and Governance §6 forbids inventing
 * the difference.
 */
function supersededIds(evidence: readonly CanonicalEvidence[]): ReadonlySet<string> {
  const latest = new Map<string, { readonly at: string; readonly id: string }>();
  for (const record of evidence) {
    const at = record.observedAt;
    if (at === undefined) continue;
    const key = `${record.sourceSystem} ${record.field ?? ''}`;
    const held = latest.get(key);
    if (held === undefined || held.at < at) latest.set(key, { at, id: record.id });
  }

  const superseded = new Set<string>();
  for (const record of evidence) {
    const at = record.observedAt;
    if (at === undefined) continue;
    const key = `${record.sourceSystem} ${record.field ?? ''}`;
    const winner = latest.get(key);
    if (winner !== undefined && winner.at > at) superseded.add(record.id);
  }
  return superseded;
}
