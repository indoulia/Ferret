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
  /**
   * Restrict to one lifecycle state.
   *
   * Omitted returns every state, tombstones included. That is the right default
   * for a store whose purpose is remembering: a caller asking what a repository
   * *currently* holds says `active` and means it, and one asking what it ever
   * held would be badly served by a filter they never applied.
   */
  readonly lifecycle?: string;
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
  /**
   * Include relationships that have ended.
   *
   * Without this a caller can only ever see what is true, never what stopped
   * being true — and "this commit deleted this file" is a relationship that
   * ended by definition. Asking *as of* a past instant answers a different
   * question: it needs the instant, and a caller who wants the whole history of
   * an edge does not have one to give.
   */
  readonly includeHistorical?: boolean;
  readonly limit?: number;
}

export interface Neighbour {
  readonly entity: CanonicalEntity;
  readonly relationshipType: string;
  readonly direction: Exclude<Direction, 'both'>;
  readonly validFrom: string;
  readonly validTo: string | null;
  /**
   * What the source said about this edge.
   *
   * Carries the facts that live on the relationship rather than on either
   * entity — most importantly whether a commit added, modified or deleted the
   * file it touched. Ferret recorded that from the first day it read history
   * and, until this was here, no client could see it: the evidence existed and
   * was unreachable, which Governance §18 makes no better than not having it.
   */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SearchQuery {
  readonly text: string;
  readonly kinds?: readonly string[];
  readonly sourceSystem?: string;
  readonly limit?: number;
  /** Search evidence statements as well as entity attributes. Default true. */
  readonly includeEvidence?: boolean;
  /**
   * Match documents containing *any* of the terms rather than all of them.
   *
   * `websearch_to_tsquery` joins terms with AND, so "how are deleted files
   * tombstoned" requires every one of `deleted`, `files` and `tombstoned` in a
   * single document. Measured on Ferret's own index: `tombstone` found a
   * result, `deleted files` found a result, and the full question found
   * nothing — the more context a person gave, the worse the answer got, in a
   * search box whose own description invites a half-remembered question.
   *
   * Relaxing is a fallback rather than the default: when every term does match,
   * that is a better answer, and starting loose would bury it.
   */
  readonly relax?: boolean;
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
