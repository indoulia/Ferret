import { Pool, type PoolClient, type PoolConfig } from 'pg';

import { missingDatabaseFields, type FerretConfig } from '../config/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { PACKAGE_NAME, VERSION } from '../version.js';

/**
 * PostgreSQL connection handling.
 *
 * Ferret owns one pool per runtime. `pg` is the reference Node driver and is
 * used as-is (Governance §5); what this module adds is Ferret's contract around
 * it: connection details never reach a log, an unreachable database produces a
 * classified `E_STORAGE_UNAVAILABLE` rather than a driver-shaped error, and an
 * idle-client fault cannot take the process down.
 */

/** The oldest PostgreSQL major version Ferret supports. */
export const MINIMUM_POSTGRES_MAJOR = 14;

/**
 * Connection ceilings.
 *
 * Deliberately small: Ferret is a single-user local service, not a web tier.
 * A large pool would consume server-side slots the user's own tools need.
 */
export const DEFAULT_POOL_SIZE = 8;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Connection facts safe to log, display or hand to an AI client. */
export interface ConnectionDescription {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
}

/**
 * Turns validated configuration into `pg` connection options.
 *
 * @throws {FerretError} `E_CONFIG_MISSING` when a required field is absent.
 * Failing here — before any socket is opened — is what turns "connection
 * refused" into "you have not told Ferret which database to use".
 */
export function poolConfigFor(config: FerretConfig): PoolConfig {
  const missing = missingDatabaseFields(config);
  if (missing.length > 0) {
    throw new FerretError(
      ErrorCode.CONFIG_MISSING,
      `Database configuration is incomplete — missing ${missing.join(', ')}`,
      {
        details: { missing },
        remediation:
          'Set FERRET_DATABASE_HOST, FERRET_DATABASE_NAME, FERRET_DATABASE_USER and FERRET_DATABASE_PASSWORD, then run `ferret init`.',
      },
    );
  }

  const database = config.database;
  return {
    host: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    max: DEFAULT_POOL_SIZE,
    connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    // A half-open connection through a NAT or a laptop that slept otherwise
    // looks healthy until the next query blocks on it indefinitely.
    keepAlive: true,
    // Names the session in `pg_stat_activity`, so an operator can see which
    // connections belong to Ferret without guessing.
    application_name: `${PACKAGE_NAME}@${VERSION}`,
  };
}

/** Connection facts without the password, for logs and diagnostics. */
export function describeConnection(config: FerretConfig): ConnectionDescription {
  return {
    host: config.database.host ?? '(unset)',
    port: config.database.port,
    database: config.database.database ?? '(unset)',
    user: config.database.user ?? '(unset)',
  };
}

/**
 * Creates the pool.
 *
 * No connection is opened here — `pg` connects lazily — so construction cannot
 * fail for a reason the caller would rather see at first use.
 */
export function createPool(config: FerretConfig, logger: Logger): Pool {
  const pool = new Pool(poolConfigFor(config));

  // An error on an *idle* client is emitted on the pool. Without this listener
  // Node treats it as an unhandled 'error' event and terminates the process, so
  // a routine server restart would kill the user's AI session.
  pool.on('error', (error: Error) => {
    logger.warn(
      { operation: 'storage.pool.idleError', err: { name: error.name, message: error.message } },
      'PostgreSQL dropped an idle connection; it will be re-established on demand',
    );
  });

  return pool;
}

/**
 * PostgreSQL SQLSTATE codes Ferret maps to specific outcomes.
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const SQLSTATE = {
  INSUFFICIENT_PRIVILEGE: '42501',
  INVALID_PASSWORD: '28P01',
  INVALID_AUTHORIZATION: '28000',
  UNDEFINED_DATABASE: '3D000',
  UNDEFINED_TABLE: '42P01',
  UNDEFINED_SCHEMA: '3F000',
  CANNOT_CONNECT_NOW: '57P03',
  ADMIN_SHUTDOWN: '57P01',
  CRASH_SHUTDOWN: '57P02',
  CONNECTION_FAILURE: '08006',
  TOO_MANY_CONNECTIONS: '53300',
} as const;

/** Node socket error codes that mean "the server is not reachable". */
const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
]);

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Classifies a driver or server error into Ferret's error model.
 *
 * Every database failure a user can cause by misconfiguration gets a distinct
 * code and a remediation, because EPIC-004 turns these into `ferret doctor`
 * advice. Anything unrecognized stays `E_STORAGE_UNAVAILABLE` rather than being
 * guessed at — Governance §6 forbids manufacturing certainty.
 */
export function classifyDatabaseError(error: unknown, operation: string): FerretError {
  if (error instanceof FerretError) return error;

  const code = errorCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  const details = { operation, ...(code === undefined ? {} : { sqlstate: code }) };

  switch (code) {
    case SQLSTATE.INVALID_PASSWORD:
    case SQLSTATE.INVALID_AUTHORIZATION:
      return new FerretError(
        ErrorCode.STORAGE_PERMISSION_DENIED,
        `PostgreSQL rejected the credentials: ${message}`,
        {
          details,
          remediation: 'Check FERRET_DATABASE_USER and FERRET_DATABASE_PASSWORD against the server.',
          cause: error,
        },
      );
    case SQLSTATE.INSUFFICIENT_PRIVILEGE:
      return new FerretError(
        ErrorCode.STORAGE_PERMISSION_DENIED,
        `The database role lacks a required privilege: ${message}`,
        {
          details,
          remediation:
            'Grant the Ferret role CREATE on the database, or run `ferret init` once as a role that can create the `ferret` schema.',
          cause: error,
        },
      );
    case SQLSTATE.UNDEFINED_DATABASE:
      return new FerretError(ErrorCode.STORAGE_UNAVAILABLE, `The database does not exist: ${message}`, {
        details,
        remediation: 'Create the database, or correct FERRET_DATABASE_NAME.',
        cause: error,
      });
    case SQLSTATE.TOO_MANY_CONNECTIONS:
    case SQLSTATE.CANNOT_CONNECT_NOW:
    case SQLSTATE.ADMIN_SHUTDOWN:
    case SQLSTATE.CRASH_SHUTDOWN:
    case SQLSTATE.CONNECTION_FAILURE:
      return new FerretError(ErrorCode.STORAGE_UNAVAILABLE, `PostgreSQL is not accepting work: ${message}`, {
        details,
        remediation: 'Wait for the server to finish starting or restarting, then retry.',
        retryable: true,
        cause: error,
      });
    default:
      break;
  }

  if (code !== undefined && UNREACHABLE_CODES.has(code)) {
    return new FerretError(ErrorCode.STORAGE_UNAVAILABLE, `Cannot reach PostgreSQL: ${message}`, {
      details,
      remediation:
        'Check that the server is running and that FERRET_DATABASE_HOST and FERRET_DATABASE_PORT are correct.',
      retryable: true,
      cause: error,
    });
  }

  return new FerretError(ErrorCode.STORAGE_UNAVAILABLE, `PostgreSQL operation "${operation}" failed: ${message}`, {
    details,
    cause: error,
  });
}

/** True when the error means a relation the caller expected does not exist. */
export function isMissingRelation(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === SQLSTATE.UNDEFINED_TABLE || code === SQLSTATE.UNDEFINED_SCHEMA;
}

export interface ServerVersion {
  readonly version: string;
  readonly major: number;
  readonly supported: boolean;
}

/**
 * Reads the server version and checks it against {@link MINIMUM_POSTGRES_MAJOR}.
 *
 * Reported rather than enforced here: the caller decides whether an old server
 * is fatal, because `ferret doctor` must be able to say "your PostgreSQL is too
 * old" instead of failing to start and saying nothing.
 */
export async function readServerVersion(client: Pool | PoolClient): Promise<ServerVersion> {
  const result = await client.query<{ version: string; version_num: string }>(
    'SELECT current_setting($1) AS version, current_setting($2) AS version_num',
    ['server_version', 'server_version_num'],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new FerretError(ErrorCode.STORAGE_UNAVAILABLE, 'PostgreSQL did not report a server version', {
      details: { operation: 'storage.readServerVersion' },
    });
  }
  const major = Math.floor(Number(row.version_num) / 10_000);
  return { version: row.version, major, supported: major >= MINIMUM_POSTGRES_MAJOR };
}
