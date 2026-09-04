import { ErrorCode } from '../errors/index.js';

/**
 * Process exit codes.
 *
 * Part of Ferret's public contract: scripts and AI clients branch on these, so
 * a code's meaning never changes once published. Values below 64 are Ferret's
 * own; 130/143 follow the shell convention of 128 + signal number.
 */
export const ExitCode = {
  OK: 0,
  /** An operation failed for a reason Ferret could not classify. */
  ERROR: 1,
  /** The command line was wrong: unknown command, bad option, bad argument. */
  USAGE: 2,
  /** Configuration is missing or invalid. */
  CONFIG: 3,
  /** A required external dependency is unavailable or unsupported. */
  DEPENDENCY: 4,
  /** The command is planned but not implemented in this release. */
  NOT_IMPLEMENTED: 5,
  /**
   * The database is reachable but its schema is not usable: a migration
   * failed, is pending under a policy that forbids applying it, was applied by
   * a newer Ferret, or was edited after being applied.
   */
  STORAGE: 6,
  /**
   * The caller was not granted the permission the operation requires — EPIC-068.
   *
   * Its own code for the reason `STORAGE` has one: a well-formed request from a
   * principal that simply was not granted something is a distinct condition an
   * operator resolves differently from a missing or invalid configuration value.
   * Collapsing it into `CONFIG` would tell a script "your configuration is
   * broken" when the configuration is fine and the grant is narrow.
   */
  NOT_PERMITTED: 7,
  /**
   * A destructive operation was requested without a usable confirmation —
   * EPIC-069.
   *
   * Distinct from `NOT_PERMITTED` because the two are resolved by different
   * people: a narrow grant is an operator's to widen, while an unconfirmed
   * operation is the caller's to confirm. Collapsing them would tell a script to
   * go and edit configuration when all it needed to do was ask again.
   */
  NOT_CONFIRMED: 8,
  /** Interrupted (SIGINT). */
  INTERRUPTED: 130,
  /** Terminated (SIGTERM). */
  TERMINATED: 143,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const BY_ERROR_CODE: Readonly<Record<ErrorCode, ExitCode>> = {
  [ErrorCode.UNKNOWN]: ExitCode.ERROR,
  [ErrorCode.USAGE]: ExitCode.USAGE,
  [ErrorCode.CONFIG_INVALID]: ExitCode.CONFIG,
  [ErrorCode.CONFIG_MISSING]: ExitCode.CONFIG,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: ExitCode.DEPENDENCY,
  // A remote source system is an external dependency like any other — EPIC-021.
  // Both map to `DEPENDENCY` deliberately: a script retries the same way whether
  // GitHub is down or the token is wrong, and the *message* is what tells an
  // operator which. Giving a bad token its own exit code would imply Ferret can
  // tell a revoked token from an expired one, and it cannot.
  [ErrorCode.SOURCE_UNAUTHORIZED]: ExitCode.DEPENDENCY,
  [ErrorCode.SOURCE_UNAVAILABLE]: ExitCode.DEPENDENCY,
  [ErrorCode.DEPENDENCY_UNSUPPORTED]: ExitCode.DEPENDENCY,
  [ErrorCode.LIFECYCLE_INVALID_STATE]: ExitCode.ERROR,
  [ErrorCode.INITIALIZATION_FAILED]: ExitCode.ERROR,
  [ErrorCode.SHUTDOWN_FAILED]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_DUPLICATE]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_INVALID]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_INIT_FAILED]: ExitCode.ERROR,
  // A missing capability is an absent dependency, not a Ferret defect: the
  // remedy is to install or configure a provider that offers it.
  [ErrorCode.CAPABILITY_UNAVAILABLE]: ExitCode.DEPENDENCY,
  // A bad cursor is a malformed request, whoever sent it: the caller passed
  // something Ferret did not issue, which is the usage class.
  [ErrorCode.CURSOR_INVALID]: ExitCode.USAGE,
  // An unreachable database is an unavailable external dependency, which is
  // exit code 4; a *reachable* database whose schema Ferret cannot use is a
  // distinct condition an operator resolves differently, so it gets its own.
  [ErrorCode.STORAGE_UNAVAILABLE]: ExitCode.DEPENDENCY,
  [ErrorCode.STORAGE_PERMISSION_DENIED]: ExitCode.STORAGE,
  // A conflict that outlived its retries is contention, not an unusable schema
  // and not an unreachable server: the database did exactly what it should. The
  // dependency class is right — the remedy is to reduce concurrency or try
  // again, the same shape as a server that is busy.
  [ErrorCode.STORAGE_CONFLICT]: ExitCode.DEPENDENCY,
  [ErrorCode.MIGRATION_FAILED]: ExitCode.STORAGE,
  [ErrorCode.MIGRATION_LOCKED]: ExitCode.STORAGE,
  [ErrorCode.MIGRATION_PENDING]: ExitCode.STORAGE,
  [ErrorCode.SCHEMA_UNSUPPORTED]: ExitCode.STORAGE,
  [ErrorCode.SCHEMA_DRIFT]: ExitCode.STORAGE,
  // An invalid entity is a data problem, not a configuration or dependency one:
  // it means a source object could not be represented. Unclassified is honest.
  [ErrorCode.ENTITY_INVALID]: ExitCode.ERROR,
  [ErrorCode.ENTITY_NOT_FOUND]: ExitCode.ERROR,
  [ErrorCode.RELATIONSHIP_INVALID]: ExitCode.ERROR,
  [ErrorCode.EVIDENCE_INVALID]: ExitCode.ERROR,
  // Tampered evidence is a data-integrity failure, which is the storage class.
  [ErrorCode.EVIDENCE_TAMPERED]: ExitCode.STORAGE,
  [ErrorCode.IDENTITY_INVALID]: ExitCode.ERROR,
  [ErrorCode.IDENTITY_COLLISION]: ExitCode.ERROR,
  [ErrorCode.NOT_PERMITTED]: ExitCode.NOT_PERMITTED,
  // Both, and the same code: from a process's point of view the operation did
  // not happen because it was not confirmed, and whether the token was absent or
  // unusable is in the error the caller already has.
  [ErrorCode.CONFIRMATION_REQUIRED]: ExitCode.NOT_CONFIRMED,
  [ErrorCode.CONFIRMATION_INVALID]: ExitCode.NOT_CONFIRMED,
  // EPIC-089 D1. `ERROR` rather than `STORAGE`: the database is healthy and
  // the index is intact — a strict export declined to write a document it
  // could not make both faithful and credential-free, and the operator's next
  // move is to fix the source value or take the faithful document.
  [ErrorCode.EXPORT_REFUSED]: ExitCode.ERROR,
  [ErrorCode.NOT_IMPLEMENTED]: ExitCode.NOT_IMPLEMENTED,
  [ErrorCode.INTERRUPTED]: ExitCode.INTERRUPTED,
};

/** Maps a structured error code to the process exit code it produces. */
export function exitCodeFor(code: ErrorCode): ExitCode {
  return BY_ERROR_CODE[code] ?? ExitCode.ERROR;
}
