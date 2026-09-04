export {
  CONFLICT_INITIAL_DELAY_MS,
  CONFLICT_MAX_ATTEMPTS,
  CONFLICT_MAX_DELAY_MS,
  withConflictRetry,
  type ConflictRetryOptions,
} from './conflict-retry.js';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  MINIMUM_POSTGRES_MAJOR,
  classifyDatabaseError,
  createPool,
  describeConnection,
  isMissingRelation,
  isTransientConflict,
  poolConfigFor,
  readServerVersion,
  type ConnectionDescription,
  type ServerVersion,
} from './connection.js';

export {
  ExtensionState,
  OPTIONAL_EXTENSIONS,
  probeExtensions,
  provisionExtensions,
  type ExtensionProvisionResult,
  type ExtensionStatus,
} from './capabilities.js';

export {
  allMigrations,
  checksumOf,
  targetSchemaVersion,
  type Migration,
} from './migration-source.js';

export {
  FAILURES_TABLE,
  FERRET_SCHEMA,
  MIGRATIONS_TABLE,
  type AppliedMigrationRow,
  type MigrationFailureRow,
} from './bookkeeping.js';

export {
  ADVISORY_LOCK_CLASS,
  ADVISORY_LOCK_MIGRATIONS,
  DEFAULT_LOCK_TIMEOUT_MS,
  MigrationPolicy,
  migrate,
  readSchemaStatus,
  type AppliedInThisRun,
  type MigrateOptions,
  type MigrationReport,
  type PendingMigration,
  type SchemaDrift,
  type SchemaStatus,
} from './migrator.js';

export {
  PostgresStorageProvider,
  STORAGE_PROVIDER_ID,
  createStorageProvider,
  type StorageProviderOptions,
  type StorageReport,
} from './provider.js';

export {
  EntityStore,
  UpsertOutcome,
  type FerretDatabase,
  type UpsertResult,
} from './entities.js';

export {
  entity,
  entityExternalId,
  ferret as ferretSchema,
  type EntityExternalIdRow,
  type EntityRow,
  type NewEntityRow,
} from './schema/entities.js';

export {
  AssertOutcome,
  RelationshipStore,
  type AssertResult,
  type TraversalOptions,
} from './relationships.js';

export {
  relationship,
  type NewRelationshipRow,
  type RelationshipRow,
} from './schema/relationships.js';

export {
  EvidenceStore,
  UNRESTRICTED_READ,
  type EvidenceQuery,
  type ConflictReconciliation,
  type RecordedEvidence,
  type ScopedRead,
} from './evidence.js';

export {
  evidence,
  evidenceDerivation,
  type EvidenceDerivationRow,
  type EvidenceRow,
  type NewEvidenceRow,
} from './schema/evidence.js';

export {
  IdentityStore,
  LinkOutcome,
  type LinkResult,
  type MergeResult,
} from './identities.js';

export {
  identityAlias,
  type IdentityAliasRow,
  type NewIdentityAliasRow,
} from './schema/identities.js';

export {
  ArtifactState,
  CompatibilityService,
  type DerivedArtifact,
  type DerivedArtifactInput,
} from './compatibility.js';

export {
  derivedArtifact,
  type DerivedArtifactRow,
  type NewDerivedArtifactRow,
} from './schema/derived.js';

export { RetrievalStore } from './retrieval.js';

export { IndexLifecycleStore, type LifecycleChange } from './lifecycle.js';

export {
  EmbeddingStore,
  SemanticRetrieval,
  type StoredEmbedding,
} from './embeddings.js';

export { SymbolStore, escapeLikePrefix } from './symbols.js';
export {
  DEFAULT_SWEEP_LIMIT,
  IntegrityService,
  UNFINISHED_RUN_AFTER_MS,
  type SweepCounts,
  type SweepCursor,
  type ProducerIdentityResolver,
  type SweepOptions,
  type SweepReport,
} from './integrity.js';
export { IndexRunStore, RunOutcome, type StartedRun, type UnfinishedRun } from './runs.js';
export {
  CURSOR_ARTIFACT_KIND,
  SyncCursorStore,
  type SyncCursor,
  type SyncCursorStatus,
} from './cursors.js';
export {
  describeLockHolder,
  findLockHolder,
  readInventory,
  remediationForHolder,
  type IndexInventory,
  type LockHolder,
} from './diagnostics.js';
export { SessionStore } from './sessions.js';
export { indexRun, type IndexRunRow } from './schema/runs.js';
export {
  engineeringMemory,
  session,
  sessionCapture,
  sessionCheckpoint,
  type EngineeringMemoryRow,
  type SessionCaptureRow,
  type SessionCheckpointRow,
  type SessionRow,
} from './schema/sessions.js';
export { instanceRestore, type InstanceRestoreRow as InstanceRestoreTableRow } from './schema/provenance.js';
export {
  ContentStore,
  MAX_STORED_TEXT_BYTES,
  OMITTED_REASONS,
  classifyContent,
  type ContentBody,
  type ContentStats,
  type OmittedReason,
  type StoreContentInput,
  type StoredContent,
} from './content.js';
export { contentBlob, type ContentBlobRow } from './schema/content.js';
export {
  DEFAULT_JOURNAL_KEEP,
  RETENTION_TARGETS,
  RetentionService,
  RetentionTarget,
  planReclaims,
  type RetentionCount,
  type RetentionPlan,
  type RetentionRequest,
} from './retention.js';
export {
  EXPORT_BATCH_ROWS,
  EXPORT_EXCLUSIONS,
  EXPORT_TABLES,
  ExportService,
  backupCommandFor,
  isExportManifest,
  isExportTrailer,
  readExportDocument,
  type CredentialFinding,
  type ExcludedTable,
  type ExportManifest,
  type ExportOptions,
  type ExportResult,
  type ExportRow,
  type ExportSink,
  type ExportTrailer,
} from './export.js';
export {
  ImportOutcome,
  ImportService,
  MAX_REPORTED_ORPHANS,
  readDocument,
  type CheckedDocument,
  type ImportOptions,
  type ImportProvenance,
  type ImportReport,
  type ImportTableReport,
} from './import.js';
