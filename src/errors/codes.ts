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
  /** No registered provider offers a capability the operation needs. */
  CAPABILITY_UNAVAILABLE: 'E_CAPABILITY_UNAVAILABLE',
  /** A pagination cursor is malformed, expired, or was issued by something else. */
  CURSOR_INVALID: 'E_CURSOR_INVALID',
  /** The database is unreachable, refused the connection, or dropped it. */
  STORAGE_UNAVAILABLE: 'E_STORAGE_UNAVAILABLE',
  /** The database rejected an operation because the role lacks a privilege. */
  STORAGE_PERMISSION_DENIED: 'E_STORAGE_PERMISSION_DENIED',
  /** A transaction lost a race with a concurrent one. Retryable — EPIC-079. */
  STORAGE_CONFLICT: 'E_STORAGE_CONFLICT',
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
  /** A canonical entity failed validation, or names an unregistered kind. */
  ENTITY_INVALID: 'E_ENTITY_INVALID',
  /** An entity that was expected to exist does not. */
  ENTITY_NOT_FOUND: 'E_ENTITY_NOT_FOUND',
  /** A relationship failed validation, or names an unregistered type. */
  RELATIONSHIP_INVALID: 'E_RELATIONSHIP_INVALID',
  /** An evidence record failed validation. */
  EVIDENCE_INVALID: 'E_EVIDENCE_INVALID',
  /** A stored evidence record no longer matches its integrity hash. */
  EVIDENCE_TAMPERED: 'E_EVIDENCE_TAMPERED',
  /** An identity alias or reconciliation is not valid. */
  IDENTITY_INVALID: 'E_IDENTITY_INVALID',
  /** Two actors claim the same external identity. Never merged silently. */
  IDENTITY_COLLISION: 'E_IDENTITY_COLLISION',
  /**
   * The caller was not granted the permission this operation requires — EPIC-068.
   *
   * Deliberately distinct from `ENTITY_NOT_FOUND` *and* returned identically
   * whether or not the target exists: a refusal that varied would let a caller
   * probe for the existence of something it may not see.
   */
  NOT_PERMITTED: 'E_NOT_PERMITTED',
  /**
   * A destructive operation was requested without confirmation — EPIC-069.
   *
   * Not a failure: the operation was well formed and permitted, and Ferret
   * disclosed what it would do instead of doing it. The error carries the plan
   * and a token, and the remediation is to present that token.
   */
  CONFIRMATION_REQUIRED: 'E_CONFIRMATION_REQUIRED',
  /**
   * A confirmation token cannot be used — EPIC-069.
   *
   * Returned identically whether the token was never issued, has expired, has
   * already been spent, or was issued for a different operation: a refusal that
   * distinguished them would let a caller probe for a token's existence.
   */
  CONFIRMATION_INVALID: 'E_CONFIRMATION_INVALID',
  /**
   * A remote source system refused the credential Ferret presented — EPIC-021.
   *
   * Distinct from `NOT_PERMITTED`, which is *Ferret's* authorization decision
   * about its own caller. This one is somebody else's system saying no, and the
   * remediation is a token rather than a grant. Conflating them would send a
   * user to `ferret` when the fix is on GitHub.
   */
  SOURCE_UNAUTHORIZED: 'E_SOURCE_UNAUTHORIZED',
  /**
   * A remote source system is unreachable, failing, or rate-limiting — EPIC-021.
   *
   * Retryable by construction: unlike `DEPENDENCY_UNAVAILABLE`, which reports a
   * missing local tool that no amount of waiting installs, this says the system
   * exists and is not answering *now*.
   */
  SOURCE_UNAVAILABLE: 'E_SOURCE_UNAVAILABLE',
  /**
   * A strict export cannot satisfy the fidelity contract — EPIC-089 D1.
   *
   * Not a fault in the index and not a failure of the database: the index
   * holds a credential-shaped value, and a strict export will neither write it
   * into a cleartext document nor rewrite it and leave a content hash that no
   * longer describes its row. Distinct from `STORAGE_*` so a caller can tell
   * "this index cannot be exported strictly" from "the export broke", and
   * distinct from `NOT_PERMITTED` because nothing was refused to the operator —
   * the operator can take the faithful document instead.
   */
  EXPORT_REFUSED: 'E_EXPORT_REFUSED',
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
