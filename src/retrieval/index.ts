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
