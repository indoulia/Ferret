/**
 * Turning what a provider observed into what Ferret knows.
 *
 * Core logic, deliberately: deciding what to read, in what order, and what has
 * already been seen has nothing to do with PostgreSQL. The indexer names the
 * narrow write interfaces it needs (`./ports.js`) and the EPIC-002 stores
 * satisfy them structurally, so the core still reaches no `storage/` module —
 * which `boundaries.test.ts` proves.
 */

export {
  INDEXER_PRODUCER,
  INDEX_ARTIFACT_KIND,
  RepositoryIndexer,
  assertIndexed,
  type IndexOptions,
  type IndexReport,
  type IndexableSource,
  type IndexerDependencies,
  type WriteCounts,
} from './indexer.js';
export type {
  EntityWriteResult,
  EntityWriter,
  EvidenceWriteResult,
  EvidenceWriter,
  RelationshipWriteResult,
  RelationshipWriter,
  WatermarkRecord,
  WatermarkStore,
} from './ports.js';
