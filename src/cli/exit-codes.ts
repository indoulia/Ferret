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
  [ErrorCode.DEPENDENCY_UNSUPPORTED]: ExitCode.DEPENDENCY,
  [ErrorCode.LIFECYCLE_INVALID_STATE]: ExitCode.ERROR,
  [ErrorCode.INITIALIZATION_FAILED]: ExitCode.ERROR,
  [ErrorCode.SHUTDOWN_FAILED]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_DUPLICATE]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_INVALID]: ExitCode.ERROR,
  [ErrorCode.PROVIDER_INIT_FAILED]: ExitCode.ERROR,
  // An unreachable database is an unavailable external dependency, which is
  // exit code 4; a *reachable* database whose schema Ferret cannot use is a
  // distinct condition an operator resolves differently, so it gets its own.
  [ErrorCode.STORAGE_UNAVAILABLE]: ExitCode.DEPENDENCY,
  [ErrorCode.STORAGE_PERMISSION_DENIED]: ExitCode.STORAGE,
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
  [ErrorCode.NOT_IMPLEMENTED]: ExitCode.NOT_IMPLEMENTED,
  [ErrorCode.INTERRUPTED]: ExitCode.INTERRUPTED,
};

/** Maps a structured error code to the process exit code it produces. */
export function exitCodeFor(code: ErrorCode): ExitCode {
  return BY_ERROR_CODE[code] ?? ExitCode.ERROR;
}
