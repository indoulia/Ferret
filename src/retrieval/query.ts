import type { CanonicalEntity, CanonicalEvidence } from '../domain/index.js';

import type { AccessContext, WithheldReport } from './access.js';

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
  /**
   * Hops from the origin — EPIC-050.
   *
   * Default 1, which is exactly what `neighbours` has always done, so no
   * existing caller changes. Clamped to {@link MAX_TRAVERSAL_DEPTH} rather than
   * rejected: a caller asking for more than Ferret will walk is asking for
   * everything, and the honest answer is as much as it will walk plus a
   * `truncated` flag saying so.
   */
  readonly depth?: number;
}

/**
 * Hops a single traversal will ever take — EPIC-050 §8.2.
 *
 * A bound rather than a preference. The walk costs one query per level, and the
 * questions Ferret exists for — "which release contains this commit", "what does
 * this function reach" — are shallow and typed. EPIC-007 §D-001 chose a table
 * with indexes over a graph database on exactly that reasoning.
 */
export const MAX_TRAVERSAL_DEPTH = 6;

export function boundedDepth(requested: number | undefined): number {
  if (requested === undefined) return 1;
  if (!Number.isInteger(requested) || requested < 1) return 1;
  return Math.min(requested, MAX_TRAVERSAL_DEPTH);
}

/** One edge on the way to a reached entity — EPIC-050 §8.1. */
export interface TraversalStep {
  readonly relationshipType: string;
  readonly direction: Exclude<Direction, 'both'>;
  /** The entity this step arrived at. The last one is the reached entity. */
  readonly entityId: string;
}

/**
 * One entity a traversal reached, and how — EPIC-050 §8.1.
 *
 * The path is the answer to "how", and a flat node set throws it away: a caller
 * handed a release cannot tell whether Ferret walked the edge it expected or a
 * different one of the same kind.
 */
export interface TraversalPath {
  readonly entity: CanonicalEntity;
  /** Hops from the origin. `1` is a direct neighbour. */
  readonly depth: number;
  /**
   * The steps from the origin to this entity, in order.
   *
   * One path per reached entity — the **first** found, which under breadth-first
   * order is a shortest one. Enumerating every path is path-finding, which
   * EPIC-050 §4 declines.
   */
  readonly steps: readonly TraversalStep[];
  /** What the last edge's source said about it. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** Why a traversal stopped short — EPIC-050 §8.4. */
export const TraversalBound = {
  DEPTH: 'depth',
  LIMIT: 'limit',
} as const;

export type TraversalBound = (typeof TraversalBound)[keyof typeof TraversalBound];

export interface TraversalResult {
  readonly paths: readonly TraversalPath[];
  /**
   * The bound that stopped the walk, when one did.
   *
   * `undefined` means the walk exhausted the reachable graph. Without this a
   * caller cannot tell "nothing further exists" from "Ferret stopped looking" —
   * the distinction EPIC-059 and EPIC-062 both exist to preserve, and the one a
   * graph makes easiest to lose.
   */
  readonly truncated: TraversalBound | undefined;
  /** How deep the walk actually went. */
  readonly depthReached: number;
  /** What the caller was not permitted to see — EPIC-058. Counts only. */
  readonly withheld: WithheldReport;
  /**
   * How whole the reference graph behind this walk is — F-27.
   *
   * On the multi-hop branch for the same reason as the one-hop one, and it
   * matters more here: an unresolved reference at hop 1 removes everything that
   * was only reachable *through* it, so a depth-3 walk understates by more than
   * the missing edge.
   *
   * Declared on `ReferenceCompleteness`, whose scope is the subject's
   * repository — not the union of every scope the walk wandered into. A walk
   * that leaves the repository is bounded by the count it was given, and saying
   * so precisely is better than widening the claim to cover ground it cannot
   * measure.
   */
  readonly references?: ReferenceCompleteness | undefined;
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
  /**
   * The match was in the file's body — EPIC-087.
   *
   * Distinct from `ENTITY` because it answers a different question. An entity
   * hit means the thing is *called* that; a content hit means the thing
   * *contains* that, and a caller deciding whether to show a path or a snippet
   * needs to know which.
   */
  CONTENT: 'content',
} as const;

export type HitSource = (typeof HitSource)[keyof typeof HitSource];

export interface SearchHit {
  readonly source: HitSource;
  readonly entity: CanonicalEntity;
  /** The evidence that matched, when the hit came from one. */
  readonly evidence: CanonicalEvidence | undefined;
  /**
   * Relevance, higher is better, in `[0, 1]`.
   *
   * Comparable across queries — EPIC-056 §8.1, which is what changed it. It
   * used to be PostgreSQL's raw `ts_rank`: a function of the document and the
   * query, unbounded above, so 0.09 in one search and 0.09 in another were
   * unrelated quantities and "treating it as one across queries is how a
   * threshold gets hard-coded that means nothing". Every branch now ranks with
   * normalisation `32` (`rank / (rank + 1)`), and independent matches combine
   * by probabilistic or. `1.0` is reserved for an exact identifier match.
   */
  readonly score: number;
  /** The matched text with the query terms marked, for showing a person why. */
  readonly highlight: string | undefined;
  /**
   * How the score was arrived at — EPIC-056 §12.
   *
   * Absent on a hit that did not come from the ranked path. Present, it is the
   * observability for ranking: no metric and no log line, because the breakdown
   * travels with the answer, which Governance §18 prefers to a number in a log
   * nobody correlates.
   */
  readonly ranking?: RankBreakdown;
}

/**
 * Why a hit ranks where it does — EPIC-056.
 *
 * Not an explanation feature; EPIC-063 owns that. This is the arithmetic, so a
 * reader can check the order rather than trust it.
 */
export interface RankBreakdown {
  /** This hit's own normalised relevance, before anything was combined. */
  readonly relevance: number;
  /**
   * What contributed, one entry per independent contributor.
   *
   * `entity`, `evidence` and `content` are the hit's own branches;
   * `subsumed:<id>` is a part of this thing that matched — a symbol it
   * declares, a version of it — credited to it under §8.2.
   */
  readonly contributors: readonly string[];
  /** Entity ids folded into this hit rather than returned beside it. */
  readonly subsumed: readonly string[];
  /**
   * Whether what this hit says still holds — EPIC-057 §8.1. Lower is better.
   *
   * `0` is a thing the source reports as present. Anything above it is a hit
   * ranked below every live result: removed, replaced, or never observed. It is
   * an ordering over recorded lifecycle, never a decay curve — age alone is not
   * evidence that something stopped being true.
   */
  readonly standing: number;
  /**
   * Why standing moved this hit, for a person to read.
   *
   * Absent on a live hit, because a sentence on every result saying "this is
   * live" is noise a reader learns to skip — and then does not read the one that
   * matters. Governance §18 asks Ferret to explain why evidence was "considered
   * stale"; this is that sentence for a search hit.
   */
  readonly why?: string | undefined;
}

/**
 * Ordering inputs a hit may carry that are not on `SearchHit` — EPIC-057 §5.
 *
 * `authority` lives on the evidence record, and the ranked path deliberately
 * does not read evidence until it knows which hits survive. The candidate row
 * carries the one field the ordering needs instead, so overfetching does not
 * multiply round trips for objects nobody sees.
 */
export interface RankSignals {
  /** The backing evidence's authority rank, when this hit came from one. */
  readonly authority?: number | undefined;
}

/**
 * Hits, and how much the caller was not allowed to see — EPIC-058.
 *
 * A result object rather than a bare array *only* here, and deliberately: search
 * covers evidence statements, so it is the path where a permission scope decides
 * whether content reaches an answer, and it is therefore the path where a caller
 * most needs to know the answer is short. `withheld` carries counts and nothing
 * else.
 */
export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly withheld: WithheldReport;
}

/**
 * What an exact lookup found, and what it could not show.
 *
 * A result object rather than a bare array, for the reason `SearchResult` is
 * one — and it was missing here, which is the whole of F-31. `findEntities`
 * filtered permission-withheld rows *after* the `LIMIT`, into a tally it
 * constructed inline and threw away, so a caller received a shorter array and
 * nothing else. `ferret_find` then derived "is there more" from that array's
 * length and reported `truncated: false` over an answer that had been cut.
 *
 * The two facts are separate and both are reported. `more` means the store
 * holds further matches; `withheld` means rows were removed because this caller
 * may not see them. Collapsing them would make "you are not allowed to see it"
 * indistinguishable from "there is nothing there", which is the distinction
 * EPIC-058 exists to keep.
 */
export interface EntityResult {
  readonly entities: readonly CanonicalEntity[];
  readonly withheld: WithheldReport;
  /** Further matches exist beyond the ones returned. */
  readonly more: boolean;
}

/**
 * Whether the reference graph behind this answer is whole — F-27.
 *
 * The counts exist: EPIC-035 §12's per-file `referenceResolution` is persisted
 * on the `file` entity. What was missing is that no read surface consulted them,
 * so an inbound reference list came back with `truncated: false` and
 * `withheld: 0` — an affirmative claim of completeness — over a graph from which
 * Ferret had *refused* to resolve references. "Nothing references this" and "we
 * declined to resolve the references that would have answered you" were the same
 * bytes.
 *
 * **Reported, never repaired.** This says how much of the graph is missing. It
 * does not guess at edges, and no count here becomes a neighbour.
 *
 * `completeness` is derived rather than stored, from the reasons rather than
 * from the total, because the reasons do not mean the same thing:
 *
 * - `ambiguous`, `receiver-unknown`, `imported` are **refusals**. Ferret holds
 *   declarations that could be the target and declined to choose, so any one of
 *   them could have been an edge into the entity being asked about. `imported`
 *   belongs here and it is the easy one to get wrong: `import { foo } from
 *   './bar.js'` names a symbol Ferret very likely *does* hold, and §8.4 does not
 *   follow the import — so the edge is missing, not absent.
 * - `not-found` is an **absence**. No declaration Ferret holds carries the name,
 *   so it cannot be an edge to a held symbol; the target is a built-in, another
 *   repository, or nothing. Counting it as incompleteness would mark every real
 *   index incomplete for referring to `console.log`, and a caveat that is always
 *   on is one a reader learns to skip — the F-66 lesson, earned once already.
 *
 * Every reason is still reported. The verdict is derived from the refusals; the
 * numbers let a caller disagree with that derivation.
 */
export interface ReferenceCompleteness {
  /**
   * `complete` — every reference in scope resolved or was a true absence.
   * `incomplete` — references were refused, so this answer may be short.
   * `unknown` — nothing in scope recorded resolution counts, so completeness is
   * not merely unproven but unmeasured. Distinct from `complete` on purpose: an
   * index built before F-27, or one whose content stage never ran, must not be
   * able to claim a clean bill of health it never earned.
   */
  readonly completeness: 'complete' | 'incomplete' | 'unknown';
  /** References the parser found across the scope. */
  readonly extracted: number;
  /** References that became an edge. */
  readonly resolved: number;
  /**
   * What did not resolve, and why. `total` counts every reason; `refused` counts
   * only those that could have hidden an edge to a held symbol, and is what
   * `completeness` is derived from.
   */
  readonly unresolved: {
    readonly total: number;
    readonly refused: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
  /**
   * Files in scope carrying resolution counts.
   *
   * Zero is what makes the verdict `unknown`. Counted rather than inferred from
   * `extracted === 0`, because a scope of genuinely reference-free files is a
   * measured scope and must report `complete`, not `unknown`.
   */
  readonly filesMeasured: number;
}

/** One hop's neighbours, what was withheld, and whether the hop was cut short. */
export interface NeighbourResult {
  readonly neighbours: readonly Neighbour[];
  readonly withheld: WithheldReport;
  /**
   * How whole the reference graph behind this answer is — F-27.
   *
   * Present only when the query could have returned reference edges. Absent
   * means the question was not about references, not that the answer is
   * complete: a commit's neighbours have no reference graph to be short of, and
   * attaching a resolution verdict to them would be noise asserting a
   * relationship that does not exist.
   */
  readonly references?: ReferenceCompleteness | undefined;
  /**
   * The bound cut this hop.
   *
   * Reported because a traversal cannot see it otherwise: the limit is applied
   * in SQL and the walk counts rows in TypeScript, so a frontier node whose
   * neighbours were cut in the database looked to the walk exactly like a node
   * that had no more — and a truncated traversal was returned as an exhaustive
   * one.
   */
  readonly more: boolean;
}

/**
 * Every read Ferret can be asked to perform, and the authorization it is
 * performed under.
 *
 * `access` is a **required second parameter** on every method — EPIC-058, and
 * `Checkpoints/EPIC-008.md:112` states the reason: "EPIC-058 must make it
 * mandatory on the retrieval path — an internal caller omitting it is correct, a
 * retrieval caller omitting it is a leak." A parameter that can be omitted is a
 * parameter that will be, and Governance §12 puts the control here rather than
 * in a convention. `PUBLIC_ACCESS` is how a caller says "the default view" in
 * code a reviewer can grep for.
 */
export interface RetrievalPort {
  findEntities(query: EntityQuery, access: AccessContext): Promise<EntityResult>;
  getEntity(id: string, access: AccessContext): Promise<CanonicalEntity | undefined>;
  neighbours(query: TraversalQuery, access: AccessContext): Promise<NeighbourResult>;
  /**
   * Multi-hop traversal — EPIC-050.
   *
   * Separate from `neighbours` because the *result* differs: a path rather than
   * a neighbour. `neighbours` stays the one-hop primitive every existing caller
   * uses, and EPIC-007's five recorded limitations are answered here.
   */
  traverse(query: TraversalQuery, access: AccessContext): Promise<TraversalResult>;
  search(query: SearchQuery, access: AccessContext): Promise<SearchResult>;
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

/**
 * Where a page starts — EPIC-118.
 *
 * Unbounded above, deliberately: `MAX_LIMIT` bounds what one query *returns*,
 * which is what protects a context window, and bounding the offset too would
 * cap how much of a repository could ever be enumerated — the exact failure
 * this exists to fix. A repository with more entities than any ceiling anyone
 * picked is a repository Ferret would be unable to describe.
 *
 * Rejected values become 0 rather than an error, matching `boundedLimit`. A
 * caller that reaches the store with a negative offset has already been refused
 * by the MCP schema; this is the second line, and it fails towards the first
 * page rather than towards a database error.
 */
export function boundedOffset(requested: number | undefined): number {
  if (requested === undefined) return 0;
  if (!Number.isInteger(requested) || requested < 0) return 0;
  return requested;
}
