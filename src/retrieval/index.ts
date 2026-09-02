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
  boundedLimit,
  type EntityQuery,
  type Neighbour,
  type RankBreakdown,
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type TraversalQuery,
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
