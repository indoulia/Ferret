import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import {
  BaseProvider,
  Capability,
  CAPABILITY_VERSIONS,
  ProviderKind,
  type CapabilityDeclaration,
  type ProviderContext,
} from '../providers/index.js';

import { probeExtensions, ExtensionState, type ExtensionStatus } from './capabilities.js';
import {
  classifyDatabaseError,
  createPool,
  describeConnection,
  readServerVersion,
  MINIMUM_POSTGRES_MAJOR,
  type ConnectionDescription,
  type ServerVersion,
} from './connection.js';
import {
  migrate,
  readSchemaStatus,
  type MigrationPolicy,
  type MigrationReport,
  type SchemaStatus,
} from './migrator.js';

/**
 * The PostgreSQL storage provider.
 *
 * This is how a database reaches Ferret: through the EPIC-001 provider
 * contract, not through core code importing `pg`. Nothing in `src/runtime`,
 * `src/config` or `src/cli` knows this class exists; `tests/unit/boundaries.test.ts`
 * enforces that. Replacing PostgreSQL later means writing another `storage`
 * provider, not editing the core.
 *
 * It is *not* registered by default. `ferret env` and `ferret --version` must
 * work on a machine with no database, so only commands that need storage
 * register it.
 */

export const STORAGE_PROVIDER_ID = 'ferret.storage.postgres';

export interface StorageProviderOptions {
  /**
   * Overrides the configured migration policy. `ferret status` passes `off` so
   * inspecting health cannot change the schema (EPIC-004).
   */
  readonly policy?: MigrationPolicy;
  readonly lockTimeoutMs?: number;
}

/** Everything the provider learned about the database while starting. */
export interface StorageReport {
  readonly connection: ConnectionDescription;
  readonly server: ServerVersion;
  readonly schema: SchemaStatus;
  readonly migration: MigrationReport;
  readonly extensions: readonly ExtensionStatus[];
}

/**
 * EPIC-012: the lifecycle comes from {@link BaseProvider} rather than being
 * written here again.
 *
 * That is not only tidiness. The hand-written `shutdown` read `#pool` and
 * returned when it was undefined — correct for a provider that was never
 * started, and a **leak** when a shutdown arrived while `initialize` was still
 * connecting: it closed nothing, and the pool created a moment later was never
 * closed by anyone. `BaseProvider` waits for the in-flight initialization
 * before tearing down, which closes that race for every provider at once.
 */
export class PostgresStorageProvider extends BaseProvider {
  readonly id = STORAGE_PROVIDER_ID;
  readonly kind = ProviderKind.STORAGE;
  readonly description =
    'PostgreSQL persistence, schema migration and schema version tracking';

  /**
   * What this provider offers, declared for capability-based selection.
   *
   * The core asks the registry for `storage` and is handed this; nothing outside
   * `src/storage` names `PostgresStorageProvider`. Replacing PostgreSQL means
   * registering a different provider that declares the same capability.
   *
   * The declared limits are honest rather than aspirational: PostgreSQL pages
   * and filters server-side, has no rate limit of its own, and incremental reads
   * are the caller's to express through a query — so `supportsIncremental` is
   * deliberately absent rather than optimistically true.
   */
  readonly capabilities: readonly CapabilityDeclaration[] = [
    {
      capability: Capability.STORAGE,
      version: CAPABILITY_VERSIONS[Capability.STORAGE],
      systems: ['postgresql'],
      limits: {
        supportsPagination: true,
        supportsServerSideFilter: true,
        notes: 'Bounded by the configured pool size; a burst queues rather than failing.',
      },
    },
  ];

  readonly #options: StorageProviderOptions;
  #pool: Pool | undefined;
  #db: NodePgDatabase<Record<string, never>> | undefined;
  #report: StorageReport | undefined;
  #logger: Logger | undefined;

  constructor(options: StorageProviderOptions = {}) {
    super();
    this.#options = options;
  }

  /**
   * The pool.
   *
   * @throws {FerretError} `E_LIFECYCLE_INVALID_STATE` before initialization, so
   * a caller cannot silently operate on a half-built provider.
   */
  get pool(): Pool {
    if (this.#pool === undefined) throw this.#notReady('pool');
    return this.#pool;
  }

  /**
   * The Drizzle handle every later Epic queries through.
   *
   * TECHNOLOGY-DECISIONS §3 selected Drizzle for its generated, versioned
   * migrations, and requires full-text and vector queries to be written as raw
   * `sql` templates so the query path stays explicit.
   */
  get db(): NodePgDatabase<Record<string, never>> {
    if (this.#db === undefined) throw this.#notReady('db');
    return this.#db;
  }

  /** What starting the provider observed. Available after initialization. */
  get report(): StorageReport {
    if (this.#report === undefined) throw this.#notReady('report');
    return this.#report;
  }

  #notReady(member: string): FerretError {
    return new FerretError(
      ErrorCode.LIFECYCLE_INVALID_STATE,
      `Storage provider member "${member}" was read before initialization`,
      { details: { providerId: this.id, member }, remediation: 'Await runtime.initialize() first.' },
    );
  }

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    const logger = context.logger.child({ component: 'storage' });
    this.#logger = logger;

    const connection = describeConnection(context.config);
    // Logged before connecting so a hang is attributable to a host and port.
    // `describeConnection` cannot return the password.
    logger.debug({ operation: 'storage.connect', connection }, 'Connecting to PostgreSQL');

    const pool = createPool(context.config, logger);
    this.#pool = pool;

    try {
      const server = await this.#verifyServer(pool);
      const policy = this.#options.policy ?? context.config.database.migrate;
      const migration = await migrate(pool, {
        logger,
        policy,
        ...(this.#options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: this.#options.lockTimeoutMs }),
        signal: context.signal,
      });
      const schema = await readSchemaStatus(pool);
      const extensions = await probeExtensions(pool).catch(() => []);

      this.#db = drizzle(pool);
      this.#report = { connection, server, schema, migration, extensions };

      logger.info(
        {
          operation: 'storage.initialize',
          connection,
          server: server.version,
          schemaVersion: schema.schemaVersion,
          targetVersion: schema.targetVersion,
          extensions: extensions.map((entry) => ({ name: entry.name, state: entry.state })),
        },
        'PostgreSQL storage ready',
      );
    } catch (error) {
      // A provider that fails to start must not leave sockets open; the runtime
      // will not call shutdown() for a provider whose initialize() threw.
      await pool.end().catch(() => undefined);
      this.#pool = undefined;
      throw classifyDatabaseError(error, 'storage.initialize');
    }
  }

  async #verifyServer(pool: Pool): Promise<ServerVersion> {
    const server = await readServerVersion(pool).catch((error: unknown) => {
      throw classifyDatabaseError(error, 'storage.serverVersion');
    });
    if (!server.supported) {
      throw new FerretError(
        ErrorCode.DEPENDENCY_UNSUPPORTED,
        `PostgreSQL ${server.version} is older than the supported minimum ${String(MINIMUM_POSTGRES_MAJOR)}`,
        {
          details: { version: server.version, major: server.major, minimum: MINIMUM_POSTGRES_MAJOR },
          remediation: `Upgrade PostgreSQL to ${String(MINIMUM_POSTGRES_MAJOR)} or newer.`,
        },
      );
    }
    return server;
  }

  /**
   * Health of the database, its schema and its optional extensions.
   *
   * Read-only, and never throws: an unreachable database is a *result*, not an
   * exception, because `ferret status` must still answer when the database is
   * down (EPIC-004).
   */
  async checkDependencies(): Promise<readonly DependencyCheckResult[]> {
    const results: DependencyCheckResult[] = [];
    const pool = this.#pool;

    if (pool === undefined) {
      return [
        {
          name: 'postgres',
          status: DependencyStatus.UNKNOWN,
          required: true,
          detail: 'The storage provider has not been initialized',
        },
      ];
    }

    try {
      const server = await readServerVersion(pool);
      results.push({
        name: 'postgres',
        status: server.supported ? DependencyStatus.OK : DependencyStatus.UNAVAILABLE,
        required: true,
        detail: `PostgreSQL ${server.version}`,
        ...(server.supported
          ? {}
          : { remediation: `Upgrade PostgreSQL to ${String(MINIMUM_POSTGRES_MAJOR)} or newer.` }),
      });
    } catch (error) {
      const classified = classifyDatabaseError(error, 'storage.check');
      return [
        {
          name: 'postgres',
          status: DependencyStatus.UNAVAILABLE,
          required: true,
          detail: classified.message,
          ...(classified.remediation === undefined ? {} : { remediation: classified.remediation }),
        },
      ];
    }

    results.push(await this.#checkSchema(pool));
    results.push(...(await this.#checkExtensions(pool)));
    return results;
  }

  async #checkSchema(pool: Pool): Promise<DependencyCheckResult> {
    try {
      const schema = await readSchemaStatus(pool);
      if (schema.failures.length > 0) {
        const first = schema.failures[0];
        return {
          name: 'postgres-schema',
          status: DependencyStatus.UNAVAILABLE,
          required: true,
          detail: `Migration ${String(first?.version)} ("${first?.name ?? 'unknown'}") last failed: ${first?.errorMessage ?? 'no detail recorded'}`,
          remediation:
            'Fix the recorded cause and run `ferret init` again. The database is still at its last good schema version.',
        };
      }
      if (schema.unknown.length > 0) {
        return {
          name: 'postgres-schema',
          status: DependencyStatus.UNAVAILABLE,
          required: true,
          detail: `The database is at schema version ${String(Math.max(...schema.unknown))}, newer than this build's target ${String(schema.targetVersion)}`,
          remediation: 'Upgrade Ferret to a build that knows this schema.',
        };
      }
      if (schema.drift.length > 0) {
        return {
          name: 'postgres-schema',
          status: DependencyStatus.UNAVAILABLE,
          required: true,
          detail: `${String(schema.drift.length)} applied migration(s) no longer match the SQL this build ships`,
          remediation: 'Restore the original migration files, or roll forward with a new migration.',
        };
      }
      if (schema.pending.length > 0) {
        return {
          name: 'postgres-schema',
          status: DependencyStatus.DEGRADED,
          required: true,
          detail: `Schema is at version ${String(schema.schemaVersion)}; ${String(schema.pending.length)} migration(s) pending toward ${String(schema.targetVersion)}`,
          remediation: 'Run `ferret init` to apply the pending migrations.',
        };
      }
      return {
        name: 'postgres-schema',
        status: DependencyStatus.OK,
        required: true,
        detail: `Schema version ${String(schema.schemaVersion)} of ${String(schema.targetVersion)}`,
      };
    } catch (error) {
      const classified = classifyDatabaseError(error, 'storage.check.schema');
      return {
        name: 'postgres-schema',
        status: DependencyStatus.UNKNOWN,
        required: true,
        detail: classified.message,
      };
    }
  }

  async #checkExtensions(pool: Pool): Promise<readonly DependencyCheckResult[]> {
    try {
      const extensions = await probeExtensions(pool);
      return extensions.map((extension): DependencyCheckResult => {
        const installed = extension.state === ExtensionState.INSTALLED;
        return {
          name: `postgres-extension-${extension.name}`,
          // Not required: deterministic retrieval (EPIC-052/053) works without
          // pgvector. Only semantic retrieval (EPIC-054) needs it.
          status: installed ? DependencyStatus.OK : DependencyStatus.DEGRADED,
          required: false,
          detail: installed
            ? `${extension.name} ${extension.version ?? 'installed'}`
            : `${extension.name} is ${extension.state}; semantic retrieval stays unavailable`,
          ...(installed
            ? {}
            : {
                remediation: `Run \`ferret init\` as a role permitted to CREATE EXTENSION "${extension.name}", or ask an administrator to install it.`,
              }),
        };
      });
    } catch {
      return [
        {
          name: 'postgres-extensions',
          status: DependencyStatus.UNKNOWN,
          required: false,
          detail: 'Could not read pg_available_extensions',
        },
      ];
    }
  }

  /** Closes the pool. Safe to call without a successful `initialize`. */
  protected override async onShutdown(): Promise<void> {
    const pool = this.#pool;
    this.#pool = undefined;
    this.#db = undefined;
    if (pool === undefined) return;
    try {
      await pool.end();
    } finally {
      this.#logger?.debug({ operation: 'storage.shutdown' }, 'PostgreSQL pool closed');
    }
  }
}

/** Convenience constructor matching the style of the other subsystems. */
export function createStorageProvider(options: StorageProviderOptions = {}): PostgresStorageProvider {
  return new PostgresStorageProvider(options);
}
