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
  type RetrievalPort,
  type SearchHit,
  type SearchQuery,
  type TraversalQuery,
} from './query.js';

export { QueryShape, classify, type Classification } from './classify.js';
export { RRF_K, fuse, type FusedHit, type RankedList } from './fuse.js';
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
