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
