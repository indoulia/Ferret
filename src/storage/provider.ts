import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import type { FerretConfig } from '../config/index.js';
import { DependencyStatus, type DependencyCheckResult } from '../diagnostics/index.js';
import { ErrorCode, FerretError } from '../errors/index.js';
import type { Logger } from '../logging/index.js';
import { VERSION } from '../version.js';
import {
  BaseProvider,
  Capability,
  CAPABILITY_VERSIONS,
  ProviderKind,
  type CapabilityDeclaration,
  type ProviderContext,
} from '../providers/index.js';

import {
  probeExtensions,
  provisionExtensions,
  ExtensionState,
  type ExtensionProvisionResult,
  type ExtensionStatus,
} from './capabilities.js';
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
  applyRepairs,
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
  /**
   * Install the optional extensions before migrating. `ferret init` asks for it.
   *
   * Off by default, deliberately: `CREATE EXTENSION` needs a privilege an
   * everyday connection has no reason to hold, so an ordinary start must not
   * attempt it. `ferret init` *is* the request to provision, which is why the
   * request comes from the caller rather than from a default.
   *
   * **Before** migrating, because migration `0008` is conditional on pgvector
   * being present. Provisioning afterwards left that conditional taking its
   * "not installed" branch and then being recorded as applied — a migration
   * marked done whose effect never happened, on every fresh install, with no
   * later run able to correct it.
   */
  readonly provisionExtensions?: boolean;
}

/** Everything the provider learned about the database while starting. */
export interface StorageReport {
  readonly connection: ConnectionDescription;
  readonly server: ServerVersion;
  readonly schema: SchemaStatus;
  readonly migration: MigrationReport;
  readonly extensions: readonly ExtensionStatus[];
  /**
   * What provisioning did, when the caller asked for it.
   *
   * Absent on every run that did not provision, which is most of them. It
   * carries `created`, and a probe taken afterwards cannot recover that: an
   * extension this run installed and one installed last year look identical.
   */
  readonly provisioned?: readonly ExtensionProvisionResult[];
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
  /**
   * The one credential Ferret holds, declared by the one thing that opens the
   * connection it exists for — EPIC-081 §8.1.
   *
   * Every other provider's `context.config` has no password field at all, and
   * reaching for one does not compile. This declaration is what makes the
   * exception visible: it is a line in the provider that needs it, not a
   * property of being loaded at all.
   */
  readonly credentials: readonly string[] = ['database.password'];
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

    // Reassembled here and nowhere else — EPIC-081 AC-2. `context.config` no
    // longer carries a password, so the one component allowed to hold one puts
    // it back for the one call that needs it. Deliberately a local: it is not
    // stored on the provider, and nothing else in this file can reach it.
    const password = context.credentials?.['database.password'];
    const config: FerretConfig = {
      ...context.config,
      database: { ...context.config.database, ...(password === undefined ? {} : { password }) },
    };

    const connection = describeConnection(config);
    // Logged before connecting so a hang is attributable to a host and port.
    // `describeConnection` cannot return the password.
    logger.debug({ operation: 'storage.connect', connection }, 'Connecting to PostgreSQL');

    const pool = createPool(config, logger);
    this.#pool = pool;

    try {
      const server = await this.#verifyServer(pool);
      // Before `migrate`, and this order is the whole of EPIC-054's table
      // existing: `0008` asks `to_regtype('vector')` and skips itself when the
      // answer is NULL.
      const provisioned = this.#options.provisionExtensions === true
        ? await provisionExtensions(pool, logger)
        : undefined;
      const policy = this.#options.policy ?? config.database.migrate;
      const migration = await migrate(pool, {
        logger,
        policy,
        ...(this.#options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: this.#options.lockTimeoutMs }),
        signal: context.signal,
      });
      // After the migrations, because the repair's precondition is the
      // extension this run may have just installed, and a conditional migration
      // that ran before it existed is already spent.
      if (provisioned !== undefined) await applyRepairs(pool, logger);

      const schema = await readSchemaStatus(pool);
      // What provisioning did, when it ran: it carries `created`, which a probe
      // afterwards cannot recover. Probed otherwise, which is every other run.
      const extensions = provisioned ?? (await probeExtensions(pool).catch(() => []));

      this.#db = drizzle(pool);
      this.#report = {
        connection,
        server,
        schema,
        migration,
        extensions,
        ...(provisioned === undefined ? {} : { provisioned }),
      };

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
    results.push(await this.#checkIndex(pool));
    return results;
  }

  /**
   * What Ferret has indexed, and whether the build that indexed it is this one.
   *
   * This replaced a hard-coded component that told every operator "no index
   * exists yet, so its integrity cannot be assessed" — including operators
   * whose database held three hundred indexed files. A health check that
   * reports a constant is worse than no health check, because it is believed.
   *
   * A watermark written by a different build is reported as degraded rather
   * than as a failure: nothing is broken, the next run simply re-reads that
   * scope in full, and an operator watching a long re-read deserves to find the
   * reason here rather than infer it.
   */
  async #checkIndex(pool: Pool): Promise<DependencyCheckResult> {
    try {
      const { rows } = await pool.query<{
        total: string;
        current: string;
        newest: Date | null;
        versions: string[] | null;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE producer_version = $1)::text AS current,
                max(built_at) AS newest,
                array_agg(DISTINCT producer_version) FILTER (WHERE producer_version <> $1) AS versions
           FROM ferret.derived_artifact
          -- Only the indexer's own artefacts. EPIC-095 widened this from
          -- kind = 'index' to every ferret.% producer, which swept in
          -- content-index rows whose producer_version is a *parser identity*
          -- rather than a Ferret version. Comparing those to Ferret's version
          -- reported 584 of 585 scopes as built by a different Ferret on a
          -- healthy index, and ferret status said "degraded" about nothing.
          --
          -- The same category error EPIC-094's sweep identified and excluded,
          -- reintroduced here and caught by running the product. A parser
          -- artefact's staleness is judged by EPIC-108's re-parse gate, which
          -- has a parser in hand to compare against.
          WHERE producer = 'ferret.indexer'`,
        [VERSION],
      );

      const row = rows[0];
      const total = Number(row?.total ?? '0');
      const current = Number(row?.current ?? '0');

      // EPIC-094 AC-6. Reported *before* the "nothing indexed" branch, because
      // that is the case it exists to correct: a run killed halfway leaves rows
      // written and no watermark, and this probe then told an operator whose
      // database held thousands of rows that nothing had been indexed. An open
      // run is the fact that distinguishes the two.
      const unfinished = await this.#unfinishedRuns(pool);
      if (unfinished.count > 0) {
        return {
          name: 'index-integrity',
          status: DependencyStatus.DEGRADED,
          required: false,
          detail: `${String(unfinished.count)} index run(s) started and never recorded finishing; the oldest began ${unfinished.oldest ?? 'at an unrecorded time'}`,
          remediation:
            'Indexing is idempotent. Run `ferret verify` to see what is affected, then `ferret index <path>` again.',
        };
      }

      if (total === 0) {
        return {
          name: 'index-integrity',
          status: DependencyStatus.UNKNOWN,
          required: false,
          detail: 'Nothing has been indexed yet, so index integrity cannot be assessed',
          remediation: 'Run `ferret index <path>` to index a repository.',
        };
      }

      const newest = row?.newest ?? undefined;
      const when = newest === undefined ? 'an unrecorded time' : newest.toISOString();

      if (current < total) {
        const stale = (row?.versions ?? []).filter((v) => v !== null).join(', ');
        return {
          name: 'index-integrity',
          status: DependencyStatus.DEGRADED,
          required: false,
          detail: `${String(total - current)} of ${String(total)} indexed scope(s) were built by a different Ferret (${stale || 'unknown version'}); last indexed ${when}`,
          remediation:
            'Nothing is lost. The next `ferret index` re-reads those scopes in full, which is slower once and then correct.',
        };
      }

      return {
        name: 'index-integrity',
        status: DependencyStatus.OK,
        required: false,
        // "No skew and no unfinished run" — deliberately not "the index is
        // correct". This probe reads artefact metadata and the run journal; it
        // recomputes no hash. `ferret verify` is the check that does, and
        // saying so here is what stops this line being read as one.
        detail: `${String(total)} derived artefact(s), all built by this version; no unfinished runs; last indexed ${when}. Run \`ferret verify\` to recompute stored hashes.`,
      };
    } catch (error) {
      // An integrity check that cannot run reports unknown. It never reports ok,
      // and it never takes the whole report down with it.
      return {
        name: 'index-integrity',
        status: DependencyStatus.UNKNOWN,
        required: false,
        detail: `Index integrity could not be determined: ${classifyDatabaseError(error, 'storage.check.index').message}`,
      };
    }
  }

  /**
   * Index runs that started and never closed — EPIC-094 AC-6.
   *
   * Raw SQL against the pool, like every other probe in this file: a health
   * check must work when the rest of the process does not, and reaching for a
   * store would make it depend on more than the connection it is checking.
   *
   * A missing table is not a failure. An installation migrated by an older
   * Ferret has no `index_run`, and reporting that as a health problem would
   * make an upgrade look like a fault.
   */
  async #unfinishedRuns(pool: Pool): Promise<{ count: number; oldest: string | undefined }> {
    try {
      const { rows } = await pool.query<{ n: string; oldest: Date | null }>(
        `SELECT count(*)::text AS n, min(started_at) AS oldest
           FROM ferret.index_run
          WHERE finished_at IS NULL
            AND started_at < now() - interval '2 hours'`,
      );
      return {
        count: Number(rows[0]?.n ?? '0'),
        oldest: rows[0]?.oldest?.toISOString(),
      };
    } catch {
      return { count: 0, oldest: undefined };
    }
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
