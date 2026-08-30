import type { Pool, PoolClient } from 'pg';

import type { Logger } from '../logging/index.js';

import { classifyDatabaseError } from './connection.js';

/**
 * Optional PostgreSQL extensions.
 *
 * `pgvector` backs semantic retrieval (EPIC-054). It is deliberately *not* a
 * requirement of EPIC-002: installing an extension needs privileges an ordinary
 * database role may not have, and Ferret's deterministic retrieval path
 * (EPIC-052, EPIC-053) does not need it. So Ferret reports the capability
 * honestly — `available`, `installable`, or `absent` — and the Epics that need
 * it degrade rather than the whole product refusing to start.
 *
 * Governance §6: unavailable must be representable. Never report `available`
 * for something that was not observed.
 */

export const ExtensionState = {
  /** Installed in this database and ready to use. */
  INSTALLED: 'installed',
  /** Present on the server and creatable by a sufficiently privileged role. */
  AVAILABLE: 'available',
  /** Not present on the server; installing it is a server-side action. */
  ABSENT: 'absent',
  /** Could not be determined. */
  UNKNOWN: 'unknown',
} as const;

export type ExtensionState = (typeof ExtensionState)[keyof typeof ExtensionState];

export interface ExtensionStatus {
  readonly name: string;
  readonly state: ExtensionState;
  readonly version: string | undefined;
}

/** Extensions Ferret probes at startup. */
export const OPTIONAL_EXTENSIONS = ['vector'] as const;

/**
 * Reports extension state without changing anything.
 *
 * Read-only by construction: EPIC-004 requires health checks not to mutate, and
 * this runs on every start.
 */
export async function probeExtensions(
  client: Pool | PoolClient,
  names: readonly string[] = OPTIONAL_EXTENSIONS,
): Promise<readonly ExtensionStatus[]> {
  const result = await client.query<{
    name: string;
    installed_version: string | null;
    default_version: string | null;
  }>(
    `SELECT a.name,
            e.extversion    AS installed_version,
            a.default_version
       FROM pg_available_extensions a
       LEFT JOIN pg_extension e ON e.extname = a.name
      WHERE a.name = ANY($1::text[])`,
    [[...names]],
  );

  const found = new Map(result.rows.map((row) => [row.name, row]));
  return names.map((name): ExtensionStatus => {
    const row = found.get(name);
    if (row === undefined) return { name, state: ExtensionState.ABSENT, version: undefined };
    if (row.installed_version !== null) {
      return { name, state: ExtensionState.INSTALLED, version: row.installed_version };
    }
    return { name, state: ExtensionState.AVAILABLE, version: row.default_version ?? undefined };
  });
}

export interface ExtensionProvisionResult extends ExtensionStatus {
  /** True when this call created the extension. */
  readonly created: boolean;
  /** Why the extension could not be created, when it could not. */
  readonly reason: string | undefined;
}

/**
 * Best-effort installation of the optional extensions, for `ferret init`.
 *
 * Failure is never fatal: a role without CREATE EXTENSION is an ordinary,
 * supported deployment. The outcome is reported so the user learns what
 * semantic retrieval will need, instead of discovering it at query time.
 *
 * Only names from {@link OPTIONAL_EXTENSIONS} are accepted, so no caller can
 * turn this into arbitrary DDL with an interpolated identifier — extension
 * names cannot be parameterized in `CREATE EXTENSION`.
 */
export async function provisionExtensions(
  pool: Pool,
  logger: Logger,
  names: readonly string[] = OPTIONAL_EXTENSIONS,
): Promise<readonly ExtensionProvisionResult[]> {
  const allowed = names.filter((name): name is (typeof OPTIONAL_EXTENSIONS)[number] =>
    (OPTIONAL_EXTENSIONS as readonly string[]).includes(name),
  );

  const client = await pool.connect().catch((error: unknown) => {
    throw classifyDatabaseError(error, 'storage.extensions.connect');
  });
  try {
    const before = await probeExtensions(client, allowed);
    const results: ExtensionProvisionResult[] = [];

    for (const status of before) {
      if (status.state === ExtensionState.INSTALLED) {
        results.push({ ...status, created: false, reason: undefined });
        continue;
      }
      if (status.state !== ExtensionState.AVAILABLE) {
        results.push({
          ...status,
          created: false,
          reason: `The PostgreSQL server does not offer the "${status.name}" extension.`,
        });
        continue;
      }
      try {
        // `status.name` is constrained to OPTIONAL_EXTENSIONS above.
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${status.name}"`);
        const [after] = await probeExtensions(client, [status.name]);
        results.push({
          name: status.name,
          state: after?.state ?? ExtensionState.UNKNOWN,
          version: after?.version,
          created: true,
          reason: undefined,
        });
        logger.info(
          { operation: 'storage.extensions.create', extension: status.name },
          `Enabled PostgreSQL extension "${status.name}"`,
        );
      } catch (error) {
        const classified = classifyDatabaseError(error, 'storage.extensions.create');
        results.push({ ...status, created: false, reason: classified.message });
        logger.warn(
          { operation: 'storage.extensions.create', extension: status.name, err: classified.toJSON() },
          `Could not enable PostgreSQL extension "${status.name}"; features that need it stay unavailable`,
        );
      }
    }
    return results;
  } finally {
    client.release();
  }
}
