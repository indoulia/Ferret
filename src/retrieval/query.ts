import type { CanonicalEntity, CanonicalEvidence } from '../domain/index.js';

/**
 * What Ferret can be asked, expressed in the core.
 *
 * Two kinds of question, and keeping them apart is the point.
 *
 * **Exact** (EPIC-052) is deterministic: *which files does this repository
 * contain*, *what did this worktree have checked out on Tuesday*. There is a
 * right answer, the same one every time, and no ranking — a result that is
 * "probably" the branch a worktree was on is not an answer to that question.
 *
 * **Full-text** (EPIC-053) is a *guess with a score*. It finds things a person
 * half-remembers, and its results are ordered because there is no single right
 * one.
 *
 * Conflating them is how a system starts returning plausible answers to precise
 * questions. An AI client asking "which commits touched this file" must not get
 * a relevance-ranked approximation, and one asking "where did we discuss
 * timeouts" must not get an empty result because nothing matched exactly.
 *
 * The shapes live here, in the core, because Ferret must be able to *express* a
 * query without knowing what answers it — Governance §4. `RetrievalPort` is
 * implemented by the storage provider, and by anything else that can answer.
 */

export interface EntityQuery {
  readonly kind?: string;
  readonly kinds?: readonly string[];
  readonly sourceSystem?: string;
  /** Entities identified within this one — a repository's files, say. */
  readonly scope?: string;
  /** Exact matches on canonical attributes, all of which must hold. */
  readonly attributes?: Readonly<Record<string, string>>;
  /** An identifier another system uses for the same thing. */
  readonly externalId?: { readonly system: string; readonly id: string };
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * How a relationship is followed.
 *
 * `both` exists because the question rarely has a direction: "what is connected
 * to this file" means commits that modified it *and* the repository that
 * contains it, and making the caller ask twice invites them to ask once.
 */
export const Direction = {
  OUT: 'out',
  IN: 'in',
  BOTH: 'both',
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

export interface TraversalQuery {
  readonly from: string;
  readonly types?: readonly string[];
  readonly direction?: Direction;
  /**
   * The instant to answer as of.
   *
   * The whole reason relationships carry valid time. Omitted means "now", which
   * is the common case and the one that hides the feature: *what was I working
   * on last Tuesday* is unanswerable without it, and it is the question Ferret
   * exists for.
   */
  readonly at?: string;
  readonly limit?: number;
}

export interface Neighbour {
  readonly entity: CanonicalEntity;
  readonly relationshipType: string;
  readonly direction: Exclude<Direction, 'both'>;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface SearchQuery {
  readonly text: string;
  readonly kinds?: readonly string[];
  readonly sourceSystem?: string;
  readonly limit?: number;
  /** Search evidence statements as well as entity attributes. Default true. */
  readonly includeEvidence?: boolean;
}

/** Where a hit came from, so a caller can tell an observation from a name. */
export const HitSource = {
  ENTITY: 'entity',
  EVIDENCE: 'evidence',
} as const;

export type HitSource = (typeof HitSource)[keyof typeof HitSource];

export interface SearchHit {
  readonly source: HitSource;
  readonly entity: CanonicalEntity;
  /** The evidence that matched, when the hit came from one. */
  readonly evidence: CanonicalEvidence | undefined;
  /**
   * Relevance, higher is better.
   *
   * Comparable **within one result set and nowhere else**. PostgreSQL's
   * `ts_rank` is a function of the document and the query, not a probability,
   * and treating it as one across queries is how a threshold gets hard-coded
   * that means nothing. EPIC-056 owns ranking that can be compared.
   */
  readonly score: number;
  /** The matched text with the query terms marked, for showing a person why. */
  readonly highlight: string | undefined;
}

export interface RetrievalPort {
  findEntities(query: EntityQuery): Promise<readonly CanonicalEntity[]>;
  getEntity(id: string): Promise<CanonicalEntity | undefined>;
  neighbours(query: TraversalQuery): Promise<readonly Neighbour[]>;
  search(query: SearchQuery): Promise<readonly SearchHit[]>;
}

/** Results returned by default, when a caller does not say. */
export const DEFAULT_LIMIT = 50;

/**
 * Results a single query will ever return.
 *
 * A bound rather than a preference: retrieval answers an AI client over MCP,
 * and an unbounded result set is a context window filled with one query's
 * output. EPIC-059 decides what fits in a context pack; this stops the question
 * arising in the first place.
 */
export const MAX_LIMIT = 500;

export function boundedLimit(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) return DEFAULT_LIMIT;
  return Math.min(requested, MAX_LIMIT);
}
