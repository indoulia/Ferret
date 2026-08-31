import {
  DependencyStatus,
  HealthArea,
  buildReport,
  componentFrom,
  isDatabaseConfigured,
  plannedCapabilityComponents,
  probeCore,
  serializeError,
  toFerretError,
  VERSION,
  type FerretConfig,
  type HealthComponent,
  type HealthReport,
} from '../index.js';
import { MigrationPolicy, createStorageProvider } from '../storage/index.js';
import { createNullLogger, type Logger } from '../logging/index.js';

import { ExitCode } from './exit-codes.js';

/**
 * Composing a health report.
 *
 * This lives in the CLI layer, not in `src/diagnostics`, because it is where
 * the storage provider is *chosen*. Core diagnostics aggregate whatever
 * components they are handed; only here does Ferret decide that PostgreSQL is
 * the storage to probe. That keeps `pg` and Drizzle out of the core import
 * graph, which `tests/unit/boundaries.test.ts` enforces.
 *
 * Both `ferret status` and `ferret doctor` build on this one function, so they
 * can never disagree about whether Ferret is healthy.
 */

export interface HealthProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly logger?: Logger;
  /** How long to wait for the database before calling it unreachable. */
  readonly databaseTimeoutMs?: number;
}

/**
 * Probes the database without being able to throw.
 *
 * The storage provider raises on an unreachable database, wrong credentials or
 * an unusable schema — correct for startup, wrong for a diagnostic. Here the
 * error is the *answer*, so it is caught and turned into a component. Because
 * `FerretError` already carries a code and a remediation, the classification
 * EPIC-002 established is reused rather than re-derived.
 *
 * Read-only by construction: the migration policy is forced to `off`, so
 * running `ferret status` can never migrate a schema. That is EPIC-004's
 * "health checks do not mutate data" criterion, enforced rather than intended.
 */
async function probeStorage(config: FerretConfig, logger: Logger): Promise<HealthComponent[]> {
  if (!isDatabaseConfigured(config)) {
    // Not an error: `probeCore` has already reported that configuration is
    // incomplete, and repeating it as a database failure would send the user
    // to check a server they have not named yet.
    return [];
  }

  const provider = createStorageProvider({ policy: MigrationPolicy.OFF });
  try {
    await provider.initialize({
      logger,
      config,
      environment: {} as never,
      signal: new AbortController().signal,
    });
  } catch (error) {
    const failure = toFerretError(error);
    const serialized = serializeError(failure);
    // Schema problems are a different area from connectivity problems, and an
    // operator fixes them differently: one is "start the server", the other is
    // "upgrade Ferret" or "fix the migration".
    const schemaCodes = new Set(['E_SCHEMA_UNSUPPORTED', 'E_SCHEMA_DRIFT', 'E_MIGRATION_FAILED', 'E_MIGRATION_PENDING']);
    const area = schemaCodes.has(serialized.code) ? HealthArea.SCHEMA : HealthArea.DATABASE;

    return [
      {
        name: area === HealthArea.SCHEMA ? 'postgres-schema' : 'postgres',
        area,
        status: DependencyStatus.UNAVAILABLE,
        required: true,
        detail: serialized.message,
        ...(serialized.remediation === undefined ? {} : { remediation: serialized.remediation }),
      },
    ];
  }

  try {
    const results = await provider.checkDependencies();
    return results.map((result) => {
      if (result.name.startsWith('postgres-extension')) return componentFrom(result, HealthArea.EXTENSIONS);
      if (result.name === 'postgres-schema') return componentFrom(result, HealthArea.SCHEMA);
      if (result.name === 'index-integrity') return componentFrom(result, HealthArea.INDEX);
      return componentFrom(result, HealthArea.DATABASE);
    });
  } catch (error) {
    // A check that cannot run reports unknown. It never reports ok.
    return [
      {
        name: 'postgres',
        area: HealthArea.DATABASE,
        status: DependencyStatus.UNKNOWN,
        required: true,
        detail: `Database health could not be determined: ${toFerretError(error).message}`,
      },
    ];
  } finally {
    await provider.shutdown().catch(() => undefined);
  }
}

/**
 * Produces a complete report.
 *
 * Never throws. Governance §20 requires `status` and `doctor` to remain
 * dependable when other subsystems are unhealthy, which is precisely when they
 * are worth running.
 */
export async function probeHealth(options: HealthProbeOptions = {}): Promise<HealthReport> {
  const startedAt = Date.now();
  const logger = options.logger ?? createNullLogger();

  const core = await probeCore({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });

  const components: HealthComponent[] = [...core.components];
  if (core.config !== undefined) {
    components.push(...(await probeStorage(core.config, logger)));
  }
  components.push(...plannedCapabilityComponents());

  // `index-integrity` is answered by the database when there is one to ask.
  // When there is not, the answer is unknown rather than absent: Governance §6
  // requires an operator reading a report to see that a check did not run,
  // rather than having to notice that a name is missing.
  if (!components.some((component) => component.name === 'index-integrity')) {
    components.push({
      name: 'index-integrity',
      area: HealthArea.INDEX,
      status: DependencyStatus.UNKNOWN,
      required: false,
      detail: 'The index cannot be assessed without a database connection',
      remediation: 'Configure a database with `ferret init --save`, then run `ferret status` again.',
    });
  }

  return buildReport({
    components,
    durationMs: Date.now() - startedAt,
    version: VERSION,
    node: core.environment.node.version,
    platform: `${core.environment.platform}/${core.environment.arch}`,
  });
}

/**
 * Maps a report to a process exit code.
 *
 * Deterministic, which the Definition of Done requires: the same failure always
 * produces the same code, and the code identifies *which kind* of problem it is
 * so a script can act without parsing text. Codes are the ones Ferret already
 * publishes rather than a new scheme.
 *
 * `degraded` exits 0 by default because Ferret is genuinely usable — an absent
 * pgvector should not fail a CI job that does not use semantic search.
 * `--strict` is for callers that want anything less than perfect to fail.
 */
export function exitCodeForHealth(report: HealthReport, strict = false): ExitCode {
  if (report.status === DependencyStatus.OK) return ExitCode.OK;
  if (report.status === DependencyStatus.DEGRADED) return strict ? ExitCode.DEPENDENCY : ExitCode.OK;

  // Attribute the exit code to the worst *required* component, so the code says
  // what to go and fix.
  const blocking = report.components.filter(
    (component) => component.required && component.status !== DependencyStatus.OK,
  );
  const worst =
    blocking.find((component) => component.status === DependencyStatus.UNAVAILABLE) ?? blocking[0];

  switch (worst?.area) {
    case HealthArea.CONFIGURATION:
      return ExitCode.CONFIG;
    case HealthArea.SCHEMA:
      return ExitCode.STORAGE;
    default:
      return ExitCode.DEPENDENCY;
  }
}
