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
  [ErrorCode.NOT_IMPLEMENTED]: ExitCode.NOT_IMPLEMENTED,
  [ErrorCode.INTERRUPTED]: ExitCode.INTERRUPTED,
};

/** Maps a structured error code to the process exit code it produces. */
export function exitCodeFor(code: ErrorCode): ExitCode {
  return BY_ERROR_CODE[code] ?? ExitCode.ERROR;
}
