/**
 * Stable, machine-readable error codes.
 *
 * Codes are part of Ferret's public contract: AI clients and scripts may branch
 * on them. Add new codes; do not repurpose or remove existing ones.
 */
export const ErrorCode = {
  /** An error that Ferret could not classify. */
  UNKNOWN: 'E_UNKNOWN',
  /** The caller invoked the CLI or an API incorrectly. */
  USAGE: 'E_USAGE',
  /** Configuration was supplied but is not valid. */
  CONFIG_INVALID: 'E_CONFIG_INVALID',
  /** Configuration required for the requested operation was not supplied. */
  CONFIG_MISSING: 'E_CONFIG_MISSING',
  /** A required external dependency is absent or unusable. */
  DEPENDENCY_UNAVAILABLE: 'E_DEPENDENCY_UNAVAILABLE',
  /** A required external dependency is present but at an unsupported version. */
  DEPENDENCY_UNSUPPORTED: 'E_DEPENDENCY_UNSUPPORTED',
  /** An operation was requested that the runtime's current state does not allow. */
  LIFECYCLE_INVALID_STATE: 'E_LIFECYCLE_INVALID_STATE',
  /** Runtime initialization failed. */
  INITIALIZATION_FAILED: 'E_INITIALIZATION_FAILED',
  /** One or more resources failed to release during shutdown. */
  SHUTDOWN_FAILED: 'E_SHUTDOWN_FAILED',
  /** A provider with the same identifier is already registered. */
  PROVIDER_DUPLICATE: 'E_PROVIDER_DUPLICATE',
  /** A provider does not satisfy the provider contract. */
  PROVIDER_INVALID: 'E_PROVIDER_INVALID',
  /** A provider failed during initialization. */
  PROVIDER_INIT_FAILED: 'E_PROVIDER_INIT_FAILED',
  /** The database is unreachable, refused the connection, or dropped it. */
  STORAGE_UNAVAILABLE: 'E_STORAGE_UNAVAILABLE',
  /** The database rejected an operation because the role lacks a privilege. */
  STORAGE_PERMISSION_DENIED: 'E_STORAGE_PERMISSION_DENIED',
  /** A schema migration failed. The database is left at the last good version. */
  MIGRATION_FAILED: 'E_MIGRATION_FAILED',
  /** Another process holds the migration lock and did not release it in time. */
  MIGRATION_LOCKED: 'E_MIGRATION_LOCKED',
  /** Migrations are pending and the active policy forbids applying them. */
  MIGRATION_PENDING: 'E_MIGRATION_PENDING',
  /** The database schema is newer or otherwise unknown to this Ferret build. */
  SCHEMA_UNSUPPORTED: 'E_SCHEMA_UNSUPPORTED',
  /** An applied migration no longer matches the migration this build ships. */
  SCHEMA_DRIFT: 'E_SCHEMA_DRIFT',
  /** The capability exists in the roadmap but is not implemented in this release. */
  NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  /** The operation was interrupted by a signal. */
  INTERRUPTED: 'E_INTERRUPTED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const KNOWN: ReadonlySet<string> = new Set(Object.values(ErrorCode));

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN.has(value);
}
