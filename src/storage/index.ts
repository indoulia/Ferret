export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  MINIMUM_POSTGRES_MAJOR,
  classifyDatabaseError,
  createPool,
  describeConnection,
  isMissingRelation,
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
  type EvidenceQuery,
  type RecordedEvidence,
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
