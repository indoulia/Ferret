import {
  DependencyStatus,
  HealthArea,
  buildReport,
  componentFrom,
  credentialsFor,
  isDatabaseConfigured,
  withoutCredentialFields,
  plannedCapabilityComponents,
  probeCore,
  providerSettings,
  serializeError,
  toFerretError,
  VERSION,
  type FerretConfig,
  type HealthComponent,
  type HealthReport,
} from '../index.js';
import {
  MigrationPolicy,
  createStorageProvider,
  readInventory,
  type IndexInventory,
} from '../storage/index.js';
import { createNullLogger, type Logger } from '../logging/index.js';
import { ProviderRegistry } from '../providers/index.js';
import { createGitSourceProvider } from '../git/index.js';

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
      // Projected and granted exactly as the registry does — EPIC-081 §8.1.
      // This is the one place outside the registry that builds a provider
      // context in production, and passing the whole configuration here would
      // have made the narrowing true by type and false at runtime.
      config: withoutCredentialFields(config),
      credentials: credentialsFor(config, provider.credentials ?? []),
      environment: {} as never,
      signal: new AbortController().signal,
      settings: providerSettings(provider, config),
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

  const report = buildReport({
    components,
    durationMs: Date.now() - startedAt,
    version: VERSION,
    node: core.environment.node.version,
    platform: `${core.environment.platform}/${core.environment.arch}`,
  });

  // EPIC-091 AC-5. Governance §20 names `ferret status` and `ferret doctor` and
  // asks for them to be dependable; before this they emitted nothing at any
  // level, so a `status` that answered `unknown` left nothing behind to
  // diagnose. One record per component with its verdict, and one summary.
  //
  // After the report is built rather than beside each probe: a record written
  // mid-probe would be lost if a later probe threw, and the report is the thing
  // that says a probe ran at all. Emission is best-effort — §8, logging never
  // fails an operation — which is why the report is returned either way.
  for (const component of report.components) {
    logger.debug(
      {
        operation: 'health.probe',
        component: component.name,
        area: component.area,
        status: component.status,
        required: component.required,
        detail: component.detail,
      },
      `${component.name}: ${component.status}`,
    );
  }
  logger.debug(
    {
      operation: 'health.report',
      status: report.status,
      checked: report.components.length,
      durationMs: report.durationMs,
    },
    `Health probe finished: ${report.status}`,
  );

  return report;
}

/**
 * What Ferret holds, for `ferret doctor` — EPIC-095 §3.2.
 *
 * Here rather than in `src/diagnostics` for the reason this whole file is here:
 * it is where the storage provider is *chosen*, and only the CLI layer decides
 * that PostgreSQL is the thing to ask. That keeps `pg` out of the core import
 * graph, which `tests/unit/boundaries.test.ts` enforces.
 *
 * Returns `undefined` when there is no database to ask, when configuration is
 * incomplete, or when the query fails — absent, never zero (AC-7). A
 * diagnostic that invented a count would be worse than one that admits it could
 * not read one, and `ferret doctor` is precisely the command run when the
 * database is the thing that is broken (AC-9).
 */
export async function readIndexInventory(logger?: Logger): Promise<IndexInventory | undefined> {
  const core = await probeCore();
  if (core.config === undefined || !isDatabaseConfigured(core.config)) return undefined;

  const provider = createStorageProvider({ policy: MigrationPolicy.OFF });
  try {
    await provider.initialize({
      logger: logger ?? createNullLogger(),
      config: withoutCredentialFields(core.config),
      credentials: credentialsFor(core.config, provider.credentials ?? []),
      environment: {} as never,
      signal: new AbortController().signal,
      settings: providerSettings(provider, core.config),
    });
    return await readInventory(provider.pool);
  } catch {
    return undefined;
  } finally {
    await provider.shutdown().catch(() => undefined);
  }
}

/** Which capabilities this installation offers, and why one is missing. */
export interface CapabilityAvailability {
  readonly capability: string;
  readonly available: boolean;
  /** `unregistered`, `disabled` or `failed`. Absent when available. */
  readonly reason?: string;
  readonly providerId?: string;
}

/**
 * What Ferret can do here, and why it cannot do the rest — EPIC-095 §3.3.
 *
 * **Every provider is registered optional**, which is what makes this safe to
 * run inside `ferret doctor`: EPIC-093 turned an unstartable provider from a
 * thrown error into a recorded fact, and `doctor` is exactly the caller that
 * wants that. A diagnostic that could not run because the thing it diagnoses is
 * broken is the failure mode §8 names.
 *
 * The whole function is best-effort. It reports what it could determine and
 * nothing about what it could not.
 */
export async function readCapabilityAvailability(logger?: Logger): Promise<readonly CapabilityAvailability[]> {
  const core = await probeCore();
  if (core.config === undefined) return [];

  const registry = new ProviderRegistry();
  const providers = [createStorageProvider({ policy: MigrationPolicy.OFF }), createGitSourceProvider()];
  for (const provider of providers) registry.register(provider, { optional: true });

  const declared = new Map<string, string>();
  for (const descriptor of registry.describe()) {
    for (const capability of descriptor.capabilities) declared.set(capability, descriptor.id);
  }

  try {
    await registry.initializeAll({
      logger: logger ?? createNullLogger(),
      config: core.config,
      environment: {} as never,
      signal: new AbortController().signal,
    });
  } catch {
    // Every provider is optional, so this should not throw — and if a future
    // change makes it possible, the report degrades rather than the command.
  }

  const usable = new Set<string>(registry.capabilities());
  const failed = new Set(registry.failures().map((entry) => entry.providerId));
  const described = new Map(registry.describe().map((entry) => [entry.id, entry]));

  const availability = [...declared.entries()].map(([capability, providerId]) => {
    if (usable.has(capability)) return { capability, available: true, providerId };
    const descriptor = described.get(providerId);
    const reason = failed.has(providerId) ? 'failed' : descriptor?.enabled === false ? 'disabled' : 'unregistered';
    return { capability, available: false, reason, providerId };
  });

  await registry.shutdownAll();
  return availability;
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
