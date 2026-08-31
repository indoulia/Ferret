import { EvidenceMethod } from './evidence.js';

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
