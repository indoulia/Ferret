/**
 * What Ferret can be asked.
 *
 * Core, deliberately: Ferret must be able to *express* a query without knowing
 * what answers it (Governance §4). `RetrievalPort` is implemented by the storage
 * provider today, and by anything else that can answer tomorrow.
 */

export {
  DEFAULT_LIMIT,
  Direction,
  HitSource,
  MAX_LIMIT,
  MAX_TRAVERSAL_DEPTH,
  TraversalBound,
  boundedDepth,
  boundedLimit,
  boundedOffset,
  type EntityQuery,
  type Neighbour,
  type RankBreakdown,
  type RankSignals,
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type EntityResult,
  type NeighbourResult,
  type ReferenceCompleteness,
  type SearchResult,
  type TraversalPath,
  type TraversalQuery,
  type TraversalResult,
  type TraversalStep,
} from './query.js';

// EPIC-058. Authorization is a parameter on every read, not a convention.
export {
  NOTHING_WITHHELD,
  PUBLIC_ACCESS,
  WithheldTally,
  WithholdReason,
  SCOPE_SEPARATOR,
  assertUsableAccess,
  includedRepositories,
  permits,
  scopeDescendantPattern,
  scopeGrants,
  restricts,
  visibleEntities,
  withholds,
  type AccessContext,
  type WithheldReport,
} from './access.js';

export { QueryShape, classify, type Classification } from './classify.js';
export { RRF_K, fuse, type FusedHit, type RankedList } from './fuse.js';

// EPIC-056. Ranking is core and pure: it reorders, folds and truncates a pool
// authorization already allowed through, and never queries.
export { OVERFETCH, overfetchLimit, rank } from './rank.js';

// EPIC-050. The walk is pure and takes the filtered one-hop read as a function,
// which is what applies permission at every hop rather than only at the end.
export { traverseFrom, type HopReader, type TraverseOptions } from './traverse.js';

// EPIC-057. Freshness is an ordering over recorded lifecycle, not a decay curve.
export { LIVE_STANDING, describeStanding, recencyKey, standing } from './freshness.js';

// EPIC-063. Every sentence comes from a recorded field; nothing is generated,
// and no sentence is composed about source content.
export {
  explainQuery,
  renderExplanation,
  type ExplainableHit,
  type HitNote,
  type QueryExplanation,
  type StrategyNote,
} from './explain.js';
export {
  QueryPlanner,
  type ExactStrategy,
  type PlannedQuery,
  type PlannedResults,
  type PlannerDependencies,
  type QueryPlan,
  type SemanticStrategy,
  type StrategyOutcome,
  type TextStrategy,
} from './planner.js';
