import {
  defaultConfigSources,
  isDatabaseConfigured,
  missingDatabaseFields,
  resolveConfig,
  userConfigPath,
  type FerretConfig,
  type RepositoryPolicy,
} from '../config/index.js';
import { detectEnvironment, type EnvironmentReport } from '../environment/index.js';
import { serializeError, toFerretError } from '../errors/index.js';
import { MINIMUM_NODE_MAJOR } from '../environment/index.js';

import { DependencyStatus } from './contract.js';
import { HealthArea, type HealthComponent } from './health.js';

/**
 * Gathering health without being able to fail.
 *
 * This is the constraint that shapes the whole module. Governance §20 requires
 * `ferret status` and `ferret doctor` to stay dependable *when other subsystems
 * are unhealthy* — which is exactly when they are worth running. A diagnostic
 * that throws because the thing it was diagnosing is broken is useless.
 *
 * So every probe here catches, and turns a failure into a *result*. Nothing in
 * this file propagates an exception, and the tests assert that against a
 * database that is down, credentials that are wrong and configuration that does
 * not parse.
 *
 * It is also strictly read-only. EPIC-004 requires health checks not to mutate,
 * so nothing here writes a file, opens a transaction or migrates a schema.
 */

export interface CoreProbe {
  readonly components: readonly HealthComponent[];
  /**
   * The resolved configuration, when it could be resolved.
   *
   * `undefined` means configuration is broken — which is itself reported as a
   * component, and means the caller must not go on to probe the database.
   */
  readonly config: FerretConfig | undefined;
  readonly environment: EnvironmentReport;
  readonly repositoryPolicies: readonly RepositoryPolicy[];
}

export interface ProbeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/**
 * Node.js version. Required: running on an unsupported runtime produces failures
 * that look like Ferret defects.
 */
function runtimeComponent(environment: EnvironmentReport): HealthComponent {
  if (environment.node.supported) {
    return {
      name: 'node',
      area: HealthArea.RUNTIME,
      status: DependencyStatus.OK,
      required: true,
      detail: `Node.js ${environment.node.version} on ${environment.platform}/${environment.arch}`,
    };
  }
  return {
    name: 'node',
    area: HealthArea.RUNTIME,
    status: DependencyStatus.UNAVAILABLE,
    required: true,
    detail: `Node.js ${environment.node.version} is below the supported range ${environment.node.supportedRange}`,
    remediation: `Install Node.js ${String(MINIMUM_NODE_MAJOR)} LTS or newer and reinstall Ferret.`,
  };
}

/**
 * The `git` executable.
 *
 * Optional, not required: TECHNOLOGY-DECISIONS §5 selected the installed `git`
 * binary over an in-process library, and its absence disables repository
 * features rather than Ferret itself.
 */
function gitComponent(environment: EnvironmentReport): HealthComponent {
  if (environment.git.available) {
    return {
      name: 'git',
      area: HealthArea.SOURCES,
      status: DependencyStatus.OK,
      required: false,
      detail: environment.git.version === undefined ? 'git found' : `git ${environment.git.version}`,
    };
  }
  return {
    name: 'git',
    area: HealthArea.SOURCES,
    status: DependencyStatus.DEGRADED,
    required: false,
    detail: 'git was not found on PATH',
    remediation:
      'Install Git and ensure it is on PATH. Repository discovery and history ingestion stay unavailable until it is.',
  };
}

/**
 * Whether Ferret has been told how to reach a database.
 *
 * Reported separately from whether the database *works*, because the two have
 * completely different remediations — "run `ferret init --save`" against "start
 * PostgreSQL" — and conflating them is how a user ends up debugging the wrong
 * thing.
 */
function databaseConfiguredComponent(config: FerretConfig): HealthComponent {
  if (isDatabaseConfigured(config)) {
    return {
      name: 'database-configured',
      area: HealthArea.CONFIGURATION,
      status: DependencyStatus.OK,
      required: true,
      detail: `Configured for ${config.database.user ?? '?'}@${config.database.host ?? '?'}:${String(config.database.port)}/${config.database.database ?? '?'}`,
    };
  }
  const missing = missingDatabaseFields(config);
  return {
    name: 'database-configured',
    area: HealthArea.CONFIGURATION,
    status: DependencyStatus.UNAVAILABLE,
    required: true,
    detail: `Database connection is not configured — missing ${missing.join(', ')}`,
    remediation:
      'Set FERRET_DATABASE_HOST, FERRET_DATABASE_NAME, FERRET_DATABASE_USER and FERRET_DATABASE_PASSWORD, then run `ferret init --save` to store them.',
  };
}

/**
 * Probes everything that does not need a database.
 *
 * Runs first and always succeeds, so a report exists even when configuration
 * itself is what is broken.
 */
export async function probeCore(options: ProbeOptions = {}): Promise<CoreProbe> {
  const environment = await detectEnvironment().catch(
    (): EnvironmentReport =>
      ({
        node: {
          version: process.versions.node,
          supported: false,
          supportedRange: `>=${String(MINIMUM_NODE_MAJOR)}`,
        },
        platform: process.platform,
        arch: process.arch,
        cwd: options.cwd ?? process.cwd(),
        interactive: false,
        git: { available: false },
      }) as EnvironmentReport,
  );

  const components: HealthComponent[] = [runtimeComponent(environment), gitComponent(environment)];
  const repositoryPolicies: RepositoryPolicy[] = [];

  let config: FerretConfig | undefined;
  try {
    const { sources } = defaultConfigSources({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      onRepositoryPolicy: (policy) => repositoryPolicies.push(policy),
    });
    const resolved = resolveConfig(sources, options.env === undefined ? {} : { env: options.env });
    config = resolved.config;

    components.push({
      name: 'configuration',
      area: HealthArea.CONFIGURATION,
      status: DependencyStatus.OK,
      required: true,
      detail: `Resolved from ${String(resolved.sources.length)} layer(s); user file ${userConfigPath(options.env)}`,
    });
  } catch (error) {
    // Invalid configuration, an unreadable file, or a secret reference that
    // cannot be resolved. All of them are findings, none of them are crashes.
    const failure = toFerretError(error);
    const serialized = serializeError(failure);
    components.push({
      name: 'configuration',
      area: HealthArea.CONFIGURATION,
      status: DependencyStatus.UNAVAILABLE,
      required: true,
      detail: serialized.message,
      remediation:
        serialized.remediation ??
        `Fix the reported values, or delete ${userConfigPath(options.env)} — Ferret starts with no configuration file at all.`,
    });
  }

  if (config !== undefined) {
    components.push(databaseConfiguredComponent(config));

    // A repository that tried to set something it may not is worth surfacing:
    // silence would leave its author guessing why nothing happened.
    const ignored = repositoryPolicies.flatMap((policy) => policy.ignored);
    if (ignored.length > 0) {
      const path = repositoryPolicies.find((policy) => policy.ignored.length > 0)?.path;
      components.push({
        name: 'repository-policy',
        area: HealthArea.CONFIGURATION,
        status: DependencyStatus.DEGRADED,
        required: false,
        detail: `Repository policy set ${ignored.join(', ')}, which a repository may not change`,
        remediation: `A repository may only set \`exclude\`. Remove the other keys from ${path ?? '.ferret/config.json'}, or set them in your own configuration with \`ferret config set\`.`,
      });
    }
  }

  return { components, config, environment, repositoryPolicies };
}

/**
 * Capabilities Ferret's roadmap defines but does not yet implement.
 *
 * Reported as `unknown` rather than omitted. Governance §6 requires
 * not-indexed and unavailable to be representable, and an operator reading a
 * clean bill of health should be able to see that indexing was never checked
 * because it does not exist yet — rather than infer it from an absence.
 */
export function plannedCapabilityComponents(): readonly HealthComponent[] {
  return [
    {
      name: 'index-integrity',
      area: HealthArea.INDEX,
      status: DependencyStatus.UNKNOWN,
      required: false,
      detail: 'No index exists yet, so its integrity cannot be assessed',
      remediation: 'Indexing arrives with EPIC-031; integrity checking and recovery with EPIC-094.',
    },
    {
      name: 'synchronization',
      area: HealthArea.SOURCES,
      status: DependencyStatus.UNKNOWN,
      required: false,
      detail: 'No source synchronization is configured yet',
      remediation: 'Source synchronization arrives with EPIC-075 and EPIC-076.',
    },
  ];
}
