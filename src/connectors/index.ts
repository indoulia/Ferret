/**
 * The universal source connector boundary — EPIC-119.
 *
 * The contract itself lives with the other capability contracts, in
 * `providers/contracts/source-connector.ts`, because that is where a provider
 * looks for what it must implement. What lives here is the *other* half: the
 * one ingestion path every connector reaches, and the first real adapter onto
 * it.
 */

export {
  DEFAULT_INGEST_PAGE_LIMIT,
  INGEST_PRODUCER,
  SourceIngestor,
  ingestSources,
  type IngestCounts,
  type IngestDependencies,
  type IngestOptions,
  type IngestOutcome,
  type IngestReport,
  type IngestRequest,
} from './ingest.js';

export {
  PROJECT_ISSUE_RECORD,
  projectSourceConnector,
  type ProjectConnectorOptions,
} from './project-connector.js';

export {
  NO_WRITES,
  addWrites,
  writeContribution,
  type ContributionGraph,
  type ContributionWriters,
  type ContributionWrites,
} from './write.js';
